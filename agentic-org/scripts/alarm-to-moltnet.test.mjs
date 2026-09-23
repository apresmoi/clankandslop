import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ALARM_ROOM, BridgeError, ESCALATION_MARKER, assertAccepted, bridge, composeAlarmMessage, composeEscalation, containerEndpoint, escalate, lunaPairingReachable, mentionFindings, pendingAlarms, statusFirst } from './alarm-to-moltnet.mjs';

const connected = () => JSON.stringify({ id: 'clank-luna' });
// The existing tests all exercise the `docker exec` transport, so they pin the
// endpoint rather than shelling out to a real `docker inspect`. `running` with
// no bridge address is the honest shape for "exec is the only way in".
const execOnly = () => ({ state: 'running', ip: undefined });

const scratch = () => mkdtempSync(path.join(tmpdir(), 'clank-alarm-bridge-'));
// The bridge keeps an attempt log beside the alarms; it is never an alarm.
const spoolFiles = (directory) => readdirSync(directory).filter((name) => name !== 'attempts.jsonl').sort();
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
    const results = bridge({ spool: directory, token: 't' }, { endpoint: execOnly, lunaNetwork: connected, post: (...args) => { sent.push(args); return '202 {"message_id":"msg_1","event_id":"evt_1","accepted":true}'; }, log: () => undefined });
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
      endpoint: execOnly,
      lunaNetwork: connected, post: () => { throw new Error('container is not running'); }, log: () => undefined
    });
    assert.equal(results[0].posted, false);
    assert.deepEqual(spoolFiles(directory), ['a.json'], 'no marker, nothing deleted, nothing moved');
    assert.equal(JSON.parse(readFileSync(path.join(directory, 'a.json'), 'utf8')).reason, 'deploy-failed');

    // And the retry on the next run succeeds and marks it exactly once.
    const sent = [];
    bridge({ spool: directory, token: 't' }, { endpoint: execOnly, lunaNetwork: connected, post: (...args) => { sent.push(args); return '202 {"message_id":"msg_1","event_id":"evt_1","accepted":true}'; }, log: () => undefined });
    assert.equal(sent.length, 1);
    assert.ok(readdirSync(directory).includes('a.json.posted'));
    // A posted alarm is still an alarm: the evidence survives the notification.
    assert.equal(JSON.parse(readFileSync(path.join(directory, 'a.json'), 'utf8')).reason, 'deploy-failed');
    assert.deepEqual(spoolFiles(directory), ['a.json', 'a.json.posted']);
    bridge({ spool: directory, token: 't' }, { endpoint: execOnly, lunaNetwork: connected, post: () => { throw new Error('must not be called again'); }, log: () => undefined });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('it posts to room:release, oldest first, and refuses to run with no token', () => {
  const directory = scratch();
  try {
    writeFileSync(path.join(directory, '2026-09-22T09-00-00Z.deploy-failed.json'), JSON.stringify(alarm()));
    writeFileSync(path.join(directory, '2026-09-22T08-00-00Z.repin-failed.json'), JSON.stringify(alarm({ reason: 'repin-failed', message: 'ref missing' })));
    const sent = [];
    bridge({ spool: directory, token: 't' }, { endpoint: execOnly, lunaNetwork: connected, post: (_container, room, text) => { sent.push([room, text.split('\n')[0]]); return '202 {"message_id":"msg_1","event_id":"evt_1","accepted":true}'; }, log: () => undefined });
    assert.deepEqual(sent.map(([room]) => room), [ALARM_ROOM, ALARM_ROOM]);
    assert.match(sent[0][1], /repin-failed/u, 'oldest first');

    // No token is a refusal, not a silent no-op: an alarm that goes nowhere
    // quietly is the failure this whole path exists to prevent.
    assert.throws(() => bridge({ spool: directory }, { endpoint: execOnly, log: () => undefined }), BridgeError);
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
    const results = bridge({ spool: directory, token: 't' }, { endpoint: execOnly, lunaNetwork: connected, post: () => '405 Method Not Allowed', log: () => undefined });
    assert.equal(results[0].posted, false);
    assert.deepEqual(spoolFiles(directory), ['a.json'], 'nothing may be marked posted');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('an unreadable spool entry is reported and left alone, and a missing spool is not a crash', () => {
  const directory = scratch();
  try {
    writeFileSync(path.join(directory, 'broken.json'), '{not json');
    const lines = [];
    const results = bridge({ spool: directory, token: 't' }, { endpoint: execOnly, lunaNetwork: connected, post: () => { throw new Error('must not be called'); }, log: (line) => lines.push(line) });
    assert.equal(results[0].posted, false);
    assert.match(lines.join(' '), /skipped broken\.json/u);
    assert.deepEqual(spoolFiles(directory), ['broken.json']);
    assert.deepEqual(pendingAlarms(path.join(directory, 'nope')), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('an unreachable relay costs the confirmation, never the local alarm', () => {
  // The first version of this withheld the room post entirely while Luna was
  // unreachable — trading a visible alarm for an invisible one. The local post
  // is verifiable and the relay is not, so they are decided separately.
  assert.deepEqual(lunaPairingReachable(connected()), { reachable: true });
  assert.equal(lunaPairingReachable(JSON.stringify({ id: 'another-network' })).reachable, false);
  assert.equal(lunaPairingReachable('not json').reachable, false);

  const directory = scratch();
  try {
    writeFileSync(path.join(directory, 'a.json'), JSON.stringify(alarm()));
    writeFileSync(path.join(directory, 'b.json'), JSON.stringify(alarm()));
    const sent = [];
    let probes = 0;
    const results = bridge({ spool: directory, token: 't' }, {
      endpoint: execOnly,
      lunaNetwork: () => { probes++; throw new Error('remote request failed'); },
      post: () => { sent.push('sent'); return '202 {"message_id":"msg_1","accepted":true}'; }, log: () => undefined
    });
    assert.deepEqual(sent, ['sent', 'sent'], 'both alarms still reach the room');
    assert.ok(results.every((entry) => entry.posted));
    assert.ok(results.every((entry) => entry.relay === 'pairing_unreachable'));

    // And the marker says exactly what was proven, and not one word more.
    const marker = JSON.parse(readFileSync(path.join(directory, 'a.json.posted'), 'utf8'));
    assert.equal(marker.posted_to_room, ALARM_ROOM);
    assert.equal(marker.message_id, 'msg_1');
    assert.equal(marker.relay, 'pairing_unreachable');
    assert.equal(marker.delivery_confirmed, false);
    assert.equal(probes, 1, 'a down relay is probed once per bridge run, not once per alarm');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a reachable pairing is still not a delivery, and the record says so', () => {
  // This is the honest limit: the relay is asynchronous and this host never
  // sees an acknowledgement for a specific message. Anything that called this
  // "delivered" would be the silent-success bug in a new hat.
  const directory = scratch();
  try {
    writeFileSync(path.join(directory, 'a.json'), JSON.stringify(alarm()));
    const results = bridge({ spool: directory, token: 't' }, {
      endpoint: execOnly,
      lunaNetwork: connected, post: () => '202 {"message_id":"msg_9","accepted":true}', log: () => undefined
    });
    assert.equal(results[0].relay, 'pairing_reachable');
    const marker = JSON.parse(readFileSync(path.join(directory, 'a.json.posted'), 'utf8'));
    assert.equal(marker.relay, 'pairing_reachable');
    assert.equal(marker.delivery_confirmed, false, 'reachable is never delivered');
    assert.match(marker.note, /not observable from this host/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('every attempt is recorded, so a silent week is distinguishable from a quiet one', () => {
  const directory = scratch();
  try {
    writeFileSync(path.join(directory, 'a.json'), JSON.stringify(alarm()));
    bridge({ spool: directory, token: 't' }, { endpoint: execOnly, lunaNetwork: connected, post: () => { throw new Error('down'); }, log: () => undefined });
    bridge({ spool: directory, token: 't' }, { endpoint: execOnly, lunaNetwork: connected, post: () => '202 {"message_id":"m","accepted":true}', log: () => undefined });
    const attempts = readFileSync(path.join(directory, 'attempts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(attempts.map((row) => row.posted), [false, true]);
    assert.deepEqual(attempts.map((row) => row.relay), [null, 'pairing_reachable']);
    // The attempt log is never mistaken for an alarm.
    assert.deepEqual(pendingAlarms(directory).map((entry) => path.basename(entry.file)), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


// --- the bridge must not depend on the container it reports on ----------------

const spoolAlarm = (directory, name = '2026-09-23T09-05-33-187Z.deploy-failed.json', body = {}) => {
  writeFileSync(path.join(directory, name), JSON.stringify({
    version: 'clank.alarm.v1', reason: 'deploy-failed', edition: '2026-09-23', host: 'clankandslop',
    at: '2026-09-23T09:05:33.187Z', message: 'deploy-failed after [build]',
    detail: 'Candidate container did not become ready; /home/clank/deploy-work/secret-ish/path',
    ...body
  }));
  return path.join(directory, name);
};
const accepted = '202 {"message_id":"msg_1","accepted":true}';

test('curl writes the body then the status; the assertion still reads status first', () => {
  // `assertAccepted` is the one place that decides what a delivery is, and it
  // wants "<status> <body>". Host curl emits them the other way round.
  assert.equal(statusFirst('{"accepted":true}\n202'), '202 {"accepted":true}');
  assert.equal(statusFirst('\n401'), '401 ');
  // A body containing newlines must not fool it — the LAST newline is the split.
  assert.equal(statusFirst('{"a":1,\n"b":2}\n202'), '202 {"a":1,\n"b":2}');
});

test('a running container with a bridge address is reached over HTTP, not through docker exec', () => {
  const directory = scratch();
  try {
    spoolAlarm(directory);
    const overHttp = [];
    const results = bridge({ spool: directory, token: 't' }, {
      endpoint: () => ({ state: 'running', ip: '172.17.0.3' }),
      hostPostImpl: (ip, room, text) => { overHttp.push([ip, room]); return '{"message_id":"msg_1","accepted":true}\n202'; },
      hostLunaImpl: () => JSON.stringify({ id: 'clank-luna' }),
      post: () => { throw new Error('docker exec must not be used when HTTP works'); },
      lunaNetwork: () => { throw new Error('docker exec must not be used when HTTP works'); },
      log: () => undefined
    });
    assert.deepEqual(overHttp, [['172.17.0.3', ALARM_ROOM]]);
    assert.equal(results[0].transport, 'host-http');
    const marker = JSON.parse(readFileSync(`${path.join(directory, spoolFiles(directory)[0])}.posted`, 'utf8'));
    assert.equal(marker.transport, 'host-http');
    assert.equal(marker.container_state, 'running');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a broken HTTP path falls back to docker exec rather than losing the alarm', () => {
  const directory = scratch();
  try {
    spoolAlarm(directory);
    const results = bridge({ spool: directory, token: 't' }, {
      endpoint: () => ({ state: 'running', ip: '172.17.0.3' }),
      hostPostImpl: () => { throw new Error('connection refused'); },
      hostLunaImpl: () => { throw new Error('the probe must follow the transport that worked'); },
      lunaNetwork: connected,
      post: () => accepted,
      log: () => undefined
    });
    assert.equal(results[0].posted, true);
    assert.equal(results[0].transport, 'docker-exec');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('an HTTP post that was not accepted is not a delivery either', () => {
  // The silent-success bug must not come back through the new transport.
  const directory = scratch();
  try {
    spoolAlarm(directory);
    const results = bridge({ spool: directory, token: 't' }, {
      endpoint: () => ({ state: 'running', ip: '172.17.0.3' }),
      hostPostImpl: () => 'Method Not Allowed\n405',
      post: () => { throw new Error('exec also down'); },
      escalateImpl: () => false,
      log: () => undefined
    });
    assert.equal(results[0].posted, false);
    assert.deepEqual(spoolFiles(directory).filter((name) => name.endsWith('.posted')), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a container that is down cannot be reported INTO the room, so it is escalated out of band', () => {
  const directory = scratch();
  try {
    const file = spoolAlarm(directory);
    const pushed = [];
    const results = bridge({ spool: directory, token: 't', escalationUrl: 'https://ntfy.sh/topic' }, {
      endpoint: () => ({ state: 'exited', ip: undefined }),
      post: () => { throw new Error('Error response from daemon: container is not running'); },
      escalateImpl: (entry, options) => escalate(entry, { ...options, push: (url, title, body) => { pushed.push([url, title, body]); return 'ok\n200'; } }),
      log: () => undefined
    });
    assert.equal(results[0].posted, false);
    assert.equal(results[0].escalated, true);
    assert.equal(pushed.length, 1);
    const [url, title, body] = pushed[0];
    assert.equal(url, 'https://ntfy.sh/topic');
    assert.match(title, /deploy-failed/u);
    assert.match(body, /container exited/u);
    // MUTATION CHECK: the detail line is where paths and diagnostics live and
    // it must never leave the box. Delete this filter and this goes red.
    assert.ok(!body.includes('secret-ish'), `escalation leaked the detail line: ${body}`);
    assert.ok(!body.includes('/home/clank'), `escalation leaked a host path: ${body}`);
    // And the escalation is recorded beside the alarm.
    assert.ok(spoolFiles(directory).includes(`${path.basename(file)}${ESCALATION_MARKER}`));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the pager fires once per alarm, not every two minutes', () => {
  const directory = scratch();
  try {
    spoolAlarm(directory);
    const pushed = [];
    const run = () => bridge({ spool: directory, token: 't', escalationUrl: 'https://ntfy.sh/topic' }, {
      endpoint: () => ({ state: 'missing', ip: undefined }),
      post: () => { throw new Error('no such container'); },
      escalateImpl: (entry, options) => escalate(entry, { ...options, push: (u, t, b) => { pushed.push(b); return 'ok\n200'; } }),
      log: () => undefined
    });
    run(); run(); run();
    assert.equal(pushed.length, 1, 'a pager that repeats every two minutes is a pager somebody mutes');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('with no channel configured the escalation says so rather than pretending', () => {
  const directory = scratch();
  try {
    spoolAlarm(directory);
    const lines = [];
    const results = bridge({ spool: directory, token: 't' }, {
      endpoint: () => ({ state: 'missing', ip: undefined }),
      post: () => { throw new Error('no such container'); },
      log: (line) => lines.push(line)
    });
    assert.equal(results[0].escalated, false);
    assert.ok(lines.some((line) => /no CLANK_ALARM_URL is configured/u.test(line)), lines.join(' | '));
    // The alarm is still on disk, unposted, and will be retried.
    assert.deepEqual(spoolFiles(directory).filter((name) => name.endsWith('.posted')), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('an ntfy refusal is not an escalation', () => {
  const directory = scratch();
  try {
    const file = spoolAlarm(directory);
    const result = escalate({ file, body: { reason: 'deploy-failed', host: 'clankandslop' } }, {
      url: 'https://ntfy.sh/topic', state: 'exited', push: () => 'rate limited\n429', log: () => undefined
    });
    assert.equal(result, false);
    assert.ok(!spoolFiles(directory).includes(`${path.basename(file)}${ESCALATION_MARKER}`));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the endpoint is read with docker inspect, which still answers for a stopped container', () => {
  assert.deepEqual(containerEndpoint('c', { exec: () => 'running 172.17.0.3 \n' }), { state: 'running', ip: '172.17.0.3' });
  assert.deepEqual(containerEndpoint('c', { exec: () => 'exited  \n' }), { state: 'exited', ip: undefined });
  // A container docker has never heard of is a fact, not a crash.
  const missing = containerEndpoint('c', { exec: () => { throw new Error('No such object: c'); } });
  assert.equal(missing.state, 'missing');
  assert.match(missing.why, /No such object/u);
});

test('the short form carries what a person needs and nothing they must not receive', () => {
  const body = composeEscalation({ reason: 'seam-blocked', host: 'clankandslop', edition: '2026-09-23', at: 'T', detail: '/root/secret' }, { state: 'exited' });
  assert.match(body, /seam-blocked/u);
  assert.match(body, /clankandslop/u);
  assert.match(body, /2026-09-23/u);
  assert.ok(!body.includes('/root/secret'));
});
