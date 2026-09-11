import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { orgRoot } from './lib.mjs';
import { BUSY_STATES, PROBE_SENTINEL, WindowError, assess, clockFindings, deriveWindow, foreignProcesses, nextFire, parseCron, previousFire, quiescence, readSchedule } from './wake-window.mjs';

const at = (iso) => new Date(iso);
const berlin = 'Europe/Berlin';

test('cron resolves in the declared timezone, across DST', () => {
  // 13:00 Berlin is 11:00Z in summer and 12:00Z in winter. A window computed in
  // UTC would be an hour wrong for half the year.
  assert.equal(new Date(nextFire('0 13 * * *', berlin, at('2026-09-06T08:00:00Z'))).toISOString(), '2026-09-06T11:00:00.000Z');
  assert.equal(new Date(nextFire('0 13 * * *', berlin, at('2026-12-06T08:00:00Z'))).toISOString(), '2026-12-06T12:00:00.000Z');
  assert.equal(new Date(previousFire('30 16 * * *', berlin, at('2026-09-06T12:00:00Z'))).toISOString(), '2026-09-05T14:30:00.000Z');
});

test('the parked cron is found a year out rather than reported as never', () => {
  // `0 4 1 1 *` is the guard the operator installed. If the horizon were a
  // month the job would see "no next wake" and could not distinguish parked
  // from broken.
  assert.equal(new Date(nextFire('0 4 1 1 *', berlin, at('2026-09-06T12:00:00Z'))).toISOString(), '2027-01-01T03:00:00.000Z');
});

test('day-of-month and day-of-week are OR-ed when both are restricted, as cron does', () => {
  // 2026-09-06 is a Sunday. `0 5 10 * 1` fires on the 10th OR on Mondays.
  assert.equal(new Date(nextFire('0 5 10 * 1', berlin, at('2026-09-06T12:00:00Z'))).toISOString(), '2026-09-07T03:00:00.000Z');
  assert.equal(new Date(nextFire('0 5 10 * *', berlin, at('2026-09-06T12:00:00Z'))).toISOString(), '2026-09-10T03:00:00.000Z');
});

test('a malformed cron is refused, never silently treated as never-fires', () => {
  for (const bad of ['0 18 * *', '0 99 * * *', '0 18 * * * *', '*/0 * * * *'])
    assert.throws(() => parseCron(bad), WindowError, bad);
});

test('the window is read from the Spawnfiles, which are what the compiler lowers', () => {
  const schedule = readSchedule(orgRoot);
  assert.ok(schedule.length >= 11, `expected the eleven scheduled owners, found ${schedule.length}`);
  assert.ok(schedule.every((entry) => entry.timezone === berlin));
  const window = deriveWindow(schedule);
  // Whatever the crons currently say, the derived gap must be a real gap and
  // the recommendation must fit inside it with both margins.
  assert.ok(window.gap.minutes > 0);
  assert.equal(window.recommended.minutes, window.gap.minutes - window.leadMinutes - window.tailMinutes);
});

test('the derived window moves when the schedule moves — it is not a hardcoded hour', () => {
  const morning = deriveWindow([{ agent: 'a', cron: '0 10 * * *', timezone: berlin }, { agent: 'b', cron: '0 16 * * *', timezone: berlin }], { leadMinutes: 15, tailMinutes: 60 });
  assert.deepEqual([morning.gap.from, morning.gap.to], ['16:00', '10:00']);
  const evening = deriveWindow([{ agent: 'a', cron: '0 13 * * *', timezone: berlin }, { agent: 'b', cron: '30 16 * * *', timezone: berlin }], { leadMinutes: 15, tailMinutes: 60 });
  assert.deepEqual([evening.gap.from, evening.gap.to], ['16:30', '13:00']);
  assert.notDeepEqual(morning.recommended, evening.recommended);
});

test('the clock refuses a deploy inside the lead before a wake and the tail after one', () => {
  const schedule = [{ agent: 'cogsworth', cron: '0 13 * * *', timezone: berlin }];
  // 12:45 Berlin = 10:45Z: fifteen minutes before the wake.
  assert.match(clockFindings(schedule, { now: at('2026-09-06T10:45:00Z'), leadMinutes: 30, tailMinutes: 120 }).findings.join(' '), /wakes in 15 min/u);
  // 13:30 Berlin = 11:30Z: thirty minutes after it.
  assert.match(clockFindings(schedule, { now: at('2026-09-06T11:30:00Z'), leadMinutes: 30, tailMinutes: 120 }).findings.join(' '), /woke 30 min ago/u);
  // 09:00 Berlin = 07:00Z: clear on both sides.
  assert.deepEqual(clockFindings(schedule, { now: at('2026-09-06T07:00:00Z'), leadMinutes: 30, tailMinutes: 120 }).findings, []);
});

// --- quiescence: the check that is not the clock -----------------------------
const IDLE_PS = [
  '    1     0 bash /opt/spawnfile/daimon-uid-entrypoint.sh',
  '   39     1 bash /opt/spawnfile/entrypoint.sh --spawnfile-runtime-identity 2000 2000',
  '   63    39 /usr/local/bin/moltnet start --config /var/lib/spawnfile/moltnet/servers/x/Moltnet.json',
  '  365    39 node /usr/local/bin/daimon-runtime run --config /var/lib/spawnfile/instances/daimon/x.json',
  '  630    39 /usr/local/bin/moltnet node /var/lib/spawnfile/moltnet/nodes/x.json',
  `ate 1608     0 sh -c ps -eo pid,ppid,args # ${PROBE_SENTINEL}`.slice(4),
  ' 1609  1608 ps -eo pid,ppid,args'
].join('\n');

