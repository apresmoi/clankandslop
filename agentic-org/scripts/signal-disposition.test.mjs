import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeSignal, saveSignalDisposition, signalKey } from './signal-disposition.mjs';
import { qualifySignal } from './production-newsroom.mjs';

const edition = '2026-09-11';
const signal = (overrides = {}) => ({ edition, event_key: 'moltnet:notice-0', source_id: 'https://primary.example/lead', summary: 'A sourced lead whose mechanism matters to the hardware desk.', selected_desks: ['cogsworth'], evidence_refs: ['https://primary.example/lead'], ...overrides });
function store() {
  const records = new Map(), receipts = [];
  return { records, receipts, adapter: {
    read: async id => records.get(id),
    write: async (id, value) => records.set(id, structuredClone(value)),
    receipt: async value => { receipts.push(value); return value; }
  } };
}

test('eight overlapping notices converge into one indexed lead, without reporter wake instructions', async () => {
  const state = store();
  for (let i = 0; i < 8; i += 1) {
    const result = await saveSignalDisposition(signal({ event_key: `moltnet:notice-${i}` }), state.adapter);
    assert.equal(result.revision, 1);
    assert.equal(result.unchanged, i > 0);
    assert.equal(result.qualified, true);
    assert.doesNotMatch(result.next, /@[a-z]/u);
    assert.match(result.next, /not a commission/u);
  }
  assert.equal(state.records.size, 1);
  assert.equal(state.receipts.length, 8, 'Each source notice retains its own causal receipt.');
  assert.equal(new Set(state.receipts.map(item => item.event_key)).size, 8);
});

test('ignore and defer are durable decisions without forced desk routing', async () => {
  for (const disposition of ['ignore', 'defer']) {
    const state = store();
    const result = await saveSignalDisposition(signal({ disposition, selected_desks: undefined, evidence_refs: [] }), state.adapter);
    assert.equal(result.qualified, false);
    assert.deepEqual(result.selected_desks, []);
    assert.equal(state.records.get(result.candidate_id).disposition, disposition);
  }
  assert.throws(() => normalizeSignal(signal({ disposition: 'ignore', source_id: undefined })), /source_id is required/u);
  assert.throws(() => normalizeSignal(signal({ selected_desks: undefined })), /non-empty/u);
});

test('intentional candidate revisions require the latest revision and stable source identity', async () => {
  const state = store();
  await saveSignalDisposition(signal({ disposition: 'defer', selected_desks: [] }), state.adapter);
  await assert.rejects(saveSignalDisposition(signal({ event_key: 'moltnet:later' }), state.adapter), /expected_revision 1/u);
  const updated = await saveSignalDisposition(signal({ event_key: 'moltnet:later', expected_revision: 1 }), state.adapter);
  assert.equal(updated.revision, 2);
  await assert.rejects(saveSignalDisposition(signal({ event_key: 'moltnet:stale', expected_revision: 1, disposition: 'ignore' }), state.adapter), /expected_revision 2/u);
  assert.equal(state.records.size, 1);
  assert.equal((await saveSignalDisposition(signal({ event_key: 'moltnet:another' }), state.adapter)).revision, 2);
});

test('duplicates point at a known lead, never themselves, missing targets or duplicate chains', async () => {
  const state = store();
  await saveSignalDisposition(signal(), state.adapter);
  const duplicate = signal({ event_key: 'moltnet:overlap', source_id: 's-secondary', disposition: 'duplicate', selected_desks: undefined, duplicate_of: 'https://primary.example/lead' });
  const result = await saveSignalDisposition(duplicate, state.adapter);
  assert.equal(result.disposition, 'duplicate');
  await assert.rejects(saveSignalDisposition({ ...duplicate, source_id: 's-third', duplicate_of: 's-secondary' }, state.adapter), /existing non-duplicate/u);
  await assert.rejects(saveSignalDisposition({ ...duplicate, duplicate_of: 's-unknown' }, state.adapter), /existing non-duplicate/u);
  await assert.rejects(saveSignalDisposition({ ...duplicate, duplicate_of: 's-secondary' }, state.adapter), /duplicate itself/u);
});

