#!/usr/bin/env node
// "Is it safe to redeploy right now?" — answered from the declarations and
// from the running container, never from a hardcoded hour.
//
// WHY THIS EXISTS
// ---------------
// A redeploy KILLS every in-flight wake: `spawnfile up` replaces the container
// and whatever turn was mid-flight dies with it. The seam job (repin → rebuild
// → redeploy) therefore has one hard precondition — nothing may be awake — and
// the two ways to get that wrong are both easy:
//
//   * hardcoding "safe before 09:45" and never noticing the schedule moved.
//     The crons live in agents/<agent>/Spawnfile and have already moved once
//     (the repin script's own header still says 10:00; the tree says 13:00).
//     So the window is DERIVED from those files, every run.
//   * trusting the clock. Being outside the wake window does not prove nothing
//     is running: a wake can overrun, and an operator can fire a manual one at
//     any hour. So the clock is only the cheap pre-filter, and the decision is
//     made by reading the running container's own state.
//
// WHAT COUNTS AS AWAKE
// --------------------
// Three independent signals, any one of which blocks a deploy:
//   1. authenticated runtime executions; older runtimes without that field
//      retain the outstanding wake-receipt check;
//   2. the turn usage ledger — an incomplete turn record, plus a recent-turn
//      quiet period only when the runtime lacks execution authority;
//   3. the container's process table — an engine process that is not part of
//      the steady-state set.
// A signal that cannot be read is NOT quiescence: an unreadable container
// fails closed, because "I could not tell" and "nothing is running" must never
// produce the same answer.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ACTIVITY_PROBE, executionAuthority, isRuntimeHealthcheck } from './quiescence-activity.mjs';

export const ACCEPTANCE_STORE = '/var/lib/spawnfile/instances/daimon/daimon-organization/state/wake-acceptance';
export const USAGE_LEDGER = '/var/lib/spawnfile/daimon/usage/usage.jsonl';
// daimon's WakeReceiptState (daimon/src/runtime/wakeAcceptanceTypes.ts). The
// first two mean a turn is outstanding; the rest are terminal.
export const BUSY_STATES = Object.freeze(new Set(['accepted', 'running']));
// The processes a healthy idle container always has: the two entrypoints, the
// Moltnet server, the organization runtime, and one Moltnet node per agent.
// Anything else running under the runtime is work in flight.
export const STEADY_STATE = Object.freeze([/daimon-uid-entrypoint\.sh/u, /\/opt\/spawnfile\/entrypoint\.sh/u, /moltnet start --config/u, /moltnet node /u, /daimon-runtime run --config/u]);
// `docker exec … sh -c 'ps …'` shows up in its own output as the shell plus the
// ps it spawned. Excluding those by pattern would mean excluding `sh -c`, which
// is exactly the shape an engine turn takes — so the probe carries a sentinel
// instead and its own subtree is subtracted by PID. Anything left is real.
export const PROBE_SENTINEL = 'clank-quiescence-probe';

export class WindowError extends Error {}
const fail = (message) => { throw new WindowError(message); };

// --- cron, in a named timezone ----------------------------------------------
const field = (spec, low, high) => {
  const values = new Set();
  for (const part of spec.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) fail(`cron step ${JSON.stringify(part)} is not a positive integer`);
    let [from, to] = range === '*' ? [low, high] : range.includes('-') ? range.split('-').map(Number) : [Number(range), Number(range)];
    if (range !== '*' && !range.includes('-')) to = from;
    if (![from, to].every((value) => Number.isInteger(value) && value >= low && value <= high)) fail(`cron field ${JSON.stringify(part)} is out of range ${low}-${high}`);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
};

export function parseCron(expression) {
  const parts = String(expression).trim().split(/\s+/u);
  if (parts.length !== 5) fail(`cron expression ${JSON.stringify(expression)} must have five fields`);
  const [minute, hour, dom, month, dow] = parts;
  return {
    minute: field(minute, 0, 59), hour: field(hour, 0, 23), dom: field(dom, 1, 31),
    month: field(month, 1, 12), dow: field(dow.replace(/\b7\b/u, '0'), 0, 6),
    domRestricted: dom !== '*', dowRestricted: dow !== '*', expression: String(expression).trim()
  };
}

