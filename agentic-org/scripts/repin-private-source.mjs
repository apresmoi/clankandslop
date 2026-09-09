#!/usr/bin/env node
// Repins the private research corpus and rebuilds every checksum that
// references it.
//
// WHY THIS EXISTS
// ---------------
// agentic-org/policies/private-source.json pins the exact commit of
// clankandslop-private that newsroom-private.tar is cut from. Every reporter
// mounts that tar read-only at ./repos/newsroom-private and, on its 10:00
// Berlin wake, reads
//
//     repos/newsroom-private/<edition-date>/desks/<agent>.index
//     repos/newsroom-private/<edition-date>/stories/<id>.md
//
// where <edition-date> is resolved by the agent itself -- nothing templates
// it. The pin was hand-edited, so it went stale and every reporter's research
// pull ENOENTed. This script is the automation that keeps it current.
//
// WHICH REF (this is the whole point -- do not "simplify" it to main)
// ------------------------------------------------------------------
// The producers commit each day's corpus to a branch named `edition/<date>`
// in the private repo. A separate job merges that branch into private `main`
// in the late afternoon -- hours AFTER the reporters wake. So private `main`
// carries YESTERDAY's corpus at 10:00 Berlin, and pinning `main` leaves the
// organization permanently one edition behind. The correct source for a run
// on date D is the tip of `edition/<D>`.
//
// OPERATIONAL WINDOW
// ------------------
// Run repin + rebuild + redeploy between roughly 08:00 and 09:45 Europe/Berlin:
//   * after it   -- the last producer commit that matters has landed on
//                   `edition/<today>` by then (producers run through the
//                   early morning);
//   * before it  -- the reporters wake at 10:00 Berlin (`cron: "0 10 * * *"`,
//                   `timezone: Europe/Berlin`), and a redeploy KILLS any
//                   in-flight wake. Never run this while agents are awake.
// Installing a timer for that window is deliberately NOT this script's job.
//
// WHAT IT OWNS
// ------------
// The private archive and nothing else. It rebuilds only newsroom-private.tar
// (through the same shared writer build-newsroom-bundle.mjs uses, so the two
// are byte-identical), and rewrites only the private pin, the `private` block
// of newsroom-runtime-bundle.json, and the `private-archive` sha256 in every
// agent Spawnfile. The source/dependency/asset digests belong to the full
// build and are never touched here.
//
// USAGE
//   node agentic-org/scripts/repin-private-source.mjs [options]
//     --edition=YYYY-MM-DD  edition date the next wake will use
//                           (default: today in Europe/Berlin)
//     --ref=<branch>        private branch to pin
//                           (default: edition/<edition>; `main` to override)
//     --no-fetch            resolve from refs already in the local checkout
//     --check               verify only; write nothing, exit non-zero if the
//                           working tree is not already correctly repinned
//
// Exits non-zero on any inconsistency: missing branch, missing desk index for
// the target edition, an index row pointing at an absent story file, or a
// stale digest surviving the rewrite.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPrivateArchive, privateRoot } from './private-archive.mjs';

export const REPORTERS = ['cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton', 'vesta'];
const EDITION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const STORY_ID_PATTERN = /^s-[0-9a-f]{8}$/;
const CORPUS_PREP_VERSION = 'clank.research-corpus.prepared.v1';
const berlinDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });

export class RepinError extends Error {}
const fail = (message) => { throw new RepinError(message); };

export function berlinToday(now = new Date()) { return berlinDate.format(now); }

export function parseArgs(argv) {
  const options = { edition: null, ref: null, fetch: true, check: false };
  for (const arg of argv) {
    const [key, value] = arg.startsWith('--') ? arg.slice(2).split('=') : [null, null];
    if (key === 'edition' && value) options.edition = value;
    else if (key === 'ref' && value) options.ref = value;
    else if (key === 'no-fetch') options.fetch = false;
    else if (key === 'check') options.check = true;
    else fail(`unrecognized argument: ${arg}`);
  }
  if (options.edition && !EDITION_PATTERN.test(options.edition)) fail(`--edition must be YYYY-MM-DD, got ${options.edition}`);
  return options;
}

