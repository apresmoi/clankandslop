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
import { TREES_DIR, assertTreesDirectory, auditVolumeRoot } from './corpus-volume.mjs';
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

// ONE SWEEP, FOUR QUESTIONS, EACH ANSWERED FROM OUTSIDE THE VOLUME
// ---------------------------------------------------------------
//   1. does the volume root hold a name this host never writes?
//   2. is CORPUS.json still the bytes the host published?
//   3. does every `<date>` link still point where the host pointed it?
//   4. is the tree today's edition reads still the tree git says it is?
//
// `tampered` separates what must be healed from what can only be reported: a
// forged record, a moved link or drifted content all mean the newsroom is
// reading something the host did not land, and all three are repairable. An
// unexpected NAME is not repairable without deleting evidence, so it alarms and
// stays.
export function integritySweep({ volume, landed, landedFile, edition, privateRepo, exec }) {
  const findings = [], links = [];
  const unknown = [
    ...auditVolumeRoot(volume).map((text) => `volume root: ${text}`),
    ...unknownTrees(volume, landed.trees.map(treeName)).map((name) => `${TREES_DIR}/${name} is a tree this host did not land`)
  ];
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

  let drift = null, touched = [];
  const serving = landed.editions[edition];
  if (serving) {
    const manifest = readManifest(landedFile, serving.commit);
    const treeRoot = path.join(volume, serving.tree);
    if (!manifest) findings.push(`no land-time manifest for ${serving.tree.slice(0, 13)}, so its content cannot be verified`);
    else if (!assertTreesDirectory(volume)) findings.push(`${TREES_DIR}/ is gone, so nothing can be verified`);
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
  return { findings, unknown, identity, links, drift, touched, tampered: Boolean(identity || links.length || drift) };
}
