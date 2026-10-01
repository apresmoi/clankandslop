// Continuous integrity verification of the corpus volume, against the host's own
// record and against git.
//
// WHY VERIFY INSTEAD OF PREVENT
// -----------------------------
// Because prevention is not available. The mount has to be `mode: mutable` or
// the container dies on its own `chmod -R a-w`, the compiler's ownership guard
// chowns the volume to uid 2000 on every start, and the guard then requires a
// uid-owned 0755 volume root. An owner can always restore its own write bit, so
// every NAME at the volume root -- CORPUS.json, each `<date>` symlink, `trees/`
// itself -- is writable by all twelve agents, durably and shared. Bytes inside
// an already-frozen 0555 directory are not. That asymmetry is the whole threat
// model, and it was reproduced in production, not argued.
//
// So the honest guarantee is not "cannot be tampered with" but "cannot be
// tampered with unnoticed, for longer than one poll interval". The refresher
// runs every two minutes; this sweep runs on every one of those runs that would
// otherwise return early, which is ~700 times a day. On drift it alarms with the
// paths and the newsroom RE-LANDS from git, so the corpus heals itself without a
// human in the loop.
//
// The bundle this replaced was never verified after extraction at all -- it was
// unpacked from the image at container start and trusted for the life of the
// container. A weaker permission model with continuous verification detects
// strictly more than that did.
//
// WHAT IS CHEAP ENOUGH TO RUN EVERY TWO MINUTES
// ---------------------------------------------
// One lstat per entry over ~4660 files, compared against the (kind, size, mtime,
// mode) manifest written at land time. That settles every edit that changes the
// set of names, a length, a mode or a kind. A same-size rewrite shows up as a
// moved mtime and nothing else, so exactly those paths -- and no others -- are
// then hashed and compared against `git ls-tree -r <commit>`, which is the
// authority the tree was extracted from in the first place. Typical cost of the
// deep pass is zero files.

import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { CORPUS_IDENTITY_FILE } from './corpus-contract.mjs';
import { TREES_DIR, assertTreesDirectory, auditVolumeRoot, moveAsideCommand } from './corpus-volume.mjs';
import { compareManifest, readManifest, sha256, treeName } from './corpus-landed.mjs';

// EVERY WORD THESE MODULES CAN PAGE A HUMAN WITH
// ----------------------------------------------
// Declared here, as constants, because alarm.mjs's vocabulary is CLOSED: an
// unregistered --reason exits 64, which `raiseDetached` reports as "could not be
// raised" -- that is, no alarm at all. A typo in a reason string is therefore a
// silent failure of exactly the kind this newsroom is worst at noticing, so no
// call site in these modules may pass a bare string, and a test walks this list
// against the registry and raises each word for real.
//
// Two words, not one, because they ask different things of the person reading
// them at 04:00: a REFUSAL left the last good corpus mounted and untouched --
// degraded, nothing on fire -- while TAMPER means the mounted corpus stopped
// matching what the host landed, and the host has already re-landed it.
export const TAMPER_REASON = 'corpus-tampered';
export const REFUSAL_REASON = 'corpus-refresh-failed';
export const CORPUS_ALARM_REASONS = Object.freeze([REFUSAL_REASON, TAMPER_REASON]);

// How much disk unknown names under `trees/` may occupy before being REPORTED
// stops being enough. They are never deleted -- that guard is correct, deleting
// them destroys the only evidence of who else writes the mount -- but "reported"
// must not be able to mean "nobody will ever look" while a planted directory
// quietly fills the production host. A real corpus tree is single-digit MiB, so
// this threshold is crossed by something that is not a corpus.
export const DEFAULT_UNKNOWN_MIB = 256;
const MIB = 1024 * 1024;

const readOrNull = (file) => { try { return readFileSync(file, 'utf8'); } catch { return null; } };
const linkOrNull = (file) => { try { return lstatSync(file).isSymbolicLink() ? readlinkSync(file) : null; } catch { return null; } };

/** The blob id git holds for every path in a commit, so a suspect file can be compared with the thing it was extracted from. */
export function gitBlobIds(privateRepo, commit, exec) {
  const listing = exec('git', ['-C', privateRepo, 'ls-tree', '-r', commit]).toString();
  const blobs = new Map();
  for (const line of listing.split('\n')) {
    const match = /^\d+ blob ([0-9a-f]{40})\t(.*)$/u.exec(line);
    if (match) blobs.set(match[2], match[1]);
  }
  return blobs;
}

// The deep pass. Only ever handed paths whose stat tuple moved but whose size,
// mode and kind did not, which is the one shape the cheap pass cannot settle.
export function contentDrift(treeRoot, suspects, { privateRepo, commit, exec }) {
  if (!suspects.length) return [];
  const blobs = gitBlobIds(privateRepo, commit, exec);
  const drifted = [];
  for (const file of suspects) {
    const want = blobs.get(file);
    if (!want) { drifted.push(file); continue; }
    let got = null;
    try { got = exec('git', ['-C', privateRepo, 'hash-object', '--', path.join(treeRoot, file)]).toString().trim(); }
    catch { /* unreadable is drift */ }
    if (got !== want) drifted.push(file);
  }
  return drifted;
}

