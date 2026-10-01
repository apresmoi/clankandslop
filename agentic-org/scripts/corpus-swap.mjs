// The mutating half of the corpus refresh: extract, validate, freeze, land, point
// the dated links, publish the record, collect the garbage.
//
// WHY IT IS ITS OWN MODULE
// ------------------------
// corpus-refresh.mjs decides, this file acts, and the split is the point: every
// decision that reaches here was taken from the host's own record outside the
// volume (corpus-landed.mjs) or from git, never from a name inside an
// agent-writable mount. Nothing in this file reads the volume to find out what to
// do -- it reads it only to assert that what it is about to touch is the real
// directory the host itself created.
//
// Read corpus-volume.mjs before changing anything here: it owns every rule about
// what may touch the volume and why one careless `chmod -R` bricks the org.

import { appendFileSync, chmodSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { CORPUS_IDENTITY_FILE, CorpusError, verifyCorpusFreshness, verifyCorpusTree } from './corpus-contract.mjs';
import {
  LANDED_VERSION, buildManifest, commissionedEdition, compareManifest, readManifest, removeManifest,
  sha256, treeName, writeLanded, writeManifest
} from './corpus-landed.mjs';
import { tamperReason } from './corpus-verify.mjs';
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

// One rename out of the volume, then deleted in the trash root -- the same path a
// retiring tree takes. Only used when a tree already under `trees/<commit>` has
// to be replaced by a freshly extracted one, which means it failed verification.
// The `<date>` links dangle between this rename and the one that lands the
// replacement: two renames, microseconds apart, and the alternative is leaving
// tampered research mounted for twelve reporters.
function evict(options, treePath, { now, exec, log }) {
  assertRealDirectory(treePath, 'the corpus tree being replaced');
  const parked = path.join(options.trash, `${path.basename(treePath)}-evicted-${isoSeconds(now).replace(/[:-]/gu, '')}.${process.pid}`);
  try { chmodSync(treePath, 0o755); } catch { /* already writable */ }
  renameSync(treePath, parked);
  removeTree(parked, { volume: options.volume, exec });
  log(`evicted ${TREES_DIR}/${path.basename(treePath).slice(0, 7)} from the volume before re-landing it`);
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
  if (existing) evict(options, treePath, { now, exec, log });
  landFrozenTree(stagingDir, treePath);
  log(`staged ${TREES_DIR}/${commit.slice(0, 7)}, ${freshness.sources} raw capture file(s) covered`);
  return { treePath, freshness, reused: false };
}

export function appendRefreshLedger(ledger, entry) {
  mkdirSync(path.dirname(ledger), { recursive: true, mode: 0o700 });
  appendFileSync(ledger, `${JSON.stringify(entry)}\n`);
  return entry;
}


export function swap(options, { commit, edition, ref, now, log, alarm, ledger, ops, exec, landed, previousCommit, outcome, force = false }) {
  const volume = options.volume;
  assertTreesDirectory(volume);
  const unexpected = auditVolumeRoot(volume);
  if (unexpected.length) {
    for (const finding of unexpected) log(`UNEXPECTED VOLUME ENTRY: ${finding}`);
    alarm(tamperReason(), { edition, message: `unexpected entries at the corpus volume root: ${unexpected[0]}`, detail: unexpected.join('\n') });
  }
  mkdirSync(path.join(volume, TREES_DIR), { recursive: true });
  const { treePath, freshness } = stage(options, { commit, edition, log, exec, now, force });

  const dates = datedDirectories(treePath);
  const editions = { ...landed.editions };
  const frozen = [], moved = [];
  for (const date of dates) {
    const commissioned = commissionedEdition(options.editionState, date);
    const known = editions[date];
    // Frozen only when the host knows what the newsroom was commissioned
    // against. With no record there is nothing to hold the date at, and leaving
    // it unlinked would be no corpus at all rather than a consistent one.
    if (commissioned.count > 0 && known && known.commit !== commit) {
      log(`edition ${date} is commissioned against ${(commissioned.commits[0] ?? known.commit).slice(0, 7)}; its corpus is frozen`);
      editions[date] = { ...known, frozen: { at: isoSeconds(now), assignments: commissioned.count, commits: commissioned.commits } };
      frozen.push(date);
      continue;
    }
    if (commissioned.count > 0 && !known) log(`edition ${date} is commissioned but this host has no record of its corpus; landing ${commit.slice(0, 7)} for it`);
    if (pointAtTree(volume, date, treeLinkTarget(commit, date), { ops, tmpDir: options.staging })) moved.push(date);
    editions[date] = { commit, tree: `${TREES_DIR}/${commit}`, landed_at: isoSeconds(now) };
  }
  log(`links moved: ${moved.length} of ${dates.length} dated director${dates.length === 1 ? 'y' : 'ies'}${moved.length ? ` (${moved.slice(-5).join(', ')}${moved.length > 5 ? ', ...' : ''})` : ''}${frozen.length ? `; ${frozen.length} frozen (${frozen.join(', ')})` : ''}`);

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

  const trees = [...new Set([...landed.trees, `${TREES_DIR}/${commit}`, ...Object.values(editions).map((entry) => entry.tree)])].sort();
  // Written only now: every volume mutation it describes has already succeeded.
  writeLanded(options.landed, { version: LANDED_VERSION, editions, trees, identity, noted: null });

  // The newly landed tree is spared even when no date references it yet -- a
  // commit whose every date is frozen is still what `corpusLanded` reads as
  // landed, and collecting it would loop this run forever.
  const live = [...new Set([commit, ...Object.values(editions).map((entry) => treeName(entry.tree))])];
  const gc = collectGarbage(volume, { known: trees.map(treeName), live, keep: options.keep, trash: options.trash, now, exec });
  log(gc.removed.length ? `removed ${gc.removed.length} unreferenced tree(s): ${gc.removed.map((name) => name.slice(0, 7)).join(', ')}` : 'no unreferenced tree to remove');
  if (gc.unknown.length) {
    for (const name of gc.unknown) log(`UNEXPECTED VOLUME ENTRY: ${TREES_DIR}/${name} is not a tree this host landed; left in place`);
    alarm(tamperReason(), { edition, message: `${gc.unknown.length} unknown entr(y/ies) under ${TREES_DIR}/`, detail: gc.unknown.join('\n') });
  }
  for (const name of gc.removed) removeManifest(options.landed, name);
  if (gc.removed.length) writeLanded(options.landed, { version: LANDED_VERSION, editions, trees: trees.filter((tree) => !gc.removed.includes(treeName(tree))), identity, noted: null });

  appendRefreshLedger(ledger, {
    v: REFRESH_LEDGER_VERSION, at: isoSeconds(now), edition, ref, commit,
    previous_commit: previousCommit, links_moved: moved.length, frozen_editions: frozen, trees_removed: gc.removed.length, changed: true
  });
  log(`corpus ${previousCommit ? previousCommit.slice(0, 7) : '(none)'} -> ${commit.slice(0, 7)} for ${edition}`);
  return { ...outcome, changed: true, current: true, frozen: frozen.includes(edition), linksMoved: moved.length, treesRemoved: gc.removed, unknownEntries: [...unexpected, ...gc.unknown] };
}

