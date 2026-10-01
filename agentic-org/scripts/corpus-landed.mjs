// The HOST's own record of what it put in the corpus volume, and the only thing
// the refresher is allowed to believe.
//
// WHY THE VOLUME CANNOT BE ITS OWN RECORD
// ---------------------------------------
// This was reproduced in the live production container on 2026-10-01, not
// theorised:
//
//   $ docker exec --user 2000:2000 <ctr> sh -c 'echo forged > <volume>/CORPUS.json'
//   $ docker exec --user 2000:2000 <ctr> sh -c 'ln -s /etc <volume>/trees'
//
// Both worked. The volume is `mode: mutable` (it has to be: `readonly` makes
// the entrypoint's own `chmod -R a-w` hit the root-owned identity sentinel and
// the container dies), and the compiler's root ownership guard recursively
// chowns the whole volume to uid 2000 on every start and then requires the
// volume root to be a uid-owned 0755 directory. So uid 2000 OWNS the volume
// root: it can create, unlink and replace names in it, and `chmod -R a-w` is
// advisory against an owner who can always `chmod u+w` again.
//
// Bytes inside an already-frozen 0555 tree are safe. NAMES in a 0755 directory
// are not -- which is every name the refresher used to read back as truth:
// CORPUS.json, the `<date>` symlinks, and the `trees/` directory itself. A
// root-privileged host job that reads those to decide what to delete is taking
// aim from an agent-writable input.
//
// So the record moves OUT. This file is root-owned 0600 under
// /var/lib/clank-corpus, never inside the volume, never readable by any
// container, and it answers all three questions the refresher used to ask the
// volume: is the corpus current, which trees are live, and what may be removed.
// CORPUS.json stays, as an OUTPUT the container reads -- never as an input the
// host trusts.
//
// A missing record is recoverable by design: it means "nothing landed", the
// next run re-lands and rewrites it. It is never inferred back from the volume,
// because the volume is exactly what it exists to stop trusting.

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CorpusError, EDITION_PATTERN } from './corpus-contract.mjs';

export const LANDED_VERSION = 'clank.corpus-landed.v1';
export const MANIFEST_VERSION = 'clank.corpus-manifest.v1';
export const MANIFEST_DIR = 'manifests';

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const TREE_PATTERN = /^trees\/[0-9a-f]{40}$/;
const fail = (message) => { throw new CorpusError(message); };

export const sha256 = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
export const treeName = (tree) => String(tree).slice('trees/'.length);

export const emptyLanded = () => ({ version: LANDED_VERSION, editions: {}, trees: [], identity: null });

// FINDINGS, NOT A THROW, on the read side: an invalid record must degrade to
// "nothing landed" and be re-earned, never abort the refresher -- a host that
// cannot refresh because its own bookkeeping is corrupt is a newsroom with no
// corpus at all. The WRITE side refuses, because publishing a record the next
// run cannot trust is how the bookkeeping got corrupt.
export function landedFindings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`must be a JSON object, got ${Array.isArray(value) ? 'an array' : typeof value}`];
  const findings = [];
  if (value.version !== LANDED_VERSION) findings.push(`version must be ${LANDED_VERSION}, got ${JSON.stringify(value.version)}`);
  if (!Array.isArray(value.trees) || value.trees.some((tree) => typeof tree !== 'string' || !TREE_PATTERN.test(tree))) findings.push(`trees must be an array of trees/<40hex>, got ${JSON.stringify(value.trees)}`);
  if (!value.editions || typeof value.editions !== 'object' || Array.isArray(value.editions)) return [...findings, `editions must be an object keyed by YYYY-MM-DD, got ${JSON.stringify(value.editions)}`];
  const trees = new Set(Array.isArray(value.trees) ? value.trees : []);
  for (const [date, entry] of Object.entries(value.editions)) {
    if (!EDITION_PATTERN.test(date)) { findings.push(`editions key ${JSON.stringify(date)} is not YYYY-MM-DD`); continue; }
    if (!entry || typeof entry !== 'object') { findings.push(`editions[${date}] must be an object`); continue; }
    if (typeof entry.commit !== 'string' || !COMMIT_PATTERN.test(entry.commit)) findings.push(`editions[${date}].commit must be a 40-character lowercase hex sha, got ${JSON.stringify(entry.commit)}`);
    if (entry.tree !== `trees/${entry.commit}`) findings.push(`editions[${date}].tree must be trees/<commit>, got ${JSON.stringify(entry.tree)}`);
    // The cross-check that makes the record usable as the GC's whole input: a
    // tree an edition is serving and the tree list disagree, and the sweep is
    // taking aim at something still mounted.
    else if (!trees.has(entry.tree)) findings.push(`editions[${date}].tree ${entry.tree} is absent from trees[]`);
    if (typeof entry.landed_at !== 'string' || !entry.landed_at) findings.push(`editions[${date}].landed_at must be an instant`);
  }
  return findings;
}

