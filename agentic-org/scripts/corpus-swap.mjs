// The mutating half of the corpus refresh: extract, validate, freeze, land, point
// the dated links, publish the record, collect the garbage.
//
// WHAT THIS FILE IS ALLOWED TO READ, EXHAUSTIVELY
// -----------------------------------------------
// Four things, and this list is the contract:
//
//   1. the host's own record outside the volume (`landed`, corpus-landed.mjs);
//   2. git, through `exec`, in the host's private checkout;
//   3. the host's clock, as the `now` its caller passes;
//   4. the volume itself -- ONLY to assert that what it is about to touch is the
//      real directory the host created, and to list the dated directories inside
//      a tree it has just extracted from git and not yet made reachable.
//
// It reads NOTHING inside the edition-state volume, and nothing at all inside a
// mount an agent can write to find out what to DO. An earlier version of this
// comment claimed that while the freeze below counted assignment files in the
// edition-state docker volume, which the agents can write and delete. A comment
// that describes a property the code does not have is the most expensive defect
// this repository produces, because every later reader trusts it instead of the
// code; the list above is checked by a test that plants and deletes those files
// and requires the decision to come out identical.
//
// Read corpus-volume.mjs before changing anything here: it owns every rule about
// what may touch the volume and why one careless `chmod -R` bricks the org.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { CORPUS_IDENTITY_FILE, CorpusError, corpusTreePath, verifyCorpusFreshness, verifyCorpusTree } from './corpus-contract.mjs';
import {
  LANDED_VERSION, buildManifest, compareManifest, editionCutoff, editionSettled, readManifest, removeManifest,
  sha256, treeName, writeLanded, writeManifest
} from './corpus-landed.mjs';
import { TAMPER_REASON } from './corpus-verify.mjs';
import {
  TREES_DIR, applyOwner, assertRealDirectory, assertTreesDirectory, auditVolumeRoot, collectGarbage,
  corpusIdentity, datedDirectories, freeze, identityBytes, isoSeconds, landFrozenTree, pointAtTree,
  removeTree, treeLinkTarget, writeIdentity
} from './corpus-volume.mjs';

export const REFRESH_LEDGER_VERSION = 'clank.corpus-refresh.v1';
const fail = (message) => { throw new CorpusError(message); };

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

// ONE RENAME OUT, AND THE DELETE DEFERRED UNTIL NOTHING POINTS INTO THE TREE
// --------------------------------------------------------------------------
// Only reached when a tree already under `trees/<commit>` has to be replaced by a
// freshly extracted one, which means it failed verification -- so it runs on every
// forced re-land, which is every drift heal.
//
// IT USED TO DANGLE FOR THE LENGTH OF A RECURSIVE DELETE. One function renamed the
// tree out, deleted it, and only THEN returned so the caller could land the
// replacement, so every `<date>` link pointing into that tree dangled across a
// full `rm -r`: 198 ENOENT reads measured over a 245 ms window on a 4000-file
// tree. The real corpus is ~4660 files and twelve agents read it on their own
// schedule.
//
// So the delete is not part of the swap any more. This does the one rename that
// frees the name; `stage` lands the replacement immediately after it; `swap`
// repoints the dated links; and only then is the parked tree deleted, outside the
// volume, with nothing pointing into it.
//
// WHAT IS LEFT, STATED HONESTLY BECAUSE A COMMENT THAT OVERSTATES THIS IS WORSE
// THAN NO COMMENT: the links still dangle between the rename below and the rename
// that lands the replacement. That is two adjacent rename(2) calls on one
// directory entry with no readdir, unlink, chmod or delete between them. It cannot
// be zero -- `trees/<commit>` is ONE name, the replacement has to end up under it,
// and Node exposes no renameat2(RENAME_EXCHANGE) to swap two directories in a
// single step. Nothing in this file may claim readers never see ENOENT.
function park(options, treePath) {
  assertRealDirectory(treePath, 'the corpus tree being replaced');
  const parked = path.join(options.trash, `${path.basename(treePath)}-evicted-${isoSeconds(options.now).replace(/[:-]/gu, '')}.${process.pid}`);
  // Same reason as landFrozenTree: rename(2) of a directory into another parent
  // needs write permission on the directory being moved, and a frozen tree has none.
  try { chmodSync(treePath, 0o755); } catch { /* already writable */ }
  renameSync(treePath, parked);
  return parked;
}

