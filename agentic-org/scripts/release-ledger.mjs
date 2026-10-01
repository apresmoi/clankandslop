// The release ledger: what the seam has already shipped, so a timer can ask
// "is there anything to release?" without building anything to find out.
//
// WHY THIS EXISTS
// ---------------
// The seam used to be a DAILY job because the image carried the day's research
// corpus: a new day meant a new ~5GB image whether or not a single line of code
// or prompt had changed. The corpus now lives in the host-populated
// `clank-newsroom-corpus` volume (see agentic-org/Spawnfile), so an org image is
// day-agnostic and there is nothing about tomorrow that obliges a rebuild.
//
// What is left is a RELEASE job: it should run when the org repo's code or
// prompts change, and do nothing at all otherwise. "Has it changed" is answered
// against this ledger — one JSON file naming the commit that is actually running
// — rather than against a clock, because a clock cannot tell the difference
// between a new day and a new build.
//
// WHY A SEPARATE MODULE
// ---------------------
// seam-run.mjs is already long, and this is the one part of the pipeline a
// SECOND unit has to agree with byte for byte: whatever writes the ledger and
// whatever reads it must share the shape, or the job redeploys an identical
// image forever. Sharing the module is what makes that structural instead of a
// coincidence two copies have to keep.

import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, chownSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_RELEASE_LEDGER = '/home/clank/deploy-work/released.json';
export const RELEASE_LEDGER_VERSION = 'clank.release.v1';
export const RELEASE_PENDING_VERSION = 'clank.release-pending.v1';
export const RELEASE_LOG_NAME = 'release-log.jsonl';
export const RELEASE_PENDING_NAME = 'release-pending.json';
// A release the wake gate has been deferring for a day is not a quiet system,
// it is a system that has stopped shipping. Below this it is noise; above it, a
// person has to hear it exactly once per pending commit.
export const DEFER_ALARM_AFTER_MS = 24 * 60 * 60 * 1000;

// Carries its own reason word so seam-run's alarm vocabulary survives the split
// into two modules. It is NOT a SeamError subclass on purpose: importing one
// from the other would close an import cycle between the pipeline and the one
// piece of it the second unit has to read on its own.
export class ReleaseError extends Error { constructor(message, reason) { super(message); this.reason = reason; } }

export const releaseLogPath = (ledger) => path.join(path.dirname(ledger), RELEASE_LOG_NAME);
export const releasePendingPath = (ledger) => path.join(path.dirname(ledger), RELEASE_PENDING_NAME);

