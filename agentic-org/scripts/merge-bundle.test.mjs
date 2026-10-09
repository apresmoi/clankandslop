import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, lstat, readdir } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { mergeBundle } from './production-newsroom.mjs';
test('merging a mounted bundle copies its tree, not the link', async () => {
  const r = await mkdtemp(join(tmpdir(), 'mb-')); await mkdir(join(r,'backing')); await writeFile(join(r,'backing','a.png'),'x');
  await symlink(join(r,'backing'), join(r,'og')); await mergeBundle(join(r,'og'), join(r,'out'));
  assert.equal((await lstat(join(r,'out'))).isSymbolicLink(), false); assert.deepEqual(await readdir(join(r,'out')), ['a.png']);
});