test('legacy qualified calls stay valid and primary URL fragments do not fork identity', async () => {
  const state = store();
  const legacy = signal(); delete legacy.source_id;
  assert.equal((await saveSignalDisposition(legacy, state.adapter)).candidate_id, signalKey(legacy.event_key));
  await saveSignalDisposition(signal(), state.adapter);
  const result = await saveSignalDisposition(signal({ source_id: 'https://primary.example/lead#quote', event_key: 'moltnet:fragment' }), state.adapter);
  assert.equal(result.unchanged, true);
  assert.equal(result.source_id, 'https://primary.example/lead');
});

test('legacy on-disk records retain their qualified result when read by the new tool', async () => {
  const state = store(), legacy = signal(); delete legacy.source_id;
  state.records.set(signalKey(legacy.event_key), { version: 'clank.qualified-signal.v1', ...legacy });
  const result = await saveSignalDisposition(legacy, state.adapter);
  assert.equal(result.qualified, true);
  assert.equal(result.revision, 1);
  assert.equal(result.unchanged, true);
  assert.equal(state.records.get(result.candidate_id).version, 'clank.qualified-signal.v2');
});

test('transactional tool supports several lead dispositions in one wake and durable indexed replay', { skip: !process.env.CLANK_NEWSROOM_STATE_ADAPTER && 'private newsroom adapter required' }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-signal-dispositions-'));
  const prior = { root: process.env.CLANK_EDITION_STATE_ROOT, role: process.env.CLANK_NEWSROOM_AGENT, wake: process.env.DAIMON_WAKE_ID };
  process.env.CLANK_EDITION_STATE_ROOT = temporary;
  process.env.CLANK_NEWSROOM_AGENT = 'klaxon';
  process.env.DAIMON_WAKE_ID = 'moltnet:batched-notices';
  try {
    const first = signal({ event_key: process.env.DAIMON_WAKE_ID });
    const accepted = await qualifySignal(first);
    assert.deepEqual(await qualifySignal(first), accepted);
    await qualifySignal(signal({ event_key: process.env.DAIMON_WAKE_ID, source_id: 's-ignored', disposition: 'ignore', selected_desks: [] }));
    await qualifySignal(signal({ event_key: process.env.DAIMON_WAKE_ID, source_id: 's-deferred', disposition: 'defer', selected_desks: [] }));
    await qualifySignal(signal({ event_key: process.env.DAIMON_WAKE_ID, source_id: 's-duplicate', disposition: 'duplicate', duplicate_of: first.source_id, selected_desks: [] }));
    await assert.rejects(qualifySignal({ ...first, summary: 'An incompatible changed decision in the same accepted wake.' }), /event_key conflict/u);
    const base = path.join(temporary, 'editions', edition);
    assert.equal((await readdir(path.join(base, 'candidates'))).length, 4);
    const index = await readFile(path.join(base, 'INDEX'), 'utf8');
    assert.equal(index.split('\n').filter(line => line.startsWith('C ')).length, 4);
    for (const disposition of ['qualified', 'ignore', 'defer', 'duplicate']) assert.match(index, new RegExp(` ${disposition} desks=`));
    assert.match(index, /assignments=0 filings=0/u);
    process.env.DAIMON_WAKE_ID = 'moltnet:later-notice';
    const repeat = await qualifySignal({ ...first, event_key: process.env.DAIMON_WAKE_ID });
    assert.equal(repeat.unchanged, true);
    assert.equal(repeat.revision, 1);
  } finally {
    for (const [key, value] of [['CLANK_EDITION_STATE_ROOT', prior.root], ['CLANK_NEWSROOM_AGENT', prior.role], ['DAIMON_WAKE_ID', prior.wake]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(temporary, { recursive: true, force: true });
  }
});
