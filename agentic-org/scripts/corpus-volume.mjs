// The physical layout of the read-only research-corpus volume, and every rule
// about what a host-side writer may and may not touch inside it.
//
// WHY THESE RULES ARE NOT NEGOTIABLE
// ----------------------------------
// The volume is mounted into all twelve agents, and the container's startup
// guard walks the WHOLE volume on every start: it readdirs the tree, stats
// what it found, and aborts the start if anything it listed cannot be stat'd
// or if the resource-identity sentinel is not exactly as it left it. So a
// writer on the host can kill every agent's container without writing a single
// byte an agent would ever read:
//
//   * a partially extracted tree, or a tree mid-delete, inside the volume
//     -> readdir sees an entry that is gone by the time it is stat'd -> abort;
//   * one `chown -R` or `chmod -R` with the volume ROOT as its target
//     -> .spawnfile-resource-identity changes owner or mode -> abort, and the
//        org is bricked until the sentinel is repaired by hand;
//   * the volume root's own mode moved off 0755
//     -> "volume identity parent is unsafe" -> abort.
//
// Hence the shape every function here enforces: content is extracted OUTSIDE
// the volume, lands inside it through exactly one rename(2), leaves it through
// exactly one rename(2), and no recursive mode or ownership change is ever
// aimed at anything but a tree the host still owns privately.
//
//     <staging>/<commit>-<pid>/    extracted, validated, chowned, frozen here
//         |  rename(2)
//     <volume>/trees/<commit>/     immutable content, a-w, never rewritten
//     <volume>/<date>  ->  trees/<commit>/<date>    rename(2) over the old link
//     <volume>/CORPUS.json         which commit the links point at
//         |  rename(2)
//     <trash>/<commit>-<stamp>/    deleted out here, never inside the volume
//
// READ-ONLY IS THE HOST'S JOB
// ---------------------------
// Nothing in the container makes the corpus read-only: the entrypoint runs as
// uid 2000 with no capabilities, so a `chmod -R` from inside cannot touch the
// root-owned sentinel and aborts the start. `applyOwner` + `freeze` on the
// staging tree, before it is reachable, is the only thing standing between the
// agents and a writable corpus.

import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CORPUS_IDENTITY_FILE, CORPUS_IDENTITY_VERSION, CorpusError, EDITION_PATTERN, corpusIdentityFindings } from './corpus-contract.mjs';

export const TREES_DIR = 'trees';
export const VOLUME_IDENTITY_SENTINEL = '.spawnfile-resource-identity';
export const VOLUME_ROOT_MODE = 0o755;

const fail = (message) => { throw new CorpusError(message); };

// Every external command the host writer runs, in one place, so a test can watch
// exactly which trees were chowned and frozen.
//
// stdin is 'ignore' EXCEPT when the caller pipes bytes in: `stdio[0]: 'ignore'`
// silently wins over `input`, and `tar -x` then extracts nothing and exits 0 --
// a staged corpus that is simply empty, with no error anywhere to say so.
export const hostExec = (command, args, options = {}) => execFileSync(command, args, {
  maxBuffer: 1024 * 1024 * 1024, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...options
});

/** Seconds, not milliseconds: these timestamps are read by people in a ledger, and a corpus is never written twice in one second. */
export const isoSeconds = (date) => `${date.toISOString().slice(0, 19)}Z`;

export const treeLinkTarget = (commit, date) => `${TREES_DIR}/${commit}/${date}`;

/** Every dated corpus directory in `root`. One commit carries EVERY day's corpus, not just its own. */
export function datedDirectories(root) {
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && EDITION_PATTERN.test(entry.name)).map((entry) => entry.name).sort();
}

// Read before any write, and a refusal rather than a repair: 0755 is what the
// container's startup guard requires of the sentinel's parent, and a host-side
// job that "fixed" the volume root's mode would be guessing at a contract it
// does not own.
export function assertVolumeRoot(volume) {
  let stat;
  try { stat = statSync(volume); } catch { return fail(`corpus volume ${volume} does not exist -- create the docker volume before refreshing it`); }
  if (!stat.isDirectory()) fail(`corpus volume ${volume} is not a directory`);
  const mode = stat.mode & 0o7777;
  if (mode !== VOLUME_ROOT_MODE) {
    fail(`corpus volume root ${volume} is mode 0${mode.toString(8)}, must be 0${VOLUME_ROOT_MODE.toString(8)}.\n`
      + `  The container's startup guard refuses a volume whose ${VOLUME_IDENTITY_SENTINEL} parent is unsafe, so every agent container would fail to start on its next recreate.\n`
      + `  Repair with: chmod 0${VOLUME_ROOT_MODE.toString(8)} ${volume}`);
  }
  return stat;
}

