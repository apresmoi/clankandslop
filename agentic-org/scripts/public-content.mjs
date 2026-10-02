// The day-varying public content -- every published edition and the byline
// indexes derived from them -- and the one rule about where it lives.
//
// WHY THIS IS NOT IN THE IMAGE ANY MORE
// -------------------------------------
// The source archive (newsroom-runtime.tar, mounted at ./repos/newsroom) used to
// be every tracked file, so `content/editions/<date>/**` was inside it. Landing
// an edition therefore moved the archive digest, publish-edition-branch.mjs
// repinned all twelve agent Spawnfiles to the new digest, `main` moved, and the
// hourly release job (`seam-run.mjs --if-changed`) rebuilt and redeployed the
// whole organization every night -- for a change that was data, not code. The
// research corpus had the same defect and the same cure (PR #200): the content
// is now the team-shared `clank-newsroom-content` volume, populated on the HOST
// from origin/main by content-refresh.mjs, and nothing in the image changes when
// an edition is published.
//
// WHAT MOVED, EXACTLY
// -------------------
// Only the paths below. Everything else under `content/` is not day-varying and
// stays in the image: `agents/` (the persona roster), `topics.json` and its
// generated view `topics.txt`, `log/` and `fixtures/`. The site build code
// (`website/`), the validators (`ops/`) and every runtime script stay in the
// image too -- they are code, and code still ships through a release.
//
// ONE PREDICATE, FOUR READERS
// ---------------------------
// This list is read by the source archive (what is excluded from the image), the
// release gate (a merge that touches only these paths is already released), the
// host refresher (what it lands in the volume) and the edition publisher (what an
// edition commit may contain). They cannot disagree because there is only one of
// it; merge-edition.yml spells the same list in YAML and a test holds the two
// equal.
//
// WHY A SIBLING MOUNT AND NOT ./repos/newsroom/content
// ---------------------------------------------------
// The compiler refuses overlapping workspace mounts (a volume inside a bundle's
// mount is an "overlapping mounts" validation error), and a symlink packed into
// the archive cannot point at the volume: a team volume's backing path embeds a
// hash of the absolute path of the Spawnfile on the build host. So the volume is
// mounted beside the code at ./repos/newsroom-content, and its `current` link is
// what every reader resolves: `current/editions/<date>/...`, `current/bylines/`.

import { lstatSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { cp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

export const PUBLIC_CONTENT_PATHS = Object.freeze(['content/editions/', 'content/bylines/']);
export const PUBLIC_CONTENT_DIRS = Object.freeze(['editions', 'bylines']);

/** True for a repository path that is served from the content volume and is therefore not an image input. */
export const isPublicContentPath = (name) => typeof name === 'string' && PUBLIC_CONTENT_PATHS.some((prefix) => name.startsWith(prefix));

export const CONTENT_VOLUME_NAME = 'clank-newsroom-content';
export const CONTENT_MOUNT = './repos/newsroom-content';
// The one name a reader resolves; the host swaps it with a single rename(2).
export const CONTENT_LINK = 'current';
export const CONTENT_IDENTITY_FILE = 'CONTENT.json';
export const CONTENT_IDENTITY_VERSION = 'clank.public-content.v1';
// The environment variable every in-container reader is handed: the volume's
// mount point. Unset means a developer checkout, where `content/` is the tree.
export const CONTENT_VOLUME_ENV = 'CLANK_PUBLIC_CONTENT_VOLUME';

export class PublicContentError extends Error {}
const fail = (message) => { throw new PublicContentError(message); };

const COMMIT = /^[0-9a-f]{40}$/u;
const TREE = /^[0-9a-f]{40}$/u;

/** Every way a CONTENT.json record is not one the host would have written. Empty means valid. */
export function contentIdentityFindings(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return ['must be a JSON object'];
  const findings = [];
  if (record.version !== CONTENT_IDENTITY_VERSION) findings.push(`version must be ${CONTENT_IDENTITY_VERSION}, got ${JSON.stringify(record.version)}`);
  if (!COMMIT.test(record.commit ?? '')) findings.push(`commit must be a 40-character lowercase hex sha, got ${JSON.stringify(record.commit)}`);
  if (typeof record.ref !== 'string' || !record.ref) findings.push('ref must name the tracked ref the content was landed from');
  if (record.tree !== `trees/${record.commit}/content`) findings.push(`tree must be trees/<commit>/content, got ${JSON.stringify(record.tree)}`);
  for (const dir of PUBLIC_CONTENT_DIRS) if (!TREE.test(record.content_trees?.[dir] ?? '')) findings.push(`content_trees.${dir} must be the git tree id the host landed`);
  if (!Number.isInteger(record.editions) || record.editions < 1) findings.push(`editions must be a positive count, got ${JSON.stringify(record.editions)}`);
  if (typeof record.landed_at !== 'string' || !record.landed_at) findings.push('landed_at must be an instant');
  return findings;
}

/**
 * Where the published editions and bylines are, for this process.
 *
 * Inside the container the volume is handed in through CLANK_PUBLIC_CONTENT_VOLUME,
 * and the answer is its `current` link -- but only once the host has landed
 * something there. FAIL CLOSED: a volume that is empty, half-written or carries
 * no valid CONTENT.json is a refusal that says so, never a silently empty archive.
 * An archive index that quietly came back empty would let compose_edition refuse
 * every archived map, and let a site build ship without the back catalogue.
 *
 * Without the variable this is a developer or CI checkout, where `content/` under
 * the repository root is the tree itself.
 */
export function publicContentRoot({ env = process.env, repo = path.resolve(import.meta.dirname, '..', '..') } = {}) {
  const volume = env[CONTENT_VOLUME_ENV];
  if (volume === undefined || volume === '') return path.join(repo, 'content');
  if (!path.isAbsolute(volume)) fail(`${CONTENT_VOLUME_ENV} must be an absolute path, got ${JSON.stringify(volume)}`);
  let record;
  try { record = JSON.parse(readFileSync(path.join(volume, CONTENT_IDENTITY_FILE), 'utf8')); }
  catch (error) { fail(`the public content volume at ${volume} has no readable ${CONTENT_IDENTITY_FILE} (${error.code ?? error.message}) -- the host has not landed the published editions yet, so nothing that reads past editions can be trusted. The host job is clank-content-refresh.service.`); }
  const findings = contentIdentityFindings(record);
  if (findings.length) fail(`the public content volume's ${CONTENT_IDENTITY_FILE} is invalid: ${findings.join('; ')}`);
  const root = path.join(volume, CONTENT_LINK);
  for (const dir of PUBLIC_CONTENT_DIRS) {
    let info = null;
    try { info = statSync(path.join(root, dir)); } catch { /* reported below */ }
    if (!info?.isDirectory()) fail(`the public content volume at ${volume} does not serve ${CONTENT_LINK}/${dir}/ -- refusing to read past editions from a volume the host has not landed`);
  }
  return root;
}

/** The published editions directory for this process; see publicContentRoot. */
export const publicEditionsRoot = (options) => path.join(publicContentRoot(options), 'editions');

// --- pressman's release candidate ----------------------------------------------
// The private release adapter copies CLANK_PUBLIC_SOURCE_ROOT into a scratch
// candidate and runs ops/validate-content.mjs and `astro build` inside it. That
// tree now carries the code and no published editions, so the editions and
// bylines are laid over it from the volume -- the SAME `current` the agents read,
// resolved once, so a host swap mid-copy cannot mix two commits into one build.
// It is the helper the adapter is handed (`helpers.stagePublicSource`), so the
// private adapter did not have to change.
export async function stagePublicSource(source, temporary, filter, { env = process.env, makeOwnerWritable } = {}) {
  await cp(source, temporary, { recursive: true, dereference: true, filter });
  const volume = env[CONTENT_VOLUME_ENV];
  if (volume !== undefined && volume !== '') {
    const pinned = path.join(volume, currentTarget(publicContentRoot({ env })));
    for (const dir of PUBLIC_CONTENT_DIRS) {
      const target = path.join(temporary, 'content', dir);
      await rm(target, { recursive: true, force: true });
      await cp(path.join(pinned, dir), target, { recursive: true, dereference: true, filter });
    }
  }
  // Fail closed for both shapes: a candidate without the back catalogue builds a
  // site that silently drops every past edition.
  const editions = await readdir(path.join(temporary, 'content', 'editions')).catch(() => []);
  if (!editions.some((name) => /^\d{4}-\d{2}-\d{2}$/u.test(name))) fail(`the release candidate at ${temporary} carries no published editions under content/editions -- refusing to build a site without its back catalogue`);
  if (makeOwnerWritable) await makeOwnerWritable(temporary);
}

// `current` -> trees/<commit>/content. Read as a link rather than realpath'd, so
// the copy names the tree the link pointed at when it was read even if the host
// repoints it a millisecond later; the old tree outlives the swap (keep >= 1).
function currentTarget(root) {
  const info = lstatSync(root);
  if (!info.isSymbolicLink()) fail(`${root} is not the host's ${CONTENT_LINK} link`);
  const target = readlinkSync(root);
  if (!/^trees\/[0-9a-f]{40}\/content$/u.test(target)) fail(`${root} points at ${JSON.stringify(target)}, not trees/<commit>/content`);
  return target;
}
