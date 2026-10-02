#!/usr/bin/env node
// Puts every published edition in front of the newsroom, from the HOST, without
// building an image.
//
// WHAT IT REPLACES
// ----------------
// Published editions used to ride inside newsroom-runtime.tar. Every edition
// moved that archive's digest, publish-edition-branch.mjs repinned all twelve
// agent Spawnfiles to the new digest, origin/main moved in an image input, and
// the hourly release job rebuilt and redeployed the organization every night --
// for a change that was data. The editions and their byline indexes are now the
// team-shared `clank-newsroom-content` volume (agentic-org/Spawnfile), and this
// script is the only thing that is supposed to write it. See public-content.mjs
// for exactly which paths moved and why the rest of `content/` did not.
//
// THE CORPUS REFRESHER'S DISCIPLINE, REUSED RATHER THAN RE-ARGUED
// ---------------------------------------------------------------
// The research corpus left the image the same way (PR #200), and every hard rule
// that work established applies here unchanged, so the same primitives enforce
// them (corpus-volume.mjs, corpus-landed.mjs, corpus-verify.mjs,
// corpus-refresh-lock.mjs):
//
//   * content is extracted, validated, chowned and frozen OUTSIDE the volume and
//     lands with one rename(2); the reader-facing name `current` is replaced with
//     one rename(2) of a fresh symlink, never unlinked;
//   * an unvalidated tree is never reachable -- a refusal leaves the last good
//     content mounted, alarms, and exits non-zero;
//   * the host takes no decision from any name inside the volume: its record is
//     /var/lib/clank-content/landed.json, root-owned 0600, and every path it is
//     about to touch is lstat'd first;
//   * the mount is agent-writable (`mode: mutable`), so on every poll the served
//     tree is re-verified against the host's land-time manifest and against git,
//     drift alarms and re-lands itself, bounded by --heal-limit;
//   * one writer: the same flock(2) the corpus refresher and the release job
//     take, so no refresh ever interleaves with a container recreate, whose
//     startup guard walks every volume.
//
// WHAT IT LANDS
// -------------
// `content/editions/` and `content/bylines/` at origin/main's tip, from the build
// root the release job already fetches (`/root/work/clankandslop`), with the
// public deploy key the release job already uses. Keyed on the two git TREE ids,
// so a merge that changes only code is a no-op here, and an edition merge lands
// within one poll.
//
//     <volume>/current       -> trees/<commit>/content
//     <volume>/CONTENT.json     which commit and trees `current` serves
//     <volume>/trees/<commit>/content/{editions,bylines}   frozen, a-w
//
// USAGE
//   node agentic-org/scripts/content-refresh.mjs [--check] [--no-fetch] [...]
//   Every flag and default: content-refresh-options.mjs.

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { raiseDetached } from './alarm.mjs';
import { buildManifest, compareManifest, readManifest, removeManifest, sha256, writeManifest } from './corpus-landed.mjs';
import { LOCK_ENV, relayUnderLock } from './corpus-refresh-lock.mjs';
import { contentDrift, treeShape } from './corpus-verify.mjs';
import { SYMLINK_OPS, TREES_DIR, VOLUME_IDENTITY_SENTINEL, applyOwner, assertRealDirectory, assertSameDevice, assertTreesDirectory, assertVolumeRoot, collectGarbage, freeze, hostExec, isoSeconds, landFrozenTree, pointAtTree, removeTree } from './corpus-volume.mjs';
import { contentIdentity, readContentIdentityBytes, readContentLanded, writeContentIdentity, writeContentLanded, CONTENT_LANDED_VERSION } from './content-landed.mjs';
import { contentRefreshArgs } from './content-refresh-options.mjs';
import { validateContentTree } from './content-validate.mjs';
import { fetchTracked } from './release-git.mjs';
import { CONTENT_IDENTITY_FILE, CONTENT_LINK, PUBLIC_CONTENT_DIRS, PUBLIC_CONTENT_PATHS, PublicContentError } from './public-content.mjs';

// alarm.mjs's vocabulary is closed; an unregistered word is no alarm at all.
export const CONTENT_REFUSAL_REASON = 'content-refresh-failed';
export const CONTENT_TAMPER_REASON = 'content-tampered';
export const CONTENT_ALARM_REASONS = Object.freeze([CONTENT_REFUSAL_REASON, CONTENT_TAMPER_REASON]);
export const ROOT_NAMES = Object.freeze([VOLUME_IDENTITY_SENTINEL, CONTENT_IDENTITY_FILE, TREES_DIR, CONTENT_LINK]);

