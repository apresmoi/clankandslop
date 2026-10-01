#!/usr/bin/env node
// Puts the day's research corpus in front of the reporters, from the HOST,
// without building an image.
//
// WHAT IT REPLACES
// ----------------
// The corpus used to be newsroom-private.tar: a checksum-pinned bundle baked
// into the org image and repinned every morning by repin-private-source.mjs.
// That made one day's research a property of a ~5GB image, so every edition
// needed a full rebuild and redeploy before the 10:00 Berlin wake -- and a
// rebuild can be lost to a disk floor, a compile error or a health probe that
// times out. It was, twice in one week, and each time the newsroom lost the
// edition.
//
// The corpus is DATA with a daily cadence; the code is not. Binding them to one
// digest made the slow thing hostage to the fast one. The corpus is now a
// host-populated docker volume (`clank-newsroom-corpus`) mounted into all twelve
// agents at the unchanged path ./repos/newsroom-private, and this script is the
// only thing that is SUPPOSED to write it.
//
// THE BOUNDARY IS THE POINT
// -------------------------
// Everything needing a credential or a network happens HERE, on the host, as
// root, outside the agent sandbox: the private fetch, the ref resolution, the
// extraction. Nothing inside the container has either.
//
// THE VOLUME IS NOT TRUSTED
// -------------------------
// It cannot be. The mount is `mode: mutable` (verified on the box: `readonly`
// kills every container), the compiler chowns the whole volume to uid 2000 on
// every start, and the ownership guard then demands a uid-owned 0755 volume
// root. uid 2000 therefore OWNS the volume root: an agent can create, unlink and
// replace CORPUS.json, any `<date>` symlink, and `trees/` itself. All three were
// done in the live production container. Content inside an already-frozen 0555
// tree is safe; names at the root are not.
//
// So this script keeps its own record OUTSIDE the volume
// (/var/lib/clank-corpus/landed.json, root-owned 0600, see corpus-landed.mjs)
// and every decision -- is the corpus current, which trees are live, what may be
// deleted -- comes from that record. CORPUS.json is an OUTPUT for the container
// to read, never an input. Every path operation is lstat'd first, because a
// root-run rmSync aimed through an agent-planted symlink is a root-privileged
// delete an agent chose the target of. And because the mount stays writable, the
// corpus is RE-VERIFIED against the host's land-time manifest and against git on
// every poll (corpus-verify.mjs): drift alarms and re-lands itself. The bundle
// this replaced was never verified after extraction at all.
//
// HOW A SWAP IS SAFE WHILE AGENTS ARE READING
// -------------------------------------------
// Content is immutable and addressed by commit; a refresh extracts OUTSIDE the
// volume, validates, freezes, and then moves things in and out with single
// rename(2) calls:
//
//     <staging>/<commit>-<pid>   --rename-->  <volume>/trees/<commit>
//     <volume>/<date>            --rename-->  points at trees/<commit>/<date>
//     <volume>/trees/<old>       --rename-->  <trash>/<old>-<stamp>, deleted there
//
// An unvalidated corpus never becomes reachable: validation runs on the staging
// tree, outside the volume, and a failure removes it, raises the alarm and
// leaves yesterday's corpus exactly as it was. Stale research under today's
// date is a bad edition; a desk index pointing at a story file that does not
// exist is no edition at all.
//
// ONCE AN EDITION IS COMMISSIONED, ITS CORPUS IS FROZEN
// ----------------------------------------------------
// Brass binds a corpus commit into every assignment receipt. Moving that date's
// link afterwards makes the receipt cite research nobody read, and lets one
// reporter resolve a desk index from one commit and a story file from another.
// So a date with assignment records does not follow the branch: the new tree
// still lands, other dates still move, and the run is a SUCCESS that says the
// edition is frozen.
//
// RUN IT OFTEN
// ------------
// This is a poll, not one shot at the morning: it is cheap and idempotent, so
// the timer runs it every couple of minutes and the corpus is in place within
// minutes of the producers cutting it. The no-op path reads one small JSON file
// outside the volume and then lstats the landed tree; it writes NOTHING.
//
// USAGE
//   node agentic-org/scripts/corpus-refresh.mjs [options]
//     --edition=YYYY-MM-DD  edition date the next wake will use
//                           (default: today in Europe/Berlin)
//     --ref=<branch>        private branch to extract
//                           (default: edition/<edition>)
//     --volume=<path>       the volume's host data directory
//     --private=<path>      the private corpus checkout to extract from
//     --landed=<path>       the host's authoritative record of what it landed;
//                           root-owned 0600, NEVER inside the volume
//     --edition-state=<path> host-visible root of the edition-state volume,
//                           read to see which editions are commissioned
//     --staging=<path>      where trees are extracted and validated; must be
//                           OUTSIDE the volume and on the same filesystem
//     --trash=<path>        where retired trees are deleted, same constraints
//     --keep=<n>            unreferenced trees to keep for inspection
//     --owner=<uid:gid>     owner for everything written
//     --require-by=HH:MM    Europe/Berlin time by which edition/<today> must
//                           exist; before it, a missing branch is a logged wait
//     --lock=<path>         the flock(2) path this run serializes on
//     --no-lock             skip locking (tests only)
//     --no-fetch            resolve from refs already in the local checkout
//     --no-verify           skip the tamper sweep (tests only)
//     --check               verify only; write nothing, exit non-zero if a
//                           refresh is needed

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { raiseDetached } from './alarm.mjs';
import { CORPUS_IDENTITY_FILE, CorpusError, EDITION_PATTERN, berlinToday, resolveRef } from './corpus-contract.mjs';
import { buildManifest, corpusLanded, emptyLanded, readLanded, sha256, writeLanded, writeManifest } from './corpus-landed.mjs';
import { swap } from './corpus-swap.mjs';
import { integritySweep, tamperReason } from './corpus-verify.mjs';
import { assertSameDevice, assertVolumeRoot, hostExec, pointAtTree, SYMLINK_OPS, writeIdentity } from './corpus-volume.mjs';

