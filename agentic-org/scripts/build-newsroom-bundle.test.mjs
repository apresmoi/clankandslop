import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Regression coverage for the machine-local-mode bug: build-newsroom-bundle.mjs
// used to write `lstatSync(file).mode` straight into the ustar header, so the
// same commit produced a different newsroom-runtime.tar (and checksum) on a
// machine with a different umask or checkout tool. The fix derives every
// header mode from git's own recorded mode instead, collapsed to 0o644/0o755.
//
// This runs the real build script against the real repo (it already requires
// the clankandslop-private checkout and installed website dependencies to run
// at all, same as every other consumer of it), so it is skipped rather than
// failed when those local prerequisites are absent.
const scriptPath = resolve(import.meta.dirname, 'build-newsroom-bundle.mjs');
const repoRoot = resolve(import.meta.dirname, '..', '..');
const manifestPath = resolve(repoRoot, 'agentic-org', 'newsroom-runtime-bundle.json');
const privateGitDir = resolve(repoRoot, 'clankandslop-private', '.git');
const targetFile = resolve(repoRoot, 'agentic-org', 'scripts', 'lib.mjs');

const prerequisitesReady = existsSync(privateGitDir) && existsSync(resolve(repoRoot, 'website', 'node_modules'));

const runBuild = () => {
  execFileSync(process.execPath, [scriptPath], { cwd: repoRoot });
  return JSON.parse(readFileSync(manifestPath, 'utf8')).source.sha256;
};

test(
  'newsroom source bundle digest is stable across a tracked file mode change',
  { skip: !prerequisitesReady && 'clankandslop-private checkout or website/node_modules not available locally' },
  () => {
    // newsroom-runtime-bundle.json is itself one of the bundled source files
    // (it describes the bundle it ships in), so each build rewrites its own
    // input for the next one. Snapshot and restore it around both measured
    // builds so the only variable between them is the file-mode mutation
    // below, not that self-description drifting.
    const manifestBaseline = readFileSync(manifestPath, 'utf8');
    const originalMode = statSync(targetFile).mode & 0o777;
    try {
      const before = runBuild();
      writeFileSync(manifestPath, manifestBaseline);
      chmodSync(targetFile, 0o600);
      const after = runBuild();
      assert.equal(after, before, 'archive digest must depend only on git-recorded mode, never on local file mode/umask');
    } finally {
      // Restore exactly the bytes/mode this test observed on entry -- not a
      // third build, which would only add another link to the self-describing
      // manifest's generation chain and leave the working tree one build
      // ahead of where it started.
      chmodSync(targetFile, originalMode);
      writeFileSync(manifestPath, manifestBaseline);
    }
  }
);