const refuse = (message) => { const error = new PublicContentError(message); error.alarm = true; throw error; };
const linkTarget = (commit) => `${TREES_DIR}/${commit}/content`;
const gitOut = (exec, repo, args) => exec('git', ['-C', repo, ...args]).toString().trim();

/** The tip and the two tree ids an edition merge moves. */
export function resolveContent(options, { exec = hostExec } = {}) {
  let commit, trees;
  try {
    commit = gitOut(exec, options.repo, ['rev-parse', '--verify', `${options.track}^{commit}`]);
    trees = Object.fromEntries(PUBLIC_CONTENT_DIRS.map((dir) => [dir, gitOut(exec, options.repo, ['rev-parse', '--verify', `${commit}:content/${dir}`])]));
  } catch (error) { refuse(`cannot resolve ${options.track} and its published content in ${options.repo}: ${String(error.message).trim().slice(0, 200)}`); }
  return { commit, trees };
}

const sameTrees = (a, b) => PUBLIC_CONTENT_DIRS.every((dir) => a?.[dir] === b?.[dir]);

function prepareWorkRoots(options) {
  assertVolumeRoot(options.volume);
  for (const [label, directory] of [['staging root', options.staging], ['trash root', options.trash]]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertSameDevice(options.volume, directory, label);
  }
  if (!assertTreesDirectory(options.volume)) mkdirSync(path.join(options.volume, TREES_DIR));
}

// Extract -> validate -> chown -> freeze, all OUTSIDE the volume, then one
// rename in. A tree already present is reused only when the host's own manifest
// still describes it; anything else is re-extracted.
function stage(options, { commit, log, exec, now, force }) {
  const treePath = path.join(options.volume, TREES_DIR, commit);
  const existing = assertRealDirectory(treePath, `the content tree ${TREES_DIR}/${commit.slice(0, 7)}`);
  if (existing && !force) {
    const manifest = readManifest(options.landed, commit);
    const compared = manifest ? compareManifest(treePath, manifest) : null;
    if (compared && !compared.missing.length && !compared.extra.length && !compared.changed.length) return { treePath, editions: validateContentTree(treePath, { repo: options.repo, commit, exec }), parked: null };
  }
  const stagingDir = path.join(options.staging, `${commit}-${process.pid}`);
  removeTree(stagingDir, { volume: options.volume, exec });
  mkdirSync(stagingDir, { recursive: true });
  let editions;
  try {
    const archive = exec('git', ['-C', options.repo, 'archive', '--format=tar', commit, '--', ...PUBLIC_CONTENT_PATHS.map((prefix) => prefix.replace(/\/$/u, ''))]);
    exec('tar', ['-x', '-C', stagingDir], { input: archive });
    editions = validateContentTree(stagingDir, { repo: options.repo, commit, exec });
    applyOwner(stagingDir, options.owner, { volume: options.volume, exec });
    freeze(stagingDir, { volume: options.volume, exec });
  } catch (error) {
    try { removeTree(stagingDir, { volume: options.volume, exec }); } catch { /* reported by the refusal itself */ }
    error.alarm = true;
    throw error;
  }
  // Park and land back to back: `current` dangles only across these two renames.
  let parked = null;
  if (existing) {
    parked = path.join(options.trash, `${commit}-evicted-${isoSeconds(now).replace(/[:-]/gu, '')}.${process.pid}`);
    try { chmodSync(treePath, 0o755); } catch { /* already writable */ }
    renameSync(treePath, parked);
  }
  try { landFrozenTree(stagingDir, treePath); }
  catch (error) {
    if (parked && !existsSync(treePath)) { try { renameSync(parked, treePath); chmodSync(treePath, 0o555); } catch { /* the refusal below says enough */ } }
    throw error;
  }
  log(`staged ${TREES_DIR}/${commit.slice(0, 7)}: ${editions} published edition(s)`);
  return { treePath, editions, parked };
}