export const DEFAULT_VOLUME = '/var/lib/docker/volumes/clank-newsroom-corpus/_data';
export const DEFAULT_PRIVATE = '/root/work/clankandslop/clankandslop-private';
export const DEFAULT_WORK = '/var/lib/clank-corpus';
export const DEFAULT_STAGING = `${DEFAULT_WORK}/staging`;
export const DEFAULT_TRASH = `${DEFAULT_WORK}/trash`;
// OUTSIDE the volume and outside every container's view of the filesystem. This
// path is the whole of FIX 1: the host's truth cannot live where twelve agents
// can rewrite it.
export const DEFAULT_LANDED = `${DEFAULT_WORK}/landed.json`;
// The edition-state volume as the HOST sees it. Read-only, and its absence means
// "nothing commissioned" rather than an error, so a fresh box still refreshes.
export const DEFAULT_EDITION_STATE = '/var/lib/docker/volumes/clank-edition-state/_data';
export const DEFAULT_LOCK = '/run/lock/clank-corpus-refresh.lock';
export const REFRESH_LEDGER = `${DEFAULT_WORK}/refresh.jsonl`;
// The host's `clank` user is 2000:2000, the same uid the agents run as.
export const DEFAULT_OWNER = '2000:2000';
export const DEFAULT_KEEP = 3;
// The producers push edition/<today> at roughly 00:50 Berlin. Before this hour a
// missing branch is a wait, after it a failure.
export const DEFAULT_REQUIRE_BY = '09:00';

const fail = (message) => { throw new CorpusError(message); };

const berlinClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** Wall-clock HH:MM in Europe/Berlin; zero-padded, so a plain string compare orders it. */
export const berlinHourMinute = (now = new Date()) => berlinClock.format(now);

