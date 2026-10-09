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
// between a new day and a new build. What the ledger is COMPARED to is the
// tracked tip, not this checkout's HEAD: see release-git.mjs, which is the half
// of that question this module does not answer.
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
// The git side of a release decision, including the error type that carries the
// alarm reason word. Re-exported, because "the release ledger's ReleaseError" is
// how the rest of the pipeline already knows it.
import { DEFAULT_FETCH_KEY, DEFAULT_TRACK_REF, ReleaseError, classifyFetchFailure, contentOnlyChange, fastForwardToTip, fetchSshCommand, fetchTracked, git, headCommit, trackedRef, trackedTip } from './release-git.mjs';

export { DEFAULT_FETCH_KEY, DEFAULT_TRACK_REF, ReleaseError, classifyFetchFailure, fastForwardToTip, fetchSshCommand, fetchTracked, headCommit, trackedRef, trackedTip };

export const DEFAULT_RELEASE_LEDGER = '/home/clank/deploy-work/released.json';
export const RELEASE_LEDGER_VERSION = 'clank.release.v1';
export const RELEASE_PENDING_VERSION = 'clank.release-pending.v1';
export const RELEASE_LOG_NAME = 'release-log.jsonl';
export const RELEASE_PENDING_NAME = 'release-pending.json';
// A release the wake gate has been deferring for a day is not a quiet system,
// it is a system that has stopped shipping. Below this it is noise; above it, a
// person has to hear it exactly once per pending commit.
export const DEFER_ALARM_AFTER_MS = 24 * 60 * 60 * 1000;

export const releaseLogPath = (ledger) => path.join(path.dirname(ledger), RELEASE_LOG_NAME);
export const releasePendingPath = (ledger) => path.join(path.dirname(ledger), RELEASE_PENDING_NAME);

