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
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
  return names.filter((name) => name.endsWith('.json') && name !== 'attempts.jsonl' && !names.includes(`${name}.posted`)).sort()
    .map((name) => {
      const file = path.join(directory, name);
      try { return { file, body: JSON.parse(read(file, 'utf8')) }; }
      catch (error) { return { file, unreadable: String(error.message) }; }
    });
}

// `POST /v1/messages`, with an explicit `from.id` — the room-scoped
// `/v1/rooms/<id>/messages` route is GET only and answers a POST with 405.
//
// AND THE STATUS IS READ. The first version of this ran `curl -sS`, which
// exits 0 on a 405 as happily as on a 202, and reported twelve alarms
// delivered that the room never received. An alarm path that cannot tell the
// difference between sent and refused is worse than no alarm path, so the
// transport now returns the body and this asserts on it: 2xx, `accepted:
// true`, and a `message_id` the server minted. Anything else throws, the
// entry stays pending, and the next run tries again.
export const SEND_PATH = '/v1/messages';
export const SENDER_ID = 'operator';
export const LUNA_PAIRING = 'clank-luna';

// ListPairings is cached. This endpoint makes a live request to Luna and
// refreshes pairing diagnostics, so a recovered connection can retry alarms.
const dockerLunaNetwork = (container, token) => execFileSync('docker', [
  'exec', container, 'sh', '-c',
  `curl -fsS --max-time 12 -H "Authorization: Bearer $1" http://127.0.0.1:8787/v1/pairings/${LUNA_PAIRING}/network`,
  'sh', token
], { encoding: 'utf8', timeout: 20_000 });

// Reachable is not delivered, and this name says so. The relay is
// asynchronous and this host never sees an acknowledgement for a specific
// message, so the strongest true statement available is "the pairing answered
// a live request at the moment we asked". Anything stronger would be the
// silent-success bug again, wearing a different hat.
export function lunaPairingReachable(response) {
  let parsed;
  try { parsed = JSON.parse(String(response)); }
  catch { return { reachable: false, why: 'Luna network response is unreadable' }; }
  if (parsed?.id !== LUNA_PAIRING) return { reachable: false, why: 'Luna network identity does not match the pairing' };
  return { reachable: true };
}

const dockerPost = (container, room, text, token) => execFileSync('docker', [
  'exec', '-i', container, 'sh', '-c',
  `curl -sS -o /tmp/clank-alarm-post.json -w '%{http_code}' -X POST -H "Authorization: Bearer $1" -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:8787${SEND_PATH}"; printf ' '; cat /tmp/clank-alarm-post.json; rm -f /tmp/clank-alarm-post.json`,
  'sh', token
], {
  input: JSON.stringify({ from: { type: 'agent', id: SENDER_ID }, target: { kind: 'room', room_id: room }, parts: [{ kind: 'text', text }] }),
  encoding: 'utf8', timeout: 20_000
});

/** Throws unless the server says it accepted the message. */
export function assertAccepted(response) {
  const text = String(response ?? '');
  const [status, ...rest] = text.trim().split(' ');
  const body = rest.join(' ');
  if (!/^2\d\d$/u.test(status)) throw new BridgeError(`Moltnet answered HTTP ${status || '(nothing)'}: ${body.slice(0, 200)}`);
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new BridgeError(`Moltnet returned ${status} with a body this job cannot read: ${body.slice(0, 200)}`); }
  if (parsed?.accepted !== true || typeof parsed.message_id !== 'string' || !parsed.message_id) {
    throw new BridgeError(`Moltnet returned ${status} without accepting the message: ${body.slice(0, 200)}`);
  }
  return parsed.message_id;
}

export function bridge(options = {}, { post = dockerPost, lunaNetwork = dockerLunaNetwork, list = readdirSync, read = readFileSync, write = writeFileSync, log = console.log } = {}) {
  const directory = options.spool ?? DEFAULT_SPOOL;
  const token = options.token;
  if (!token) throw new BridgeError('no Moltnet operator token; the alarm stays on disk rather than going nowhere quietly');
  const results = [];
  let lunaCheck;
  for (const entry of pendingAlarms(directory, { list, read })) {
    if (entry.unreadable) { log(`  skipped ${path.basename(entry.file)}: ${entry.unreadable}`); results.push({ file: entry.file, posted: false }); continue; }
    const text = composeAlarmMessage(entry.body, { breadcrumb: entry.file });
    const findings = mentionFindings(text);
    if (findings.length) { log(`  REFUSED ${path.basename(entry.file)}: ${findings.join('; ')}`); results.push({ file: entry.file, posted: false, refused: findings }); continue; }
    try {
      // The local post is NEVER gated on the relay. An alarm the operator can
      // read in the room is worth having even when Luna is unreachable, and
      // withholding it would trade a visible alarm for an invisible one.
      const messageId = assertAccepted(post(options.container ?? 'spawnfile-clank-and-slop', options.room ?? ALARM_ROOM, text, token));
      // One probe per bridge run, shared across entries, so a backlog cannot
      // exhaust the systemd timeout.
      if (lunaCheck === undefined) {
        try { lunaCheck = lunaPairingReachable(lunaNetwork(options.container ?? 'spawnfile-clank-and-slop', token)); }
        catch (error) { lunaCheck = { reachable: false, why: String(error.message).trim().slice(0, 160) }; }
      }
      // Marked only after the post returns. A crash between the two reposts the
      // alarm next run, which is the safe direction to be wrong in.
      //
      // The marker records WHAT WAS PROVEN and nothing more. `posted_to_room`
      // is a verified local 202 carrying a server-minted id. `relay` is the
      // pairing's state at that moment and is deliberately NOT called
      // delivery: the relay is asynchronous and this host never sees an
      // acknowledgement for a specific message, so `pairing_reachable` is the
      // strongest true statement available and `delivery_confirmed` is always
      // false. An operator reading this can tell the two apart, which is the
      // whole point — reporting a delivery we cannot observe is the same
      // silent-success bug that made the first bridge lie.
      const marker = {
        v: 'clank.alarm-delivery.v1',
        at: new Date().toISOString(),
        posted_to_room: options.room ?? ALARM_ROOM,
        message_id: messageId,
        relay: lunaCheck.reachable ? 'pairing_reachable' : 'pairing_unreachable',
        relay_detail: lunaCheck.why,
        delivery_confirmed: false,
        note: 'relay delivery of this specific message is not observable from this host'
      };
      write(`${entry.file}.posted`, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
      log(`  posted ${path.basename(entry.file)} to room:${marker.posted_to_room} (${marker.relay}; delivery unconfirmable)`);
      results.push({ file: entry.file, posted: true, relay: marker.relay });
    } catch (error) {
      log(`  post failed for ${path.basename(entry.file)} (${String(error.message).trim().slice(0, 160)}); the alarm remains on disk`);
      results.push({ file: entry.file, posted: false, error: true });
    } finally {
      // Every attempt, whatever it did, so a silent week is distinguishable
      // from a quiet one.
      try {
        appendFileSync(path.join(directory, 'attempts.jsonl'), `${JSON.stringify({
          at: new Date().toISOString(), alarm: path.basename(entry.file),
          posted: results.at(-1)?.posted === true, relay: results.at(-1)?.relay ?? null
        })}\n`, { mode: 0o600 });
      } catch { /* the attempt log is a convenience; it never blocks an alarm */ }
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