const git = (repo, args, exec) => exec('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

export function headCommit(repo, { exec = execFileSync } = {}) {
  let head;
  try { head = git(repo, ['rev-parse', 'HEAD'], exec).trim(); }
  catch (error) { throw new ReleaseError(`cannot read HEAD in ${repo}: ${String(error.message).trim().slice(0, 200)} — a release has to be identifiable by a commit`, 'seam-blocked'); }
  if (!/^[0-9a-f]{40}$/u.test(head)) throw new ReleaseError(`git -C ${repo} rev-parse HEAD returned ${JSON.stringify(head)}, which is not a commit`, 'seam-blocked');
  return head;
}

// The files the `bundle` stage is EXPECTED to rewrite in the working tree
// during a run: the descriptor it measures, and the agent Spawnfiles whose
// source and public-asset pins it advances. Anything else modified under a
// release is a change that is not in the commit being released.
//
// This is the simpler honest version of "uncommitted changes other than the
// ones bundle rewrites": a declared allowlist matched against
// `git status --porcelain`, not a diff of what bundle would have touched. A
// precise answer would mean predicting the rewrite, and a check that models
// another program's output is a check that drifts away from it.
//
// Untracked files (`??`) are not findings, and that is an argument rather than
// a shortcut: the source archive is built from `git ls-files`, so an untracked
// file cannot enter the image at all. Every tar this build writes is gitignored
// and therefore never appears here either.
export const BUNDLE_REWRITTEN = Object.freeze([
  /^agentic-org\/newsroom-runtime-bundle\.json$/u,
  /^agentic-org\/agents\/[\w.-]+\/Spawnfile$/u
]);

export function dirtyTreeFindings(repo, { exec = execFileSync } = {}) {
  let raw;
  try { raw = git(repo, ['status', '--porcelain'], exec); }
  catch (error) { throw new ReleaseError(`cannot read the working tree state of ${repo}: ${String(error.message).trim().slice(0, 200)}`, 'seam-blocked'); }
  const findings = [];
  for (const line of raw.split('\n').filter((entry) => entry.trim())) {
    if (line.startsWith('??')) continue;
    // A rename carries both sides; both have to be allowed. A path git chose to
    // quote keeps its quotes and therefore matches nothing, which is the right
    // way round: an unusual filename is a refusal, not an exemption.
    for (const file of line.slice(3).split(' -> ')) {
      if (!BUNDLE_REWRITTEN.some((pattern) => pattern.test(file))) findings.push(`${file} is modified in the working tree (${line.slice(0, 2).trim()})`);
    }
  }
  return findings;
}

// A ledger that is MISSING means "nothing has been released from this box yet",
// which is a full run. A ledger that exists and cannot be read means this job
// does not know what is running — and a job that cannot read its own ledger
// must not deploy, because it also cannot write the one the next run depends
// on. Unreadable is a refusal, never an assumed-stale.
export function readReleaseLedger(file, { read = readFileSync } = {}) {
  let raw;
  try { raw = read(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new ReleaseError(`cannot read the release ledger ${file}: ${error.message} — refusing to release against a ledger this job cannot read`, 'seam-blocked');
  }
  let ledger;
  try { ledger = JSON.parse(raw); }
  catch (error) { throw new ReleaseError(`the release ledger ${file} is not parseable JSON (${error.message}) — refusing to assume it is stale, because that assumption deploys`, 'seam-blocked'); }
  if (ledger?.version !== RELEASE_LEDGER_VERSION || !/^[0-9a-f]{40}$/u.test(ledger?.commit ?? ''))
    throw new ReleaseError(`the release ledger ${file} is not a ${RELEASE_LEDGER_VERSION} record naming a commit — refusing to release against a ledger this job cannot read`, 'seam-blocked');
  return ledger;
}

function writeJsonAtomic(file, value, { mode = 0o644 } = {}) {
  const directory = path.dirname(file);
  const { uid, gid } = statSync(existsSync(file) ? file : directory);
  const scratch = `${file}.new-${process.pid}`;
  writeFileSync(scratch, `${JSON.stringify(value, null, 2)}\n`, { mode });
  // The ledger belongs to the deploy user, not to root: the identity that owns
  // the deployment record is the identity that has to be able to read this.
  // Taken from the directory it lives in rather than from a name lookup, so
  // there is one source of truth for "whose directory is this".
  chownSync(scratch, uid, gid);
  chmodSync(scratch, mode);
  renameSync(scratch, file);
}

// Written only after `settle` and `runtimeBootstrap` have both passed, because
// the ledger's claim is "this commit is RUNNING", not "this commit was built".
// A failure here is loud rather than a warning: a ledger that silently did not
// advance makes every later timer run rebuild and redeploy the same commit, and
// the symptom of that is a newsroom that is recreated hourly forever.
export function recordRelease(options, { log = console.log, now = new Date() } = {}) {
  const file = options.released;
  const commit = options.releaseCommit ?? headCommit(options.repo);
  const record = { version: RELEASE_LEDGER_VERSION, commit, tag: options.tag, at: now.toISOString() };
  try {
    writeJsonAtomic(file, record);
    appendFileSync(releaseLogPath(file), `${JSON.stringify({ ...record, edition: options.edition ?? null })}\n`, { mode: 0o644 });
    try { unlinkSync(releasePendingPath(file)); } catch { /* nothing was pending, which is the ordinary case */ }
  } catch (error) {
    throw new ReleaseError(`the deployment succeeded but the release ledger ${file} could not be written: ${error.message}\n`
      + '  Until it can be, every timer run will rebuild and redeploy this same commit.', 'deploy-failed');
  }
  log(`release: recorded ${commit.slice(0, 12)} as ${options.tag} in ${file}`);
  return record;
}

// THE DEFERRAL PATH, and why it does not page.
//
// This job runs on an hourly timer, and `gate` refuses whenever an agent is
// awake or the container is not quiet — which is most of the day. A job that
// paged on every closed window would page ~20 times a day and teach whoever
// carries the pager to ignore it, which is how the 2026-09-23 failure reached
// nobody. So a closed window under `--if-changed` is a log line and exit 0.
//
// It must not be able to hide forever either: the pending commit and the
// instant it FIRST deferred are written beside the ledger, so "nothing has
// shipped since Tuesday" is readable from a file rather than reconstructible
// from the journal, and once it passes a day a person hears it exactly once.
export function deferRelease(options, finding, { now = new Date(), log = console.log, alarm = () => {} } = {}) {
  const file = releasePendingPath(options.released);
  const commit = options.releaseCommit;
  let pending = null;
  try { pending = JSON.parse(readFileSync(file, 'utf8')); } catch { /* first deferral of this commit, or a file this job is about to replace */ }
  if (pending?.version !== RELEASE_PENDING_VERSION || pending.commit !== commit)
    pending = { version: RELEASE_PENDING_VERSION, commit, since: now.toISOString(), alarmed_at: null };
  const since = Date.parse(pending.since);
  const ageMs = Number.isFinite(since) ? Math.max(0, now.getTime() - since) : 0;
  const stale = ageMs >= DEFER_ALARM_AFTER_MS;
  const raising = stale && !pending.alarmed_at;
  if (raising) pending.alarmed_at = now.toISOString();
  try { writeJsonAtomic(file, pending); }
  catch (error) {
    log(`release: could not record the pending release at ${file} (${String(error.message).trim().slice(0, 160)})`
      + ' — until it can be written, the 24h staleness alarm cannot fire');
  }
  const age = `${Math.floor(ageMs / 3600000)}h${String(Math.floor((ageMs % 3600000) / 60000)).padStart(2, '0')}m`;
  log(`release deferred: ${finding}; retrying on the next timer (commit ${commit.slice(0, 12)} pending ${age})`);
  if (raising) {
    log(`release: ${commit.slice(0, 12)} has been waiting ${age} for a quiet window — raising release-deferred once`);
    alarm('release-deferred', {
      edition: options.edition,
      message: `release ${commit.slice(0, 12)} deferred for ${age}: the deploy window has not been quiet`,
      detail: finding
    });
  }
  return { deferred: true, pending, ageMs, alarmed: raising };
}

// --- the stage ---------------------------------------------------------------
// FIRST, and deliberately the cheapest thing in the pipeline: two git reads and
// one file read. The already-released path must not write a byte, must not talk
// to docker, and must not rewrite a Spawnfile — on an hourly timer it is the
// path that runs almost every time.
export function releaseGate(options, { log = console.log, read = readFileSync, exec = execFileSync } = {}) {
  const head = headCommit(options.repo, { exec });
  options.releaseCommit = head;
  const ledger = readReleaseLedger(options.released, { read });
  if (ledger && ledger.commit === head) {
    log(`release: org commit ${head.slice(0, 12)} already released as ${ledger.tag}; nothing to do`);
    return { head, ledger, released: true };
  }
  // Only once there is something to release: a dirty tree with nothing to ship
  // is somebody working, not a failure, and it must not page.
  const findings = dirtyTreeFindings(options.repo, { exec });
  if (findings.length) throw new ReleaseError(
    `refusing to release a working tree that does not match its commit — ${findings.length} finding(s):\n  ${findings.join('\n  ')}\n`
    + '  A release must be reproducible from a commit. Commit the change, or stash it, and run again.', 'seam-blocked');
  log(ledger
    ? `release: org commit ${head.slice(0, 12)} differs from the released ${ledger.commit.slice(0, 12)} (${ledger.tag}, ${ledger.at}) — releasing`
    : `release: no release ledger at ${options.released} yet, so nothing is recorded as running — releasing ${head.slice(0, 12)}`);
  return { head, ledger, released: false };
}
