// The research-corpus contract: what a day's corpus must contain before any
// reporter can be pointed at it, and how a reader knows which commit it is
// looking at.
//
// The corpus is a Spawnfile fed volume (agentic-org/Spawnfile, resource
// `research-corpus`): the host's `spawnfile volume refresh` lands the private
// repo's `edition/<today>` branch as `trees/<revision>`, swaps `current` to it,
// writes `.spawnfile-feed.json`, and freezes at the 12:00 Europe/Berlin cutoff.
// Two programs read the same facts from opposite sides of the agent boundary:
// this module is the feed's `validate` hook on the HOST (run against the staged
// tree before it can land), and the newsroom tools read the mount through it
// inside the container. Shared, never copied: a corpus check that has drifted is
// indistinguishable from no corpus check at all.
//
// Only read-and-verify logic lives here: nothing builds, writes, fetches or
// deploys.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const REPORTERS = ['cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton', 'vesta'];
export const EDITION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const STORY_ID_PATTERN = /^s-[0-9a-f]{8}$/;
export const CORPUS_PREP_VERSION = 'clank.research-corpus.prepared.v1';

// The corpus identity a newsroom record binds (assignments, compositions). It
// travels with the data: Spawnfile writes `.spawnfile-feed.json` at the mount
// root, and `corpusIdentityFromFeed` reads it into this shape. The tree a desk
// reads is `current/`, the link Spawnfile swaps.
export const CORPUS_IDENTITY_VERSION = 'clank.research-corpus.identity.v1';
export const CORPUS_IDENTITY_FILE = '.spawnfile-feed.json';
export const CORPUS_FEED_VERSION = 'spawnfile.volume-feed.v1';
export const CORPUS_RESOURCE = 'research-corpus';
export const CORPUS_LINK = 'current';
/** The tree every desk reads: the mount's `current` link. */
export const corpusRoot = (mount) => path.join(mount, CORPUS_LINK);

// Shape first, then Date.parse: Date.parse alone accepts 'Jan 1 2020' and
// other locale-ish strings, which no reader on the far side should have to
// guess at, and the shape alone accepts 2026-13-45T99:99:99Z.
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const berlinDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The wall clock the newsroom's cron runs on; the reporters resolve their own edition date from it. */
export function berlinToday(now = new Date()) { return berlinDate.format(now); }

export class CorpusError extends Error {}
const fail = (message) => { throw new CorpusError(message); };

// ONE SPELLING OF A CORPUS TREE, AND THIS IS IT
// ---------------------------------------------
// A landed tree is `trees/<revision>` (or `trees/<revision>.<generation>` after
// a re-land): the 64-hex revision Spawnfile derives from the selected git tree.
// Editions commissioned before the corpus became a fed volume recorded
// `trees/<commit>`, and their records still have to read as valid. The
// predicates live here and are imported, never re-spelled.
export const CORPUS_TREES_DIR = 'trees';
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const FEED_TREE_PATTERN = /^[0-9a-f]{64}(?:\.[1-9][0-9]*)?$/u;

/** A corpus commit id: 40 lowercase hex characters, which is what git prints and what every corpus record must carry. */
export const isCorpusCommit = (value) => typeof value === 'string' && COMMIT_PATTERN.test(value);

/** True for a landed tree path: trees/<revision>[.<generation>], or a pre-feed record's trees/<commit>. */
export const isCorpusTreePath = (value) => typeof value === 'string'
  && value.startsWith(`${CORPUS_TREES_DIR}/`)
  && (FEED_TREE_PATTERN.test(value.slice(CORPUS_TREES_DIR.length + 1)) || isCorpusCommit(value.slice(CORPUS_TREES_DIR.length + 1)));

const EDITION_REF = /(?:^|\/)edition\/(\d{4}-\d{2}-\d{2})$/u;
/** The edition a corpus ref was cut for (`origin/edition/<date>`), or null. */
export const editionOfRef = (ref) => (typeof ref === 'string' ? EDITION_REF.exec(ref)?.[1] ?? null : null);

const datedDirectories = (root) => { try { return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && EDITION_PATTERN.test(entry.name)).map((entry) => entry.name).sort(); } catch { return []; } };

/**
 * Spawnfile's identity record, read into the identity shape a newsroom record
 * binds. Never throws: whatever is wrong with the record shows up as findings
 * from `corpusIdentityFindings`, because every field it cannot read is absent.
 */
