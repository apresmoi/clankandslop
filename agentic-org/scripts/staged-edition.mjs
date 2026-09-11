import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink, stat } from 'node:fs/promises';
import path from 'node:path';

const EDITION_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

// --- reading what pressman promoted ----------------------------------------
// `current-edition` is the symlink stage_release flips atomically after its
// validator and build both passed. Following it, rather than scanning for the
// newest directory, means this job can only ever publish an artifact that was
// promoted — a half-written candidate is never named by the link.
export async function resolveStagedEdition(stagingRoot, { stateRoot } = {}) {
  if (!path.isAbsolute(stagingRoot)) throw new Error(`--staging must be an absolute path, got ${JSON.stringify(stagingRoot)}`);
  const link = path.join(stagingRoot, 'current-edition');
  const target = await readlink(link).catch(() => { throw new Error(`no promoted edition at ${link} — pressman has not staged one, or stage_release did not reach promotion`); });
  if (path.isAbsolute(target) || target.includes('/')) throw new Error(`current-edition must name a sibling directory, got ${JSON.stringify(target)}`);
  const artifact = path.join(stagingRoot, target);
  const edition = target.slice(0, 10);
  if (!EDITION_PATTERN.test(edition)) throw new Error(`promoted artifact ${JSON.stringify(target)} does not begin with an edition date`);
  const source = path.join(artifact, 'content', 'editions', edition);
  const info = await stat(source).catch(() => { throw new Error(`promoted artifact carries no ${path.join('content', 'editions', edition)} directory`); });
  if (!info.isDirectory()) throw new Error(`${source} is not a directory`);
  const receipt = stateRoot === undefined ? undefined : await stagedReceipt(stateRoot, edition, artifact);
  return { edition, artifact, source, editionPath: path.posix.join('content', 'editions', edition), receipt };
}

// The producer's own artifact hash, recomputed here. Byte-identical rule to
// `directoryDigest` in production-newsroom.mjs (the function `promoteCandidate`
// hashes the candidate with before it renames it into place): names sorted,
// `d\0<path>\0` or `f\0<path>\0` per entry, file contents appended, any symlink
// or device node a refusal. It is deliberately a second implementation on the
// other side of the airlock — a digest a host recomputes is evidence; a digest
// it copies out of the receipt is a restatement.
export async function artifactDigest(directory) {
  const hash = createHash('sha256');
  const visit = async (base, relative = '') => {
    for (const name of (await readdir(base)).sort()) {
      const file = path.join(base, name), next = path.posix.join(relative, name), info = await lstat(file);
      if (info.isSymbolicLink()) throw new Error(`release artifact contains a symlink at ${next}`);
      hash.update(`${info.isDirectory() ? 'd' : 'f'}\0${next}\0`);
      if (info.isDirectory()) await visit(file, next);
      else if (info.isFile()) hash.update(await readFile(file));
      else throw new Error(`release artifact contains an unsupported node at ${next}`);
    }
  };
  await visit(directory);
  return `sha256:${hash.digest('hex')}`;
}

// Ties the bytes about to be pushed back to the durable receipt pressman wrote,
// so a staging volume edited by hand between the build and the push is caught
// rather than published.
//
// IT CANNOT COMPARE THE PATH, and used to. `stage_release` records
// `staging_root` as it sees it — CLANK_RELEASE_STAGING_ROOT, which for pressman
// is the workspace symlink `…/agents/pressman/staging/<artifact>`. This job sees
// the same directory as the host mount point of the same volume,
// `/var/lib/docker/volumes/clank-release-staging/_data/<artifact>`. The two
// strings never match, so `--state` — the flag the unattended timer must pass —
// refused every real artifact. Verified on the box on 2026-09-06 against the
// first artifact `stage_release` has ever produced: the check fired on the
// prefix and nothing else was ever examined.
//
// What replaces it is not weaker, it is the thing the path comparison was
// reaching for and never had:
//
//   * the artifact's DIRECTORY NAME must match the receipt's, and must be the
//     name `stage_release` derives from the composition digest it recorded —
//     `<edition>-<composition digest[0:16]>`. Mount-point independent, and it
//     binds the artifact to the composition rather than to a mount.
//   * the artifact's CONTENT must hash to the receipt's `artifact_digest`,
//     recomputed here from the bytes on disk. A hand-edited staging volume is
//     caught by this and was never caught by the path.
async function stagedReceipt(stateRoot, edition, artifact) {
  if (!path.isAbsolute(stateRoot)) throw new Error(`--state must be an absolute path, got ${JSON.stringify(stateRoot)}`);
  const directory = path.join(stateRoot, 'editions', edition, 'receipts');
  const name = path.basename(path.resolve(artifact));
  const suffix = name.slice(edition.length + 1);
  if (name !== `${edition}-${suffix}` || !/^[a-f0-9]{16}$/u.test(suffix)) throw new Error(`promoted artifact ${JSON.stringify(name)} must be <edition>-<16 composition hex digits>`);
  // stage_release retains one receipt per composition; promotion selects which one may publish.
  const file = path.join(directory, `staged-${suffix}.json`);
  const value = JSON.parse(await readFile(file, 'utf8').catch(error => {
    if (error.code === 'ENOENT') throw new Error(`no staged receipt for promoted artifact ${JSON.stringify(name)} at ${file}`);
    throw error;
  }));
  if (value?.state !== 'staged' || value.edition !== edition) throw new Error(`staged receipt for ${edition} is not a staged receipt for this edition`);
  if (path.basename(path.resolve(String(value.staging_root ?? ''))) !== name) throw new Error(`staged receipt names the artifact ${JSON.stringify(value.staging_root)}, but current-edition points at ${JSON.stringify(name)}`);
  if (!/^sha256:[a-f0-9]{64}$/u.test(value.composition_digest ?? '') || name !== `${edition}-${value.composition_digest.slice(7, 23)}`) throw new Error(`promoted artifact ${JSON.stringify(name)} is not the artifact this composition produced — stage_release names it <edition>-<composition digest>, and the receipt records ${JSON.stringify(value.composition_digest)}`);
  if (typeof value.artifact_digest !== 'string') throw new Error(`staged receipt for ${edition} carries no artifact_digest — nothing binds the bytes on disk to what pressman built`);
  const measured = await artifactDigest(artifact);
  if (measured !== value.artifact_digest) throw new Error(`the promoted artifact hashes to ${measured}, but the staged receipt records ${value.artifact_digest} — the staging volume changed after pressman built it, and this job does not publish bytes nobody staged`);
  return value;
}