export function land(options, { commit, trees, landed, now, log, alarm, exec, ops, force = false, heals = {} }) {
  prepareWorkRoots(options);
  const { treePath, editions, parked } = stage(options, { commit, log, exec, now, force });
  pointAtTree(options.volume, CONTENT_LINK, linkTarget(commit), { ops, tmpDir: options.staging });
  const identity = contentIdentity({ commit, ref: options.track, contentTrees: trees, editions, landedAt: isoSeconds(now) });
  const identitySha = writeContentIdentity(options.volume, identity, { owner: options.owner, tmpDir: options.staging, exec });
  writeManifest(options.landed, buildManifest(treePath, commit));
  // The delete, last: `current` already points at the replacement.
  if (parked) { try { removeTree(parked, { volume: options.volume, exec }); } catch (error) { log(`could not delete the replaced tree parked at ${parked}: ${error.message}`); } }
  let known = [...new Set([...(landed?.trees ?? []), commit])].sort();
  const record = (list) => ({ version: CONTENT_LANDED_VERSION, commit, content_trees: { ...trees }, trees: list, editions, identity_sha256: identitySha, landed_at: isoSeconds(now), noted: null, heals });
  writeContentLanded(options.landed, record(known));
  const gc = collectGarbage(options.volume, { known, live: [commit], keep: options.keep, trash: options.trash, now, exec });
  for (const name of gc.removed) removeManifest(options.landed, name);
  if (gc.removed.length) { known = known.filter((name) => !gc.removed.includes(name)); writeContentLanded(options.landed, record(known)); }
  if (gc.unknown.length) alarm(CONTENT_TAMPER_REASON, { message: `${gc.unknown.length} unknown entr(y/ies) under the content volume's ${TREES_DIR}/`, detail: gc.unknown.join('\n') });
  log(`content ${landed?.commit?.slice(0, 7) ?? '(none)'} -> ${commit.slice(0, 7)}: ${editions} published edition(s) behind ${CONTENT_LINK}`);
  return { changed: true, current: true, commit, editions, treesRemoved: gc.removed };
}

// Everything compared comes from outside the volume; everything found is said.
export function sweep(options, { record, exec }) {
  const findings = [], volume = options.volume;
  const unknown = readdirSync(volume).filter((name) => !ROOT_NAMES.includes(name)).sort();
  for (const name of unknown) findings.push(`${name} is a name this host never writes at the content volume root`);
  const treePath = path.join(volume, TREES_DIR, record.commit);
  const shape = treeShape(treePath);
  let drift = shape === 'missing', planted = shape !== 'missing' && shape !== 'directory';
  if (drift) findings.push(`${TREES_DIR}/${record.commit.slice(0, 7)} is missing`);
  if (planted) findings.push(`${TREES_DIR}/${record.commit.slice(0, 7)} is a ${shape}, not the tree this host landed`);
  let touched = [];
  if (shape === 'directory') {
    const manifest = readManifest(options.landed, record.commit);
    const compared = manifest ? compareManifest(treePath, manifest) : null;
    if (!compared) { drift = true; findings.push(`no land-time manifest for ${record.commit.slice(0, 7)}`); }
    else {
      const bad = [...compared.missing.map((key) => `${key} missing`), ...compared.extra.map((key) => `${key} added`), ...compared.changed.map((key) => `${key} changed`)];
      const rewritten = contentDrift(treePath, compared.touched, { privateRepo: options.repo, commit: record.commit, exec });
      bad.push(...rewritten.map((key) => `${key} rewritten`));
      if (bad.length) { drift = true; findings.push(...bad.slice(0, 20), ...(bad.length > 20 ? [`... and ${bad.length - 20} more`] : [])); }
      touched = compared.touched.filter((key) => !rewritten.includes(key));
    }
  }
  let link = null;
  try { link = lstatSync(path.join(volume, CONTENT_LINK)).isSymbolicLink() ? readlinkSync(path.join(volume, CONTENT_LINK)) : 'not a symlink'; } catch { link = 'missing'; }
  const relink = link !== linkTarget(record.commit) && link !== 'not a symlink';
  if (link !== linkTarget(record.commit)) findings.push(`${CONTENT_LINK} is ${link === 'missing' || link === 'not a symlink' ? link : `-> ${link}`}, want -> ${linkTarget(record.commit)}`);
  const bytes = readContentIdentityBytes(volume);
  const identity = !bytes || sha256(bytes) !== record.identity_sha256;
  if (identity) findings.push(`${CONTENT_IDENTITY_FILE} is not the record this host published`);
  return { findings, drift, planted, relink, blocked: link === 'not a symlink', identity, touched, unknown };
}

