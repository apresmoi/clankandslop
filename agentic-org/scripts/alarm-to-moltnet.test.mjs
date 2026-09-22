import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ALARM_ROOM, BridgeError, assertAccepted, assertLunaReachable, bridge, composeAlarmMessage, mentionFindings, pendingAlarms } from './alarm-to-moltnet.mjs';

const connected = () => JSON.stringify({ id: 'clank-luna' });

const scratch = () => mkdtempSync(path.join(tmpdir(), 'clank-alarm-bridge-'));
const alarm = (extra = {}) => ({
  reason: 'deploy-failed', edition: '2026-09-22', message: 'the container never settled',
  at: '2026-09-22T09:06:38.000Z', host: 'clankandslop', ...extra
});

test('the message says whether to get up, without opening anything', () => {
  const text = composeAlarmMessage(alarm(), { breadcrumb: '/var/lib/clank-alarm/spool/x.json' });
  assert.match(text, /^CLANK ALARM NEEDS A HUMAN — deploy-failed$/mu);
  assert.match(text, /what: the container never settled/u);
  assert.match(text, /where: clankandslop, edition 2026-09-22/u);
  assert.match(text, /evidence: \/var\/lib\/clank-alarm\/spool\/x\.json/u);
  // A gate refusal is the one the next run retries by itself.
  assert.match(composeAlarmMessage(alarm({ reason: 'seam-blocked' }), { breadcrumb: '/x' }), /^CLANK ALARM WAITS — seam-blocked$/mu);
});