export function corpusRefreshArgs(argv) {
  const options = {
    edition: null, ref: null, volume: DEFAULT_VOLUME, private: DEFAULT_PRIVATE, landed: DEFAULT_LANDED,
    editionState: DEFAULT_EDITION_STATE, staging: DEFAULT_STAGING, trash: DEFAULT_TRASH, lock: DEFAULT_LOCK,
    keep: DEFAULT_KEEP, owner: DEFAULT_OWNER, requireBy: DEFAULT_REQUIRE_BY, fetch: true, verify: true, check: false
  };
  for (const arg of argv) {
    const [key, ...rest] = arg.startsWith('--') ? arg.slice(2).split('=') : [null];
    const value = rest.join('=');
    if (key === 'edition' && value) options.edition = value;
    else if (key === 'ref' && value) options.ref = value;
    else if (key === 'volume' && value) options.volume = path.resolve(value);
    else if (key === 'private' && value) options.private = path.resolve(value);
    else if (key === 'landed' && value) options.landed = path.resolve(value);
    else if (key === 'edition-state' && value) options.editionState = path.resolve(value);
    else if (key === 'staging' && value) options.staging = path.resolve(value);
    else if (key === 'trash' && value) options.trash = path.resolve(value);
    else if (key === 'lock' && value) options.lock = path.resolve(value);
    else if (key === 'no-lock') options.lock = null;
    else if (key === 'keep' && value) options.keep = Number(value);
    else if (key === 'owner' && value) options.owner = value;
    else if (key === 'require-by' && value) options.requireBy = value;
    else if (key === 'no-fetch') options.fetch = false;
    else if (key === 'no-verify') options.verify = false;
    else if (key === 'check') options.check = true;
    else fail(`unrecognized argument: ${arg}`);
  }
  if (options.edition && !EDITION_PATTERN.test(options.edition)) fail(`--edition must be YYYY-MM-DD, got ${options.edition}`);
  if (!Number.isInteger(options.keep) || options.keep < 0) fail(`--keep must be a non-negative integer, got ${options.keep}`);
  if (!/^\d+:\d+$/.test(options.owner)) fail(`--owner must be <uid>:<gid>, got ${options.owner}`);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(options.requireBy)) fail(`--require-by must be HH:MM in 24-hour Europe/Berlin time, got ${options.requireBy}`);
  // The record must never be reachable from inside the volume, whatever anyone
  // passes: a landed.json an agent can rewrite is the defect this file exists to
  // close, and it would be a silent one.
  if (!path.relative(options.volume, options.landed).startsWith('..')) fail(`--landed ${options.landed} is inside the corpus volume ${options.volume}.\n`
    + '  The volume root is owned by uid 2000 and writable by all twelve agents, so a record kept there is an agent-writable input to a root-privileged job.');
  return options;
}

// WAITING IS NOT BROKEN
// ---------------------
// Between Berlin midnight and the producers' first push the branch does not
// exist. At a two-minute cadence that was ~25 non-zero exits a night, each one
// firing the unit's OnFailure= alarm, which is how a pager gets ignored. Before
// the deadline a missing edition/<today> is a WAIT: said out loud, exit 0,
// nothing written. After it, the refusal is exactly what it always was.
//
// Only for TODAY and only for the default ref: an explicitly named --ref, or a
// past date, is a deliberate request that must still refuse.
function resolveEditionRef(options, { edition, ref, now, log }) {
  try { return { ...resolveRef(options.private, ref), waiting: false }; }
  catch (error) {
    const clock = berlinHourMinute(now);
    if (options.ref || edition !== berlinToday(now) || clock >= options.requireBy) throw error;
    log(`waiting for ${ref}: the producers have not cut today's corpus yet. It is ${clock} Europe/Berlin and the branch is due by ${options.requireBy}; nothing is broken and nothing was changed.`);
    return { waiting: true, clock, commit: null };
  }
}

const prepareWorkRoots = (options) => {
  assertVolumeRoot(options.volume);
  for (const [label, directory] of [['staging root', options.staging], ['trash root', options.trash]]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertSameDevice(options.volume, directory, label);
  }
};

