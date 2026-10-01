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
// host-populated read-only docker volume (`clank-newsroom-corpus`) mounted into
// all twelve agents at the unchanged path ./repos/newsroom-private, and this
// script is the only thing that ever writes it.
//
// THE BOUNDARY IS THE POINT
// -------------------------
// Everything needing a credential or a network happens HERE, on the host, as
// root, outside the agent sandbox: the private fetch, the ref resolution, the
// extraction. Nothing inside the container has either, and nothing inside it
// can write the corpus, because the tree is chowned and frozen before it is
// reachable (see corpus-volume.mjs, which owns every rule about what may touch
// the volume and why -- read it before changing anything here).
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
// RUN IT OFTEN
// ------------
// This is a poll, not one shot at the morning: it is cheap and idempotent, so
// the timer runs it every couple of minutes and the corpus is in place within
// minutes of the producers cutting it. The no-op path (step 3 below) reads one
// JSON file and one symlink and writes NOTHING -- not even a GC -- because it
// is the path that runs ~700 times a day.
//
// USAGE
//   node agentic-org/scripts/corpus-refresh.mjs [options]
//     --edition=YYYY-MM-DD  edition date the next wake will use
//                           (default: today in Europe/Berlin)
//     --ref=<branch>        private branch to extract
//                           (default: edition/<edition>)
//     --volume=<path>       the volume's host data directory
//     --private=<path>      the private corpus checkout to extract from
//     --staging=<path>      where trees are extracted and validated; must be
//                           OUTSIDE the volume and on the same filesystem
//     --trash=<path>        where retired trees are deleted, same constraints
//     --keep=<n>            unreferenced trees to keep for inspection
//     --owner=<uid:gid>     owner for everything written
//     --lock=<path>         the flock(2) path this run serializes on
//     --no-lock             skip locking (tests only)
//     --no-fetch            resolve from refs already in the local checkout
//     --check               verify only; write nothing to the volume, exit
//                           non-zero if a refresh is needed

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { raiseDetached } from './alarm.mjs';
import { CorpusError, EDITION_PATTERN, berlinToday, corpusIdentityFindings, resolveRef, verifyCorpusFreshness, verifyCorpusTree } from './corpus-contract.mjs';
import {
  TREES_DIR, applyOwner, assertSameDevice, assertVolumeRoot, collectGarbage, corpusIdentity,
  datedDirectories, freeze, hostExec, isoSeconds, landFrozenTree, pointAtTree, readIdentity, realpathOrNull, removeTree,
  resolveCorpusLink, SYMLINK_OPS, treeLinkTarget, writeIdentity
} from './corpus-volume.mjs';

export const DEFAULT_VOLUME = '/var/lib/docker/volumes/clank-newsroom-corpus/_data';
export const DEFAULT_PRIVATE = '/root/work/clankandslop/clankandslop-private';
export const DEFAULT_WORK = '/var/lib/clank-corpus';
export const DEFAULT_STAGING = `${DEFAULT_WORK}/staging`;
export const DEFAULT_TRASH = `${DEFAULT_WORK}/trash`;
export const DEFAULT_LOCK = '/run/lock/clank-corpus-refresh.lock';
export const REFRESH_LEDGER = `${DEFAULT_WORK}/refresh.jsonl`;
export const REFRESH_LEDGER_VERSION = 'clank.corpus-refresh.v1';
// The host's `clank` user is 2000:2000, the same uid the agents run as.
export const DEFAULT_OWNER = '2000:2000';
export const DEFAULT_KEEP = 3;

const fail = (message) => { throw new CorpusError(message); };