// Atomicity here is not a style preference, it is the only reason agents can
// keep reading while the corpus is replaced -- and rename(2) is atomic only
// within one filesystem. Checked instead of assumed because the staging and
// trash roots live outside the volume by design, where a separate mount would
// silently turn every rename into a copy-and-delete.
export function assertSameDevice(volume, other, label) {
  const volumeDevice = statSync(volume).dev, otherDevice = statSync(other).dev;
  if (volumeDevice !== otherDevice) {
    fail(`${label} ${other} is on device ${otherDevice} but the corpus volume ${volume} is on device ${volumeDevice}.\n`
      + '  Every corpus swap depends on rename(2), which cannot cross filesystems; a cross-device move would copy into the volume while agents read it.\n'
      + `  Put ${label} on the same filesystem as the volume.`);
  }
}

// The guard that keeps a recursive chown or chmod away from the volume root,
// and therefore away from .spawnfile-resource-identity. One such call is enough
// to brick the organization, so the target is checked every time rather than
// trusted to the call site.
function assertScoped(target, volume) {
  // Resolved through symlinks, not merely normalized: a lexical comparison
  // would wave through any symlinked spelling of the volume root, and this
  // guard is the last thing between a typo and a bricked organization.
  const scope = canonicalPath(target), root = canonicalPath(volume);
  const toRoot = path.relative(scope, root);
  if (toRoot === '' || !toRoot.startsWith('..')) {
    fail(`refusing to apply a recursive ownership or mode change to ${scope}: it contains the corpus volume root ${root}.\n`
      + `  That would rewrite ${VOLUME_IDENTITY_SENTINEL}, which the container's startup guard requires to be root:root mode 0644 with its exact bytes.`);
  }
}

const canonicalPath = (target) => realpathOrNull(target) ?? path.resolve(target);

/** Ownership for everything the agents will read. The host runs this as root; the uid is the one the agents run as. */
export function applyOwner(target, owner, { volume, exec = hostExec } = {}) {
  if (volume) assertScoped(target, volume);
  exec('chown', ['-R', owner, target]);
}

// Read-only before it is reachable. Nothing inside the container can do this, so
// it happens here or not at all.
//
// The top directory is left writable and re-frozen by `landFrozenTree` after the
// move, because rename(2) of a directory into a different parent needs write
// permission on the directory being moved: freezing it first would make the one
// rename this whole design rests on fail for any writer that is not root.
export function freeze(target, { volume, exec = hostExec } = {}) {
  if (volume) assertScoped(target, volume);
  exec('chmod', ['-R', 'a-w', target]);
  chmodSync(target, 0o755);
}

/** The one rename that makes a validated tree part of the volume, with its root frozen the moment it lands. */
export function landFrozenTree(stagingDir, treePath) {
  renameSync(stagingDir, treePath);
  // Non-recursive, and aimed at one directory inside the volume: the recursive
  // pass already happened outside it, and this entry is not reachable through
  // any dated link yet.
  chmodSync(treePath, 0o555);
  return treePath;
}

// A frozen tree's own directories are unwritable, so its files cannot be
// unlinked until write is restored. Root ignores that; the owner does not, and
// a cleanup that silently failed would fill the disk the daily image build used
// to. Only ever called on a path OUTSIDE the volume.
export function removeTree(target, { volume, exec = hostExec } = {}) {
  if (volume) assertScoped(target, volume);
  try { exec('chmod', ['-R', 'u+w', target]); } catch { /* already writable, or already gone */ }
  rmSync(target, { recursive: true, force: true });
}

// Every filesystem call the symlink swap makes, in one place, so a test can
// watch what the swap actually does rather than trust a comment. See pointAtTree.
export const SYMLINK_OPS = Object.freeze({ lstat: lstatSync, readlink: readlinkSync, symlink: symlinkSync, rename: renameSync, unlink: unlinkSync });

// ATOMIC OR NOTHING
// -----------------
// Twelve agents read ./repos/newsroom-private/<date> on their own schedule and
// none of them is paused for this. So the live name is NEVER unlinked: a new
// symlink is created under a temporary name and rename(2)'d over the live one,
// which replaces it in a single step. An agent sees the old tree or the new
// one, never a missing or dangling path. `unlink` here only ever touches that
// temporary name, left behind by a crashed run.
//
// `tmpDir` is OUTSIDE the volume by default at the call site, so the volume
// root never gains a transient entry the container's startup walk could trip
// over. The link target is relative, so it resolves the same at the host path
// and at the container's mount point wherever the link is created.
export function pointAtTree(volume, name, target, { ops = SYMLINK_OPS, tmpDir = volume } = {}) {
  const live = path.join(volume, name);
  let existing = null;
  try { existing = ops.lstat(live); } catch { /* absent: the first corpus for this date */ }
  if (existing && !existing.isSymbolicLink()) fail(`${live} is a real ${existing.isDirectory() ? 'directory' : 'file'}, not a symlink into ${TREES_DIR}/ -- refusing to replace corpus data this job did not write`);
  if (existing && ops.readlink(live) === target) return false;
  const tmp = path.join(tmpDir, `.${name}.${process.pid}.tmp`);
  try { ops.unlink(tmp); } catch { /* no leftover from a crashed run */ }
  ops.symlink(target, tmp);
  ops.rename(tmp, live);
  return true;
}

