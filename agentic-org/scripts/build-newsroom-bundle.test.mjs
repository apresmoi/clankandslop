import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Regression coverage for the machine-local-mode bug: build-newsroom-bundle.mjs
// used to write `lstatSync(file).mode` straight into the ustar header, so the
// same commit produced a different newsroom-runtime.tar (and checksum) on a
// machine with a different umask or checkout tool. The fix derives every
// header mode from git's own recorded mode instead, collapsed to 0o644/0o755.
//
// The build already requires the clankandslop-private checkout. Dependency
// validation runs against a tiny fixture node_modules tree so this test remains
// independent of the developer machine's installed packages. It builds in an
// isolated clone of HEAD rather than the shared
// working tree: this repo's own newsroom-runtime.tar/newsroom-runtime-bundle.json
// are real build outputs other tests (organization.test.mjs) read, and
// `node --test` runs test files concurrently, so mutating them in place here
// would race those reads.
const repoRoot = resolve(import.meta.dirname, '..', '..');
const privateRepoRoot = join(repoRoot, 'clankandslop-private');
const prerequisitesReady = existsSync(join(privateRepoRoot, '.git'));

const scriptInputs = [
  'agentic-org/scripts/build-newsroom-bundle.mjs',
  'agentic-org/scripts/private-archive.mjs',
  'agentic-org/scripts/source-archive.mjs',
];

const createCheckout = () => {
  const root = mkdtempSync(join(tmpdir(), 'clank-bundle-mode-test-'));
  const dest = join(root, 'checkout');
  execFileSync('git', ['clone', '--quiet', '--local', repoRoot, dest]);
  execFileSync('git', ['clone', '--quiet', '--local', privateRepoRoot, join(dest, 'clankandslop-private')]);
  // website/public/og is git-tracked, so the clone above already reproduces it.
  // Dependency checks are exercised against a tiny installed tree owned by this
  // fixture, because the shared developer node_modules may legitimately drift.
  writeMinimalWebsiteDependencies(dest);
  // Copy the script modules from the working tree so this test covers
  // uncommitted review fixes.
  for (const relative of scriptInputs) copyFileSync(join(repoRoot, relative), join(dest, relative));
  return { root, dest };
};

const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

const writeMinimalWebsiteDependencies = (dest) => {
  writeJson(join(dest, 'website', 'package.json'), { dependencies: { 'fixture-dep': '1.0.0' } });
  writeJson(join(dest, 'website', 'package-lock.json'), {
    name: 'fixture-website',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { dependencies: { 'fixture-dep': '1.0.0' } },
      'node_modules/fixture-dep': { version: '1.0.0' },
    },
  });
  mkdirSync(join(dest, 'website', 'node_modules', 'fixture-dep'), { recursive: true });
  writeJson(join(dest, 'website', 'node_modules', 'fixture-dep', 'package.json'), { name: 'fixture-dep', version: '1.0.0' });
  writeFileSync(join(dest, 'website', 'node_modules', 'fixture-dep', 'index.js'), 'export const fixture = true;\n');
};

const dependencyModule = async (dest) => import(pathToFileURL(join(dest, 'clankandslop-private', 'newsroom', 'build', 'dependencies.mjs')).href);
const archiveModule = async (dest) => import(pathToFileURL(join(dest, 'clankandslop-private', 'newsroom', 'build', 'archive.mjs')).href);

const writeValidDependencyProvenance = async (dest) => {
  const { writeDependencyProvenance } = await dependencyModule(dest);
  await writeDependencyProvenance(dest, { rehearsal: true });
};

const buildBundle = (dest) => {
  execFileSync(process.execPath, [join(dest, 'agentic-org', 'scripts', 'build-newsroom-bundle.mjs')], {
    cwd: dest,
    env: { ...process.env, CLANK_RELEASE_REHEARSAL: '1' },
  });
  return JSON.parse(readFileSync(join(dest, 'agentic-org', 'newsroom-runtime-bundle.json'), 'utf8'));
};

const buildSourceDigest = async (dest) => {
  await writeValidDependencyProvenance(dest);
  return buildBundle(dest).source.sha256;
};

