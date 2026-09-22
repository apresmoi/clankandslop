#!/usr/bin/env node
// Carries an alarm the box has already recorded into a room a human's agent
// watches.
//
// WHY A BRIDGE AND NOT A SEND
// ---------------------------
// There are two alarm producers and they share nothing: `alarm.mjs` runs
// in-process when a seam stage refuses, and `clank-alarm.sh` runs as systemd's
// `OnFailure=` handler and deliberately depends on nothing but /bin/sh — no
// node, no network, no checkout — because an alarm that needs a healthy box is
// missing exactly when the box is not. Teaching either one to talk to Moltnet
// would either duplicate the transport or give the dependency-free handler a
// dependency.
//
// So neither sends. Both write, and this reads. The ordering is the guarantee:
// the record is on disk before anything is attempted, so a transport error
// costs the notification and never the evidence. A spool entry is marked
// posted by a sibling `.posted` marker; the alarm itself is never modified,
// never moved and never deleted.
//
// WHY room:release
// ----------------
// `validate-org.mjs` asserts the network declares exactly six rooms, so a
// dedicated alerts room is not available without changing a file this job is
// not allowed to change. Of the six, `release` is the operational one — where
// the edition hands off from Caslon to Pressman — rather than an editorial
// one, and Luna is federated into it like every other room.
//
// IT CANNOT WAKE ANYBODY
// ----------------------
// A mention is the literal token `@<agent-id>` and TEAM.md is explicit that it
// is the only thing that wakes a peer: "a bare name, a role word, or a
// capitalised label addresses nobody". That is a convention until something
// checks it, so this refuses to post any text containing an `@` followed by a
// known agent id, and the check runs on the composed message rather than on
// its inputs. An alarm is an observer notification; it is not editorial input
// and it must never become an instruction.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_SPOOL = '/var/lib/clank-alarm/spool';
export const ALARM_ROOM = 'release';
export const NETWORK = 'clank-newsroom';
// Every id that can be mentioned. An alarm naming one of these with an `@` in
// front would be a wake, so the text is refused rather than rewritten: quietly
// stripping it would hide that an alarm tried to address the newsroom.
export const AGENT_IDS = Object.freeze([
  'brass', 'caslon', 'cogsworth', 'foreman', 'graves', 'klaxon',
  'ledger', 'pressman', 'spike', 'sprockett', 'tinkerton', 'vesta',
  'gatherer', 'research-sensor', 'luna', 'operator', 'console'
]);

export class BridgeError extends Error {}

/** Every reason the composed text may not be posted. Empty means it may. */
export function mentionFindings(text) {
  const mentions = [...String(text).matchAll(/@([a-z][a-z0-9-]*)/gu)].map((match) => match[1]);
  return mentions.filter((id) => AGENT_IDS.includes(id)).map((id) => `alarm text mentions @${id}; an alarm may not address a newsroom agent`);
}

/**
 * One line a person can act on without opening anything, plus where the
 * evidence is. Severity is the alarm's own reason, not a guess: `seam-blocked`
 * is a refusal the next run retries, everything else stopped something.
 */
export function composeAlarmMessage(alarm, { breadcrumb, host = alarm.host } = {}) {
  const wait = alarm.reason === 'seam-blocked';
  const lines = [
    `CLANK ALARM ${wait ? 'WAITS' : 'NEEDS A HUMAN'} — ${alarm.reason}`,
    `what: ${alarm.message ?? '(no message)'}`,
    `when: ${alarm.at}`,
    `where: ${host ?? 'unknown host'}${alarm.edition ? `, edition ${alarm.edition}` : ''}`,
    `evidence: ${breadcrumb}`
  ];
  if (alarm.detail) lines.push(`detail: ${String(alarm.detail).trim().split('\n').slice(-3).join(' / ').slice(0, 300)}`);
  return lines.join('\n');
}

/** Spool entries with no `.posted` sibling, oldest first. */
export function pendingAlarms(directory = DEFAULT_SPOOL, { list = readdirSync, read = readFileSync } = {}) {
  let names;
  try { names = list(directory); } catch { return []; }
  return names.filter((name) => name.endsWith('.json') && !names.includes(`${name}.posted`)).sort()
    .map((name) => {
      const file = path.join(directory, name);
      try { return { file, body: JSON.parse(read(file, 'utf8')) }; }
      catch (error) { return { file, unreadable: String(error.message) }; }
    });
}

const dockerPost = (container, room, text, token) => execFileSync('docker', [
  'exec', '-i', container, 'sh', '-c',
  `curl -sS -X POST -H "Authorization: Bearer $1" -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:8787/v1/rooms/$2/messages"`,
  'sh', token, room
], { input: JSON.stringify({ network: NETWORK, text }), encoding: 'utf8', timeout: 20_000 });

export function bridge(options = {}, { post = dockerPost, list = readdirSync, read = readFileSync, write = writeFileSync, log = console.log } = {}) {
  const directory = options.spool ?? DEFAULT_SPOOL;
  const token = options.token;
  if (!token) throw new BridgeError('no Moltnet operator token; the alarm stays on disk rather than going nowhere quietly');
  const results = [];
  for (const entry of pendingAlarms(directory, { list, read })) {
    if (entry.unreadable) { log(`  skipped ${path.basename(entry.file)}: ${entry.unreadable}`); results.push({ file: entry.file, posted: false }); continue; }
    const text = composeAlarmMessage(entry.body, { breadcrumb: entry.file });
    const findings = mentionFindings(text);
    if (findings.length) { log(`  REFUSED ${path.basename(entry.file)}: ${findings.join('; ')}`); results.push({ file: entry.file, posted: false, refused: findings }); continue; }
    try {
      post(options.container ?? 'spawnfile-clank-and-slop', options.room ?? ALARM_ROOM, text, token);
      // Marked only after the post returns. A crash between the two reposts the
      // alarm next run, which is the safe direction to be wrong in.
      write(`${entry.file}.posted`, `${new Date().toISOString()}\n`, { mode: 0o600 });
      log(`  posted ${path.basename(entry.file)} to room:${options.room ?? ALARM_ROOM}`);
      results.push({ file: entry.file, posted: true });
    } catch (error) {
      log(`  post failed for ${path.basename(entry.file)} (${String(error.message).trim().slice(0, 160)}); the alarm remains on disk`);
      results.push({ file: entry.file, posted: false, error: true });
    }
  }
  return results;
}

function main(argv) {
  const value = (name) => { const index = argv.indexOf(`--${name}`); return index === -1 ? undefined : argv[index + 1]; };
  const envFile = value('env-file') ?? '/home/clank/deploy-work/deploy.env';
  let token;
  if (existsSync(envFile)) {
    const line = readFileSync(envFile, 'utf8').split('\n').find((row) => row.startsWith('CLANK_MOLTNET_OPERATOR_TOKEN='));
    token = line?.slice('CLANK_MOLTNET_OPERATOR_TOKEN='.length);
  }
  const results = bridge({ spool: value('spool'), container: value('container'), room: value('room'), token });
  console.log(`alarm bridge: ${results.filter((row) => row.posted).length} posted, ${results.filter((row) => !row.posted).length} still pending`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`alarm-to-moltnet: ${error.message}\n`); process.exitCode = 1; }
}
