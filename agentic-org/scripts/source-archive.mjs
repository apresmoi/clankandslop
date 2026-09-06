// The source archive — `newsroom-runtime.tar`, the tree every one of the twelve
// agents mounts at `./repos/newsroom`.
//
// It is factored out of build-newsroom-bundle.mjs for the same reason
// private-archive.mjs was: so the full build and the drift check cannot
// disagree about what belongs in it. Unlike the dependency and asset archives,
// this one is a pure function of the git tree — every entry is a tracked file
// and every mode is git's recorded mode — so any checkout of a commit produces
// the same bytes, and a descriptor that disagrees with a fresh build is drift
// rather than a machine difference.

import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildTar, gitModeMap, normalizeMode } from './private-archive.mjs';

// Present in the archive whether or not `git ls-files` reaches them: the MCP
// entrypoint and the module it loads are what makes the mount a runtime.
export const SOURCE_REQUIRED = Object.freeze([
  'agentic-org/scripts/production-newsroom.mjs',
  'agentic-org/scripts/production-newsroom-mcp.mjs',
]);

// newsroom-runtime-bundle.json describes the archives it is generated from,
// including this one's own sha256 -- it can never accurately describe its own
// digest if it is packed inside the archive it is describing (each rebuild
// would shift the digest by one generation, even from an untouched clean
// checkout). It is a build-time/repo-level manifest only: no agent reads it
// from the mounted workspace, so it is excluded here the same way Spawnfile
// and the other non-payload paths are.
const excluded = (name) =>
  name.startsWith('clankandslop-private/')
  || name.startsWith('website/node_modules/')
  || name.startsWith('website/public/og/')
  || name.endsWith('/Spawnfile')
  || name === 'agentic-org/Spawnfile'
  || name === 'agentic-org/newsroom-runtime-bundle.json';

/**
 * The entry set and recorded modes the source archive is built from.
 *
 * Symlinks are identified by git's recorded mode (120000), not by a live
 * lstat. Same answer on any clean checkout, and it does not fall over when
 * the index and the worktree disagree — which is exactly what a build box
 * with the private checkout and node_modules linked in beside the tree looks
 * like, and how this function first crashed.
 */
export function sourceArchivePlan(repo) {
  const modes = gitModeMap(repo, ['ls-files', '--stage', '-z']);
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repo, maxBuffer: 1024 * 1024 * 256 })
    .toString().split('\0').filter(Boolean)
    .filter((name) => !excluded(name))
    .filter((name) => modes.get(name)?.mode !== 0o120000);
  const entries = new Set([...tracked, ...SOURCE_REQUIRED]);
  for (const name of SOURCE_REQUIRED)
    if (!lstatSync(path.join(repo, name)).isFile()) throw new Error(`required newsroom input missing: ${name}`);
  return { entries, modes };
}

/**
 * Writes the source archive to `output` and returns its digest, file count and
 * content bytes. Every mode comes from git, never from a live stat: an entry
 * git does not record is refused rather than guessed at, which is what keeps
 * this reproducible from any checkout of the same commit.
 */
export function buildSourceArchive(repo, output, plan = sourceArchivePlan(repo)) {
  return buildTar(plan.entries, output, {
    resolveFile: (name) => path.join(repo, name),
    modeFor: (name) => {
      const recorded = plan.modes.get(name);
      if (recorded === undefined) throw new Error(`source archive entry has no recorded git mode: ${name}`);
      return normalizeMode(recorded.mode);
    },
  });
}

/** Builds the source archive into a scratch file purely to measure it. */
export function measureSourceArchive(repo) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'clank-source-archive-'));
  try {
    return buildSourceArchive(repo, path.join(scratch, 'newsroom-runtime.tar'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Every way the committed descriptor disagrees with a fresh build of the
 * tracked tree, as plain sentences. Empty means the pin describes this commit.
 */
export function sourceDescriptorFindings(descriptor, measured) {
  const out = [];
  const source = descriptor?.source;
  if (!source) return ['newsroom-runtime-bundle.json carries no "source" block'];
  if (source.sha256 !== measured.digest) out.push(`source.sha256 is ${source.sha256}, a fresh build of this tree is ${measured.digest}`);
  if (source.file_count !== measured.count) out.push(`source.file_count is ${source.file_count}, a fresh build of this tree has ${measured.count}`);
  if (source.content_bytes !== measured.total) out.push(`source.content_bytes is ${source.content_bytes}, a fresh build of this tree has ${measured.total}`);
  return out;
}
