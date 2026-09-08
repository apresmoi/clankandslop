import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { archiveIndex } from './lay-page.mjs';
import { repo } from './lay-page.test-data.mjs';

test('the archive index includes every committed region and its newest published crop', () => {
  const files = execFileSync('git', ['ls-files', '-z', 'content/editions/*/maps/*.json'], { cwd: repo })
    .toString().split('\0').filter(Boolean).sort();
  assert.ok(files.length > 0);
  const expected = new Map(files.map(file => [file.split('/').at(-1).slice(0, -5), resolve(repo, file)]));
  const actual = archiveIndex();
  assert.deepEqual(actual, expected);
  actual.delete('west-bank-regional-context');
  assert.notDeepEqual(actual, expected, 'a missing published map must be detectable');
});