export function corpusIdentityFromFeed(record, mount) {
  const feed = record && typeof record === 'object' && !Array.isArray(record) && record.version === CORPUS_FEED_VERSION && record.resource === CORPUS_RESOURCE;
  const source = feed && record.source && typeof record.source === 'object' ? record.source : {};
  return {
    version: feed ? CORPUS_IDENTITY_VERSION : (record?.version ?? null),
    commit: source.kind === 'git' ? source.commit : undefined,
    ref: source.ref,
    edition: editionOfRef(source.ref),
    fetched_at: feed ? record.landed_at : undefined,
    tree: feed ? record.tree : undefined,
    editions_present: datedDirectories(corpusRoot(mount)),
    source_count: feed ? record.files : undefined
  };
}

// The proof that matters: read the paths back out of the tree that will
// actually be mounted, not out of git. Returns per-reporter index stats and
// the resolved story files.
//
// A QUIET DESK IS NOT A BROKEN CORPUS
// ----------------------------------
// Every reporter's index must exist, parse, and resolve to story files that are
// really there -- those are the defects that ENOENT a wake. A desk with ZERO
// rows is not one of them: it is a beat with nothing routed to it today. Vesta
// runs roughly one edition in seven by declaration, and the real row counts fall
// to single digits (graves filed one row on 2026-09-30), so refusing a corpus
// over an empty desk would turn "five desks pitch, one sits out" into "no
// paper" -- the exact class of lost edition this whole change exists to remove.
// An over-strict guard that loses the day is as bad as a missing one.
//
// What a routing failure actually looks like is ALL of them empty: a split that
// broke, or captures that produced nothing. That is the total below, and it is
// one behaviour for every caller -- no flag, because a flag with two behaviours
// is how the retired build path and the runtime drifted apart in the first place.
export function verifyCorpusTree(root, edition) {
  const report = [];
  for (const agent of REPORTERS) {
    const indexPath = path.join(root, edition, 'desks', `${agent}.index`);
    let text;
    try { text = readFileSync(indexPath, 'utf8'); } catch { return fail(`extracted corpus is missing ${edition}/desks/${agent}.index`); }
    const rows = text.split('\n').filter((line) => line.trim() && !line.startsWith('#'));
    const stories = rows.map((line) => line.trim().split(/\s+/)[0]);
    const unparsable = stories.filter((id) => !STORY_ID_PATTERN.test(id));
    if (unparsable.length) fail(`${edition}/desks/${agent}.index has row(s) whose first field is not a story id: ${unparsable.join(', ')}`);
    const missing = stories.filter((id) => !existsSync(path.join(root, edition, 'stories', `${id}.md`)));
    if (missing.length) fail(`DEFECT: ${edition}/desks/${agent}.index references story files that are absent from the corpus: ${missing.map((id) => `${edition}/stories/${id}.md`).join(', ')}`);
    report.push({ agent, bytes: Buffer.byteLength(text), rows: rows.length, stories });
  }
  if (report.reduce((total, entry) => total + entry.rows, 0) === 0) fail(`corpus for ${edition} routed no stories to any desk`);
  return report;
}

const digestText = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

export function verifyCorpusFreshness(root, edition) {
  const metadataPath = path.join(root, edition, 'desks', '_corpus.prepared.json');
  let metadata;
  try { metadata = JSON.parse(readFileSync(metadataPath, 'utf8')); } catch { fail(`extracted corpus is missing parseable ${edition}/desks/_corpus.prepared.json`); }
  if (metadata.version !== CORPUS_PREP_VERSION) fail(`${edition}/desks/_corpus.prepared.json has unsupported version ${JSON.stringify(metadata.version)}`);
  if (metadata.edition !== edition) fail(`${edition}/desks/_corpus.prepared.json names edition ${JSON.stringify(metadata.edition)}`);
  if (!Array.isArray(metadata.sources)) fail(`${edition}/desks/_corpus.prepared.json must declare sources[]`);

  const rawSources = [];
  for (const site of ['chatgpt', 'grok']) {
    const dir = path.join(root, edition, site);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) if (name.endsWith('.md')) rawSources.push(`${site}/${name}`);
  }
  if (!rawSources.length) fail(`${edition} has no raw chatgpt/grok research captures to prove freshness against`);

  const declared = new Map();
  for (const source of metadata.sources) {
    if (!source || typeof source.path !== 'string' || typeof source.sha256 !== 'string') fail(`${edition}/desks/_corpus.prepared.json has malformed source entry`);
    if (declared.has(source.path)) fail(`${edition}/desks/_corpus.prepared.json declares duplicate source ${source.path}`);
    declared.set(source.path, source.sha256);
  }
  const missing = rawSources.filter((source) => !declared.has(source));
  if (missing.length) fail(`${edition}/desks/_corpus.prepared.json does not cover latest raw capture(s): ${missing.join(', ')}`);
  const stale = [];
  for (const source of rawSources) {
    const digest = digestText(readFileSync(path.join(root, edition, source), 'utf8'));
    if (declared.get(source) !== digest) stale.push(source);
  }
  if (stale.length) fail(`${edition}/desks/_corpus.prepared.json has stale digest(s) for: ${stale.join(', ')}`);

  const extra = [...declared.keys()].filter((source) => !rawSources.includes(source));
  if (extra.length) fail(`${edition}/desks/_corpus.prepared.json declares source(s) absent from the corpus: ${extra.join(', ')}`);
  return { sources: rawSources.length };
}

