#!/usr/bin/env node
// The disk cleanup step of clank-release.service, run before its 20 GiB floor.
//
// Spawnfile prunes old release tags but keeps build cache, and a release
// refused to start on 2026-11-06 at 12 GiB free with stale cache and an unused
// release image on disk. This step frees only what a release can rebuild:
//
//   * build cache unused for 24 hours: `docker builder prune --filter until=24h -f`
//   * release images (`<repository>:*`) and untagged, undigested leftovers that
//     no container uses
//
// It keeps the image of every container (running or stopped), the current and
// previous release tags from Spawnfile's release ledger (the rollback pair),
// every `clank-rollback:*` image, every image carrying any tag outside the
// release repository, and every digest-pinned pull (a pinned build input). It
// never forces a removal, so Docker's own in-use refusal still holds, and it
// never touches containers or volumes. Without a readable ledger it removes no
// image at all.
//
//   release-disk-cleanup.mjs --ledger <ledger.json> --repository <name> [--dry-run]
//
// Exit 0: done (or nothing to do). 1: a Docker command failed; the unit's
// floor check that follows still decides whether the release starts.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const CACHE_PRUNE = ['builder', 'prune', '--filter', 'until=24h', '-f'];
const ROLLBACK_REPOSITORY = 'clank-rollback';

const lines = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);
const repositoryOf = (tag) => tag.slice(0, tag.lastIndexOf(':'));

/** The rollback pair Spawnfile recorded, or null when the ledger cannot vouch for it. */
export function releaseTags(ledgerText) {
  try {
    const ledger = JSON.parse(ledgerText);
    if (ledger?.version !== 'spawnfile.release-ledger.v1' || typeof ledger.image_tag !== 'string') return null;
    return [ledger.image_tag, ledger.previous_image_tag].filter((tag) => typeof tag === 'string' && tag);
  } catch {
    return null;
  }
}

/**
 * Decides removals from inspected images. Returns the Docker references to
 * remove (a tag for release images, the ID for an untagged leftover) and the
 * reasons each kept image was kept.
 */
export function plan({ images, containerImageIds, keepTags, repository }) {
  const inUse = new Set(containerImageIds);
  const remove = [], kept = [];
  for (const image of images) {
    const tags = (image.RepoTags ?? []).filter((tag) => !tag.endsWith(':<none>'));
    const digests = image.RepoDigests ?? [];
    const keep = (reason) => kept.push({ id: image.Id, tags, reason });
    if (inUse.has(image.Id)) keep('used by a container');
    else if (tags.some((tag) => keepTags.includes(tag))) keep('current or previous release');
    else if (tags.some((tag) => repositoryOf(tag) === ROLLBACK_REPOSITORY)) keep('rollback image');
    else if (tags.some((tag) => repositoryOf(tag) !== repository)) keep('not a release image');
    else if (tags.length > 0) remove.push(...tags.map((tag) => ({ ref: tag, id: image.Id, size: image.Size })));
    else if (digests.length > 0) keep('digest-pinned pull');
    else remove.push({ ref: image.Id, id: image.Id, size: image.Size });
  }
  return { remove, kept };
}

const gib = (bytes) => `${(Number(bytes ?? 0) / 2 ** 30).toFixed(2)} GiB`;

export function cleanup({ ledgerText, repository, dryRun = false, docker, log = console.log }) {
  let failed = false;
  const attempt = (args) => {
    try { return docker(args); } catch (error) { failed = true; log(`docker ${args.join(' ')} failed: ${error.message}`); return null; }
  };

  if (dryRun) log(`would run: docker ${CACHE_PRUNE.join(' ')}`);
  else {
    const output = attempt(CACHE_PRUNE);
    if (output !== null) log(lines(output).at(-1) ?? 'build cache pruned');
  }

  const keepTags = releaseTags(ledgerText);
  if (!keepTags) {
    log('no readable release ledger: removing no image');
    return failed ? 1 : 0;
  }
  const containers = lines(docker(['ps', '--all', '--quiet', '--no-trunc']));
  const containerImageIds = containers.length ? lines(docker(['inspect', '--format', '{{.Image}}', ...containers])) : [];
  const imageIds = [...new Set(lines(docker(['image', 'ls', '--quiet', '--no-trunc'])))];
  const images = imageIds.length ? JSON.parse(docker(['image', 'inspect', ...imageIds])) : [];
  const { remove, kept } = plan({ images, containerImageIds, keepTags, repository });

  for (const { id, tags, reason } of kept) log(`keep ${tags.join(',') || id.slice(0, 19)}: ${reason}`);
  for (const { ref, id, size } of remove) {
    if (dryRun) { log(`would remove ${ref} (${id.slice(0, 19)}, ${gib(size)})`); continue; }
    if (attempt(['image', 'rm', ref]) !== null) log(`removed ${ref} (${id.slice(0, 19)}, ${gib(size)})`);
  }
  if (!remove.length) log('no unused release image to remove');
  return failed ? 1 : 0;
}

const option = (argv, name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const ledger = option(argv, '--ledger'), repository = option(argv, '--repository');
  if (!ledger || !repository) {
    process.stderr.write('usage: release-disk-cleanup.mjs --ledger <ledger.json> --repository <name> [--dry-run]\n');
    process.exit(64);
  }
  let ledgerText = '';
  try { ledgerText = readFileSync(ledger, 'utf8'); } catch (error) { console.log(`cannot read ${ledger}: ${error.code ?? error.message}`); }
  const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 2 ** 20 });
  try {
    process.exitCode = cleanup({ ledgerText, repository, dryRun: argv.includes('--dry-run'), docker });
  } catch (error) {
    process.stderr.write(`release-disk-cleanup: ${error.message}\n`);
    process.exitCode = 1;
  }
}
