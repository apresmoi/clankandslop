import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AlarmError, REASONS, composeAlarm, deliver, parseArgs, raise, readBack, readTopicUrl, spool } from './alarm.mjs';

const scratch = () => mkdtempSync(path.join(tmpdir(), 'clank-alarm-test-'));
const url = 'https://ntfy.sh/topic-abcdef';
const environment = (extra = {}) => ({ CLANK_ALARM_URL: url, CLANK_ALARM_HOST: 'testbox', ...extra });

test('every reason the unattended cycle can raise has a title, a priority and a tag', () => {
  for (const reason of ['repin-failed', 'bundle-mismatch', 'deploy-failed', 'no-edition'])
    assert.ok(REASONS[reason]?.title && REASONS[reason].priority && REASONS[reason].tags, `${reason} is not a declared alarm reason`);
});

test('an unknown reason is refused rather than sent as free text', () => {
  assert.throws(() => parseArgs(['--reason=whatever']), AlarmError);
  assert.throws(() => parseArgs([]), AlarmError);
});

test('a channel that is absent or not https is refused, and the URL is never echoed back', () => {
  assert.throws(() => readTopicUrl({}), /CLANK_ALARM_URL is not set/u);
  assert.throws(() => readTopicUrl({ CLANK_ALARM_URL: 'http://ntfy.sh/t' }), /must be https/u);
  assert.throws(() => readTopicUrl({ CLANK_ALARM_URL: 'https://ntfy.sh/a/b' }), /exactly one ntfy topic/u);
  assert.equal(readTopicUrl({ CLANK_ALARM_URL: url }).topic, 'topic-abcdef');
});

test('the breadcrumb is written before the send, so a failed POST never swallows the text', async () => {
  const directory = scratch();
  try {
    const alarm = composeAlarm({ reason: 'deploy-failed', edition: '2026-09-06', message: 'up exited 1', host: 'box', at: '2026-09-06T08:00:00.000Z' });
    const file = spool(alarm, { directory });
    const written = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(written.reason, 'deploy-failed');
    assert.equal(written.edition, '2026-09-06');
    assert.equal(written.message, 'up exited 1');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('delivery retries a transient failure and reports the attempt it succeeded on', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; if (calls < 3) throw new Error('ECONNRESET'); return { ok: true, json: async () => ({ id: 'x' }) }; };
  const result = await deliver(readTopicUrl(environment()), composeAlarm({ reason: 'no-edition', host: 'b', at: 'now' }), { fetchImpl, sleep: async () => {} });
  assert.deepEqual([result.delivered, result.attempt], [true, 3]);
});

test('an undeliverable alarm exits the raise path as undelivered, with the breadcrumb named', async () => {
  const directory = scratch();
  try {
    const fetchImpl = async () => { throw new Error('no route to host'); };
    const result = await raise({ reason: 'repin-failed', edition: '2026-09-06', message: 'ref missing' },
      { environment: environment({ CLANK_ALARM_SPOOL: directory }), now: new Date('2026-09-06T08:00:00Z'), log: () => {}, fetchImpl, sleep: async () => {} });
    assert.equal(result.delivered, false);
    assert.equal(readdirSync(directory).length, 1);
    assert.equal(JSON.parse(readFileSync(result.breadcrumb, 'utf8')).reason, 'repin-failed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a POST that is accepted but never appears in the topic is a FAILED self-test, not a pass', async () => {
  const directory = scratch();
  try {
    const fetchImpl = async (target) => target.includes('/json?poll=')
      ? { ok: true, text: async () => '' }
      : { ok: true, json: async () => ({ id: 'accepted' }) };
    await assert.rejects(
      raise({ reason: 'selftest', selftest: true }, { environment: environment({ CLANK_ALARM_SPOOL: directory }), log: () => {}, fetchImpl, sleep: async () => {}, attempts: 2 }),
      /self-test FAILED/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('read-back matches on the alarm instant, so it cannot pass on somebody else s message', async () => {
  const alarm = composeAlarm({ reason: 'selftest', host: 'b', at: '2026-09-06T08:00:00.000Z' });
  const other = JSON.stringify({ event: 'message', message: 'unrelated 2026-09-05T08:00:00.000Z' });
  const mine = JSON.stringify({ event: 'message', id: 'mine', message: `x ${alarm.body.at}` });
  const seen = await readBack(readTopicUrl(environment()), alarm, { fetchImpl: async () => ({ ok: true, text: async () => `${other}\n${mine}` }), sleep: async () => {} });
  assert.deepEqual(seen.map((entry) => entry.id), ['mine']);
});
