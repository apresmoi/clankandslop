// The research-corpus contract: what a day's corpus must contain before any
// reporter can be pointed at it, and how the host tells the container which
// commit it is looking at.
//
// WHY THIS IS ITS OWN MODULE
// --------------------------
// Two programs on opposite sides of the agent boundary have to agree on the
// same facts. repin-private-source.mjs validated a corpus it had just cut into
// a checksum-pinned tar; corpus-refresh.mjs validates a corpus it has just
// extracted into a read-only docker volume, and the newsroom tools inside the
// container read the identity record that refresher wrote. If the checks were
// copied instead of shared, the copy that is not exercised every morning is
// the one that drifts -- and a corpus check that has drifted is
// indistinguishable from no corpus check at all.
//
// WHAT LIVES HERE AND WHAT DOES NOT
// ---------------------------------
// Only read-and-verify logic: nothing here builds a tar, writes a volume,
// fetches a repo or deploys anything. The two callers keep their own side
// effects. `resolveRef` is the exception that proves the rule -- it only ever
// *reads* refs, and both callers must refuse a missing edition branch in
// exactly the same way, which is the whole reason the module exists.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const REPORTERS = ['cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton', 'vesta'];
export const EDITION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const STORY_ID_PATTERN = /^s-[0-9a-f]{8}$/;
export const CORPUS_PREP_VERSION = 'clank.research-corpus.prepared.v1';

// The identity record the host writes at the root of the corpus volume. It is
// what replaced the bundle's sha256 as the paper's provenance: the digest used
// to prove which research backed an edition because the corpus was part of the
// image, and now the corpus is data the host swaps under a running container,
// so the proof has to travel *with the data*.
export const CORPUS_IDENTITY_VERSION = 'clank.research-corpus.identity.v1';
export const CORPUS_IDENTITY_FILE = 'CORPUS.json';

// Shape first, then Date.parse: Date.parse alone accepts 'Jan 1 2020' and
// other locale-ish strings, which no reader on the far side should have to
// guess at, and the shape alone accepts 2026-13-45T99:99:99Z.
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const berlinDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The wall clock the newsroom's cron runs on; the reporters resolve their own edition date from it. */
export function berlinToday(now = new Date()) { return berlinDate.format(now); }

export class CorpusError extends Error {}
const fail = (message) => { throw new CorpusError(message); };

// ONE SPELLING OF `trees/<commit>`, AND THIS IS IT
// -----------------------------------------------
// The commit shape and the tree path are a single rule with four readers -- this
// contract, the host's record (corpus-landed.mjs), the host-side volume writer
// and the edition publisher -- and every one of them had its own private copy,
// because this module was documented as the home for shared corpus rules while
// exporting none of them. Four copies of a validation rule are three that can
// drift in silence, and a corpus check that has drifted is indistinguishable
// from no corpus check at all.
//
// So the predicate, the builder and the validator live here and are imported,
// never re-spelled: corpus-contract.test.mjs scans the corpus modules for a
// private copy of either pattern and fails on a hit, so the fifth copy cannot
// land quietly either.
//
// This is still the READ side: a path, not a filesystem. The host-side writer
// re-exports the directory name (corpus-volume.mjs's TREES_DIR) so the container
// never has to import a volume mutator to know what the path looks like.
export const CORPUS_TREES_DIR = 'trees';
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

/** A corpus commit id: 40 lowercase hex characters, which is what git prints and what every corpus record must carry. */
export const isCorpusCommit = (value) => typeof value === 'string' && COMMIT_PATTERN.test(value);

/** The one spelling of a corpus tree path, relative to the volume root. Refuses to build one from anything that is not a commit. */
export const corpusTreePath = (commit) => {
  if (!isCorpusCommit(commit)) fail(`a corpus tree path needs a 40-character lowercase hex commit, got ${JSON.stringify(commit)}`);
  return `${CORPUS_TREES_DIR}/${commit}`;
};

/** True for exactly the strings `corpusTreePath` builds, so a record's `tree` field is validated without restating the shape. */
export const isCorpusTreePath = (value) => typeof value === 'string'
  && value.startsWith(`${CORPUS_TREES_DIR}/`)
  && isCorpusCommit(value.slice(CORPUS_TREES_DIR.length + 1));

// stderr is captured rather than inherited so a probe that is *expected* to
// miss (rev-parse on a ref that does not exist yet) does not print raw git
// noise ahead of this module's own, far more actionable, message.
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 1024 * 1024 * 256, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

