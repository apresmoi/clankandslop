import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Regression coverage for the machine-local-mode bug: build-newsroom-bundle.mjs
// used to write `lstatSync(file).mode` straight into the ustar header, so the
// same commit produced a different newsroom-runtime.tar (and checksum) on a
// machine with a different umask or checkout tool. The fix derives every
// header mode from git's own recorded mode instead, collapsed to 0o644/0o755.
//
// The build already requires the clankandslop-private checkout and installed
// website dependencies to run at all (same as every other consumer of it),
// so this is skipped rather than failed when those local prerequisites are
// absent. It builds in an isolated clone of HEAD rather than the shared
// working tree: this repo's own newsroom-runtime.tar/newsroom-runtime-bundle.json
// are real build outputs other tests (organization.test.mjs) read, and
// `node --test` runs test files concurrently, so mutating them in place here
// would race those reads.
const repoRoot = resolve(import.meta.dirname, '..', '..');
const privateRepoRoot = join(repoRoot, 'clankandslop-private');
const nodeModulesRoot = join(repoRoot, 'website', 'node_modules');

const prerequisitesReady = existsSync(join(privateRepoRoot, '.git')) && existsSync(nodeModulesRoot);

const createCheckout = () => {
  const root = mkdtempSync(join(tmpdir(), 'clank-bundle-mode-test-'));
  const dest = join(root, 'checkout');
  execFileSync('git', ['clone', '--quiet', '--local', repoRoot, dest]);
  execFileSync('git', ['clone', '--quiet', '--local', privateRepoRoot, join(dest, 'clankandslop-private')]);
  // website/node_modules is gitignored (never cloned); website/public/og is
  // git-tracked, so the clone above already reproduces it.
  symlinkSync(nodeModulesRoot, join(dest, 'website', 'node_modules'));
  return { root, dest };
};

const buildSourceDigest = (dest) => {
  execFileSync(process.execPath, [join(dest, 'agentic-org', 'scripts', 'build-newsroom-bundle.mjs')], { cwd: dest });
  return JSON.parse(readFileSync(join(dest, 'agentic-org', 'newsroom-runtime-bundle.json'), 'utf8')).source.sha256;
};

test(
  'newsroom source bundle digest is stable across a tracked file mode change',
  { skip: !prerequisitesReady && 'clankandslop-private checkout or website/node_modules not available locally' },
  () => {
    const checkout = createCheckout();
    try {
      const before = buildSourceDigest(checkout.dest);
      chmodSync(join(checkout.dest, 'agentic-org', 'scripts', 'lib.mjs'), 0o600);
      const after = buildSourceDigest(checkout.dest);
      assert.equal(after, before, 'archive digest must depend only on git-recorded mode, never on local file mode/umask');
    } finally {
      rmSync(checkout.root, { recursive: true, force: true });
    }
  }
);
