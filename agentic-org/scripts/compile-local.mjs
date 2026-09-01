import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { orgRoot } from './lib.mjs';

const arch = process.env.SPAWNFILE_MOLTNET_TARGET_ARCH ?? (process.arch === 'arm64' ? 'arm64' : 'amd64');
const repositoryRoot = resolve(orgRoot, '..');
const candidates = [
  process.env.SPAWNFILE_MOLTNET_RELEASE_DIR,
  resolve(repositoryRoot, '..', 'moltnet', 'dist', 'spawnfile-local-release'),
  resolve(repositoryRoot, '..', 'noopolis-org', 'moltnet', 'dist', 'spawnfile-local-release')
].filter(Boolean);
const complete = (directory) => existsSync(resolve(directory, `moltnet_linux_${arch}.tar.gz`))
  && existsSync(resolve(directory, `local_moltnet_release_stamp_${arch}.json`));
const releaseDirectory = candidates.find(complete);

if (!releaseDirectory) {
  console.error(`local compile denied: no complete ${arch} Moltnet override; set SPAWNFILE_MOLTNET_RELEASE_DIR to a directory containing moltnet_linux_${arch}.tar.gz and local_moltnet_release_stamp_${arch}.json`);
  process.exit(1);
}

const cli = process.env.SPAWNFILE_CLI ?? 'spawnfile';
const version = spawnSync(cli, ['--version'], { encoding: 'utf8' });
if (version.error || version.status !== 0) {
  console.error(`local compile denied: unable to verify Spawnfile CLI version${version.error ? `: ${version.error.message}` : ''}`);
  process.exit(1);
}
if (version.stdout.trim() !== '0.1.17') {
  console.error(`local compile denied: Spawnfile 0.1.17 required, found ${version.stdout.trim() || 'unknown'}`);
  process.exit(1);
}
const output = resolve(process.env.SPAWNFILE_OUT ?? resolve(repositoryRoot, '.spawn-local'));
const result = spawnSync(cli, ['compile', orgRoot, '--out', output], {
  cwd: dirname(orgRoot),
  env: { ...process.env, SPAWNFILE_MOLTNET_RELEASE_DIR: '', SPAWNFILE_LOCAL_MOLTNET_RELEASE_DIR: releaseDirectory, SPAWNFILE_ALLOW_LOCAL_E2E: '1', SPAWNFILE_MOLTNET_TARGET_ARCH: arch },
  stdio: 'inherit'
});
if (result.error) {
  console.error(`local compile failed to start ${cli}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