// The whole sequence. The one-writer lock is NOT taken here: `main` holds it for
// the entire run (see relayUnderLock), so every caller that reaches this point
// already has it, or deliberately runs without one.
export function refresh(argv = [], { now = new Date(), log = console.log, alarm = raiseDetached, ledger = REFRESH_LEDGER, ops = SYMLINK_OPS, exec = hostExec } = {}) {
  const options = corpusRefreshArgs(argv);
  const edition = options.edition ?? berlinToday(now);
  const ref = options.ref ?? `edition/${edition}`;

  // A fetch failure is a refusal, not a warning: a refresher that cannot see
  // origin would report whatever it already has as current, which is
  // yesterday's research under today's date.
  if (options.fetch) {
    try { exec('git', ['-C', options.private, 'fetch', '--prune', '--quiet', 'origin']); }
    catch (error) { fail(`could not fetch the private corpus repo at ${options.private}: ${error.message}`); }
  }
  const resolved = resolveEditionRef(options, { edition, ref, now, log });
  if (resolved.waiting) return { changed: false, current: false, waiting: true, edition, ref, commit: null, previousCommit: null, linksMoved: 0, treesRemoved: [], frozen: false, findings: [] };
  const commit = resolved.commit;

  // The host's record, and nothing from the volume. An unreadable one degrades
  // to "nothing landed" -- loudly -- because a corpus that must be re-landed is
  // recoverable and a refresher that refuses to run is not.
  const { record, reason: recordReason } = readLanded(options.landed);
  if (recordReason) log(`ignoring the host record: ${recordReason} -- treating this volume as carrying nothing`);
  const landed = record ?? emptyLanded();
  const previousCommit = landed.editions[edition]?.commit ?? null;

  const state = corpusLanded(landed, { commit, edition });
  const outcome = { changed: false, current: state.current, waiting: false, edition, ref, commit, previousCommit, linksMoved: 0, treesRemoved: [], frozen: Boolean(state.frozen), findings: [] };
  if (state.current) {
    log(state.frozen
      ? `corpus already current: ${edition} is frozen at ${state.entry.commit.slice(0, 7)} and ${commit.slice(0, 7)} is landed`
      : `corpus already current: ${edition} @ ${commit.slice(0, 7)}`);
    if (!options.verify) return outcome;
    return sweepAndHeal(options, { commit, edition, ref, now, log, alarm, ledger, ops, exec, landed, outcome });
  }
  log(`refresh needed for ${edition} @ ${commit.slice(0, 7)}: ${state.reason}`);
  if (options.check) return { ...outcome, reason: state.reason };

  prepareWorkRoots(options);
  return swap(options, { commit, edition, ref, now, log, alarm, ledger, ops, exec, landed, previousCommit, outcome });
}

// FIX 4's hot path: the run that would otherwise return early blind. Everything
// it compares comes from outside the volume, and everything it finds is said out
// loud. A repairable finding is repaired from git and the record; an unexpected
// NAME is reported and left exactly where it is, because deleting it would
// destroy the only evidence of who else is writing the mount.
function sweepAndHeal(options, { commit, edition, ref, now, log, alarm, ledger, ops, exec, landed, outcome }) {
  const sweep = integritySweep({ volume: options.volume, landed, landedFile: options.landed, edition, privateRepo: options.private, exec });
  if (!sweep.findings.length) return outcome;
  for (const finding of sweep.findings) log(`TAMPER: ${finding}`);
  const digest = sha256(sweep.findings.join('\n'));
  // Unexpected names persist by design (they are never deleted), so paging about
  // the same set every two minutes would teach whoever carries the pager to
  // ignore the word. Anything repairable alarms every time, because it is new.
  if (sweep.tampered || landed.noted !== digest) {
    alarm(tamperReason(), { edition, message: `corpus volume tampered: ${sweep.findings[0]}`, detail: sweep.findings.join('\n') });
  }
  const result = { ...outcome, findings: sweep.findings, tampered: sweep.tampered };
  if (options.check) return { ...result, current: !sweep.tampered };
  prepareWorkRoots(options);
  if (sweep.drift) {
    log(`re-landing ${sweep.drift.tree.slice(0, 13)} from git so the newsroom heals itself`);
    return { ...swap(options, { commit: sweep.drift.commit, edition, ref, now, log, alarm, ledger, ops, exec, landed, previousCommit: outcome.previousCommit, outcome: result, force: true }), findings: sweep.findings, tampered: true };
  }
  let next = landed;
  if (sweep.links.length || sweep.identity) {
    for (const link of sweep.links) {
      log(`restoring ${link.date} -> ${link.want}`);
      pointAtTree(options.volume, link.date, link.want, { ops, tmpDir: options.staging });
    }
    if (sweep.identity) {
      log(`republishing ${CORPUS_IDENTITY_FILE}`);
      writeIdentity(options.volume, landed.identity.record, { edition: landed.identity.record.edition, owner: options.owner, tmpDir: options.staging, exec });
    }
  }
  // A moved mtime over identical bytes is still a write to the mount: said once,
  // then re-stamped, or it would be said again every two minutes forever.
  if (sweep.touched.length) writeManifest(options.landed, buildManifest(path.join(options.volume, landed.editions[edition].tree), landed.editions[edition].commit));
  next = writeLanded(options.landed, { ...landed, noted: digest });
  // One bounded re-check: a repair that did not take must not be reported as a
  // heal, and must not quietly become next poll's "already current".
  const after = integritySweep({ volume: options.volume, landed: next, landedFile: options.landed, edition, privateRepo: options.private, exec });
  if (after.tampered) {
    const error = new CorpusError(`the corpus volume is still tampered after repair: ${after.findings.join('; ')}`);
    error.alarm = true;
    error.edition = edition;
    throw error;
  }
  return { ...result, current: true, changed: Boolean(sweep.links.length || sweep.identity) };
}