export function refresh(argv = [], { now = new Date(), log = console.log, alarm = raiseDetached, ops = SYMLINK_OPS, exec = hostExec } = {}) {
  const options = contentRefreshArgs(argv);
  if (options.fetch) {
    try { fetchTracked({ repo: options.repo, track: options.track, key: options.key }, { exec, log }); }
    catch (error) {
      // An unreachable remote is "not yet": the last good content stays mounted
      // and the next poll retries. A refused identity will not clear by itself.
      if (error?.unreachable) { log(`content kept as landed: ${error.message.split('\n')[0]}`); return { changed: false, current: true, waiting: true }; }
      error.alarm = true; throw error;
    }
  }
  const { commit, trees } = resolveContent(options, { exec });
  const { record, reason } = readContentLanded(options.landed);
  if (reason) log(`ignoring the host record: ${reason} -- treating this volume as carrying nothing`);
  if (!record || !sameTrees(record.content_trees, trees)) {
    log(`refresh needed: ${record ? `content trees moved since ${record.commit.slice(0, 7)}` : 'nothing landed'} -> ${commit.slice(0, 7)}`);
    if (options.check) return { changed: false, current: false, commit };
    return land(options, { commit, trees, landed: record, now, log, alarm, exec, ops });
  }
  log(`content already current: ${record.commit.slice(0, 7)} serves the published content at ${commit.slice(0, 7)}`);
  if (!options.verify) return { changed: false, current: true, commit: record.commit };
  return heal(options, { record, trees, now, log, alarm, exec, ops });
}

function heal(options, { record, trees, now, log, alarm, exec, ops }) {
  const found = sweep(options, { record, exec });
  if (!found.findings.length) {
    if (!options.check && (record.noted || Object.keys(record.heals ?? {}).length)) writeContentLanded(options.landed, { ...record, noted: null, heals: {} });
    return { changed: false, current: true, commit: record.commit };
  }
  for (const finding of found.findings) log(`TAMPER: ${finding}`);
  const digest = sha256(found.findings.join('\n'));
  const cycles = record.heals?.[record.commit]?.cycles ?? 0;
  const suspended = found.drift && cycles >= options.healLimit;
  const repairing = (found.drift && !suspended) || found.relink || found.identity;
  if (repairing || record.noted !== digest) alarm(CONTENT_TAMPER_REASON, { message: suspended ? `content auto-repair suspended after ${cycles} re-lands of ${record.commit.slice(0, 7)}` : `content volume tampered: ${found.findings[0]}`, detail: found.findings.join('\n') });
  const serviceable = !found.planted && !found.blocked;
  if (options.check) return { changed: false, current: false, commit: record.commit, findings: found.findings };
  if (found.drift && !suspended && !found.planted) {
    log(`re-landing ${record.commit.slice(0, 7)} from git so the newsroom heals itself`);
    const heals = { ...record.heals, [record.commit]: { cycles: cycles + 1, since: record.heals?.[record.commit]?.since ?? isoSeconds(now), last: isoSeconds(now) } };
    return { ...land(options, { commit: record.commit, trees, landed: record, now, log, alarm, exec, ops, force: true, heals }), findings: found.findings };
  }
  if (found.relink && !found.planted) pointAtTree(options.volume, CONTENT_LINK, linkTarget(record.commit), { ops, tmpDir: options.staging });
  let next = { ...record, noted: digest };
  if (found.identity && !found.planted) {
    const identity = contentIdentity({ commit: record.commit, ref: options.track, contentTrees: record.content_trees, editions: record.editions, landedAt: record.landed_at ?? isoSeconds(now) });
    next = { ...next, identity_sha256: writeContentIdentity(options.volume, identity, { owner: options.owner, tmpDir: options.staging, exec }) };
  }
  if (found.touched.length && !found.drift) writeManifest(options.landed, buildManifest(path.join(options.volume, TREES_DIR, record.commit), record.commit));
  writeContentLanded(options.landed, next);
  return { changed: found.relink || found.identity, current: serviceable && !suspended, commit: record.commit, findings: found.findings, suspended, announced: repairing || record.noted !== digest };
}

export function main(argv = [], { log = console.log, alarm = raiseDetached, env = process.env, spawn = spawnSync, script = import.meta.filename, ...rest } = {}) {
  try {
    const options = contentRefreshArgs(argv);
    if (options.lock && !options.check && env[LOCK_ENV] !== options.lock) return relayUnderLock(options, argv, { env, spawn, script, log });
    const result = refresh(argv, { log, alarm, ...rest });
    // A non-zero exit is an OnFailure page, so it means "something NEW is wrong".
    // An unchanged operator-only state has already paged once through the alarm.
    if (result.current || result.changed || result.waiting) return 0;
    return result.announced === false && !options.check ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof PublicContentError ? error.message : error.stack}\n`);
    if (error?.alarm) alarm(CONTENT_REFUSAL_REASON, { message: `public content refresh refused: ${String(error.message).split('\n')[0]}`, detail: error.stack ?? error.message });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
