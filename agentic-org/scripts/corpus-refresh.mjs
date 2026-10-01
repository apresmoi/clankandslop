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
// ONCE A DATE IS SETTLED, ITS CORPUS IS FROZEN -- ON THE HOST'S OWN CLOCK
// ----------------------------------------------------------------------
// Brass binds a corpus commit into every assignment receipt. Moving that date's
// link afterwards makes the receipt cite research nobody read, and lets one
// reporter resolve a desk index from one commit and a story file from another.
// So a date this host has landed stops following the branch once that date's
// `--require-by` cutoff has passed: the new tree still lands, other dates still
// move, and the run is a SUCCESS that says the edition is frozen.
//
// The gate is deliberately NOT "has the newsroom commissioned this edition". That
// question can only be answered by counting assignment records inside the
// edition-state docker volume, which the twelve agents can write AND delete -- so
// one planted file could freeze a date nobody commissioned and one `rm` could thaw
// a date the reporters were drafting against. Both were reproduced. The cutoff is
// a question the host answers from its own record and its own clock, and it is
// wrong in the safe direction: a spurious freeze keeps an edition on the corpus it
// already had, while a spurious thaw moves research under reporters mid-draft.
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
// Every flag, what it defaults to and why: corpus-refresh-options.mjs.

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { raiseDetached } from './alarm.mjs';
import { CORPUS_IDENTITY_FILE, CorpusError, berlinToday, resolveRef } from './corpus-contract.mjs';
import {
  berlinHourMinute, buildManifest, bumpHeal, corpusLanded, emptyLanded,
  readLanded, sha256, writeLanded, writeManifest
} from './corpus-landed.mjs';
import { LOCK_ENV, relayUnderLock } from './corpus-refresh-lock.mjs';
import { corpusRefreshArgs, REFRESH_LEDGER } from './corpus-refresh-options.mjs';
import { swap } from './corpus-swap.mjs';
import { REFUSAL_REASON, TAMPER_REASON, integritySweep } from './corpus-verify.mjs';
import { assertSameDevice, assertVolumeRoot, hostExec, isoSeconds, pointAtTree, SYMLINK_OPS, writeIdentity } from './corpus-volume.mjs';

// Every flag, every production default and every refusal behind them are in
// corpus-refresh-options.mjs. Re-exported here, so nothing that imports them from
// this module had to change.
export {
  DEFAULT_KEEP, DEFAULT_LANDED, DEFAULT_LOCK, DEFAULT_OWNER, DEFAULT_PRIVATE, DEFAULT_REQUIRE_BY,
  DEFAULT_STAGING, DEFAULT_TRASH, DEFAULT_VOLUME, DEFAULT_WORK, REFRESH_LEDGER, corpusRefreshArgs
} from './corpus-refresh-options.mjs';

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
  const sweep = integritySweep({ volume: options.volume, landed, landedFile: options.landed, edition, privateRepo: options.private, exec, unknownMib: options.unknownMib });
  if (!sweep.findings.length) return acknowledgeClean(options, { landed, outcome });
  for (const finding of sweep.findings) log(`TAMPER: ${finding}`);
  const digest = sha256(sweep.findings.join('\n'));

  // AUTO-REPAIR IS BOUNDED, BECAUSE IT CAN BE DRIVEN
  // ------------------------------------------------
  // An agent can `chmod u+w` a directory it owns inside the frozen tree, dirty one
  // file, and make the next poll re-extract ~4660 files through `git archive`.
  // Repeated every two minutes that is a CPU and IO drain on the production host,
  // self-inflicted by this loop. Healing a one-off is right; absorbing a driven
  // loop silently is not, so the host counts the cycles per tree in its own record
  // and stands down after `--heal-limit` of them.
  const tree = sweep.drift?.tree ?? null;
  const healed = tree ? landed.heals?.[tree] ?? null : null;
  const suspended = Boolean(healed) && healed.cycles >= options.healLimit;

  // Unexpected names persist by design (they are never deleted), so paging about
  // the same set every two minutes would teach whoever carries the pager to ignore
  // the word. Anything repairable alarms every time, because it is new -- except
  // once auto-repair has stood down, where "every time" is ~700 pages a day about a
  // state only an operator can clear. There the stand-down pages once, and a
  // CHANGED finding set pages again.
  // OPERATOR-ONLY STATES PAGE ONCE, NOT ~700 TIMES A DAY.
  // A real directory where a dated link belongs, a non-directory where the serving
  // tree belongs, or a sweep that could not finish are all states nothing this job
  // does will clear -- the refusals are correct and deliberately delete nothing.
  // Paging about an UNCHANGED one every two minutes is the cadence that teaches
  // whoever carries the pager to ignore the word, which is the same mistake the
  // suspension branch below already avoids. The first page is what matters, and a
  // CHANGED picture is what matters next. Anything the host is about to REPAIR
  // still pages every occurrence: each repair is a real event, and a driven loop is
  // bounded by --heal-limit rather than by silence.
  const repairing = Boolean(sweep.drift) || sweep.links.length > 0 || Boolean(sweep.identity);
  const unheard = landed.noted !== digest;
  const announced = suspended ? !healed.suspended || unheard : repairing || unheard;
  if (announced) {
    alarm(TAMPER_REASON, suspended
      ? { edition, message: `corpus auto-repair suspended: ${tree.slice(0, 13)} has been rewritten and re-landed ${healed.cycles} times`, detail: suspensionDetail(options, { tree, healed, sweep }) }
      : { edition, message: `corpus volume tampered: ${sweep.findings[0]}`, detail: sweep.findings.join('\n') });
  }
  const result = { ...outcome, findings: sweep.findings, tampered: sweep.tampered, suspended, blocked: unrepairable(sweep), announced };
  if (options.check) return { ...result, current: !sweep.tampered };
  if (suspended) {
    log(`auto-repair suspended for ${tree.slice(0, 13)}: ${healed.cycles} drift-and-reland cycles since ${healed.since}, limit ${options.healLimit}. The last good tree is left exactly where it is.`);
    writeLanded(options.landed, { ...landed, noted: digest, heals: { ...landed.heals, [tree]: { ...healed, suspended: healed.suspended ?? isoSeconds(now) } } });
    return { ...result, current: false, changed: false };
  }
  prepareWorkRoots(options);
  if (sweep.drift) {
    log(`re-landing ${sweep.drift.tree.slice(0, 13)} from git so the newsroom heals itself`);
    const heals = bumpHeal(landed.heals, sweep.drift.tree, { at: isoSeconds(now) });
    return { ...swap(options, { commit: sweep.drift.commit, edition, ref, now, log, alarm, ledger, ops, exec, landed, previousCommit: outcome.previousCommit, outcome: result, heals, force: true }), findings: sweep.findings, tampered: true };
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
  // Only the states this poll SET OUT to repair may fail it. A blocked dated name
  // or a planted serving tree survives on purpose, so counting it as "still
  // tampered after repair" turned every one of them into a throw -- and an alarm --
  // on every poll, for a condition already paged once above.
  if (after.drift || after.links.length > 0 || after.identity) {
    const error = new CorpusError(`the corpus volume is still tampered after repair: ${after.findings.join('; ')}`);
    error.alarm = true;
    error.edition = edition;
    throw error;
  }
  // `current` must mean "a desk can read today's research", so an unreachable dated
  // name is not current however much else was repaired. --check already answered
  // this way; this path used to say `true` regardless, which disagreed with it.
  return { ...result, current: !result.blocked, changed: Boolean(sweep.links.length || sweep.identity) };
}