export function readLanded(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return { record: null, reason: null, missing: true }; }
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { record: null, reason: `${file} is not parseable JSON`, missing: false }; }
  const findings = landedFindings(parsed);
  if (findings.length) return { record: null, reason: `${file} is invalid: ${findings.join('; ')}`, missing: false };
  return { record: parsed, reason: null, missing: false };
}

/** tmp + rename, 0600, and only ever called after the volume mutation it describes has succeeded. */
export function writeLanded(file, record) {
  const findings = landedFindings(record);
  if (findings.length) fail(`refusing to write an invalid ${path.basename(file)}: ${findings.join('; ')}`);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return record;
}

// THE NO-OP CHECK, decided entirely from the host record. Cheap (one small read
// outside the volume), observable (it says why a refresh is needed), and it
// consults nothing an agent can write.
//
// `frozen` is the FIX-3 case: the edition has been commissioned, so its corpus
// is pinned to the commit the assignment receipts name. A newer commit is still
// landed -- that is what `trees[]` carrying it proves -- but this date does not
// follow it, and that state has to read as a stable no-op or every poll would
// re-land the same tree forever.
export function corpusLanded(record, { commit, edition }) {
  if (!record) return { current: false, reason: 'the host has no record of anything landed for this volume', entry: null, frozen: null };
  const entry = record.editions?.[edition] ?? null;
  if (!entry) return { current: false, reason: `the host has never landed a corpus for ${edition}`, entry: null, frozen: null };
  const frozen = entry.frozen ?? null;
  if (frozen && record.trees.includes(`trees/${commit}`)) return { current: true, reason: null, entry, frozen };
  if (entry.commit !== commit) {
    return { current: false, entry, frozen, reason: frozen
      ? `${edition} is frozen at ${entry.commit.slice(0, 7)} and ${commit.slice(0, 7)} is not landed yet`
      : `the host landed ${entry.commit.slice(0, 7)} for ${edition}, want ${commit.slice(0, 7)}` };
  }
  return { current: true, reason: null, entry, frozen };
}

// WHAT A CHEAP TAMPER CHECK CAN BE
// --------------------------------
// The mount is unavoidably agent-writable, so the honest guarantee is not
// "cannot be written" but "cannot be written unnoticed". This runs every two
// minutes over ~4660 files, so it must be one lstat per entry and no reads:
// kind, size, mode, and the mtime, recorded at land time while the tree was
// still the host's.
//
// A full re-hash of the tree every two minutes would be ~4660 file reads a run,
// ~700 runs a day; the stat sweep is the same information for anything that
// changed LENGTH, MODE, KIND or SET OF NAMES, which is every edit that changes
// what a reporter reads. The one case it cannot settle alone is a same-size
// rewrite, which shows up here as an mtime that moved: those paths, and only
// those, are then re-hashed against git (see contentDrift in corpus-refresh).
//
// Note what the retired bundle did instead: it was extracted from the image at
// container start and never verified again, by anything, ever. A weaker
// permission model with continuous verification is a net gain in integrity, not
// a regression -- but only while the verification actually runs, which is why
// `--no-verify` exists for tests and nothing else.
export function buildManifest(root, commit) {
  const entries = {};
  const walk = (directory, prefix) => {
    for (const name of readdirSync(directory).sort()) {
      const full = path.join(directory, name), key = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(full);
      const mode = stat.mode & 0o7777;
      if (stat.isSymbolicLink()) entries[key] = ['l', 0, 0, mode, readlinkSync(full)];
      else if (stat.isDirectory()) { entries[key] = ['d', 0, 0, mode]; walk(full, key); }
      else entries[key] = ['f', stat.size, Math.round(stat.mtimeMs), mode];
    }
  };
  walk(root, '');
  return { version: MANIFEST_VERSION, commit, files: Object.keys(entries).length, entries };
}