// stderr is captured rather than inherited so a probe that is *expected* to
// miss (rev-parse on a ref that does not exist yet) does not print raw git
// noise ahead of this script's own, far more actionable, message.
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 1024 * 1024 * 256, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

// Resolves `ref` to a commit WITHOUT ever falling back to another ref: a
// missing edition branch means the producer has not cut today's corpus yet,
// and silently pinning main in that case is exactly the failure this script
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
// costs nothing next to a 60MB archive build.
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

// The proof that matters: read the paths back out of the archive that will
// actually be mounted, not out of git. Returns per-reporter index stats and
// the resolved story files.
export function verifyArchive(root, edition) {
  const report = [];
  for (const agent of REPORTERS) {
    const indexPath = path.join(root, edition, 'desks', `${agent}.index`);
    let text;
    try { text = readFileSync(indexPath, 'utf8'); } catch { return fail(`extracted archive is missing ${edition}/desks/${agent}.index`); }
    const rows = text.split('\n').filter((line) => line.trim() && !line.startsWith('#'));
    const stories = rows.map((line) => line.trim().split(/\s+/)[0]);
    const unparsable = stories.filter((id) => !STORY_ID_PATTERN.test(id));
    if (unparsable.length) fail(`${edition}/desks/${agent}.index has row(s) whose first field is not a story id: ${unparsable.join(', ')}`);
    const missing = stories.filter((id) => !existsSync(path.join(root, edition, 'stories', `${id}.md`)));
    if (missing.length) fail(`DEFECT: ${edition}/desks/${agent}.index references story files that are absent from the archive: ${missing.map((id) => `${edition}/stories/${id}.md`).join(', ')}`);
    report.push({ agent, bytes: Buffer.byteLength(text), rows: rows.length, stories });
  }
  return report;
}

const digestText = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

export function verifyCorpusFreshness(root, edition) {
  const metadataPath = path.join(root, edition, 'desks', '_corpus.prepared.json');
  let metadata;
  try { metadata = JSON.parse(readFileSync(metadataPath, 'utf8')); } catch { fail(`extracted archive is missing parseable ${edition}/desks/_corpus.prepared.json`); }
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
  if (extra.length) fail(`${edition}/desks/_corpus.prepared.json declares source(s) absent from the archive: ${extra.join(', ')}`);
  return { sources: rawSources.length };
}