export function readIdentity(volume) {
  try { return JSON.parse(readFileSync(path.join(volume, CORPUS_IDENTITY_FILE), 'utf8')); } catch { return null; }
}

/** Exactly the record the container reads. The field list IS the contract, so it is built in one place. */
export function corpusIdentity({ commit, ref, edition, fetchedAt, editionsPresent, sourceCount }) {
  return {
    version: CORPUS_IDENTITY_VERSION,
    commit,
    // The ref NAME, not the resolved refs/remotes/... form: `edition/2026-10-02`
    // is what a producer, a runbook and an agent all recognize.
    ref,
    edition,
    fetched_at: fetchedAt,
    tree: `${TREES_DIR}/${commit}`,
    editions_present: [...editionsPresent].sort(),
    source_count: sourceCount
  };
}

// Refuses to publish a record that does not satisfy the contract: a reader that
// cannot validate CORPUS.json treats the corpus as unusable, so an invalid
// record is worse than an old one. The bytes are validated AFTER they are on
// disk and BEFORE they are visible -- reparsing what the filesystem actually
// holds is what catches a truncated write, which validating the object cannot.
export function writeIdentity(volume, record, { edition, owner, tmpDir, exec = hostExec } = {}) {
  const planned = corpusIdentityFindings(record, { edition });
  if (planned.length) fail(`refusing to publish an invalid ${CORPUS_IDENTITY_FILE}: ${planned.join('; ')}`);
  const live = path.join(volume, CORPUS_IDENTITY_FILE);
  const tmp = path.join(tmpDir ?? volume, `.${CORPUS_IDENTITY_FILE}.${process.pid}.tmp`);
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o444 });
  let written = null;
  try { written = JSON.parse(readFileSync(tmp, 'utf8')); } catch { /* reported as a finding below */ }
  const findings = written === null ? [`${CORPUS_IDENTITY_FILE} did not survive the write as parseable JSON`] : corpusIdentityFindings(written, { edition });
  if (findings.length) { rmSync(tmp, { force: true }); fail(`${CORPUS_IDENTITY_FILE} failed validation after it was written: ${findings.join('; ')}`); }
  // Scoped to the one file, never `-R` from the volume root.
  if (owner) exec('chown', [owner, tmp]);
  exec('chmod', ['0444', tmp]);
  renameSync(tmp, live);
  return record;
}

// Trees are cheap to keep and catastrophic to lose mid-read, so nothing a
// symlink resolves into is ever a candidate -- not even a stale date nobody
// will read again. `protect` carries the commit CORPUS.json names, which is
// never deleted even if the links have since moved on.
//
// The doomed tree leaves the volume with ONE rename -- one directory entry
// removed -- and is deleted outside it. A recursive delete in place would
// unlink thousands of entries under the container's startup walk.
export function collectGarbage(volume, { keep, protect = [], trash, now = new Date(), exec = hostExec, remove = removeTree } = {}) {
  // No default: an absent `keep` would slice from 0 and sweep every spare tree,
  // which is the one mistake here that cannot be undone.
  if (!Number.isInteger(keep) || keep < 0) fail(`collectGarbage needs how many unreferenced trees to keep, got ${JSON.stringify(keep)}`);
  const treesDir = path.join(volume, TREES_DIR);
  let names;
  try { names = readdirSync(treesDir).sort(); } catch { return []; }
  const live = new Set(protect);
  for (const name of readdirSync(volume)) {
    if (!EDITION_PATTERN.test(name)) continue;
    let target;
    try { target = readlinkSync(path.join(volume, name)); } catch { continue; }
    const relative = path.relative(treesDir, path.resolve(volume, target));
    const [first] = relative.split(path.sep);
    if (first && first !== '..' && !path.isAbsolute(relative)) live.add(first);
  }
  const doomed = names.filter((name) => !live.has(name))
    .map((name) => ({ name, mtime: statSync(path.join(treesDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(keep);
  const stamp = `${isoSeconds(now).replace(/[:-]/g, '')}.${process.pid}`;
  for (const entry of doomed) {
    const parked = path.join(trash, `${entry.name}-${stamp}`);
    const tree = path.join(treesDir, entry.name);
    // Same reason as landFrozenTree: a frozen directory cannot be renamed into
    // another parent until its own write bit is back.
    try { chmodSync(tree, 0o755); } catch { /* already writable */ }
    renameSync(tree, parked);
    remove(parked, { volume, exec });
  }
  return doomed.map((entry) => entry.name);
}

/** Where a dated corpus link points, read the way an agent would read it -- null when it is absent, dangling, or not a symlink at all. */
export function resolveCorpusLink(root, name) {
  const link = path.join(root, name);
  try { if (!lstatSync(link).isSymbolicLink()) return null; } catch { return null; }
  return realpathOrNull(link);
}

export function realpathOrNull(target) {
  try { return realpathSync(target); } catch { return null; }
}