export const manifestPath = (landedFile, commit) => path.join(path.dirname(landedFile), MANIFEST_DIR, `${commit}.json`);

export function writeManifest(landedFile, manifest) {
  const file = manifestPath(landedFile, manifest.commit);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(manifest)}\n`;
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  return { file, sha256: sha256(text), files: manifest.files };
}

export function readManifest(landedFile, commit) {
  try {
    const value = JSON.parse(readFileSync(manifestPath(landedFile, commit), 'utf8'));
    return value?.version === MANIFEST_VERSION && value.commit === commit && value.entries ? value : null;
  } catch { return null; }
}

export function removeManifest(landedFile, commit) { rmSync(manifestPath(landedFile, commit), { force: true }); }

/**
 * `changed` is drift on its own evidence; `touched` is a same-size, same-mode
 * file whose mtime moved and which therefore still needs its content compared.
 */
export function compareManifest(root, manifest) {
  const actual = buildManifest(root, manifest.commit).entries;
  const missing = [], extra = [], changed = [], touched = [];
  for (const [key, want] of Object.entries(manifest.entries)) {
    const got = actual[key];
    if (!got) { missing.push(key); continue; }
    if (got[0] !== want[0] || got[1] !== want[1] || got[3] !== want[3] || (want[0] === 'l' && got[4] !== want[4])) { changed.push(key); continue; }
    if (want[0] === 'f' && got[2] !== want[2]) touched.push(key);
  }
  for (const key of Object.keys(actual)) if (!(key in manifest.entries)) extra.push(key);
  return { missing, extra, changed, touched };
}

// FIX 3's gate, read from the HOST side of the edition-state volume. An edition
// with assignment records has been commissioned: Brass bound a corpus commit
// into every receipt, the reporters are drafting against the tree that commit
// named, and moving the link under them would make the receipt cite research
// nobody read and let one reporter resolve an index from one commit and a story
// file from another.
//
// An absent path means "nothing commissioned", not an error: a fresh host has
// no edition state yet, and a refresher that refused to run until the newsroom
// had commissioned something would never let it.
export function commissionedEdition(stateRoot, edition) {
  const directory = path.join(stateRoot, 'editions', edition, 'assignments');
  let listing;
  try { listing = readdirSync(directory, { withFileTypes: true }); } catch { return { count: 0, commits: [] }; }
  const records = [];
  for (const entry of listing) {
    if (entry.isFile() && entry.name.endsWith('.json')) records.push(path.join(directory, entry.name));
    // Some newsroom records converge as <id>/<revision>.json rather than a flat
    // file, so one level down counts too: a commissioned edition must not look
    // uncommissioned because of a layout detail this module does not own.
    else if (entry.isDirectory()) {
      try { for (const inner of readdirSync(path.join(directory, entry.name))) if (inner.endsWith('.json')) records.push(path.join(directory, entry.name, inner)); }
      catch { /* raced away between readdir and read; the outer count still stands */ }
    }
  }
  const commits = new Set();
  for (const file of records) {
    try { const value = JSON.parse(readFileSync(file, 'utf8')); if (typeof value?.corpus?.commit === 'string') commits.add(value.corpus.commit); }
    catch { /* an unreadable receipt is still a commissioned edition */ }
  }
  return { count: records.length, commits: [...commits].sort() };
}