/** Tree names present under `trees/` that the host's record does not know. Reported, never deleted. */
export function unknownTrees(volume, known) {
  if (!assertTreesDirectory(volume)) return [];
  return readdirSync(path.join(volume, TREES_DIR)).filter((name) => !known.includes(name)).sort();
}

// THE ONE RULE EVERY WALK IN THIS FILE OBEYS
// -----------------------------------------
// LSTAT, AND NEVER DESCEND A NAME AN AGENT CHOSE. uid 2000 owns `trees/` and can
// replace any name under it with a symlink, so a walk that resolves names with
// `stat` is a walk whose target an agent picked: following one measures /etc, and
// aimed at `/` it is a whole-filesystem readdir every two minutes.
//
// This file used to state the rule here and break it twenty lines below, where
// `compareManifest` walked `trees/<commit>` without ever asking what that name
// was. Both halves now obey it:
//
//   * `unknownFootprint` counts a planted symlink as one entry and stops there;
//   * the serving tree is lstat'd by `treeShape` and refused unless it is a real
//     directory, BEFORE `compareManifest` reads one name under it.
//
// Normally there are no unknown names at all and the first of those walks nothing.
export function unknownFootprint(volume, names) {
  let entries = 0, bytes = 0;
  const walk = (target) => {
    let stat;
    try { stat = lstatSync(target); } catch { return; }
    entries += 1;
    if (stat.isSymbolicLink()) return;
    if (!stat.isDirectory()) { bytes += stat.size; return; }
    let listing = [];
    try { listing = readdirSync(target); } catch { return; }
    for (const name of listing) walk(path.join(target, name));
  };
  for (const name of names) walk(path.join(volume, TREES_DIR, name));
  return { entries, bytes };
}

// WHAT `trees/<commit>` ACTUALLY IS, ASKED WITH ONE LSTAT
// ------------------------------------------------------
// `assertTreesDirectory` checks `trees/`. It says nothing about `trees/<commit>`,
// and that was the one path into this sweep with no guard on it at all:
//
//   * `mv trees/<commit> trees/zzz` inside the container made `buildManifest`'s
//     readdir throw ENOENT straight out of the sweep -- exit 1, no alarm, dated
//     links left dangling, and the re-land this design rests on never ran;
//   * a symlink at `trees/<commit>` was recursively readdir'd and lstat'd by
//     `compareManifest` -- 34 measured entries outside the volume -- long before
//     `stage`'s `assertRealDirectory` got the chance to refuse it.
//
// So the shape of that name is established first, with one lstat, and the walk
// only ever runs on a real directory. Returned rather than thrown: the caller
// classifies this into a finding, and a refusal that escapes the sweep is the
// silent exit described under `integritySweep`.
export function treeShape(treeRoot) {
  let stat;
  try { stat = lstatSync(treeRoot); } catch (error) { return error.code === 'ENOENT' ? 'missing' : `unreadable (${error.code})`; }
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'directory';
  return stat.isFile() ? 'file' : 'special file';
}