// FINDINGS, NOT A THROW
// ---------------------
// The writer and the reader want opposite things from a bad identity record.
// The host refresher must refuse and raise an alarm; a newsroom tool inside
// the container must be able to say "the corpus I was given is not today's"
// in a sentence an agent can act on. Returning every finding at once serves
// both, and keeps the one list of rules in one place.
// WHY A `*Findings` PREDICATE NEVER THROWS
// ---------------------------------------
// Two programs read the same corpus mount and both decide whether to proceed from
// these predicates. One wrapped its call in a try/catch and carried a comment
// saying an unexpected throw fails closed; the other called it bare. So the two
// readers did not actually agree, and the disagreement was invisible because each
// one looked right on its own.
//
// The guarantee belongs HERE, where the rule is, not at each call site: every
// `*Findings` function below answers with findings for every input it is handed, so
// a bare call cannot be weaker than a wrapped one no matter who writes the next
// reader. (`verifyCorpusTree` and `verifyCorpusFreshness` are the other family --
// they throw CorpusError by contract and every caller wraps them.)
//
// DEFENCE IN DEPTH, NOT A REPAIR FOR AN OBSERVED FAILURE, and this comment says so
// because overstating it is the defect family this file keeps catching: probing the
// real shapes did not produce a throw -- `trees` as a regular file answers with a
// dangling-link finding -- and the only throws that can be constructed come from
// arguments no reader passes. corpus-contract.test.mjs constructs exactly those, so
// the catch is exercised rather than merely claimed.
const answering = (label, answer) => {
  try {
    const findings = answer();
    return Array.isArray(findings) ? findings : [`${label} could not be checked: the check returned ${typeof findings}, not a list of findings`];
  } catch (error) { return [`${label} could not be checked: ${error?.message ?? error}`]; }
};

export function corpusIdentityFindings(value, options = {}) {
  return answering(CORPUS_IDENTITY_FILE, () => identityFindings(value, options));
}

