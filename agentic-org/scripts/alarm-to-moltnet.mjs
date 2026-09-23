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

// WHY THE HOST TALKS TO MOLTNET DIRECTLY, AND ONLY FALLS BACK TO `docker exec`
// ---------------------------------------------------------------------------
// Every transport here used to be `docker exec <container> curl 127.0.0.1:8787`,
// which makes the bridge depend on the health of the very container it exists
// to report on. `docker exec` needs a RUNNING container with a working init;
// when it is wedged, or stopped, or gone, the alarm cannot move.
//
// It does not have to be that way. Moltnet's `listen_addr` is `0.0.0.0:8787`,
// so it answers on the container's bridge address as well as on loopback, and
// the host can reach that address directly:
//
//     POST http://<container-bridge-ip>:8787/v1/messages  ->  401 unauthorized
//
// Measured on this box 2026-09-23, with NO published ports
// (`NetworkSettings.Ports` is `{}`). That matters: nothing is exposed to the
// outside world, the container's EGRESS is untouched, and the agents' network
// confinement is exactly what it was. This is the host reaching INTO a
// container on its own bridge, which is the host operator's own privilege and
// not a hole in the agents' isolation.
//
// WHAT THIS FIXES AND WHAT IT HONESTLY DOES NOT
// ---------------------------------------------
// FIXES: a container whose `docker exec` path is broken or wedged while
// Moltnet itself is still serving. The alarm now goes out over HTTP instead of
// being stuck behind exec.
//
// DOES NOT FIX: a container that is DOWN. Moltnet RUNS INSIDE it, so when the
// container is stopped there is no room:release to post into and no transport
// — exec, bridge IP, or a published port — can change that. What the bridge
// can now do is TELL THE DIFFERENCE, because `docker inspect` still answers
// for a stopped or restarting container where `docker exec` simply fails. A
// container that is down is escalated out of band instead (see escalate()),
// which is the only channel that outlives the container.
export const MOLTNET_PORT = 8787;