const partsFormatter = new Map();
const zoneParts = (instantMs, timezone) => {
  if (!partsFormatter.has(timezone)) partsFormatter.set(timezone, new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }));
  const found = Object.fromEntries(partsFormatter.get(timezone).formatToParts(new Date(instantMs)).map((part) => [part.type, part.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(found.weekday);
  return { year: Number(found.year), month: Number(found.month), day: Number(found.day), hour: Number(found.hour) % 24, minute: Number(found.minute), weekday };
};

const offsetMs = (instantMs, timezone) => {
  const p = zoneParts(instantMs, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0) - Math.floor(instantMs / 60000) * 60000;
};

// Wall-clock in a zone -> instant. Two rounds converge everywhere outside a
// DST gap; inside one the answer lands just past the gap, which is what cron
// implementations do too.
export function zonedInstant(year, month, day, hour, minute, timezone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let round = 0; round < 3; round += 1) guess = Date.UTC(year, month - 1, day, hour, minute, 0) - offsetMs(guess, timezone);
  return guess;
}

const dayMatches = (cron, p) => cron.month.has(p.month)
  && (cron.domRestricted && cron.dowRestricted ? cron.dom.has(p.day) || cron.dow.has(p.weekday) : cron.dom.has(p.day) && cron.dow.has(p.weekday));

// Day-granular scan: for `0 4 1 1 *` (the parked cron) the first match is next
// New Year's Day, so the horizon has to be a year and change.
function scan(cron, timezone, fromMs, direction, horizonDays = 400) {
  const hours = [...cron.hour].sort((a, b) => a - b);
  const minutes = [...cron.minute].sort((a, b) => a - b);
  for (let offset = 0; offset <= horizonDays; offset += 1) {
    const probe = fromMs + direction * offset * 86400000;
    const p = zoneParts(probe, timezone);
    if (!dayMatches(cron, p)) continue;
    const candidates = [];
    for (const hour of hours) for (const minute of minutes) candidates.push(zonedInstant(p.year, p.month, p.day, hour, minute, timezone));
    const ordered = direction > 0 ? candidates.sort((a, b) => a - b) : candidates.sort((a, b) => b - a);
    const hit = ordered.find((instant) => direction > 0 ? instant > fromMs : instant < fromMs);
    if (hit !== undefined) return hit;
  }
  return null;
}

export const nextFire = (cron, timezone, now) => scan(parseCron(cron), timezone, now.getTime(), 1);
export const previousFire = (cron, timezone, now) => scan(parseCron(cron), timezone, now.getTime(), -1);

// --- the declared schedule ---------------------------------------------------
// Read from the Spawnfiles rather than policies/schedule.json: the Spawnfile is
// what the compiler lowers into the container's cron, so it is the only file
// whose contents can actually wake an agent.
export function readSchedule(orgRoot) {
  const agentsRoot = path.join(orgRoot, 'agents');
  const schedule = [];
  for (const agent of readdirSync(agentsRoot).sort()) {
    const file = path.join(agentsRoot, agent, 'Spawnfile');
    if (!existsSync(file)) continue;
    const source = readFileSync(file, 'utf8');
    const block = /^schedule:\n(?:[ \t]+.*\n?)+/mu.exec(source)?.[0];
    if (!block) continue;
    const cron = /^\s*cron:\s*"([^"]+)"/mu.exec(block)?.[1];
    const timezone = /^\s*timezone:\s*(\S+)/mu.exec(block)?.[1];
    if (!cron || !timezone) fail(`agents/${agent}/Spawnfile has a schedule block without both cron and timezone`);
    schedule.push({ agent, cron, timezone });
  }
  if (!schedule.length) fail(`no agent under ${agentsRoot} declares a cron schedule`);
  return schedule;
}