export function corpusRefreshArgs(argv) {
  const options = {
    edition: null, ref: null, volume: DEFAULT_VOLUME, private: DEFAULT_PRIVATE, staging: DEFAULT_STAGING,
    trash: DEFAULT_TRASH, lock: DEFAULT_LOCK, keep: DEFAULT_KEEP, owner: DEFAULT_OWNER, fetch: true, check: false
  };
  for (const arg of argv) {
    const [key, ...rest] = arg.startsWith('--') ? arg.slice(2).split('=') : [null];
    const value = rest.join('=');
    if (key === 'edition' && value) options.edition = value;
    else if (key === 'ref' && value) options.ref = value;
    else if (key === 'volume' && value) options.volume = path.resolve(value);
    else if (key === 'private' && value) options.private = path.resolve(value);
    else if (key === 'staging' && value) options.staging = path.resolve(value);
    else if (key === 'trash' && value) options.trash = path.resolve(value);
    else if (key === 'lock' && value) options.lock = path.resolve(value);
    else if (key === 'no-lock') options.lock = null;
    else if (key === 'keep' && value) options.keep = Number(value);
    else if (key === 'owner' && value) options.owner = value;
    else if (key === 'no-fetch') options.fetch = false;
    else if (key === 'check') options.check = true;
    else fail(`unrecognized argument: ${arg}`);
  }
  if (options.edition && !EDITION_PATTERN.test(options.edition)) fail(`--edition must be YYYY-MM-DD, got ${options.edition}`);
  if (!Number.isInteger(options.keep) || options.keep < 0) fail(`--keep must be a non-negative integer, got ${options.keep}`);
  if (!/^\d+:\d+$/.test(options.owner)) fail(`--owner must be <uid>:<gid>, got ${options.owner}`);
  return options;
}

// THE NO-OP CHECK. Cheap (one small read plus two lstats), observable (it says
// why a refresh is needed), and it writes nothing at all.
export function corpusCurrent(volume, { commit, edition }) {
  const identity = readIdentity(volume);
  if (!identity) return { current: false, reason: 'CORPUS.json is missing or unparseable', identity: null };
  const findings = corpusIdentityFindings(identity, { edition });
  if (findings.length) return { current: false, reason: `CORPUS.json is invalid: ${findings.join('; ')}`, identity };
  if (identity.commit !== commit) return { current: false, reason: `volume carries ${identity.commit.slice(0, 7)}, want ${commit.slice(0, 7)}`, identity };
  const live = resolveCorpusLink(volume, edition);
  if (!live) return { current: false, reason: `${edition} is absent, dangling, or not a symlink into ${TREES_DIR}/`, identity };
  const tree = realpathOrNull(path.join(volume, TREES_DIR, commit));
  if (!tree) return { current: false, reason: `${TREES_DIR}/${commit.slice(0, 7)} is absent`, identity };
  if (!live.startsWith(tree + path.sep)) return { current: false, reason: `${edition} resolves outside ${TREES_DIR}/${commit.slice(0, 7)}`, identity };
  return { current: true, reason: null, identity };
}

// Validation is the gate between "extracted" and "reachable", so a failure here
// is the one thing in this script that must reach a human: it means the paper
// will be written off yesterday's research, quietly, unless somebody looks.
function validateTree(root, edition) {
  try {
    verifyCorpusTree(root, edition);
    return verifyCorpusFreshness(root, edition);
  } catch (error) {
    error.alarm = true;
    error.edition = edition;
    throw error;
  }
}

// Extracts, validates, chowns and freezes OUTSIDE the volume, then moves the
// finished tree in with one rename. Nothing partial is ever visible to the
// container's startup walk, and nothing unvalidated is ever reachable.
function stage(options, { commit, edition, log, exec }) {
  const treePath = path.join(options.volume, TREES_DIR, commit);
  if (existsSync(treePath)) {
    log(`reusing ${TREES_DIR}/${commit.slice(0, 7)}, already extracted`);
    return { treePath, freshness: validateTree(treePath, edition) };
  }
  const stagingDir = path.join(options.staging, `${commit}-${process.pid}`);
  removeTree(stagingDir, { volume: options.volume, exec });
  mkdirSync(stagingDir, { recursive: true });
  let freshness;
  try {
    const archive = exec('git', ['-C', options.private, 'archive', '--format=tar', commit]);
    exec('tar', ['-x', '-C', stagingDir], { input: archive });
    // tar can exit 0 having written nothing at all -- it did, until hostExec
    // stopped discarding its stdin -- and "extracted" must mean something is
    // there before any of the checks below can mean anything.
    if (readdirSync(stagingDir).length === 0) fail(`extracting ${commit.slice(0, 7)} produced an empty tree in ${stagingDir}`);
    freshness = validateTree(stagingDir, edition);
    applyOwner(stagingDir, options.owner, { volume: options.volume, exec });
    freeze(stagingDir, { volume: options.volume, exec });
  } catch (error) {
    try { removeTree(stagingDir, { volume: options.volume, exec }); } catch (cleanup) { process.stderr.write(`could not remove ${stagingDir}: ${cleanup.message}\n`); }
    throw error;
  }
  // A concurrent writer may have published this commit while we extracted. Its
  // tree is the same content, so prefer it and discard ours.
  if (existsSync(treePath)) removeTree(stagingDir, { volume: options.volume, exec });
  else landFrozenTree(stagingDir, treePath);
  log(`staged ${TREES_DIR}/${commit.slice(0, 7)}, ${freshness.sources} raw capture file(s) covered`);
  return { treePath, freshness };
}