/** The container's state and bridge address, from `docker inspect`, which answers for a STOPPED container. */
export function containerEndpoint(container, { exec = execFileSync } = {}) {
  let raw;
  try {
    raw = exec('docker', ['inspect', container, '--format', '{{.State.Status}} {{range $k, $v := .NetworkSettings.Networks}}{{$v.IPAddress}} {{end}}'],
      { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // No such container is a fact worth reporting, not an error to swallow.
    return { state: 'missing', ip: undefined, why: String(error.message).trim().slice(0, 160) };
  }
  const [state, ...addresses] = String(raw).trim().split(/\s+/u).filter(Boolean);
  const ip = addresses.find((value) => /^\d+\.\d+\.\d+\.\d+$/u.test(value));
  return { state: state || 'unknown', ip };
}

// Returns the same `"<status> <body>"` shape the exec transport returns, so
// `assertAccepted` stays the single place that decides what "accepted" means.
// That function is what caught the original silent-success bug and it keeps
// its tests. `curl` on the HOST, deliberately: it keeps this whole job
// synchronous like the transport it replaces, and it is the same tool the exec
// path already depended on — just run on the side of the boundary that still
// works when the container does not.
export const hostPost = (ip, room, text, token, { exec = execFileSync } = {}) => exec('curl', [
  '-sS', '-o', '-', '-w', '\n%{http_code}', '--max-time', '15',
  '-X', 'POST', '-H', `Authorization: Bearer ${token}`, '-H', 'Content-Type: application/json',
  '--data-binary', '@-', `http://${ip}:${MOLTNET_PORT}${SEND_PATH}`
], {
  input: JSON.stringify({ from: { type: 'agent', id: SENDER_ID }, target: { kind: 'room', room_id: room }, parts: [{ kind: 'text', text }] }),
  encoding: 'utf8', timeout: 20_000
});

/** `curl` writes the body then the status; `assertAccepted` wants "<status> <body>". */
export function statusFirst(response) {
  const text = String(response ?? '');
  const cut = text.lastIndexOf('\n');
  if (cut === -1) return text.trim();
  return `${text.slice(cut + 1).trim()} ${text.slice(0, cut).trim()}`;
}

export const hostLunaNetwork = (ip, token, { exec = execFileSync } = {}) => exec('curl', [
  '-fsS', '--max-time', '12', '-H', `Authorization: Bearer ${token}`,
  `http://${ip}:${MOLTNET_PORT}/v1/pairings/${LUNA_PAIRING}/network`
], { encoding: 'utf8', timeout: 20_000 });

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

// THE CHANNEL THAT OUTLIVES THE CONTAINER
// ---------------------------------------
// room:release lives inside the newsroom container. When that container is
// down, stopped or missing there is no room to post into, and no transport can
// invent one. PR #165 removed the ntfy channel on the grounds that the alarm
// text names the box and no third party needs to see it — true, and the reason
// the escalation below sends the SHORT form: reason, host, edition and time,
// never the `detail:` line, which is where paths and diagnostics live.
//
// The topic name is the entire secret, so it lives in /etc/clank-alarm/alarm.env
// at 0600 and never in this repository.
//
// It fires ONLY when the room could not be reached, so a healthy day pages
// nobody: this is the last resort, not a second notification channel.
export const ESCALATION_MARKER = '.escalated';

/** The short form. Deliberately not `composeAlarmMessage` — no detail line leaves the box. */
export function composeEscalation(alarm, { state } = {}) {
  return [
    `${alarm.reason ?? 'alarm'} on ${alarm.host ?? 'unknown host'}`,
    alarm.edition ? `edition ${alarm.edition}` : undefined,
    `at ${alarm.at ?? 'unknown time'}`,
    `container ${state ?? 'unknown'}; room:release unreachable — look on the box`
  ].filter(Boolean).join(' | ');
}

export const ntfyPush = (url, title, body, { exec = execFileSync } = {}) => exec('curl', [
  '-sS', '-o', '-', '-w', '\n%{http_code}', '--max-time', '15',
  '-H', `Title: ${title}`, '-H', 'Priority: urgent', '-H', 'Tags: rotating_light',
  '--data-binary', '@-', url
], { input: body, encoding: 'utf8', timeout: 20_000 });

/** Escalates one unposted alarm out of band. Returns true only on a 2xx from ntfy. */
export function escalate(entry, { url, state, push = ntfyPush, write = writeFileSync, log = console.log, exists = existsSync } = {}) {
  if (!url) { log(`  NOT escalated ${path.basename(entry.file)}: no CLANK_ALARM_URL is configured`); return false; }
  // ONCE per alarm. The bridge retries every 120s for as long as an alarm
  // stays unposted, and a pager that repeats every two minutes is a pager
  // somebody mutes. The marker is the record that a human was raised.
  if (exists(`${entry.file}${ESCALATION_MARKER}`)) return false;
  const body = composeEscalation(entry.body ?? {}, { state });
  let status;
  try { status = statusFirst(push(url, `CLANK ${entry.body?.reason ?? 'alarm'}`, body)).split(' ')[0]; }
  catch (error) { log(`  escalation failed for ${path.basename(entry.file)}: ${String(error.message).trim().slice(0, 160)}`); return false; }
  if (!/^2\d\d$/u.test(status)) { log(`  escalation refused for ${path.basename(entry.file)}: ntfy answered HTTP ${status || '(nothing)'}`); return false; }
  write(`${entry.file}${ESCALATION_MARKER}`, `${JSON.stringify({ v: 'clank.alarm-escalation.v1', at: new Date().toISOString(), channel: 'ntfy', container_state: state ?? 'unknown', note: 'short form only; no detail line left the box' })}\n`, { mode: 0o600 });
  log(`  ESCALATED ${path.basename(entry.file)} out of band (container ${state ?? 'unknown'})`);
  return true;
}

export function bridge(options = {}, {
  post = dockerPost, lunaNetwork = dockerLunaNetwork,
  hostPostImpl = hostPost, hostLunaImpl = hostLunaNetwork,
  endpoint = containerEndpoint, escalateImpl = escalate,
  list = readdirSync, read = readFileSync, write = writeFileSync, log = console.log
} = {}) {
  const directory = options.spool ?? DEFAULT_SPOOL;
  const token = options.token;
  if (!token) throw new BridgeError('no Moltnet operator token; the alarm stays on disk rather than going nowhere quietly');
  const results = [];
  let lunaCheck;
  const container = options.container ?? 'spawnfile-clank-and-slop';
  // Resolved ONCE per run, before any entry is attempted, and by `docker
  // inspect` rather than `docker exec` — so a stopped or missing container is
  // a fact this job holds rather than an error it trips over.
  const where = endpoint(container);
  const overHttp = where.state === 'running' && Boolean(where.ip);
  if (!overHttp) log(`  container ${container} is ${where.state}${where.ip ? '' : ' with no bridge address'}; room delivery is not available`);

  // Host HTTP first, `docker exec` second. Both are asserted by the same
  // `assertAccepted`, so neither can report a delivery the server did not make.
  const deliver = (text) => {
    if (overHttp) {
      try { return { messageId: assertAccepted(statusFirst(hostPostImpl(where.ip, options.room ?? ALARM_ROOM, text, token))), transport: 'host-http' }; }
      catch (error) { log(`  host HTTP post failed (${String(error.message).trim().slice(0, 120)}); falling back to docker exec`); }
    }
    return { messageId: assertAccepted(post(container, options.room ?? ALARM_ROOM, text, token)), transport: 'docker-exec' };
  };
  for (const entry of pendingAlarms(directory, { list, read })) {
    if (entry.unreadable) { log(`  skipped ${path.basename(entry.file)}: ${entry.unreadable}`); results.push({ file: entry.file, posted: false }); continue; }
    const text = composeAlarmMessage(entry.body, { breadcrumb: entry.file });
    const findings = mentionFindings(text);
    if (findings.length) { log(`  REFUSED ${path.basename(entry.file)}: ${findings.join('; ')}`); results.push({ file: entry.file, posted: false, refused: findings }); continue; }
    try {
      // The local post is NEVER gated on the relay. An alarm the operator can
      // read in the room is worth having even when Luna is unreachable, and
      // withholding it would trade a visible alarm for an invisible one.
      const { messageId, transport } = deliver(text);
      // One probe per bridge run, shared across entries, so a backlog cannot
      // exhaust the systemd timeout.
      if (lunaCheck === undefined) {
        // The probe follows the transport that ACTUALLY carried the post.
        // Probing over HTTP after HTTP just failed is a guaranteed timeout,
        // and it was: a 12s stall per run against a transport already proven
        // broken.
        try { lunaCheck = lunaPairingReachable(transport === 'host-http' ? hostLunaImpl(where.ip, token) : lunaNetwork(container, token)); }
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
        transport,
        container_state: where.state,
        relay: lunaCheck.reachable ? 'pairing_reachable' : 'pairing_unreachable',
        relay_detail: lunaCheck.why,
        delivery_confirmed: false,
        note: 'relay delivery of this specific message is not observable from this host'
      };
      write(`${entry.file}.posted`, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
      log(`  posted ${path.basename(entry.file)} to room:${marker.posted_to_room} via ${transport} (${marker.relay}; delivery unconfirmable)`);
      results.push({ file: entry.file, posted: true, relay: marker.relay, transport });
    } catch (error) {
      log(`  post failed for ${path.basename(entry.file)} (${String(error.message).trim().slice(0, 160)}); the alarm remains on disk`);
      // The room could not be reached, which is exactly the case the room
      // cannot cover. Page out of band, once per alarm.
      const escalated = escalateImpl(entry, { url: options.escalationUrl, state: where.state, write, log });
      results.push({ file: entry.file, posted: false, error: true, escalated });
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
  // The escalation topic is the entire secret, so it is read from the same
  // kind of 0600 file as the Moltnet token and never from this repository.
  const alarmEnv = value('alarm-env') ?? '/etc/clank-alarm/alarm.env';
  let escalationUrl = process.env.CLANK_ALARM_URL;
  if (!escalationUrl && existsSync(alarmEnv)) {
    const line = readFileSync(alarmEnv, 'utf8').split('\n').find((row) => row.startsWith('CLANK_ALARM_URL='));
    escalationUrl = line?.slice('CLANK_ALARM_URL='.length).trim();
  }
  const results = bridge({ spool: value('spool'), container: value('container'), room: value('room'), token, escalationUrl });
  console.log(`alarm bridge: ${results.filter((row) => row.posted).length} posted, ${results.filter((row) => !row.posted).length} still pending, ${results.filter((row) => row.escalated).length} escalated out of band`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`alarm-to-moltnet: ${error.message}\n`); process.exitCode = 1; }
}
