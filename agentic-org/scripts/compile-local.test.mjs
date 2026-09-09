import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const helper = resolve(import.meta.dirname, 'compile-local.mjs');
const arch = 'amd64';

const fakeSpawnfile = (root) => {
  const cli = join(root, 'spawnfile');
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === '--version') {
  process.stdout.write('0.1.17\\n');
  process.exit(0);
}
if (process.argv[2] === 'compile') {
  const local = process.env.SPAWNFILE_LOCAL_MOLTNET_RELEASE_DIR;
  const production = process.env.SPAWNFILE_MOLTNET_RELEASE_DIR;
  const optedIn = process.env.SPAWNFILE_ALLOW_LOCAL_E2E;
  process.exit(local && !production && optedIn === '1' ? 0 : 3);
}
process.exit(2);
`);
  chmodSync(cli, 0o755);
  return cli;
};

const runHelper = (releaseDirectory, cli, output) => spawnSync(process.execPath, [helper], {
  encoding: 'utf8',
  env: {
    ...process.env,
    SPAWNFILE_CLI: cli,
    SPAWNFILE_MOLTNET_RELEASE_DIR: releaseDirectory,
    SPAWNFILE_MOLTNET_TARGET_ARCH: arch,
    SPAWNFILE_OUT: output
  }
});

test('local compile accepts only the local Moltnet release stamp contract', () => {
  const root = mkdtempSync(join(tmpdir(), 'clank-compile-local-'));
  const cli = fakeSpawnfile(root);
  const localRelease = join(root, 'local-release');
  mkdirSync(localRelease);
  writeFileSync(join(localRelease, `moltnet_linux_${arch}.tar.gz`), 'archive');
  writeFileSync(join(localRelease, `local_moltnet_release_stamp_${arch}.json`), '{}\n');

  const accepted = runHelper(localRelease, cli, join(root, 'accepted-output'));
  assert.equal(accepted.status, 0, accepted.stderr);
});