export function appendRefreshLedger(ledger, entry) {
  mkdirSync(path.dirname(ledger), { recursive: true, mode: 0o700 });
  appendFileSync(ledger, `${JSON.stringify(entry)}\n`);
  return entry;
}

export function refresh(argv = [], { now = new Date(), log = console.log, ledger = REFRESH_LEDGER, ops = SYMLINK_OPS, exec = hostExec } = {}) {
  const options = corpusRefreshArgs(argv);
  const edition = options.edition ?? berlinToday(now);
  const ref = options.ref ?? `edition/${edition}`;
  const volume = options.volume;

  // A fetch failure is a refusal, not a warning: a refresher that cannot see
  // origin would report whatever it already has as current, which is
  // yesterday's research under today's date.
  if (options.fetch) {
    try { exec('git', ['-C', options.private, 'fetch', '--prune', '--quiet', 'origin']); }
    catch (error) { fail(`could not fetch the private corpus repo at ${options.private}: ${error.message}`); }
  }
  const { commit } = resolveRef(options.private, ref);
  const previous = readIdentity(volume);
  const previousCommit = typeof previous?.commit === 'string' ? previous.commit : null;

  const state = corpusCurrent(volume, { commit, edition });
  const outcome = { changed: false, current: state.current, edition, ref, commit, previousCommit, linksMoved: 0, treesRemoved: [] };
  if (state.current) {
    log(`corpus already current: ${edition} @ ${commit.slice(0, 7)}`);
    return outcome;
  }
  log(`refresh needed for ${edition} @ ${commit.slice(0, 7)}: ${state.reason}`);
  if (options.check) return { ...outcome, reason: state.reason };

  assertVolumeRoot(volume);
  for (const [label, directory] of [['staging root', options.staging], ['trash root', options.trash]]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertSameDevice(volume, directory, label);
  }
  return swap(options, { commit, edition, ref, now, log, ledger, ops, exec, previousCommit, outcome });
}

function swap(options, { commit, edition, ref, now, log, ledger, ops, exec, previousCommit, outcome }) {
  const volume = options.volume;
  mkdirSync(path.join(volume, TREES_DIR), { recursive: true });
  const { treePath, freshness } = stage(options, { commit, edition, log, exec });

  const dates = datedDirectories(treePath);
  const moved = dates.filter((date) => pointAtTree(volume, date, treeLinkTarget(commit, date), { ops, tmpDir: options.staging }));
  log(`links moved: ${moved.length} of ${dates.length} dated director${dates.length === 1 ? 'y' : 'ies'}${moved.length ? ` (${moved.slice(-5).join(', ')}${moved.length > 5 ? ', ...' : ''})` : ''}`);

  writeIdentity(volume, corpusIdentity({
    commit, ref, edition, fetchedAt: isoSeconds(now), editionsPresent: dates, sourceCount: freshness.sources
  }), { edition, owner: options.owner, tmpDir: options.staging, exec });

  const treesRemoved = collectGarbage(volume, { keep: options.keep, protect: [commit], trash: options.trash, now, exec });
  log(treesRemoved.length ? `removed ${treesRemoved.length} unreferenced tree(s): ${treesRemoved.map((name) => name.slice(0, 7)).join(', ')}` : 'no unreferenced tree to remove');

  appendRefreshLedger(ledger, {
    v: REFRESH_LEDGER_VERSION, at: isoSeconds(now), edition, ref, commit,
    previous_commit: previousCommit, links_moved: moved.length, trees_removed: treesRemoved.length, changed: true
  });
  log(`corpus ${previousCommit ? previousCommit.slice(0, 7) : '(none)'} -> ${commit.slice(0, 7)} for ${edition}`);
  return { ...outcome, changed: true, current: true, linksMoved: moved.length, treesRemoved };
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
    const result = refresh(argv, { log, ...rest });
    return result.changed || result.current ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof CorpusError ? error.message : error.stack}\n`);
    if (error?.alarm) alarm('corpus-refresh-failed', { edition: error.edition, message: `corpus refresh refused: ${error.message.split('\n')[0]}`, detail: error.stack ?? error.message });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
