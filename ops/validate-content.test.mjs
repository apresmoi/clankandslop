import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '..'), edition = '2026-10-21';

// A scratch repository: a copy of ops/ (the validator resolves its root from
// its own real path), the image content, every published edition linked in,
// and `edition` copied so it can be broken. The validator is run through a
// symlink, as a host or tool may invoke it.
function runThroughSymlink(compiledBy) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clank-validate-content-'));
  try {
    cpSync(path.join(repo, 'ops'), path.join(root, 'ops'), { recursive: true });
    symlinkSync(path.join(repo, 'agentic-org'), path.join(root, 'agentic-org'));
    mkdirSync(path.join(root, 'content/editions'), { recursive: true });
    for (const name of ['agents', 'topics.json', 'fixtures']) symlinkSync(path.join(repo, 'content', name), path.join(root, 'content', name));
    for (const date of readdirSync(path.join(repo, 'content/editions')).filter(date => date !== edition)) symlinkSync(path.join(repo, 'content/editions', date), path.join(root, 'content/editions', date));
    cpSync(path.join(repo, 'content/editions', edition), path.join(root, 'content/editions', edition), { recursive: true });
    const chrome = path.join(root, 'content/editions', edition, 'desk/caslon.chrome.json');
    if (compiledBy) writeFileSync(chrome, JSON.stringify({ ...JSON.parse(readFileSync(chrome, 'utf8')), compiled_by: compiledBy }));
    const link = path.join(root, 'validate-content-link.mjs');
    symlinkSync(path.join(root, 'ops/validate-content.mjs'), link);
    return spawnSync(process.execPath, [link], { encoding: 'utf8' });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('run through a symlink, the validator still validates a good tree', () => {
  const result = runThroughSymlink();
  assert.equal(result.status, 0, result.stderr.slice(-2000));
  assert.match(result.stdout, /^content OK — /mu);
});

test('run through a symlink, the validator still fails a bad edition', () => {
  const result = runThroughSymlink(['Caslon']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`✗ content/editions/${edition}/desk: compiled_by names unknown agent "Caslon"`, 'u'));
});
