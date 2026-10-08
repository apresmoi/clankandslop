import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateContentTree } from './content-validate.mjs';

const repo = path.resolve(import.meta.dirname, '..', '..');
const hook = path.join(import.meta.dirname, 'content-validate.mjs');
const staged = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'content-validate-'));
  for (const dir of ['content/editions', 'content/bylines']) cpSync(path.join(repo, dir), path.join(root, dir), { recursive: true });
  return root;
};
const runHook = (tree) => { try { execFileSync(process.execPath, [hook], { env: { ...process.env, SPAWNFILE_FEED_TREE: tree }, stdio: 'pipe' }); return 0; } catch (error) { return error.status; } };

test('the published tree in this checkout passes, through the hook as well', () => {
  const root = staged();
  try {
    assert.ok(validateContentTree(root) > 0);
    assert.equal(runHook(root), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an undated entry, a missing byline index and a drifted byline row are each refused', () => {
  for (const [name, mutate, reason] of [
    ['undated', (root) => cpSync(path.join(root, 'content/editions'), path.join(root, 'content/editions-copy'), { recursive: true }) || writeFileSync(path.join(root, 'content/editions/notes.md'), 'x'), /undated/u],
    ['missing bylines', (root) => rmSync(path.join(root, 'content/bylines'), { recursive: true }), /content\/bylines\/ is missing/u],
    ['drifted row', (root) => writeFileSync(path.join(root, 'content/bylines', `${execFileSync('ls', [path.join(root, 'content/bylines')], { encoding: 'utf8' }).split('\n')[0]}`), 'drift\n'), /not what its editions render/u],
  ]) {
    const root = staged();
    try {
      mutate(root);
      assert.throws(() => validateContentTree(root), reason, name);
      assert.equal(runHook(root), 1, name);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  assert.notEqual(runHook(''), 0, 'the hook refuses to run without a staged tree');
});
