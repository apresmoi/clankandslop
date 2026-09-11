import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { artifactDigest, resolveStagedEdition } from './staged-edition.mjs';

const edition = '2026-09-11';
async function stages(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'clank-stage-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staging = path.join(root, 'staging'), state = path.join(root, 'state');
  const receipts = path.join(state, 'editions', edition, 'receipts');
  await mkdir(receipts, { recursive: true });
  const entries = [];
  for (const [hex, headline] of [['1', 'First approved layout'], ['f', 'Revised approved layout']]) {
    const digest = `sha256:${hex.repeat(64)}`, name = `${edition}-${digest.slice(7, 23)}`;
    const artifact = path.join(staging, name), source = path.join(artifact, 'content', 'editions', edition);
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'front.json'), JSON.stringify({ headline }));
    const receipt = { version: 'clank.newsroom-release-receipt.v2', state: 'staged', edition,
      composition_digest: digest, artifact_digest: await artifactDigest(artifact),
      staging_root: `/agent/pressman/staging/${name}`, mechanical_digest: `sha256:${'a'.repeat(64)}` };
    const file = path.join(receipts, `staged-${digest.slice(7, 23)}.json`);
    await writeFile(file, JSON.stringify(receipt));
    // The producer writes the immutable receipt, then atomically promotes its sibling artifact.
    await symlink(name, path.join(staging, '.next'));
    await rename(path.join(staging, '.next'), path.join(staging, 'current-edition'));
    entries.push({ name, artifact, file, receipt });
  }
  return { staging, state, receipts, entries, resolve: () => resolveStagedEdition(staging, { stateRoot: state }) };
}

test('two valid staged releases publish the promoted artifact and retain both audit receipts', async t => {
  const f = await stages(t), [old, latest] = f.entries;
  const before = await Promise.all(f.entries.map(entry => readFile(entry.file, 'utf8')));
  const selected = await f.resolve();
  assert.equal(selected.artifact, latest.artifact);
  assert.deepEqual(selected.receipt, latest.receipt);
  assert.deepEqual((await readdir(f.receipts)).sort(), f.entries.map(entry => path.basename(entry.file)).sort());
  assert.deepEqual(await Promise.all(f.entries.map(entry => readFile(entry.file, 'utf8'))), before);
  await symlink(old.name, path.join(f.staging, '.next'));
  await rename(path.join(f.staging, '.next'), path.join(f.staging, 'current-edition'));
  assert.deepEqual((await f.resolve()).receipt, old.receipt, 'promotion is authoritative, not receipt order or recency');
});

test('a missing selected receipt refuses even while another valid stage exists', async t => {
  const f = await stages(t); await rm(f.entries[1].file);
  await assert.rejects(f.resolve(), /no staged receipt for promoted artifact/);
  assert.deepEqual(JSON.parse(await readFile(f.entries[0].file, 'utf8')), f.entries[0].receipt);
});

test('malformed, stale or mismatched selected receipts never fall back to an older valid one', async t => {
  const cases = [
    ['invalid JSON', () => '{', /JSON/],
    ['null', () => 'null', /not a staged receipt/],
    ['wrong state', value => ({ ...value, state: 'prepared' }), /not a staged receipt/],
    ['wrong edition', value => ({ ...value, edition: '2026-09-10' }), /not a staged receipt/],
    ['wrong artifact directory', (value, old) => ({ ...value, staging_root: old.staging_root }), /current-edition points at/],
    ['stale composition', (value, old) => ({ ...value, composition_digest: old.composition_digest }), /not the artifact this composition produced/],
    ['malformed composition prefix', value => ({ ...value, composition_digest: `invalid${value.composition_digest.slice(7)}` }), /not the artifact this composition produced/],
    ['truncated composition', value => ({ ...value, composition_digest: value.composition_digest.slice(0, 23) }), /not the artifact this composition produced/],
    ['missing artifact digest', value => ({ ...value, artifact_digest: undefined }), /carries no artifact_digest/],
    ['wrong artifact bytes', (value, old) => ({ ...value, artifact_digest: old.artifact_digest }), /staging volume changed/]
  ];
  for (const [name, mutate, expected] of cases) await t.test(name, async t => {
    const f = await stages(t), result = mutate(f.entries[1].receipt, f.entries[0].receipt);
    await writeFile(f.entries[1].file, typeof result === 'string' ? result : JSON.stringify(result));
    await assert.rejects(f.resolve(), expected);
    assert.deepEqual(JSON.parse(await readFile(f.entries[0].file, 'utf8')), f.entries[0].receipt);
  });
});

test('a malformed promoted artifact suffix cannot choose a receipt path', async t => {
  const f = await stages(t), latest = f.entries[1];
  const malformed = `${edition}-not-a-composition`;
  await rename(latest.artifact, path.join(f.staging, malformed));
  await symlink(malformed, path.join(f.staging, '.next'));
  await rename(path.join(f.staging, '.next'), path.join(f.staging, 'current-edition'));
  await assert.rejects(f.resolve(), /must be <edition>-<16 composition hex digits>/);
});