function identityFindings(value, { edition } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${CORPUS_IDENTITY_FILE} must be a JSON object, got ${Array.isArray(value) ? 'an array' : typeof value}`];
  const findings = [];
  if (value.version !== CORPUS_IDENTITY_VERSION) findings.push(`version must be ${CORPUS_IDENTITY_VERSION}, got ${JSON.stringify(value.version)}`);
  if (!isCorpusCommit(value.commit)) findings.push(`commit must be a 40-character lowercase hex sha, got ${JSON.stringify(value.commit)}`);
  if (typeof value.ref !== 'string' || !value.ref.trim()) findings.push(`ref must name the branch the corpus was cut from, got ${JSON.stringify(value.ref)}`);
  if (typeof value.edition !== 'string' || !EDITION_PATTERN.test(value.edition)) findings.push(`edition must be YYYY-MM-DD, got ${JSON.stringify(value.edition)}`);
  if (typeof value.fetched_at !== 'string' || !ISO_INSTANT_PATTERN.test(value.fetched_at) || Number.isNaN(Date.parse(value.fetched_at))) findings.push(`fetched_at must be an ISO instant, got ${JSON.stringify(value.fetched_at)}`);
  // The tree is bound to what desks read by `corpusLinkFindings`, not here.
  if (!isCorpusTreePath(value.tree)) findings.push(`tree must be ${CORPUS_TREES_DIR}/<revision>, got ${JSON.stringify(value.tree)}`);
  if (!Array.isArray(value.editions_present) || !value.editions_present.includes(value.edition)) findings.push(`editions_present must list the edition the record names, got ${JSON.stringify(value.editions_present)}`);
  if (!Number.isSafeInteger(value.source_count) || value.source_count < 1) findings.push(`source_count must be a positive integer, got ${JSON.stringify(value.source_count)}`);
  // Named with BOTH dates on purpose: "wrong edition" read on a lock screen or
  // in an agent's tool error is useless without which day was mounted and
  // which day was wanted.
  if (edition && value.edition !== edition) findings.push(`corpus is edition ${JSON.stringify(value.edition)}, not ${edition}`);
  return findings;
}

const realpathOrNull = (target) => { try { return realpathSync(target); } catch { return null; } };

// THE LINK IS PART OF THE IDENTITY
// -------------------------------
// The identity record names a tree, and no reader ever opens that tree by name:
// the reporters cat <mount>/current/<edition>/desks/<agent>.index. So a record
// that validates proves NOTHING about the bytes a desk reads unless `current`
// is the link to exactly the tree the record names, and that tree holds the
// edition. The volume root is owned by the uid the agents run as, so an agent
// can replace the link or the record; Spawnfile re-verifies and heals on every
// host poll, and this is the read side asking the same question at call time.
//
// Fails closed on every error: an unreadable link, a dangling link, a link to
// another tree, an absent edition and a real directory where the link belongs
// are each "this corpus is not bound to the tree it claims", never "probably
// fine".
export function corpusLinkFindings(mount, edition, tree) {
  return answering(`the ${edition} corpus link`, () => linkFindings(mount, edition, tree));
}

function linkFindings(mount, edition, tree) {
  // Checked first, and by type: `path.join` throws on anything that is not a string,
  // which is the one way a reader has ever been able to make this throw at all.
  if (typeof mount !== 'string' || !mount) return [`the corpus mount must be a path to resolve the current link against, got ${JSON.stringify(mount)}`];
  if (typeof edition !== 'string' || !EDITION_PATTERN.test(edition)) return [`edition must be YYYY-MM-DD to resolve a corpus link, got ${JSON.stringify(edition)}`];
  if (!isCorpusTreePath(tree)) return [`tree must be ${CORPUS_TREES_DIR}/<revision> to resolve a corpus link, got ${JSON.stringify(tree)}`];
  const link = corpusRoot(mount);
  let stat;
  try { stat = lstatSync(link); } catch (error) { return [`${CORPUS_LINK} is not on the corpus mount at all (${error.code ?? error.message})`]; }
  if (!stat.isSymbolicLink()) return [`${CORPUS_LINK} is a real ${stat.isDirectory() ? 'directory' : 'file'} on the mount, not the link to ${tree}`];
  let target;
  try { target = readlinkSync(link); } catch (error) { return [`${CORPUS_LINK} cannot be read (${error.code ?? error.message})`]; }
  if (target !== tree) return [`${CORPUS_LINK} points at ${JSON.stringify(target)}, not the ${tree} the record names`];
  if (realpathOrNull(link) === null) return [`${CORPUS_LINK} is a dangling symlink, so nothing it names can be read`];
  let edstat = null;
  try { edstat = lstatSync(path.join(mount, tree, edition)); } catch { /* reported below */ }
  if (!edstat?.isDirectory()) return [`${tree} holds no ${edition}/ directory, so the edition the record names was not landed`];
  return [];
}

// THE FEED'S VALIDATE HOOK
// ------------------------
// `spawnfile volume refresh research-corpus` runs this against the staged tree
// before it can land (agentic-org/Spawnfile). The edition is the one the ref
// was cut for (`origin/edition/<date>`), and the corpus must carry that
// edition's six desk indexes, every story they name, and fresh prepared
// metadata. A non-zero exit lands nothing and the old tree keeps serving.
export function validateStagedCorpus(tree, provenance) {
  const edition = editionOfRef(provenance?.ref);
  if (!edition) fail(`the staged corpus was resolved from ${JSON.stringify(provenance?.ref ?? null)}, which names no edition/<date> branch`);
  const desks = verifyCorpusTree(tree, edition);
  const fresh = verifyCorpusFreshness(tree, edition);
  return { edition, rows: desks.reduce((total, entry) => total + entry.rows, 0), sources: fresh.sources };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    const tree = process.env.SPAWNFILE_FEED_TREE;
    if (!tree || !path.isAbsolute(tree)) fail('SPAWNFILE_FEED_TREE must name the staged tree (this runs as a Spawnfile feed validate hook)');
    let provenance;
    try { provenance = JSON.parse(process.env.SPAWNFILE_FEED_PROVENANCE ?? ''); } catch { fail('SPAWNFILE_FEED_PROVENANCE must be the JSON provenance Spawnfile passes the hook'); }
    const result = validateStagedCorpus(tree, provenance);
    console.log(`research corpus OK: ${result.edition}, ${result.rows} desk row(s), ${result.sources} raw source(s)`);
  } catch (error) {
    console.error(`research corpus refused: ${error.message}`);
    process.exitCode = 1;
  }
}