// The derived window, stated in the schedule's own terms. `gapMinutes` is the
// largest hole between consecutive daily wakes — the only stretch in which a
// redeploy has room — and `recommended` is that hole minus the margins.
export function deriveWindow(schedule, { leadMinutes = 30, tailMinutes = 120 } = {}) {
  const timezone = schedule[0].timezone;
  const minutesOfDay = [];
  for (const entry of schedule) {
    const cron = parseCron(entry.cron);
    for (const hour of cron.hour) for (const minute of cron.minute) minutesOfDay.push({ agent: entry.agent, at: hour * 60 + minute });
  }
  const times = [...new Set(minutesOfDay.map((item) => item.at))].sort((a, b) => a - b);
  let gap = { after: times[times.length - 1], before: times[0] + 1440, minutes: times[0] + 1440 - times[times.length - 1] };
  for (let index = 1; index < times.length; index += 1)
    if (times[index] - times[index - 1] > gap.minutes) gap = { after: times[index - 1], before: times[index], minutes: times[index] - times[index - 1] };
  const clock = (value) => `${String(Math.floor((value % 1440) / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  return {
    timezone, wakeTimes: times.map(clock), leadMinutes, tailMinutes,
    gap: { from: clock(gap.after), to: clock(gap.before), minutes: gap.minutes },
    recommended: { from: clock(gap.after + tailMinutes), to: clock(gap.before - leadMinutes), minutes: gap.minutes - tailMinutes - leadMinutes }
  };
}

// The clock pre-filter. Returns findings, not a boolean, so the caller can log
// exactly which agent is too close and by how much.
export function clockFindings(schedule, { now = new Date(), leadMinutes = 30, tailMinutes = 120 } = {}) {
  const findings = [];
  const detail = [];
  for (const entry of schedule) {
    const next = nextFire(entry.cron, entry.timezone, now);
    const previous = previousFire(entry.cron, entry.timezone, now);
    const untilNext = next === null ? Infinity : Math.round((next - now.getTime()) / 60000);
    const sincePrevious = previous === null ? Infinity : Math.round((now.getTime() - previous) / 60000);
    detail.push({ agent: entry.agent, cron: entry.cron, untilNextMinutes: untilNext, sincePreviousMinutes: sincePrevious });
    if (untilNext < leadMinutes) findings.push(`${entry.agent} wakes in ${untilNext} min (cron ${entry.cron} ${entry.timezone}); a deploy needs ${leadMinutes} min of clearance`);
    if (sincePrevious < tailMinutes) findings.push(`${entry.agent} woke ${sincePrevious} min ago (cron ${entry.cron} ${entry.timezone}); its wake may still be running inside ${tailMinutes} min`);
  }
  return { findings, detail };
}

// --- the running container ---------------------------------------------------
const dockerExec = (container, script, { docker = 'docker' } = {}) =>
  execFileSync(docker, ['exec', container, 'sh', '-c', script], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

const dockerInspect = (container, { docker = 'docker' } = {}) =>
  execFileSync(docker, ['inspect', '--format', '{{.State.Status}} {{.State.Health.Status}}', container], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

// Fails closed. Every branch that cannot read a signal returns a finding, so
// "the container is unreachable" blocks a deploy exactly as "an agent is awake"
// does.
export function quiescence(container, { docker = 'docker', now = new Date(), quietMinutes = 15, exec = dockerExec, inspect = dockerInspect, acceptanceStore = ACCEPTANCE_STORE, usageLedger = USAGE_LEDGER } = {}) {
  const findings = [];
  const observed = { outstanding: [], incompleteTurns: 0, lastTurnMinutesAgo: null, extraProcesses: [] };

  let running;
  try { running = inspect(container, { docker }); }
  catch (error) { return { quiet: false, findings: [`container ${container} could not be inspected (${String(error.message).trim().slice(0, 200)}) — refusing to call an unreadable container quiet`], observed }; }
  observed.container = running;
  if (!running.startsWith('running')) findings.push(`container ${container} is ${running}, not running — a deploy into an unhealthy container is not the fix, and this job will not paper over it`);

  // Durable pending deliveries survive a deploy; only live executions are cognition.
  let authority;
  try {
    authority = executionAuthority(exec(container, ACTIVITY_PROBE, { docker }));
    observed.authority = authority.authority;
    observed.executions = authority.executions;
    for (const execution of authority.executions) findings.push(`execution ${execution.execution_id} for ${execution.agent_id} is running — a redeploy would kill it`);
  } catch { findings.push('could not read valid authenticated runtime activity — refusing to infer legacy quiescence'); }

  if (authority?.authority === 'legacy-receipts') try {
    const raw = exec(container, `for f in ${acceptanceStore}/*.json; do [ -e "$f" ] || continue; cat "$f"; echo; done`, { docker });
    for (const line of raw.split('\n').filter((item) => item.trim())) {
      let record;
      try { record = JSON.parse(line); } catch { findings.push('a wake-acceptance receipt is not parseable JSON — refusing to guess whether it is outstanding'); continue; }
      if (!record.acceptance_id || !BUSY_STATES.has(record.state)) continue;
      observed.outstanding.push({ agent: record.agent_id, delivery: record.delivery_id, state: record.state, updated_at: record.updated_at });
      findings.push(`wake ${record.delivery_id} for ${record.agent_id} is ${record.state} (updated ${record.updated_at}) — a redeploy would kill it`);
    }
  } catch (error) { findings.push(`could not read the wake-acceptance store (${String(error.message).trim().slice(0, 200)})`); }

  // 2. the turn usage ledger.
  try {
    const raw = exec(container, `cat ${usageLedger} 2>/dev/null || true`, { docker });
    const records = raw.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    observed.incompleteTurns = records.filter((record) => record.complete === false).length;
    if (observed.incompleteTurns) findings.push(`${observed.incompleteTurns} turn record(s) in the usage ledger are incomplete — a turn is still in flight`);
    const last = records.filter((record) => typeof record.at === 'string').map((record) => Date.parse(record.at)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    if (last !== undefined) {
      observed.lastTurnMinutesAgo = Math.round((now.getTime() - last) / 60000);
      if (authority?.authority !== 'executions' && observed.lastTurnMinutesAgo < quietMinutes) findings.push(`the last metered turn was ${observed.lastTurnMinutesAgo} min ago; the ledger must be quiet for ${quietMinutes} min before a redeploy`);
    }
  } catch (error) { findings.push(`could not read the usage ledger (${String(error.message).trim().slice(0, 200)})`); }

  // 3. the process table.
  try {
    observed.extraProcesses = foreignProcesses(exec(container, `ps -eo pid,ppid,args # ${PROBE_SENTINEL}`, { docker }));
    for (const args of observed.extraProcesses) findings.push(`a process outside the steady-state set is running in the container: ${args.slice(0, 160)}`);
  } catch (error) { findings.push(`could not read the container process table (${String(error.message).trim().slice(0, 200)})`); }

  return { quiet: findings.length === 0, findings, observed };
}

// Splits a `pid ppid args` table into "work in flight" and everything else.
// The probe's own shell is found by its sentinel and removed together with
// every process it parented, so the measurement cannot see itself.
export function foreignProcesses(table) {
  const rows = table.split('\n').map((line) => line.trim()).filter(Boolean)
    .map((line) => /^(\d+)\s+(\d+)\s+(.*)$/u.exec(line)).filter(Boolean)
    .map(([, pid, ppid, args]) => ({ pid, ppid, args }));
  const probe = new Set(rows.filter((row) => row.args.includes(PROBE_SENTINEL)).map((row) => row.pid));
  // One generation is enough: `sh -c` spawns ps directly. Repeat until stable
  // anyway, so a shell that forks once more cannot reappear as a finding.
  for (let round = 0; round < 4; round += 1)
    for (const row of rows) if (probe.has(row.ppid)) probe.add(row.pid);
  return rows.filter((row) => !probe.has(row.pid) && !STEADY_STATE.some((pattern) => pattern.test(row.args)) && !isRuntimeHealthcheck(row.args)).map((row) => row.args);
}

export function assess(orgRoot, container, options = {}) {
  const schedule = readSchedule(orgRoot);
  const window = deriveWindow(schedule, options);
  const clock = clockFindings(schedule, options);
  const state = options.skipContainer ? { quiet: true, findings: [], observed: { skipped: true } } : quiescence(container, options);
  return { schedule, window, clock, state, safe: clock.findings.length === 0 && state.quiet, findings: [...clock.findings, ...state.findings] };
}

function main(argv) {
  const orgRoot = path.resolve(import.meta.dirname, '..');
  const container = argv.find((arg) => arg.startsWith('--container='))?.split('=')[1] ?? 'spawnfile-clank-and-slop';
  const result = assess(orgRoot, container, { skipContainer: argv.includes('--no-container') });
  console.log(`schedule (${result.window.timezone}): ${result.schedule.map((entry) => `${entry.agent}@${entry.cron}`).join(', ')}`);
  console.log(`daily wake times: ${result.window.wakeTimes.join(', ')}`);
  console.log(`largest gap: ${result.window.gap.from} -> ${result.window.gap.to} (${result.window.gap.minutes} min)`);
  console.log(`derived deploy window: ${result.window.recommended.from} -> ${result.window.recommended.to} (${result.window.recommended.minutes} min, lead ${result.window.leadMinutes} / tail ${result.window.tailMinutes})`);
  for (const entry of result.clock.detail) console.log(`  ${entry.agent.padEnd(10)} next in ${String(entry.untilNextMinutes).padStart(7)} min, last ${String(entry.sincePreviousMinutes).padStart(7)} min ago`);
  console.log(`container: ${result.state.observed.skipped ? '(not inspected)' : result.state.observed.container ?? 'unknown'}`);
  if (!result.state.observed.skipped) console.log(`  outstanding wakes: ${result.state.observed.outstanding.length}; incomplete turns: ${result.state.observed.incompleteTurns}; last turn: ${result.state.observed.lastTurnMinutesAgo ?? 'n/a'} min ago; extra processes: ${result.state.observed.extraProcesses.length}`);
  if (result.safe) { console.log('SAFE TO DEPLOY: the schedule is clear and the container is quiet.'); return; }
  console.error(`UNSAFE TO DEPLOY — ${result.findings.length} finding(s):`);
  for (const finding of result.findings) console.error(`  ✗ ${finding}`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof WindowError ? error.message : error.stack}\n`); process.exit(1); }
}