const container = (files, { ps = IDLE_PS, usage = '' } = {}) =>
  (_name, script) => {
    if (script.includes('/v2/activity')) return JSON.stringify({ status: 404 });
    if (script.includes('wake-acceptance')) return files.join('\n');
    if (script.includes('usage.jsonl')) return usage;
    if (script.startsWith('ps ')) return ps;
    throw new Error(`unexpected script ${script}`);
  };
const healthy = () => 'running healthy';

test('an outstanding wake receipt blocks the deploy', () => {
  for (const state of BUSY_STATES) {
    const receipt = JSON.stringify({ acceptance_id: 'a1', agent_id: 'agent:spike', delivery_id: 'd1', state, updated_at: '2026-09-06T08:00:00Z' });
    const result = quiescence('c', { exec: container([receipt]), inspect: healthy, now: at('2026-09-06T09:00:00Z') });
    assert.equal(result.quiet, false, state);
    assert.match(result.findings.join(' '), /would kill it/u);
  }
});

test('a terminal wake receipt does not block it', () => {
  const receipt = JSON.stringify({ acceptance_id: 'a1', agent_id: 'agent:spike', delivery_id: 'd1', state: 'completed', updated_at: '2026-09-06T08:00:00Z' });
  const result = quiescence('c', { exec: container([receipt]), inspect: healthy, now: at('2026-09-06T09:00:00Z') });
  assert.deepEqual(result.findings, []);
  assert.equal(result.quiet, true);
});

test('an incomplete turn, or a turn written moments ago, blocks the deploy', () => {
  const incomplete = JSON.stringify({ at: '2026-09-06T05:00:00Z', complete: false });
  assert.match(quiescence('c', { exec: container([], { usage: incomplete }), inspect: healthy, now: at('2026-09-06T09:00:00Z') }).findings.join(' '), /incomplete/u);
  const recent = JSON.stringify({ at: '2026-09-06T08:55:00Z', complete: true });
  assert.match(quiescence('c', { exec: container([], { usage: recent }), inspect: healthy, now: at('2026-09-06T09:00:00Z') }).findings.join(' '), /last metered turn was 5 min ago/u);
  const old = JSON.stringify({ at: '2026-09-06T06:00:00Z', complete: true });
  assert.deepEqual(quiescence('c', { exec: container([], { usage: old }), inspect: healthy, now: at('2026-09-06T09:00:00Z') }).findings, []);
});

test('the quiescence probe cannot see itself — its own sh and ps are not findings', () => {
  // Observed live on 2026-09-06: `docker exec … sh -c 'ps …'` appears in its own
  // output, and a naive filter reported the measurement as work in flight, so
  // the seam could never have run. The probe subtracts its own subtree by PID
  // rather than by pattern, because excluding `sh -c` would also excuse an
  // engine turn.
  assert.deepEqual(foreignProcesses(IDLE_PS), []);
  assert.equal(quiescence('c', { exec: container([]), inspect: healthy, now: at('2026-09-06T09:00:00Z') }).quiet, true);
});

test('a process outside the steady-state set blocks the deploy', () => {
  const ps = `${IDLE_PS}\n 1700    39 codex exec --sandbox danger-full-access`;
  const result = quiescence('c', { exec: container([], { ps }), inspect: healthy, now: at('2026-09-06T09:00:00Z') });
  assert.match(result.findings.join(' '), /outside the steady-state set/u);
  assert.deepEqual(result.observed.extraProcesses, ['codex exec --sandbox danger-full-access']);
});

test('a container that cannot be read is NOT quiet — the check fails closed', () => {
  const unreadable = quiescence('nope', { inspect: () => { throw new Error('No such container'); } });
  assert.equal(unreadable.quiet, false);
  assert.match(unreadable.findings.join(' '), /refusing to call an unreadable container quiet/u);
  const halfRead = quiescence('c', { inspect: healthy, exec: () => { throw new Error('exec refused'); }, now: at('2026-09-06T09:00:00Z') });
  assert.equal(halfRead.quiet, false);
  assert.equal(halfRead.findings.length, 3, 'each unreadable signal must produce its own finding');
});

test('assess is unsafe when either half objects, and safe only when both are clear', () => {
  const clear = assess(orgRoot, 'c', { now: at('2026-09-06T07:00:00Z'), skipContainer: true });
  assert.equal(clear.safe, clear.clock.findings.length === 0);
  const blocked = assess(orgRoot, 'nope', { now: at('2026-09-06T07:00:00Z'), inspect: () => { throw new Error('No such container'); } });
  assert.equal(blocked.safe, false);
});

test('a Spawnfile with a schedule but no timezone is an error, not a default', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clank-window-test-'));
  try {
    mkdirSync(path.join(root, 'agents', 'x'), { recursive: true });
    writeFileSync(path.join(root, 'agents', 'x', 'Spawnfile'), 'schedule:\n  kind: cron\n  cron: "0 9 * * *"\n');
    assert.throws(() => readSchedule(root), /without both cron and timezone/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
