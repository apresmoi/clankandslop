import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ACTIVITY_PROBE, ACTIVITY_PROBE_SOURCE, HEALTHCHECK_PROGRAM, executionAuthority } from './quiescence-activity.mjs';
import { foreignProcesses, quiescence } from './wake-window.mjs';

const now = new Date('2026-09-11T18:30:00Z');
const receipt = state => ({ acceptance_id: 'a', agent_id: 'agent:a', delivery_id: 'd', state, active: false });
const execution = { agent_id: 'agent:a', execution_id: 'batch-1', state: 'running', delivery_ids: ['d'] };
const envelope = (executions = [], items = [receipt('accepted')]) => ({ version: 'noopolis.daimon.organization-runtime-activity.v2', items, executions });
const response = body => JSON.stringify({ status: 200, body });
const idlePs = '1 0 node /usr/local/bin/daimon-runtime run --config /var/lib/spawnfile/instances/daimon/org/config.json';
function probe({ activity = response(envelope()), state = 'accepted', usage = '', ps = idlePs } = {}) {
  const calls = [];
  const result = quiescence('test', { now, inspect: () => 'running healthy', exec: (_container, script) => {
    calls.push(script);
    if (script === ACTIVITY_PROBE) { if (activity instanceof Error) throw activity; return activity; }
    if (script.includes('wake-acceptance')) return JSON.stringify(receipt(state));
    if (script.includes('usage.jsonl')) return usage;
    if (script.startsWith('ps ')) return ps;
    throw new Error('unexpected command');
  } });
  return { ...result, calls };
}

test('default quiescence uses execution authority: durable pending work and a recent completed turn permit redeploy', () => {
  const result = probe({ usage: JSON.stringify({ complete: true, at: now.toISOString() }) });
  assert.equal(result.quiet, true);
  assert.equal(result.observed.authority, 'executions');
  assert.equal(result.observed.lastTurnMinutesAgo, 0);
  assert.equal(result.calls.filter(script => script === ACTIVITY_PROBE).length, 1);
  assert.equal(result.calls.some(script => script.includes('wake-acceptance')), false, 'pending receipt files are not cognition');
});

test('running execution blocks even when every delivery receipt says completed and inactive', () => {
  const result = probe({ activity: response(envelope([execution], [receipt('completed')])), state: 'completed' });
  assert.equal(result.quiet, false);
  assert.match(result.findings.join(' '), /execution batch-1.*running/);
});

test('malformed and unreachable activity fail closed without consulting legacy receipt files', () => {
  const malformed = [
    new Error('connection refused'), '', '{', 'null', JSON.stringify({ status: 401 }), JSON.stringify({ status: 500 }),
    response({}), response({ ...envelope(), version: 'unknown' }), response({ ...envelope(), items: null }),
    response(envelope([], [null])), response(envelope([], [{ ...receipt('completed'), active: 'false' }])),
    ...[null, {}, '[]', [null], [{}], [{ ...execution, state: 'completed' }],
      [{ ...execution, execution_id: '' }], [{ ...execution, agent_id: '' }],
      [{ ...execution, delivery_ids: [] }], [{ ...execution, delivery_ids: ['d', null] }],
      [execution, { ...execution, delivery_ids: null }]].map(executions => response(envelope(executions)))
  ];
  for (const activity of malformed) {
    const result = probe({ activity, state: 'completed' });
    assert.equal(result.quiet, false, String(activity));
    assert.match(result.findings.join(' '), /valid authenticated runtime activity/);
    assert.equal(result.calls.some(script => script.includes('wake-acceptance')), false);
  }
});

test('only HTTP404 or a valid legacy envelope without executions retains the receipt and quiet-period guards', () => {
  const legacy = envelope(); delete legacy.executions;
  for (const activity of [JSON.stringify({ status: 404 }), response(legacy)]) {
    const pending = probe({ activity });
    assert.equal(pending.quiet, false);
    assert.equal(pending.observed.authority, 'legacy-receipts');
    assert.match(pending.findings.join(' '), /wake d.*accepted/);
    const recent = probe({ activity, state: 'completed', usage: JSON.stringify({ complete: true, at: now.toISOString() }) });
    assert.equal(recent.quiet, false);
    assert.match(recent.findings.join(' '), /ledger must be quiet for 15 min/);
    assert.equal(probe({ activity, state: 'completed' }).quiet, true);
  }
});

test('new execution authority retains independent incomplete-ledger and engine-process checks', () => {
  const incomplete = probe({ usage: JSON.stringify({ complete: false, at: now.toISOString() }) });
  assert.equal(incomplete.quiet, false);
  assert.match(incomplete.findings.join(' '), /incomplete/);
  const engine = probe({ ps: `${idlePs}\n90 1 codex exec --sandbox danger-full-access` });
  assert.equal(engine.quiet, false);
  assert.match(engine.findings.join(' '), /outside the steady-state set/);
});

test('the complete known healthcheck is steady state while altered node programs still block', () => {
  const health = `node -e ${HEALTHCHECK_PROGRAM} /var/lib/spawnfile/instances/daimon/daimon-organization/daimon/daimon-organization-runtime.json`;
  assert.deepEqual(foreignProcesses(`${idlePs}\n90 0 ${health}`), []);
  assert.equal(probe({ ps: `${idlePs}\n90 0 ${health}` }).quiet, true);
  for (const command of [health + ' extra', health.replace('/healthz', '/v2/wakes'), 'node -e console.log("work")',
    health.replace("const fs=require('node:fs');", "const fs=require('node:fs');doWork();")]) {
    assert.deepEqual(foreignProcesses(`${idlePs}\n90 0 ${command}`), [command]);
  }
});

test('the real in-container probe authenticates to loopback with timeout and rejects redirects without exposing its token', () => {
  const token = 'synthetic-private-control-token';
  const stub = `globalThis.fetch = async (url, options) => {
    if (url !== 'http://127.0.0.1:19700/v2/activity' || options.headers.authorization !== 'Bearer ' + process.env.SPAWNFILE_DAIMON_CONTROL_TOKEN || options.redirect !== 'error' || !options.signal) throw new Error('wrong request');
    return { status: 200, text: async () => ${JSON.stringify(JSON.stringify(envelope()))} };
  };`;
  const run = source => spawnSync(process.execPath, ['--input-type=module', '-e', source + ACTIVITY_PROBE_SOURCE], {
    encoding: 'utf8', env: { ...process.env, SPAWNFILE_DAIMON_CONTROL_TOKEN: token }
  });
  const result = run(stub);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(executionAuthority(result.stdout).authority, 'executions');
  assert.equal((result.stdout + result.stderr).includes(token), false);
  for (const stub of ["globalThis.fetch = async () => { throw new Error('transport unavailable'); };",
    "globalThis.fetch = async () => ({status:200,text:async()=>'{'});"]) {
    const failed = run(stub);
    assert.notEqual(failed.status, 0);
    assert.equal(failed.stdout, '');
    assert.equal(failed.stderr, 'Daimon activity probe failed\n');
  }
});