test('an alarm that would mention a newsroom agent is refused, not rewritten', () => {
  // Stripping the mention would hide that an alarm tried to address the
  // newsroom; the alarm is an observer notification and never an instruction.
  assert.deepEqual(mentionFindings('CLANK ALARM — nothing to see'), []);
  assert.deepEqual(mentionFindings('waiting on @caslon'), ['alarm text mentions @caslon; an alarm may not address a newsroom agent']);
  assert.deepEqual(mentionFindings('an email like ops@example.com is not a mention'), []);

  const directory = scratch();
  try {
    writeFileSync(path.join(directory, 'a.json'), JSON.stringify(alarm({ message: 'compose blocked, @caslon owns the missing desk' })));
    const sent = [];
    const results = bridge({ spool: directory, token: 't' }, { lunaNetwork: connected, post: (...args) => { sent.push(args); return '202 {"message_id":"msg_1","event_id":"evt_1","accepted":true}'; }, log: () => undefined });
    assert.deepEqual(sent, [], 'nothing may be posted');
    assert.equal(results[0].posted, false);
    assert.ok(results[0].refused[0].includes('@caslon'));
    assert.ok(!readdirSync(directory).includes('a.json.posted'), 'a refused alarm stays pending');
    assert.ok(readdirSync(directory).includes('a.json'), 'and the record itself is untouched');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a transport failure costs the notification and never the record', () => {
  const directory = scratch();
  try {
    writeFileSync(path.join(directory, 'a.json'), JSON.stringify(alarm()));
    const results = bridge({ spool: directory, token: 't' }, {
      lunaNetwork: connected, post: () => { throw new Error('container is not running'); }, log: () => undefined
    });
    assert.equal(results[0].posted, false);
    assert.deepEqual(readdirSync(directory), ['a.json'], 'no marker, nothing deleted, nothing moved');
    assert.equal(JSON.parse(readFileSync(path.join(directory, 'a.json'), 'utf8')).reason, 'deploy-failed');

    // And the retry on the next run succeeds and marks it exactly once.
    const sent = [];
    bridge({ spool: directory, token: 't' }, { lunaNetwork: connected, post: (...args) => { sent.push(args); return '202 {"message_id":"msg_1","event_id":"evt_1","accepted":true}'; }, log: () => undefined });
    assert.equal(sent.length, 1);
    assert.ok(readdirSync(directory).includes('a.json.posted'));
    // A posted alarm is still an alarm: the evidence survives the notification.
    assert.equal(JSON.parse(readFileSync(path.join(directory, 'a.json'), 'utf8')).reason, 'deploy-failed');
    assert.deepEqual(readdirSync(directory).sort(), ['a.json', 'a.json.posted']);
    bridge({ spool: directory, token: 't' }, { lunaNetwork: connected, post: () => { throw new Error('must not be called again'); }, log: () => undefined });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('it posts to room:release, oldest first, and refuses to run with no token', () => {
  const directory = scratch();
  try {
    writeFileSync(path.join(directory, '2026-09-22T09-00-00Z.deploy-failed.json'), JSON.stringify(alarm()));
    writeFileSync(path.join(directory, '2026-09-22T08-00-00Z.repin-failed.json'), JSON.stringify(alarm({ reason: 'repin-failed', message: 'ref missing' })));
    const sent = [];
    bridge({ spool: directory, token: 't' }, { lunaNetwork: connected, post: (_container, room, text) => { sent.push([room, text.split('\n')[0]]); return '202 {"message_id":"msg_1","event_id":"evt_1","accepted":true}'; }, log: () => undefined });
    assert.deepEqual(sent.map(([room]) => room), [ALARM_ROOM, ALARM_ROOM]);
    assert.match(sent[0][1], /repin-failed/u, 'oldest first');

    // No token is a refusal, not a silent no-op: an alarm that goes nowhere
    // quietly is the failure this whole path exists to prevent.
    assert.throws(() => bridge({ spool: directory }, { log: () => undefined }), BridgeError);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a POST that was not accepted is not a delivery', () => {
  // The first version ran `curl -sS`, which exits 0 on a 405 as happily as on
  // a 202, and reported twelve alarms delivered that the room never received.
  assert.equal(assertAccepted('202 {"message_id":"msg_1","accepted":true}'), 'msg_1');
  for (const response of [
    '405 Method Not Allowed',
    '422 {"code":"unprocessable_entity","error":"from.id is required"}',
    '200 not json at all',
    '200 {"accepted":false}',
    '200 {"accepted":true}',
    ''
  ]) assert.throws(() => assertAccepted(response), BridgeError, response);

  // And an unaccepted post leaves the entry pending, exactly like a throw.
  const directory = scratch();
  try {
    writeFileSync(path.join(directory, 'a.json'), JSON.stringify(alarm()));
    const results = bridge({ spool: directory, token: 't' }, { lunaNetwork: connected, post: () => '405 Method Not Allowed', log: () => undefined });
    assert.equal(results[0].posted, false);
    assert.deepEqual(readdirSync(directory), ['a.json'], 'nothing may be marked posted');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('an unreadable spool entry is reported and left alone, and a missing spool is not a crash', () => {
  const directory = scratch();
  try {
    writeFileSync(path.join(directory, 'broken.json'), '{not json');
    const lines = [];
    const results = bridge({ spool: directory, token: 't' }, { lunaNetwork: connected, post: () => { throw new Error('must not be called'); }, log: (line) => lines.push(line) });
    assert.equal(results[0].posted, false);
    assert.match(lines.join(' '), /skipped broken\.json/u);
    assert.deepEqual(readdirSync(directory), ['broken.json']);
    assert.deepEqual(pendingAlarms(path.join(directory, 'nope')), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('an unreachable Luna network leaves the alarm for a later bridge run', () => {
  assertLunaReachable(connected());
  assert.throws(() => assertLunaReachable(JSON.stringify({ id: 'another-network' })), BridgeError);
  const directory = scratch();
  try {
    writeFileSync(path.join(directory, 'a.json'), JSON.stringify(alarm()));
    writeFileSync(path.join(directory, 'b.json'), JSON.stringify(alarm()));
    const sent = [];
    let probes = 0;
    const first = bridge({ spool: directory, token: 't' }, {
      lunaNetwork: () => { probes++; throw new Error('remote request failed'); },
      post: () => { sent.push('sent'); return '202 {"message_id":"msg_1","accepted":true}'; }, log: () => undefined
    });
    assert.ok(first.every((entry) => !entry.posted));
    assert.equal(probes, 1, 'a down relay is probed once per bridge run');
    assert.deepEqual(sent, []);
    assert.deepEqual(readdirSync(directory).sort(), ['a.json', 'b.json']);
    const second = bridge({ spool: directory, token: 't' }, {
      lunaNetwork: connected,
      post: () => { sent.push('sent'); return '202 {"message_id":"msg_1","accepted":true}'; }, log: () => undefined
    });
    assert.ok(second.every((entry) => entry.posted));
    assert.deepEqual(sent, ['sent', 'sent']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