// A sweep that finds NOTHING is the only evidence that whatever was rewriting the
// mount has stopped, so it is what clears the acknowledged-finding digest and the
// heal counters. It writes only when there is something to clear: this path runs
// ~700 times a day, and `--check` writes nothing at all.
// The three states only an operator can clear. Named once so the paging gate, the
// post-repair re-check and `current` cannot drift apart about which they are.
const unrepairable = (sweep) => Boolean(sweep.blocked?.length) || sweep.tree === 'planted' || Boolean(sweep.failed);

function acknowledgeClean(options, { landed, outcome }) {
  if (options.check || (!landed.noted && !Object.keys(landed.heals ?? {}).length)) return outcome;
  writeLanded(options.landed, { ...landed, noted: null, heals: {} });
  return outcome;
}

// The page has to say what stopped and how it starts again, or "suspended" is just
// a word in a log nobody reads.
const suspensionDetail = (options, { tree, healed, sweep }) => [
  `${tree} has drifted and been re-landed ${healed.cycles} time(s) since ${healed.since}, which is the --heal-limit=${options.healLimit} ceiling.`,
  'Something inside the container is rewriting the corpus repeatedly, and every repair costs this host a full re-extraction of the tree.',
  'Auto-repair is now SUSPENDED for this tree: the last good tree is left mounted and is no longer being rebuilt from git, so whatever is writing it is unopposed.',
  `It resumes by itself as soon as a new commit lands for this edition, or immediately if an operator removes the ${JSON.stringify(tree)} key from "heals" in ${options.landed}.`,
  '',
  ...sweep.findings
].join('\n');

// The one-writer flock(2) relay -- and why it has to be a real flock(1) and not a
// pidfile -- is in corpus-refresh-lock.mjs. Re-exported here, so nothing that
// imports these from this module had to change; `main` below is the only caller.
export { LOCK_BUSY_EXIT, LOCK_ENV, relayUnderLock } from './corpus-refresh-lock.mjs';

export function main(argv = [], { log = console.log, alarm = raiseDetached, env = process.env, spawn = spawnSync, script = import.meta.filename, ...rest } = {}) {
  try {
    const options = corpusRefreshArgs(argv);
    // `--check` writes nothing, so it never waits on the lock -- and reporting
    // "nothing to do" for a busy lock would hide that a refresh IS needed.
    if (options.lock && !options.check && env[LOCK_ENV] !== options.lock) return relayUnderLock(options, argv, { env, spawn, script, log });
    const result = refresh(argv, { log, alarm, ...rest });
    // A wait is a success: the producers have not pushed yet, nothing is wrong,
    // and a non-zero exit here is ~25 OnFailure alarms a night. A SUSPENDED tree
    // is the same shape for the same reason: it has already paged, only an operator
    // can clear it, and a non-zero exit would add the unit's own OnFailure page
    // every two minutes on top -- which is how the word stops meaning anything.
    // `--check` is excluded: an operator asking "is the corpus right?" about a
    // suspended tree must still be told no.
    // TWO CHANNELS, deliberately. The exit code is what systemd turns into a page
    // through OnFailure=, so it must mean "something NEW is wrong" -- an unchanged
    // operator-only wedge exiting non-zero every two minutes is ~700 pages a day
    // about one condition, which is how the word stops meaning anything. Whether
    // the corpus is SERVICEABLE is a different question, and `--check` plus
    // `current` answer it on every run regardless of this number.
    if (result.blocked) return result.announced ? 1 : 0;
    return result.waiting || result.changed || result.current || (result.suspended && !options.check) ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof CorpusError ? error.message : error.stack}\n`);
    if (error?.alarm) alarm(REFUSAL_REASON, { edition: error.edition, message: `corpus refresh refused: ${error.message.split('\n')[0]}`, detail: error.stack ?? error.message });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