// Extracts, validates, chowns and freezes OUTSIDE the volume, then moves the
// finished tree in with one rename. Nothing partial is ever visible to the
// container's startup walk, and nothing unvalidated is ever reachable.
//
// A tree already under `trees/<commit>` is reused only when the host's land-time
// manifest still describes it. No manifest, or a manifest that no longer
// matches, means re-extract: adopting an unverifiable tree would launder exactly
// the tampering this design exists to notice.
function stage(options, { commit, edition, log, exec, now, force = false }) {
  const treePath = path.join(options.volume, TREES_DIR, commit);
  const existing = assertRealDirectory(treePath, `the corpus tree ${TREES_DIR}/${commit.slice(0, 7)}`);
  if (existing && !force) {
    const manifest = readManifest(options.landed, commit);
    const compared = manifest ? compareManifest(treePath, manifest) : null;
    if (compared && !compared.missing.length && !compared.extra.length && !compared.changed.length) {
      log(`reusing ${TREES_DIR}/${commit.slice(0, 7)}, already extracted`);
      return { treePath, freshness: validateTree(treePath, edition), reused: true };
    }
    log(`re-extracting ${TREES_DIR}/${commit.slice(0, 7)}: ${manifest ? 'it no longer matches the manifest the host wrote for it' : 'the host has no manifest to verify it against'}`);
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
  if (!existing && assertRealDirectory(treePath, `the corpus tree ${TREES_DIR}/${commit.slice(0, 7)}`)) {
    removeTree(stagingDir, { volume: options.volume, exec });
    return { treePath, freshness, reused: true };
  }
  // Park and land, back to back: the two renames are adjacent on purpose, and
  // anything inserted between them is paid for by twelve readers.
  const parked = existing ? park({ ...options, now }, treePath) : null;
  try { landFrozenTree(stagingDir, treePath); }
  catch (error) {
    // The one failure that must not leave the name empty. If the land itself did
    // not happen, the old tree goes back under its own name -- a second rename
    // rather than a dangling link until somebody notices.
    if (parked && !existsSync(treePath)) {
      try { renameSync(parked, treePath); chmodSync(treePath, 0o555); }
      catch (restore) { process.stderr.write(`could not put ${treePath} back after a failed land: ${restore.message}\n`); }
    }
    throw error;
  }
  log(`staged ${TREES_DIR}/${commit.slice(0, 7)}, ${freshness.sources} raw capture file(s) covered`);
  return { treePath, freshness, reused: false, parked };
}

export function appendRefreshLedger(ledger, entry) {
  mkdirSync(path.dirname(ledger), { recursive: true, mode: 0o700 });
  appendFileSync(ledger, `${JSON.stringify(entry)}\n`);
  return entry;
}


export function swap(options, { commit, edition, ref, now, log, alarm, ledger, ops, exec, landed, previousCommit, outcome, heals = {}, force = false }) {
  const volume = options.volume;
  assertTreesDirectory(volume);
  const unexpected = auditVolumeRoot(volume);
  if (unexpected.length) {
    for (const finding of unexpected) log(`UNEXPECTED VOLUME ENTRY: ${finding}`);
    alarm(TAMPER_REASON, { edition, message: `unexpected entries at the corpus volume root: ${unexpected[0]}`, detail: unexpected.join('\n') });
  }
  mkdirSync(path.join(volume, TREES_DIR), { recursive: true });
  const { treePath, freshness, parked } = stage(options, { commit, edition, log, exec, now, force });

  const dates = datedDirectories(treePath);
  const editions = { ...landed.editions };
  const frozen = [], moved = [];
  // `try`, because the parked tree has to go whether or not the links all move: a
  // dated name an agent has planted makes `pointAtTree` refuse (corpus-volume.mjs),
  // and a refusal that also leaked ~5 MiB into the trash root on every two-minute
  // poll would fill the production disk inside a day.
  try {
    for (const date of dates) {
      const known = editions[date];
      // THE FREEZE, DECIDED FROM THE HOST RECORD AND THE HOST CLOCK AND NOTHING
      // ELSE. A date is settled once this host has landed a corpus for it and that
      // date's own cutoff -- the same `--require-by` instant the missing-branch wait
      // uses, so there is one idea of when a day is done -- has passed. Before the
      // cutoff a newer commit still moves the link, which is how research that
      // arrives through the early morning reaches the reporters. An already recorded
      // freeze is kept rather than recomputed, so the record says when the host
      // FIRST froze the date and a later `--require-by` cannot thaw it.
      //
      // With no record there is nothing to hold the date at, so a first land always
      // links: no corpus at all is worse than a stale one.
      if (known && known.commit !== commit && (known.frozen || editionSettled(date, { now, requireBy: options.requireBy }))) {
        const frozenAt = known.frozen ?? { at: isoSeconds(now), cutoff: isoSeconds(editionCutoff(date, options.requireBy)), require_by: options.requireBy };
        log(`edition ${date} is frozen at ${known.commit.slice(0, 7)}: its ${frozenAt.require_by} Europe/Berlin cutoff passed at ${frozenAt.cutoff} with a corpus already landed`);
        editions[date] = { ...known, frozen: frozenAt };
        frozen.push(date);
        continue;
      }
      if (pointAtTree(volume, date, treeLinkTarget(commit, date), { ops, tmpDir: options.staging })) moved.push(date);
      // A forced re-land of the commit a frozen date already serves keeps the freeze
      // stamp: the date did not thaw, the same tree was rebuilt under it, and the
      // record must keep saying when the host first settled it.
      editions[date] = { commit, tree: corpusTreePath(commit), landed_at: isoSeconds(now), ...(known?.commit === commit && known.frozen ? { frozen: known.frozen } : {}) };
    }
    log(`links moved: ${moved.length} of ${dates.length} dated director${dates.length === 1 ? 'y' : 'ies'}${moved.length ? ` (${moved.slice(-5).join(', ')}${moved.length > 5 ? ', ...' : ''})` : ''}${frozen.length ? `; ${frozen.length} frozen (${frozen.join(', ')})` : ''}`);
  } finally {
    // THE DELETE, LAST, AND THAT ORDER IS THE WHOLE POINT. The replacement is landed
    // under the same name and every dated link has been repointed at it, so nothing
    // points into the parked copy -- its own path is in the trash root and no link
    // target is absolute. The recursive delete can therefore take the 245 ms it takes
    // without one reader seeing ENOENT. Outside the volume, as every delete here is.
    //
    // Its own try/catch: a delete that fails must not replace the reason the swap
    // failed with a message about the trash root.
    if (parked) {
      try {
        removeTree(parked, { volume, exec });
        log(`deleted the replaced ${TREES_DIR}/${commit.slice(0, 7)} in ${options.trash}, after the links already pointed at its replacement`);
      } catch (error) { process.stderr.write(`could not delete the replaced tree parked at ${parked}: ${error.message}\n`); }
    }
  }

  // CORPUS.json describes what the dated links actually serve. When the asked-for
  // edition is frozen, the mount still serves the commit its receipts name, so
  // advancing the record here would be the provenance lie FIX 3 exists to close.
  let identity = landed.identity;
  if (frozen.includes(edition)) log(`${CORPUS_IDENTITY_FILE} is left naming ${editions[edition].commit.slice(0, 7)}: ${edition} is frozen, so its provenance must not advance`);
  else {
    const record = corpusIdentity({ commit, ref, edition, fetchedAt: isoSeconds(now), editionsPresent: dates, sourceCount: freshness.sources });
    writeIdentity(volume, record, { edition, owner: options.owner, tmpDir: options.staging, exec });
    identity = { sha256: sha256(identityBytes(record)), record };
  }

  // The manifest the next ~700 polls verify the mount against, built from the
  // tree as it now sits in the volume, and kept beside landed.json where no
  // container can reach it.
  writeManifest(options.landed, buildManifest(treePath, commit));

  const trees = [...new Set([...landed.trees, corpusTreePath(commit), ...Object.values(editions).map((entry) => entry.tree)])].sort();
  // Written only now: every volume mutation it describes has already succeeded.
  // `heals` is `{}` unless the caller is the drift repair itself: a genuinely new
  // commit is a fresh corpus, so whatever was being rewritten under the old tree
  // stops being this host's problem and auto-repair resumes.
  writeLanded(options.landed, { version: LANDED_VERSION, editions, trees, identity, noted: null, heals });

  // The newly landed tree is spared even when no date references it yet -- a
  // commit whose every date is frozen is still what `corpusLanded` reads as
  // landed, and collecting it would loop this run forever.
  const live = [...new Set([commit, ...Object.values(editions).map((entry) => treeName(entry.tree))])];
  const gc = collectGarbage(volume, { known: trees.map(treeName), live, keep: options.keep, trash: options.trash, now, exec });
  log(gc.removed.length ? `removed ${gc.removed.length} unreferenced tree(s): ${gc.removed.map((name) => name.slice(0, 7)).join(', ')}` : 'no unreferenced tree to remove');
  if (gc.unknown.length) {
    for (const name of gc.unknown) log(`UNEXPECTED VOLUME ENTRY: ${TREES_DIR}/${name} is not a tree this host landed; left in place`);
    alarm(TAMPER_REASON, { edition, message: `${gc.unknown.length} unknown entr(y/ies) under ${TREES_DIR}/`, detail: gc.unknown.join('\n') });
  }
  for (const name of gc.removed) removeManifest(options.landed, name);
  if (gc.removed.length) writeLanded(options.landed, {
    version: LANDED_VERSION, editions, trees: trees.filter((tree) => !gc.removed.includes(treeName(tree))), identity, noted: null,
    // A collected tree cannot drift any more, so its heal count goes with it.
    heals: Object.fromEntries(Object.entries(heals).filter(([tree]) => !gc.removed.includes(treeName(tree))))
  });

  appendRefreshLedger(ledger, {
    v: REFRESH_LEDGER_VERSION, at: isoSeconds(now), edition, ref, commit,
    previous_commit: previousCommit, links_moved: moved.length, frozen_editions: frozen, trees_removed: gc.removed.length, changed: true
  });
  log(`corpus ${previousCommit ? previousCommit.slice(0, 7) : '(none)'} -> ${commit.slice(0, 7)} for ${edition}`);
  return { ...outcome, changed: true, current: true, frozen: frozen.includes(edition), linksMoved: moved.length, treesRemoved: gc.removed, unknownEntries: [...unexpected, ...gc.unknown] };
}