// The files the `bundle` stage is EXPECTED to rewrite in the working tree
// during a run: the descriptor it measures, and the agent Spawnfiles whose
// source and public-asset pins it advances. Anything else modified under a
// release is a change that is not in the commit being released.
//
// NO PATH IS EXEMPT. There used to be an allowlist for the files the `bundle`
// stage rewrote mid-run (the descriptor and the twelve agent Spawnfiles, limited
// to digest-shaped changes). That stage is gone: `spawnfile build --release`
// builds every bundle from the committed declarations and pins nothing into the
// tree, so ANY tracked modification is a change that is not in the commit being
// released, and is refused.
//
// Untracked files (`??`) are not findings here because `spawnfile build
// --release` refuses them itself: a release build requires every bundle input
// to match HEAD, untracked non-ignored files included.
export function dirtyTreeFindings(repo, { exec = execFileSync } = {}) {
  let raw;
  try { raw = git(repo, ['status', '--porcelain'], exec); }
  catch (error) { throw new ReleaseError(`cannot read the working tree state of ${repo}: ${String(error.message).trim().slice(0, 200)}`, 'seam-blocked'); }
  const findings = [];
  for (const line of raw.split('\n').filter((entry) => entry.trim())) {
    if (line.startsWith('??')) continue;
    for (const file of line.slice(3).split(' -> ')) findings.push(`${file} is modified in the working tree (${line.slice(0, 2).trim()})`);
  }
  return { findings, rewritten: [] };
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
//
// AND THE ESCALATION IS THE ONLY THING STOPPING "FOREVER".
//
// Which makes that one record load-bearing: it holds the instant this commit
// FIRST deferred, and the flag saying the alarm already went out. If it cannot
// be written, or exists and cannot be read, the 24h clock restarts on every run
// and the deferral can repeat indefinitely with nothing ever paging — the one
// mechanism that would have escalated is the thing that failed, and it failed
// quietly. So a broken record is ITSELF an alarm, raised on that run rather than
// deferred into a silence nobody can tell from a healthy quiet system. It still
// does not fail the deployment path; it just never fails silently.
//
// That pages on every run for as long as the record stays broken, and that is
// the deliberate half of the trade: a busy wake window is the normal state for
// twenty hours a day, while a deploy directory this job cannot write is not a
// state the box is ever supposed to be in.
export function deferRelease(options, finding, { now = new Date(), log = console.log, alarm = () => {}, read = readFileSync, write = writeJsonAtomic } = {}) {
  const file = releasePendingPath(options.released);
  const commit = options.releaseCommit;
  // releaseGate is what learns the commit, and it only runs under
  // `--if-changed`. Reaching a deferral without one would mean a deliberate run
  // had quietly become a deferral, which is the one thing this path must not do:
  // a person who asked for a release now has to be told it was refused.
  if (!/^[0-9a-f]{40}$/u.test(commit ?? '')) throw new ReleaseError('a release was deferred without a release commit — only --if-changed defers, and only after the release gate has read HEAD', 'seam-blocked');
  let pending = null, broken = null;
  // ENOENT is the ordinary first deferral of this commit. Anything else — a
  // truncated file, unreadable bytes, a path that is not a file — means the
  // instant this commit started waiting is gone, so the age below is wrong and
  // the escalation it drives cannot be trusted.
  try { pending = JSON.parse(read(file, 'utf8')); }
  catch (error) { if (error?.code !== 'ENOENT') broken = `the pending-release record ${file} cannot be read (${String(error?.message ?? error).trim().slice(0, 160)})`; }
  if (pending?.version !== RELEASE_PENDING_VERSION || pending.commit !== commit)
    pending = { version: RELEASE_PENDING_VERSION, commit, since: now.toISOString(), alarmed_at: null };
  const since = Date.parse(pending.since);
  const ageMs = Number.isFinite(since) ? Math.max(0, now.getTime() - since) : 0;
  const stale = ageMs >= DEFER_ALARM_AFTER_MS;
  const escalating = stale && !pending.alarmed_at;
  if (escalating) pending.alarmed_at = now.toISOString();
  try { write(file, pending); }
  catch (error) { broken = `the pending-release record ${file} could not be written (${String(error?.message ?? error).trim().slice(0, 160)})`; }
  const age = `${Math.floor(ageMs / 3600000)}h${String(Math.floor((ageMs % 3600000) / 60000)).padStart(2, '0')}m`;
  log(`release deferred: ${finding}; retrying on the next timer (commit ${commit.slice(0, 12)} pending ${age})`);
  const raising = escalating || broken !== null;
  if (broken) log(`release: ${broken} — the 24h staleness escalation cannot be relied on, so this deferral is being raised now instead of waited out`);
  if (escalating) log(`release: ${commit.slice(0, 12)} has been waiting ${age} for a quiet window — raising release-deferred once`);
  if (raising) {
    alarm('release-deferred', {
      edition: options.edition,
      message: broken
        ? `release ${commit.slice(0, 12)} deferred and the staleness tracking is broken: ${broken} — the 24h escalation cannot be relied on, so this deferral is raised immediately`
        : `release ${commit.slice(0, 12)} deferred for ${age}: the deploy window has not been quiet`,
      detail: finding
    });
  }
  return { deferred: true, pending, ageMs, alarmed: raising, tracking_broken: broken };
}

// --- the stage ---------------------------------------------------------------
// FIRST, and deliberately the cheapest thing in the pipeline: one fetch, one
// `rev-parse` and one file read. The already-released path must not write a byte,
// must not talk to docker, and must not rewrite a Spawnfile -- on an hourly timer
// it is the path that runs almost every time.
export function releaseGate(options, { log = console.log, read = readFileSync, exec = execFileSync, fetch = fetchTracked, forward = fastForwardToTip } = {}) {
  if (options.fetch !== false) {
    try { fetch(options, { exec, log }); }
    catch (error) {
      // A deferral keys its 24h clock on a commit, and the only one still
      // nameable when the remote is unreachable is the one the build root is
      // sitting on. A rev-parse that fails as well is the louder failure and wins.
      if (error?.unreachable) options.releaseCommit = headCommit(options.repo, { exec });
      throw error;
    }
  }
  const { head, tip } = trackedTip(options, { exec });
  // The commit being released is the TIP, not whatever the build root happens to
  // be on: it is what the ledger will record, and what every stage below will be
  // standing on by the time anything is built.
  options.releaseCommit = tip;
  const ledger = readReleaseLedger(options.released, { read });
  if (ledger && ledger.commit === tip) {
    log(`release: ${trackedRef(options.track).ref} ${tip.slice(0, 12)} already released as ${ledger.tag}; nothing to do`);
    return { head, tip, ledger, upToDate: true };
  }
  // A published edition moves the tip every evening and changes nothing the image
  // is built from: see release-git.mjs's contentOnlyChange. Still the read-only
  // path -- one diff, no write, no docker -- and the build root stays where it is,
  // because nothing here is going to be built from it.
  const since = ledger ? contentOnlyChange(options.repo, ledger.commit, tip, { exec }) : null;
  if (since?.contentOnly) {
    log(`release: ${trackedRef(options.track).ref} ${tip.slice(0, 12)} differs from ${ledger.commit.slice(0, 12)} ${since.changed.length ? `only in ${since.changed.length} published-content path(s) the content volume serves` : 'in no path at all'}, already released as ${ledger.tag}; nothing to do`);
    return { head, tip, ledger, upToDate: true, contentOnly: true };
  }
  // Only once there is something to release: a dirty tree with nothing to ship
  // is somebody working, not a failure, and it must not page. And before the
  // fast-forward, because a tree carrying changes that are in no commit must
  // never be the tree a release is built from, moved or not.
  const { findings, rewritten } = dirtyTreeFindings(options.repo, { exec });
  if (findings.length) throw new ReleaseError(
    `refusing to release a working tree that does not match its commit — ${findings.length} finding(s):\n  ${findings.join('\n  ')}\n`
    + '  A release must be reproducible from a commit. Commit the change, or stash it, and run again.', 'seam-blocked');
  log(ledger
    ? `release: ${trackedRef(options.track).ref} ${tip.slice(0, 12)} differs from the released ${ledger.commit.slice(0, 12)} (${ledger.tag}, ${ledger.at}) — releasing`
    : `release: no release ledger at ${options.released} yet, so nothing is recorded as running — releasing ${tip.slice(0, 12)}`);
  const forwarded = forward(options, { head, tip, rewritten }, { exec, log });
  return { head, tip, ledger, upToDate: false, moved: forwarded.moved };
}