// Resolves `ref` to a commit WITHOUT ever falling back to another ref: a
// missing edition branch means the producer has not cut today's corpus yet,
// and silently using main in that case is exactly the failure this machinery
// was written to end.
export function resolveRef(privateRepoPath, ref) {
  for (const candidate of [`refs/remotes/origin/${ref}`, `refs/heads/${ref}`]) {
    try { return { commit: git(privateRepoPath, ['rev-parse', '--verify', `${candidate}^{commit}`]).trim(), ref: candidate }; } catch { /* try the next form */ }
  }
  let known = '';
  try { known = git(privateRepoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/edition']).trim().split('\n').filter(Boolean).slice(-5).join(', '); } catch { /* listing is advisory */ }
  return fail(`private ref '${ref}' does not exist in ${privateRepoPath} -- refusing to fall back to another ref.\n`
    + `  The producers commit each day's corpus to edition/<date>; if that branch is missing the corpus for this edition has not been cut yet.\n`
    + (known ? `  Most recent edition branches seen locally: ${known}\n` : '')
    + '  Re-run once the branch exists, or pass --ref=<branch> deliberately.');
}

// Every path the reporters' prompts name, checked against the commit's tree
// before anything is written. `git ls-tree` on the commit is authoritative and
// costs nothing next to materializing the tree.
export function assertEditionInTree(privateRepoPath, commit, edition) {
  const present = new Set(git(privateRepoPath, ['ls-tree', '-r', '--name-only', commit, `${edition}/`]).split('\n').filter(Boolean));
  const missing = REPORTERS.filter((agent) => !present.has(`${edition}/desks/${agent}.index`));
  if (missing.length) {
    const dates = [...new Set(git(privateRepoPath, ['ls-tree', '--name-only', commit]).split('\n').filter((name) => EDITION_PATTERN.test(name.replace(/\/$/, ''))))].sort();
    fail(`commit ${commit.slice(0, 7)} has no ${edition}/desks/<agent>.index for: ${missing.join(', ')}\n`
      + `  Dated corpus directories present at that commit: ${dates.slice(-5).join(', ') || '(none)'}\n`
      + `  The reporters resolve <edition-date> themselves at wake time; a bundle without ${edition}/desks/ ENOENTs every reporter's research pull.`);
  }
  return present;
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
  // Cross-checked against `commit`, not merely shaped: a record naming one
  // commit and a tree holding another is how a reader ends up proving the
  // provenance of research it did not read.
  if (!isCorpusTreePath(value.tree) || !isCorpusCommit(value.commit) || value.tree !== corpusTreePath(value.commit)) findings.push(`tree must be ${CORPUS_TREES_DIR}/<commit>, got ${JSON.stringify(value.tree)}`);
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
// CORPUS.json names a commit, and no reader ever opens that commit by name: the
// reporters cat <root>/<edition>/desks/<agent>.index, and <edition> is a symlink
// into trees/<commit>/<edition>. So a record that validates proves NOTHING about
// the bytes a desk reads. The host moves the dated links before it writes the
// record, so a crashed or partial refresh leaves a volume whose record names
// commit A while every reporter reads commit B; and the volume root is owned by
// the uid the agents run as, so an agent can replace the link itself.
//
// The host refresher's no-op check already resolved the link before it declared
// a corpus current. The container's read side did not, which made the read side
// strictly weaker than the write side -- and that drift is the defect, not the
// missing check. So the predicate lives here, beside the record it completes,
// rather than inside either program: any side that asks whether a dated link is
// bound to a commit calls THIS, never a second copy of it.
//
// Fails closed on every error: an unreadable link, a dangling link, an absent
// tree and a real directory where the link belongs are each "this corpus is not
// bound to the commit it claims", never "probably fine".
export function corpusLinkFindings(root, edition, commit) {
  return answering(`the ${edition} corpus link`, () => linkFindings(root, edition, commit));
}

function linkFindings(root, edition, commit) {
  // Checked first, and by type: `path.join` throws on anything that is not a string,
  // which is the one way a reader has ever been able to make this throw at all.
  if (typeof root !== 'string' || !root) return [`the corpus mount must be a path to resolve a dated link against, got ${JSON.stringify(root)}`];
  if (typeof edition !== 'string' || !EDITION_PATTERN.test(edition)) return [`edition must be YYYY-MM-DD to resolve a corpus link, got ${JSON.stringify(edition)}`];
  if (!isCorpusCommit(commit)) return [`commit must be a 40-character lowercase hex sha to resolve a corpus link, got ${JSON.stringify(commit)}`];
  const link = path.join(root, edition);
  let stat;
  try { stat = lstatSync(link); } catch (error) { return [`${edition} is not on the corpus mount at all (${error.code ?? error.message})`]; }
  if (!stat.isSymbolicLink()) return [`${edition} is a real ${stat.isDirectory() ? 'directory' : 'file'} on the mount, not a symlink into ${corpusTreePath(commit)}/`];
  const resolved = realpathOrNull(link);
  if (resolved === null) return [`${edition} is a dangling symlink, so nothing it names can be read`];
  const tree = realpathOrNull(path.join(root, corpusTreePath(commit)));
  if (tree === null) return [`${corpusTreePath(commit)} is absent from the mount, so the commit the record names holds no tree`];
  if (!resolved.startsWith(`${tree}${path.sep}`)) return [`${edition} resolves to ${resolved}, which is outside ${corpusTreePath(commit)}/`];
  return [];
}