export function run(argv = [], { orgRoot = path.resolve(import.meta.dirname, '..'), now = new Date(), log = console.log } = {}) {
  const options = parseArgs(argv);
  const repo = path.resolve(orgRoot, '..');
  const privateRepoPath = path.join(repo, privateRoot.slice(0, -1));
  const edition = options.edition ?? berlinToday(now);
  const ref = options.ref ?? `edition/${edition}`;

  if (options.fetch) {
    try { git(privateRepoPath, ['fetch', '--prune', '--quiet', 'origin']); } catch (error) { fail(`could not fetch the private repo at ${privateRepoPath}: ${error.message}`); }
  }
  const resolved = resolveRef(privateRepoPath, ref);
  log(`edition ${edition} | ref ${ref} -> ${resolved.ref} | commit ${resolved.commit}`);
  assertEditionInTree(privateRepoPath, resolved.commit, edition);

  const pinPath = path.join(orgRoot, 'policies/private-source.json');
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  const previousCommit = pin.commit;
  const nextPin = `${JSON.stringify({ ...pin, commit: resolved.commit, ref, edition }, null, 2)}\n`;

  const archivePath = path.join(orgRoot, 'newsroom-private.tar');
  const archiveTmpDir = mkdtempSync(path.join(tmpdir(), 'clank-repin-archive-'));
  const archiveTmp = path.join(archiveTmpDir, 'newsroom-private.tar');
  let archive, report, freshness;
  try {
    archive = buildPrivateArchive({ privateRepoPath, commit: resolved.commit, output: archiveTmp });
    if (!DIGEST_PATTERN.test(archive.digest)) fail(`rebuilt archive produced a malformed digest: ${archive.digest}`);

    const extractDir = mkdtempSync(path.join(tmpdir(), 'clank-repin-verify-'));
    try {
      execFileSync('tar', ['-x', '-f', archiveTmp, '-C', extractDir], { maxBuffer: 1024 * 1024 * 1024 });
      report = verifyArchive(extractDir, edition);
      freshness = verifyCorpusFreshness(extractDir, edition);
    } finally { rmSync(extractDir, { recursive: true, force: true }); }
  } catch (error) {
    rmSync(archiveTmpDir, { recursive: true, force: true });
    throw error;
  }

  const bundlePath = path.join(orgRoot, 'newsroom-runtime-bundle.json');
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  const previousDigest = bundle.private.sha256;
  bundle.private = { ...bundle.private, sha256: archive.digest, file_count: archive.count, content_bytes: archive.total, commit: resolved.commit };
  const writes = [[bundlePath, `${JSON.stringify(bundle, null, 2)}\n`], [pinPath, nextPin]];

  const agentsRoot = path.join(orgRoot, 'agents');
  const spawnfiles = readdirSync(agentsRoot).sort().map((name) => path.join(agentsRoot, name, 'Spawnfile')).filter((file) => existsSync(file) && readFileSync(file, 'utf8').includes('id: private-archive'));
  if (!spawnfiles.length) fail(`no agent Spawnfile declares the private-archive resource under ${agentsRoot}`);
  for (const file of spawnfiles) {
    const source = readFileSync(file, 'utf8');
    let hits = 0;
    const next = source.replace(/^(\s*- \{ id: private-archive,.*?sha256: )sha256:[a-f0-9]{64}(.*)$/gmu, (...groups) => { hits += 1; return `${groups[1]}${archive.digest}${groups[2]}`; });
    if (hits !== 1) fail(`expected exactly one checksum-pinned private-archive resource line in ${file}, matched ${hits}`);
    writes.push([file, next]);
  }

  const changed = writes.filter(([file, next]) => readFileSync(file, 'utf8') !== next).map(([file]) => path.relative(orgRoot, file));
  if (options.check) {
    if (changed.length) fail(`--check: ${changed.length} file(s) are not repinned for edition ${edition}: ${changed.join(', ')}`);
  } else {
    renameSync(archiveTmp, archivePath);
    for (const [file, next] of writes) writeFileSync(file, next);
  }
  rmSync(archiveTmpDir, { recursive: true, force: true });

  // A stale digest surviving anywhere under agentic-org means a rewrite missed
  // a reference, which would deploy an archive some agent cannot verify.
  if (previousDigest !== archive.digest && !options.check) {
    const stale = [];
    const visit = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink() || file.endsWith('.tar')) continue;
        if (entry.isDirectory()) visit(file);
        else if (readFileSync(file, 'utf8').includes(previousDigest)) stale.push(path.relative(orgRoot, file));
      }
    };
    visit(orgRoot);
    if (stale.length) fail(`the previous private-archive digest ${previousDigest} still appears in: ${stale.join(', ')}`);
  }

  log(`pin ${previousCommit.slice(0, 7)} -> ${resolved.commit.slice(0, 7)}`);
  log(`private-archive ${previousDigest} -> ${archive.digest}`);
  log(`archive ${archive.count} files, ${archive.total} bytes; ${spawnfiles.length} Spawnfile(s) pin it`);
  for (const entry of report) log(`  ${edition}/desks/${entry.agent}.index  ${entry.bytes} bytes  ${entry.rows} row(s) -> ${entry.stories.join(', ') || '(none)'}`);
  log(`freshness: ${freshness.sources} raw capture file(s) covered by ${edition}/desks/_corpus.prepared.json`);
  log(changed.length ? `updated: ${changed.join(', ')}` : 'already current: no file changed');
  return { edition, ref, commit: resolved.commit, previousCommit, digest: archive.digest, previousDigest, changed, report, spawnfiles: spawnfiles.length };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try { run(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${error instanceof RepinError ? error.message : error.stack}\n`);
    process.exit(1);
  }
}