// ONE WRITER AT A TIME, AND IT HAS TO BE flock(2)
// ----------------------------------------------
// The refresher runs every couple of minutes; the epoch roll and the release
// job already serialize against it with `/usr/bin/flock
// /run/lock/clank-corpus-refresh.lock ...` in their units. Two refreshers
// racing would be survivable -- content is addressed by commit -- but a
// refresher racing a container recreate is a container reading the volume while
// its entries move, and the startup guard aborts on exactly that.
//
// So the lock has to be the SAME lock those units take, which is a real
// flock(2) on that path. Node cannot take one without a native addon, and a
// pidfile on the same path would be invisible to them and they to it -- mutual
// exclusion that only one side observes is worse than none, because it reads as
// protection. The whole run therefore re-executes under flock(1), once, marked
// by an environment variable so the child does not do it again.
export const LOCK_BUSY_EXIT = 69;
export const LOCK_ENV = 'CLANK_CORPUS_LOCK_HELD';

export function relayUnderLock(options, argv, { env, spawn, script, log }) {
  const relay = spawn('flock', ['-n', '-E', String(LOCK_BUSY_EXIT), options.lock, process.execPath, script, ...argv], {
    stdio: 'inherit', env: { ...env, [LOCK_ENV]: options.lock }
  });
  // A missing or broken flock(1) is a refusal: running unlocked would be a
  // refresh that can interleave with a container recreate, which is the one
  // failure this lock exists to prevent.
  if (relay.error) fail(`could not take the corpus lock ${options.lock} with flock(1): ${relay.error.message}`);
  if (relay.status === LOCK_BUSY_EXIT) { log(`another corpus writer holds ${options.lock}; nothing to do`); return 0; }
  if (relay.signal) fail(`the locked corpus refresh was killed by ${relay.signal}`);
  return relay.status ?? 1;
}

export function main(argv = [], { log = console.log, alarm = raiseDetached, env = process.env, spawn = spawnSync, script = import.meta.filename, ...rest } = {}) {
  try {
    const options = corpusRefreshArgs(argv);
    // `--check` writes nothing, so it never waits on the lock -- and reporting
    // "nothing to do" for a busy lock would hide that a refresh IS needed.
    if (options.lock && !options.check && env[LOCK_ENV] !== options.lock) return relayUnderLock(options, argv, { env, spawn, script, log });
    const result = refresh(argv, { log, alarm, ...rest });
    // A wait is a success: the producers have not pushed yet, nothing is wrong,
    // and a non-zero exit here is ~25 OnFailure alarms a night.
    return result.waiting || result.changed || result.current ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof CorpusError ? error.message : error.stack}\n`);
    if (error?.alarm) alarm('corpus-refresh-failed', { edition: error.edition, message: `corpus refresh refused: ${error.message.split('\n')[0]}`, detail: error.stack ?? error.message });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
