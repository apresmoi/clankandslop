#!/usr/bin/env node
// The alarm. One way for an unattended newsroom to say "I could not run today"
// to a PERSON.
//
// WHY THIS EXISTS
// ---------------
// CLANK_TO_PROD.md §1.6: "systemd screamed `Failed` for two days into a void;
// the endpoint it posts to was never built." The organization already has an
// alert path — run-research.sh posts a JSON line into `room:research` — but
// that reaches AGENTS, and when the failure is "the org did not start" there is
// no agent awake to read it. An unattended org needs a channel whose far end is
// a human being holding a phone.
//
// WHY ntfy.sh
// -----------
// Cheapest channel that actually works from both boxes and needs no credential
// at all: an HTTPS POST to a topic URL, outbound only, no account, no API key,
// no inbound listener, no mail relay to get delisted. Both the Hetzner box and
// LeDeluge reach it (verified). The subscriber is a phone app or a browser tab
// on https://ntfy.sh/<topic>. The topic name is the only secret, so it is
// generated random and lives in a 0600 file outside this repository.
//
// A channel nobody has tested is the same as no channel, so `--selftest` does
// not stop at "the POST returned 200": it reads the message back out of the
// topic's own cache and fails unless the bytes it sent come back.
//
// NEVER SWALLOWED
// ---------------
// Same discipline as run-research.sh's notify(): a POST that cannot be
// delivered writes the payload to the spool directory and says where, so the
// text a human was supposed to see still exists on disk. Exit 0 = delivered,
// 75 = spooled but undelivered, 64 = misuse.
//
// USAGE
//   node agentic-org/scripts/alarm.mjs --reason=deploy-failed \
//     --edition=2026-09-06 --message="spawnfile up exited 1" [--detail-file=f]
//   node agentic-org/scripts/alarm.mjs --selftest
//
// CONFIG (names only; values never printed)
//   CLANK_ALARM_URL    ntfy topic URL, e.g. https://ntfy.sh/<random-topic>
//   CLANK_ALARM_SPOOL  breadcrumb directory (default /var/lib/clank-alarm/spool)
//   CLANK_ALARM_HOST   label for which box is speaking (default: hostname)

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

// Every failure an unattended cycle can have that a human must hear about.
// `seam-run.mjs` and `cycle-audit.mjs` may only raise one of these, so the
// receiving human learns a fixed vocabulary rather than free text.
export const REASONS = Object.freeze({
  'repin-failed': { title: 'Newsroom: repin failed', priority: 'urgent', tags: 'rotating_light' },
  'bundle-mismatch': { title: 'Newsroom: bundle mismatch', priority: 'urgent', tags: 'rotating_light' },
  'deploy-failed': { title: 'Newsroom: deploy failed', priority: 'urgent', tags: 'rotating_light' },
  'no-edition': { title: 'Newsroom: no edition today', priority: 'urgent', tags: 'newspaper' },
  'seam-blocked': { title: 'Newsroom: seam could not run', priority: 'high', tags: 'warning' },
  selftest: { title: 'Newsroom alarm self-test', priority: 'default', tags: 'white_check_mark' }
});

export const DEFAULT_SPOOL = '/var/lib/clank-alarm/spool';
export class AlarmError extends Error {}
const fail = (message) => { throw new AlarmError(message); };

export function parseArgs(argv) {
  const options = { reason: null, edition: null, message: null, detailFile: null, selftest: false, dryRun: false };
  for (const arg of argv) {
    const [key, ...rest] = arg.startsWith('--') ? arg.slice(2).split('=') : [null];
    const value = rest.join('=');
    if (key === 'reason' && value) options.reason = value;
    else if (key === 'edition' && value) options.edition = value;
    else if (key === 'message' && value) options.message = value;
    else if (key === 'detail-file' && value) options.detailFile = value;
    else if (key === 'selftest') options.selftest = true;
    else if (key === 'dry-run') options.dryRun = true;
    else fail(`unrecognized argument: ${arg}`);
  }
  if (options.selftest) options.reason ??= 'selftest';
  if (!options.reason) fail('--reason=<' + Object.keys(REASONS).join('|') + '> is required');
  if (!(options.reason in REASONS)) fail(`unknown --reason ${options.reason}; expected one of ${Object.keys(REASONS).join(', ')}`);
  return options;
}

// The URL is read, never logged. Everything this module prints about it is the
// topic's shape, so a transcript of an alarm run cannot leak the one secret the
// channel has.
export function readTopicUrl(environment = process.env) {
  const url = environment.CLANK_ALARM_URL;
  if (!url) fail('CLANK_ALARM_URL is not set — the alarm has no channel to reach a human on.\n'
    + '  Put the ntfy topic URL in a 0600 file and load it with systemd EnvironmentFile=, or export it.');
  let parsed;
  try { parsed = new URL(url); } catch { return fail('CLANK_ALARM_URL is not a URL'); }
  if (parsed.protocol !== 'https:') fail('CLANK_ALARM_URL must be https — an alarm must not travel in clear text');
  const topic = parsed.pathname.replace(/^\/+|\/+$/gu, '');
  if (!topic || topic.includes('/')) fail('CLANK_ALARM_URL must name exactly one ntfy topic, e.g. https://ntfy.sh/<topic>');
  return { url: parsed, topic, origin: parsed.origin };
}

// A stable, machine-readable body. The human sees the first line on a lock
// screen; whatever is diagnosing later gets the JSON.
export function composeAlarm({ reason, edition, message, detail, host, at }) {
  const spec = REASONS[reason];
  const headline = `${host} · ${reason}${edition ? ` · ${edition}` : ''}: ${message ?? spec.title}`;
  const body = { version: 'clank.alarm.v1', reason, edition: edition ?? null, host, at, message: message ?? spec.title, detail: detail ?? null };
  return { headline, body, title: spec.title, priority: spec.priority, tags: spec.tags };
}