// ONE SWEEP, FIVE QUESTIONS, EACH ANSWERED FROM OUTSIDE THE VOLUME
// ---------------------------------------------------------------
//   1. does the volume root hold a name this host never writes?
//   2. how much disk do the names it never wrote occupy?
//   3. is CORPUS.json still the bytes the host published?
//   4. does every `<date>` link still point where the host pointed it?
//   5. is the tree today's edition reads still the tree git says it is?
//
// `tampered` separates what must be healed from what can only be reported: a
// forged record, a moved link or drifted content all mean the newsroom is
// reading something the host did not land, and all three are repairable. An
// unexpected NAME is not repairable without deleting evidence, so it alarms and
// stays.
function sweepVolume({ volume, landed, landedFile, edition, privateRepo, exec, unknownMib = DEFAULT_UNKNOWN_MIB }) {
  const findings = [], links = [];
  const strangers = unknownTrees(volume, landed.trees.map(treeName));
  const unknown = [
    ...auditVolumeRoot(volume).map((text) => `volume root: ${text}`),
    ...strangers.map((name) => `${TREES_DIR}/${name} is a tree this host did not land`)
  ];
  // The escalation. Reported-and-never-deleted is the right call for one planted
  // name; it is not the right call for a name that is eating the host's disk, and
  // the difference has to be a finding rather than a judgement nobody makes. The
  // size is rounded to whole MiB so a directory that keeps growing pages again
  // while a static one stays quiet (the caller suppresses an unchanged finding
  // set, which is what makes rounding the difference between once and ~700 times
  // a day).
  const footprint = unknownFootprint(volume, strangers);
  const overflow = footprint.bytes > unknownMib * MIB;
  if (overflow) unknown.push(`${TREES_DIR}/ holds ${footprint.entries} unknown entr${footprint.entries === 1 ? 'y' : 'ies'}`
    + ` occupying ${Math.round(footprint.bytes / MIB)} MiB, over the ${unknownMib} MiB this host will absorb;`
    + ' nothing here deletes them, so an operator has to look at what is writing this mount');
  findings.push(...unknown);

  let identity = null;
  if (landed.identity) {
    const live = readOrNull(path.join(volume, CORPUS_IDENTITY_FILE));
    if (live === null) { identity = 'missing'; findings.push(`${CORPUS_IDENTITY_FILE} is gone`); }
    else if (sha256(live) !== landed.identity.sha256) { identity = 'forged'; findings.push(`${CORPUS_IDENTITY_FILE} is not the record this host published`); }
  }

  for (const [date, entry] of Object.entries(landed.editions)) {
    const want = `${entry.tree}/${date}`;
    const got = linkOrNull(path.join(volume, date));
    if (got !== want) { links.push({ date, want, got }); findings.push(`${date} points at ${got === null ? 'no symlink at all' : JSON.stringify(got)}, not ${want}`); }
  }

  let drift = null, touched = [], tree = null;
  const serving = landed.editions[edition];
  if (serving) {
    const manifest = readManifest(landedFile, serving.commit);
    const treeRoot = path.join(volume, serving.tree);
    // `trees/` first, so a volume with no `trees/` at all is reported as what it
    // is rather than as one missing tree; then the tree itself, before anything
    // walks it.
    const shape = assertTreesDirectory(volume) ? treeShape(treeRoot) : 'missing';
    if (shape === 'missing') {
      // GONE IS REPAIRABLE, AND IT HAS TO SAY SO. This is the finding the sweep
      // never produced: the tree the newsroom reads was renamed or deleted, the
      // dated links dangle, and git still has every byte of it -- so it is handed
      // back in the same `drift` shape a rewritten file produces and the caller
      // re-lands it. Unclassified, it was an ENOENT that escaped with no page.
      tree = 'missing';
      drift = { tree: serving.tree, commit: serving.commit, paths: [] };
      findings.push(`${serving.tree} is gone from the volume, so every ${edition} link into it dangles and the corpus must be re-landed from git`);
    } else if (shape !== 'directory') {
      // AND PLANTED IS NOT. Re-landing would mean renaming or deleting a name this
      // host did not write, which it never does -- `stage`'s `assertRealDirectory`
      // refuses it too, by design. There is exactly one thing to do with this
      // state, so the finding says it, with the path and the command.
      tree = 'planted';
      // One line, deliberately: the caller passes findings[0] as the alarm's
      // headline, and a page whose first line wraps into three loses the command
      // at the end of it.
      findings.push(`${serving.tree} is a ${shape} where the corpus tree this host landed belongs, so the ${edition} corpus can be neither verified nor re-landed;`
        + ` nothing here deletes or moves a name this host did not write, so an operator has to run \`${moveAsideCommand(volume, treeRoot)}\` and the next poll re-lands the tree from git on its own`);
    } else if (!manifest) findings.push(`no land-time manifest for ${serving.tree.slice(0, 13)}, so its content cannot be verified`);
    else {
      const compared = compareManifest(treeRoot, manifest);
      const suspects = contentDrift(treeRoot, compared.touched, { privateRepo, commit: serving.commit, exec });
      const paths = [...compared.missing, ...compared.extra, ...compared.changed, ...suspects].sort();
      // Same bytes, moved mtime. Somebody still wrote to the mount, so it is said
      // out loud and the manifest is re-stamped, but re-landing identical content
      // would churn the volume under twelve readers for no gain.
      touched = compared.touched.filter((file) => !suspects.includes(file));
      if (paths.length) {
        drift = { tree: serving.tree, commit: serving.commit, paths };
        findings.push(`${serving.tree.slice(0, 13)} no longer matches what the host landed: ${paths.slice(0, 8).join(', ')}${paths.length > 8 ? ` and ${paths.length - 8} more` : ''}`);
      } else if (touched.length) findings.push(`${touched.length} file(s) in ${serving.tree.slice(0, 13)} were touched without changing their content`);
    }
  }
  return { findings, unknown, footprint, overflow, identity, links, drift, touched, tree, failed: null, tampered: Boolean(identity || links.length || drift || tree) };
}

// NO EXCEPTION LEAVES THIS SWEEP WITHOUT A PAGE
// --------------------------------------------
// The refresher's top-level handler alarms only on an error it recognizes
// (`error.alarm`), so every other throw out of here was exit 1 with no page: the
// shape that let `mv trees/<commit> trees/zzz` silence the alarm completely. The
// guards above remove the known cases; this removes the class. Anything that
// escapes -- a refusal from corpus-volume.mjs because the volume was written by
// something else, an unreadable record, a bug in this file -- comes back as a
// finding with `tampered` set, so the caller pages and `--check` answers "not
// current" instead of reporting a volume nothing managed to verify as fine.
export function integritySweep(options) {
  try { return sweepVolume(options); }
  catch (error) {
    const message = String(error?.message ?? error);
    return {
      findings: [`the corpus integrity sweep could not complete, so nothing in this volume is verified: ${message.split('\n')[0]}`],
      unknown: [], footprint: { entries: 0, bytes: 0 }, overflow: false, identity: null, links: [], drift: null,
      touched: [], tree: null, failed: { message, code: error?.code ?? null }, tampered: true
    };
  }
}
