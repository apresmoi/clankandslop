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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const TREE_PATTERN = /^trees\/[0-9a-f]{40}$/;
// Shape first, then Date.parse: Date.parse alone accepts 'Jan 1 2020' and
// other locale-ish strings, which no reader on the far side should have to
// guess at, and the shape alone accepts 2026-13-45T99:99:99Z.
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const berlinDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The wall clock the newsroom's cron runs on; the reporters resolve their own edition date from it. */
export function berlinToday(now = new Date()) { return berlinDate.format(now); }

export class CorpusError extends Error {}
const fail = (message) => { throw new CorpusError(message); };

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
export function corpusIdentityFindings(value, { edition } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${CORPUS_IDENTITY_FILE} must be a JSON object, got ${Array.isArray(value) ? 'an array' : typeof value}`];
  const findings = [];
  if (value.version !== CORPUS_IDENTITY_VERSION) findings.push(`version must be ${CORPUS_IDENTITY_VERSION}, got ${JSON.stringify(value.version)}`);
  if (typeof value.commit !== 'string' || !COMMIT_PATTERN.test(value.commit)) findings.push(`commit must be a 40-character lowercase hex sha, got ${JSON.stringify(value.commit)}`);
  if (typeof value.ref !== 'string' || !value.ref.trim()) findings.push(`ref must name the branch the corpus was cut from, got ${JSON.stringify(value.ref)}`);
  if (typeof value.edition !== 'string' || !EDITION_PATTERN.test(value.edition)) findings.push(`edition must be YYYY-MM-DD, got ${JSON.stringify(value.edition)}`);
  if (typeof value.fetched_at !== 'string' || !ISO_INSTANT_PATTERN.test(value.fetched_at) || Number.isNaN(Date.parse(value.fetched_at))) findings.push(`fetched_at must be an ISO instant, got ${JSON.stringify(value.fetched_at)}`);
  if (typeof value.tree !== 'string' || !TREE_PATTERN.test(value.tree)) findings.push(`tree must be trees/<40-hex>, got ${JSON.stringify(value.tree)}`);
  // Named with BOTH dates on purpose: "wrong edition" read on a lock screen or
  // in an agent's tool error is useless without which day was mounted and
  // which day was wanted.
  if (edition && value.edition !== edition) findings.push(`corpus is edition ${JSON.stringify(value.edition)}, not ${edition}`);
  return findings;
}