const post = async (target, alarm, { fetchImpl = fetch, timeoutMs = 15000 } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(target.url.toString(), {
      method: 'POST', signal: controller.signal,
      headers: { Title: alarm.title, Priority: alarm.priority, Tags: alarm.tags, 'Content-Type': 'text/plain; charset=utf-8' },
      body: `${alarm.headline}\n${JSON.stringify(alarm.body)}`
    });
    if (!response.ok) throw new Error(`ntfy responded ${response.status}`);
    return await response.json().catch(() => ({}));
  } finally { clearTimeout(timer); }
};

// Three attempts with backoff: a single transient DNS or TLS failure must not
// be the reason a human never hears that the paper did not come out.
export async function deliver(target, alarm, { attempts = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), ...rest } = {}) {
  const errors = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return { delivered: true, attempt, receipt: await post(target, alarm, rest) }; }
    catch (error) { errors.push(`attempt ${attempt}: ${error.message}`); if (attempt < attempts) await sleep(attempt * 2000); }
  }
  return { delivered: false, attempt: attempts, errors };
}

// The breadcrumb. Written whether or not the POST worked, so a box that lost
// its network still has the exact text on disk, and written BEFORE the send so
// a crash mid-send cannot lose it either.
export function spool(alarm, { directory = process.env.CLANK_ALARM_SPOOL ?? DEFAULT_SPOOL } = {}) {
  const name = `${alarm.body.at.replace(/[:.]/gu, '-')}.${alarm.body.reason}.json`;
  const file = path.join(directory, name);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(alarm.body, null, 2)}\n`, { mode: 0o600 });
  return file;
}

// The proof. ntfy keeps a short cache per topic; `?poll=1&since=<n>` returns it
// as newline-delimited JSON without holding the connection open. Reading our
// own message back is what turns "the POST returned 200" into "a subscriber
// would have received this".
// The cache is populated asynchronously, so an immediate poll can legitimately
// come back empty for a message that was accepted — hence the retry. An empty
// result after every attempt is a real failure and is reported as one.
export async function readBack(target, alarm, { fetchImpl = fetch, sinceSeconds = 300, attempts = 5, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await sleep(attempt === 1 ? 1500 : 2500);
    const response = await fetchImpl(`${target.origin}/${target.topic}/json?poll=1&since=${sinceSeconds}s`);
    if (!response.ok) throw new AlarmError(`could not read the topic back: ${response.status}`);
    const messages = (await response.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    last = messages.filter((entry) => entry.event === 'message' && typeof entry.message === 'string' && entry.message.includes(alarm.body.at));
    if (last.length) return last;
  }
  return last;
}

export async function raise(options, { environment = process.env, now = new Date(), log = console.log, ...rest } = {}) {
  const target = readTopicUrl(environment);
  const detail = options.detailFile ? readFileSync(options.detailFile, 'utf8').slice(-2000) : null;
  const alarm = composeAlarm({ ...options, detail, host: environment.CLANK_ALARM_HOST ?? hostname(), at: now.toISOString() });
  const breadcrumb = spool(alarm, { directory: environment.CLANK_ALARM_SPOOL ?? DEFAULT_SPOOL });
  log(`alarm ${alarm.body.reason} spooled at ${breadcrumb}`);
  if (options.dryRun) return { ...alarm.body, breadcrumb, delivered: false, dryRun: true };
  const result = await deliver(target, alarm, rest);
  if (!result.delivered) {
    process.stderr.write(`alarm NOT DELIVERED to topic ${target.topic} after ${result.attempt} attempt(s):\n  ${result.errors.join('\n  ')}\n`
      + `  the message is preserved at ${breadcrumb}\n`);
    return { ...alarm.body, breadcrumb, delivered: false };
  }
  log(`alarm delivered to topic ${target.topic} on attempt ${result.attempt}`);
  if (!options.selftest) return { ...alarm.body, breadcrumb, delivered: true };
  const seen = await readBack(target, alarm, rest);
  if (!seen.length) fail(`self-test FAILED: the POST was accepted but the message did not come back out of topic ${target.topic} — a subscriber would not have received it`);
  log(`self-test PASSED: read the alarm back out of the topic (${seen.length} matching message(s), ntfy id ${seen[0].id})`);
  return { ...alarm.body, breadcrumb, delivered: true, readBack: seen.length };
}

// Convenience for the other host-side jobs: never throws, never takes the
// caller down with it. An alarm that crashed the thing reporting the failure
// would be worse than no alarm.
export function raiseDetached(reason, { edition, message, detail } = {}, { scriptPath = import.meta.filename } = {}) {
  try {
    const args = [scriptPath, `--reason=${reason}`];
    if (edition) args.push(`--edition=${edition}`);
    if (message) args.push(`--message=${message}`);
    if (detail) { const file = path.join(process.env.CLANK_ALARM_SPOOL ?? DEFAULT_SPOOL, 'detail.txt'); mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, detail, { mode: 0o600 }); args.push(`--detail-file=${file}`); }
    execFileSync(process.execPath, args, { stdio: 'inherit' });
    return true;
  } catch (error) { process.stderr.write(`alarm could not be raised (${reason}): ${error.message}\n`); return false; }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  raise(parseArgs(process.argv.slice(2)))
    .then((result) => { process.exit(result.delivered || result.dryRun ? 0 : 75); })
    .catch((error) => { process.stderr.write(`${error instanceof AlarmError ? error.message : error.stack}\n`); process.exit(64); });
}