const runBundleExpectingFailure = (dest) => assert.throws(
  () => execFileSync(process.execPath, [join(dest, 'agentic-org', 'scripts', 'build-newsroom-bundle.mjs')], { cwd: dest, stdio: 'pipe' }),
  /Dependency provenance|ENOENT/u,
);

const dependencyArchiveBytes = (dest) => [
  readFileSync(join(dest, 'agentic-org', 'newsroom-dependencies-a.tar'), 'utf8'),
  readFileSync(join(dest, 'agentic-org', 'newsroom-dependencies-b.tar'), 'utf8'),
];

const writeSentinelDependencyArchives = (dest) => {
  writeFileSync(join(dest, 'agentic-org', 'newsroom-dependencies-a.tar'), 'dependency a sentinel');
  writeFileSync(join(dest, 'agentic-org', 'newsroom-dependencies-b.tar'), 'dependency b sentinel');
};

test(
  'newsroom source bundle digest is stable across a tracked file mode change',
  { skip: !prerequisitesReady && 'clankandslop-private checkout not available locally' },
  async () => {
    const checkout = createCheckout();
    try {
      const before = await buildSourceDigest(checkout.dest);
      chmodSync(join(checkout.dest, 'agentic-org', 'scripts', 'lib.mjs'), 0o600);
      const after = await buildSourceDigest(checkout.dest);
      assert.equal(after, before, 'archive digest must depend only on git-recorded mode, never on local file mode/umask');
    } finally {
      rmSync(checkout.root, { recursive: true, force: true });
    }
  }
);

test(
  'newsroom bundle uses the private dependency archive producer and includes provenance',
  { skip: !prerequisitesReady && 'clankandslop-private checkout not available locally' },
  async () => {
    const checkout = createCheckout();
    try {
      await writeValidDependencyProvenance(checkout.dest);
      const descriptor = buildBundle(checkout.dest);
      const { buildDependencyArchives } = await archiveModule(checkout.dest);
      const expected = await buildDependencyArchives(checkout.dest, join(checkout.root, 'canonical-dependencies'));
      assert.deepEqual(
        descriptor.dependencies.map(({ archive, sha256, file_count, content_bytes }) => ({ archive, sha256, file_count, content_bytes })),
        expected.map(({ archive, sha256, file_count, content_bytes }) => ({ archive, sha256, file_count, content_bytes })),
      );
      for (const archive of ['newsroom-dependencies-a.tar', 'newsroom-dependencies-b.tar']) {
        const entries = execFileSync('tar', ['-tf', join(checkout.dest, 'agentic-org', archive)], { encoding: 'utf8' }).trim().split('\n');
        assert.ok(entries.includes('website/dependency-provenance.json'), `${archive} must carry dependency provenance`);
      }
    } finally {
      rmSync(checkout.root, { recursive: true, force: true });
    }
  }
);

test(
  'newsroom bundle rejects missing dependency provenance before overwriting dependency archives',
  { skip: !prerequisitesReady && 'clankandslop-private checkout not available locally' },
  () => {
    const checkout = createCheckout();
    try {
      writeSentinelDependencyArchives(checkout.dest);
      const before = dependencyArchiveBytes(checkout.dest);
      runBundleExpectingFailure(checkout.dest);
      assert.deepEqual(dependencyArchiveBytes(checkout.dest), before);
    } finally {
      rmSync(checkout.root, { recursive: true, force: true });
    }
  }
);

test(
  'newsroom bundle rejects wrong dependency provenance before overwriting dependency archives',
  { skip: !prerequisitesReady && 'clankandslop-private checkout not available locally' },
  () => {
    const checkout = createCheckout();
    try {
      writeSentinelDependencyArchives(checkout.dest);
      writeFileSync(join(checkout.dest, 'website', 'dependency-provenance.json'), `${JSON.stringify({
        version: 'clank.website-dependencies.v1',
        lock_digest: `sha256:${'0'.repeat(64)}`,
        platform: process.platform,
        arch: process.arch,
        node_major: Number(process.versions.node.split('.')[0]),
        versions: {},
      }, null, 2)}\n`);
      const before = dependencyArchiveBytes(checkout.dest);
      runBundleExpectingFailure(checkout.dest);
      assert.deepEqual(dependencyArchiveBytes(checkout.dest), before);
    } finally {
      rmSync(checkout.root, { recursive: true, force: true });
    }
  }
);
