import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { importBrowserBrokerResult, validateBrowserBrokerResult } from './browser-broker-import.mjs';

const result = () => ({ version: 'v1', request_id: 'request-20260816', health: 'ok', sources: [{ url: 'https://example.test/source', retrieved_at: '2026-08-16T10:00:00.000Z', capture_digest: `sha256:${'a'.repeat(64)}`, private_locator: 'private:captures/request-20260816/source.html' }] });
const promote = (root, value = result()) => importBrowserBrokerResult({ edition: '2026-08-16', release: '2026-08-16T16:00:00+02:00[Europe/Berlin]', result: value, selectedDesks: ['vesta', 'cogsworth'], stateRoot: root });

test('imports a schema-valid broker result into one deterministic durable sensor record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-broker-import-'));
  const [first,...rest] = await Promise.all(Array.from({length:12},()=>promote(root)));
  assert.ok(rest.every(value=>JSON.stringify(value)===JSON.stringify(first)));
  assert.equal(first.sensor.id, first.record.occurrence_id);
  assert.equal(first.sensor.sender, 'research-sensor');
  assert.equal(first.sensor.target, 'dm:klaxon');
  assert.ok(Buffer.byteLength(first.sensor.text) <= 2048);
  assert.match(first.sensor.text, /Rolling window:.*https:\/\/example\.test\/source.*gap:.*Provenance:/su);
  assert.doesNotMatch(first.sensor.text, /private:|captures\//u);
  assert.deepEqual(first.record.selected_desks, ['cogsworth', 'vesta']);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'promotions', `${first.record.occurrence_id}.json`), 'utf8')), first.record);
});

test('rejects malformed and non-promotable broker results', async () => {
  for (const mutate of [
    value => { value.extra = true; },
    value => { value.sources[0].capture_digest = 'raw-capture'; },
    value => { value.sources[0].private_locator = '/tmp/raw.html'; },
    value => { value.health = 'degraded'; }
  ]) {
    const value = result(); mutate(value);
    await assert.rejects(promote(await mkdtemp(join(tmpdir(), 'clank-broker-reject-')), value));
  }
  assert.throws(() => validateBrowserBrokerResult({ version: 'v1' }), /schema/);
  await assert.rejects(importBrowserBrokerResult({edition:'2026-08-16',release:'2026-08-16T16:00:00+01:00[Europe/Berlin]',result:result(),selectedDesks:['vesta'],stateRoot:await mkdtemp(join(tmpdir(),'clank-broker-time-'))}),/metadata/);
});
