import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { landedCorpus, refreshCorpusFeed, retainHostCorpusRecord, selectHostCorpusRecord } from './corpus-host-record.mjs';

const DAY = '2026-10-27', NEXT = '2026-10-28', COMMIT = 'a'.repeat(40), TREE = 'b'.repeat(64);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const record = (edition = DAY, commit = COMMIT) => ({ version: 'spawnfile.volume-feed-landed.v1', tree: TREE, revision: TREE, trees: [TREE], heals: {}, identity_sha256: 'c'.repeat(64), identity: { version: 'spawnfile.volume-feed.v1', resource: 'research-corpus', volume: 'clank-newsroom-corpus', revision: TREE, files: 2, tree: `trees/${TREE}`, landed_at: `${edition}T08:00:00Z`, source: { kind: 'git', commit, ref: `origin/edition/${edition}`, paths: [edition] } } });
const claim = { commit: COMMIT, tree: `trees/${TREE}` };
function fixture({ missing = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'host-corpus-'));
  const state = path.join(root, 'spawnfile-feed'), file = path.join(state, 'landed.json');
  if (!missing) { mkdirSync(state, { mode: 0o700 }); writeFileSync(file, JSON.stringify(record()) + '\n', { mode: 0o600 }); }
  return { root, state, file };
}
const archived = (state, edition = DAY) => path.join(state, 'corpus-history', edition);

test('the actual wrapper archives exact predecessor bytes before its child and successor bytes afterward', () => {
  const f = fixture(), original = readFileSync(f.file), successor = JSON.stringify(record(NEXT));
  const child = path.join(f.root, 'refresh.mjs');
  writeFileSync(child, `import {readFileSync,writeFileSync} from 'node:fs';\nconst prior=readFileSync(${JSON.stringify(path.join(archived(f.state), hash(original) + '.json'))});\nif(prior.toString()!==${JSON.stringify(original.toString())})throw Error('predecessor was not retained before refresh');\nwriteFileSync(${JSON.stringify(f.file)},${JSON.stringify(successor)});\nconsole.log('REFRESH_ROTATED');\n`);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./corpus-host-record.mjs', import.meta.url)), '--', process.execPath, child], { env: { ...process.env, CLANK_CORPUS_LANDED: f.file }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /REFRESH_ROTATED/);
  assert.equal(readFileSync(path.join(archived(f.state, NEXT), hash(successor) + '.json'), 'utf8'), successor);
  const selected = selectHostCorpusRecord(f.file, DAY, claim);
  assert.equal(readFileSync(selected, 'utf8'), original.toString());
  assert.equal(landedCorpus(selected, DAY).landed_at, `${DAY}T08:00:00Z`);
  retainHostCorpusRecord(f.file); assert.equal(readdirSync(archived(f.state, NEXT)).length, 1);
});

test('an absent first landing allows initialization and preserves the first valid result', () => {
  const f = fixture({ missing: true });
  assert.equal(refreshCorpusFeed(['fixture'], { landed: f.file, run: () => {
    mkdirSync(f.state, { mode: 0o700 }); writeFileSync(f.file, JSON.stringify(record()), { mode: 0o600 }); return { status: 0 };
  } }), 0);
  assert.equal(readdirSync(archived(f.state)).length, 1);
  const empty = fixture({ missing: true });
  assert.equal(refreshCorpusFeed(['fixture'], { landed: empty.file, run: () => ({ status: 0 }) }), 0);
  assert.equal(existsSync(empty.state), false);
});

test('a refresh failure preserves the predecessor and any valid successor before returning failure', () => {
  const f = fixture(), before = readFileSync(f.file);
  assert.equal(refreshCorpusFeed(['fixture'], { landed: f.file, run: () => {
    writeFileSync(f.file, JSON.stringify(record(NEXT))); return { status: 7 };
  } }), 7);
  assert.equal(readFileSync(path.join(archived(f.state), hash(before) + '.json'), 'utf8'), before.toString());
  assert.equal(readdirSync(archived(f.state, NEXT)).length, 1);
});

test('malformed current records stop refresh before it can erase the predecessor', () => {
  for (const bad of ['{', JSON.stringify({ ...record(), version: 'unknown' }), JSON.stringify({ ...record(), identity: { ...record().identity, landed_at: 'invalid' } })]) {
    const f = fixture(); writeFileSync(f.file, bad); let ran = false;
    assert.throws(() => refreshCorpusFeed(['fixture'], { landed: f.file, run: () => { ran = true; return { status: 0 }; } }));
    assert.equal(ran, false); assert.equal(readFileSync(f.file, 'utf8'), bad); assert.equal(existsSync(archived(f.state)), false);
  }
});

test('immutable archive conflicts stop refresh without replacing the existing evidence', () => {
  const f = fixture(), target = retainHostCorpusRecord(f.file); writeFileSync(target, 'conflicting evidence');
  let ran = false;
  assert.throws(() => refreshCorpusFeed(['fixture'], { landed: f.file, run: () => { ran = true; return { status: 0 }; } }), /conflicting retained/);
  assert.equal(ran, false); assert.equal(readFileSync(target, 'utf8'), 'conflicting evidence');
});

test('history selection refuses missing, malformed, mismatched and non-private evidence', () => {
  const f = fixture(), target = retainHostCorpusRecord(f.file); writeFileSync(f.file, JSON.stringify(record(NEXT)));
  assert.throws(() => selectHostCorpusRecord(f.file, DAY, { ...claim, commit: 'd'.repeat(40) }), /no retained/);
  assert.throws(() => selectHostCorpusRecord(f.file, DAY, { ...claim, tree: `trees/${'e'.repeat(64)}` }), /no retained/);
  assert.throws(() => selectHostCorpusRecord(f.file, '2026-10-26', claim), /has no entry/);
  chmodSync(target, 0o644); assert.throws(() => selectHostCorpusRecord(f.file, DAY, claim), /private host-owned/); chmodSync(target, 0o600);
  writeFileSync(target, '{'); assert.throws(() => selectHostCorpusRecord(f.file, DAY, claim), /cannot be trusted/);
  writeFileSync(target, JSON.stringify(record(DAY, 'd'.repeat(40)))); assert.throws(() => selectHostCorpusRecord(f.file, DAY, claim), /malformed retained/);
});

test('history never follows a symlink and current malformed records cannot route around validation', () => {
  const f = fixture(); symlinkSync(f.root, path.join(f.state, 'corpus-history'));
  assert.throws(() => retainHostCorpusRecord(f.file), /private host-owned/);
  writeFileSync(f.file, '{'); assert.throws(() => selectHostCorpusRecord(f.file, DAY, claim), /cannot be trusted/);
});
