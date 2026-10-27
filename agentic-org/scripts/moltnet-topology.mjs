import { agents, assert, reporters } from './lib.mjs';

// The Moltnet topology of the cloud newsroom: tokens, relay pairings and rooms.
// Every newsroom room federates to both relay peers. `machines` is the one
// exception: it carries operational errors for the operator, so it federates
// only to Luna and must never reach clank-observer, which feeds the public
// mirror. No newsroom agent is a member, so nothing posted there wakes one.
// klaxon is here because it declares `allowed_wake_senders: [research-sensor]`
// on its DM surface, i.e. the org expects the sensor to be able to reach it.
// It cannot: Spawnfile never emits `outbound_dm_peers`, so every DM the sensor
// sends is denied by `resolveDM`, and the sensor posts to room:research anyway.
// Room membership is the only path that actually delivers.
// Ledger asks the sensor about due forecast calls itself (ledger-research.mjs).
export const researchMembers = new Set(['gatherer', 'research-sensor', 'klaxon', ...reporters, 'brass', 'ledger']);

// Pin both independent relay peers; neither is a runtime dependency.
const DECLARED_PAIRINGS = [
  { id: 'clank-observer', name: 'Clank & Slop Observer', pairSecret: 'CLANK_MOLTNET_PAIR_OBSERVER_TOKEN', relaySecret: 'CLANK_MOLTNET_RELAY_OBSERVER_TOKEN', room: 'VdoP-HC5isGQksHo5dYpnQ' },
  { id: 'clank-luna', name: 'Luna operator liaison', pairSecret: 'CLANK_MOLTNET_PAIR_LUNA_TOKEN', relaySecret: 'CLANK_MOLTNET_RELAY_LUNA_TOKEN', room: 'JevE69AjzwXEk6fCBxAsug' },
];
const RELAY_URL = 'wss://moltnet-relay.alicenet.workers.dev';
const LUNA_MEMBER = 'clank-luna:luna';

export function declaredPairings(bytes) {
  const lines = bytes.split('\n');
  const start = lines.findIndex((line) => /^\s+pairings:\s*$/.test(line));
  if (start < 0) return [];
  const indent = lines[start].length - lines[start].trimStart().length;
  const end = lines.findIndex((line, index) => index > start && line.trim() && (line.length - line.trimStart().length) <= indent);
  const entries = [];
  for (const line of lines.slice(start + 1, end < 0 ? undefined : end)) {
    if (/^\s+- /.test(line)) entries.push({});
    const field = /^\s+(?:- )?([a-z_]+): (.*)$/.exec(line);
    if (field && entries.length) entries.at(-1)[field[1]] = field[2].trim();
  }
  return entries;
}

const inlineField = (value, key) => new RegExp(`\\b${key}: "?([^,"}]+)"?`).exec(value ?? '')?.[1]?.trim();

export const MACHINES_ROOM = 'machines';
const csv = (value) => value.split(',').map((item) => item.trim()).filter(Boolean);

export function validateMachinesRoom(room) {
  assert(room !== undefined, 'machines room declaration missing');
  assert(room.federation === '[clank-luna]', 'machines must federate only to Luna, never to the public observer');
  assert(room.members.length === 2 && room.members.includes(LUNA_MEMBER) && room.members.includes('ops'), 'machines members must be exactly Luna and ops');
}

export function validateMoltnetTopology(bytes) {
  const tokens = new Map();
  const tokenPattern = /- \{ id: ([a-z-]+), secret: ([A-Z][A-Z0-9_]+), scopes: \[([^\]]+)\](?:, agents: \[([^\]]+)\])? \}/g;
  for (const match of bytes.matchAll(tokenPattern)) tokens.set(match[1], { secret: match[2], scopes: csv(match[3]), agents: match[4] ? csv(match[4]) : [] });
  const operator = tokens.get('operator');
  assert(operator?.secret === 'CLANK_MOLTNET_OPERATOR_TOKEN' && operator.scopes.join(',') === 'admin,observe,write' && operator.agents.length === 0, 'Moltnet topology operator token reference invalid');
  for (const agent of agents) {
    const token = tokens.get(agent);
    const secret = `CLANK_MOLTNET_${agent.toUpperCase().replaceAll('-', '_')}_TOKEN`;
    assert(token?.secret === secret && token.scopes.join(',') === 'attach,observe,write' && token.agents.join(',') === agent, `${agent} Moltnet token boundary invalid`);
  }
  const gatherer = tokens.get('gatherer');
  assert(gatherer?.secret === 'CLANK_MOLTNET_GATHERER_TOKEN' && gatherer.scopes.join(',') === 'attach,observe,write' && gatherer.agents.join(',') === 'gatherer', 'research intake token boundary invalid');
  const consoleToken = tokens.get('console');
  assert(consoleToken?.secret === 'CLANK_MOLTNET_CONSOLE_TOKEN' && consoleToken.scopes.join(',') === 'observe' && consoleToken.agents.length === 0, 'observe-only console token boundary invalid');
  const researchSensor = tokens.get('research-sensor');
  assert(researchSensor?.secret === 'CLANK_MOLTNET_RESEARCH_SENSOR_TOKEN' && researchSensor.scopes.join(',') === 'attach,observe,write' && researchSensor.agents.join(',') === 'research-sensor', 'research sensor token boundary invalid');
  const ops = tokens.get('ops');
  assert(ops?.secret === 'CLANK_MOLTNET_OPS_TOKEN' && ops.scopes.join(',') === 'attach,observe,write' && ops.agents.join(',') === 'ops', 'operational error reporter token boundary invalid');
  assert(tokens.size === agents.length + 7, 'unexpected Moltnet token declaration');
  const pairings = declaredPairings(bytes);
  assert(pairings.length === DECLARED_PAIRINGS.length && new Set(pairings.map(pairing => pairing.id)).size === pairings.length, 'cloud Moltnet must declare exactly the observer and Luna pairings');
  for (const expected of DECLARED_PAIRINGS) {
    const pairing = pairings.find(candidate => candidate.id === expected.id);
    assert(pairing?.remote_network_id === expected.id && pairing.remote_network_name === expected.name && pairing.token_secret === expected.pairSecret, `${expected.id} pairing identity invalid`);
    assert(pairing.remote_base_url === undefined && pairing.relay !== undefined, `${expected.id} pairing must use the relay, never an inbound base url`);
    assert(inlineField(pairing.relay, 'url') === RELAY_URL && inlineField(pairing.relay, 'room') === expected.room && inlineField(pairing.relay, 'token_secret') === expected.relaySecret, `${expected.id} relay transport must match the paired client coordinates`);
    const pairToken = tokens.get(expected.id);
    assert(pairToken?.secret === pairing.token_secret && pairToken.scopes.join(',') === 'pair' && pairToken.agents.length === 0, `${expected.id} pair token must be pair-scoped, agent-free and bound to the pairing secret`);
  }
  assert(!/^\s+remote_base_url:/m.test(bytes), 'cloud Moltnet must not accept an inbound federation peer');
  assert(bytes.includes('id: gatherer') && bytes.includes('network: clank-newsroom') && bytes.includes('auth: { token_id: gatherer }') && bytes.includes('dms: { enabled: true }'), 'research intake participant invalid');
  assert(bytes.includes('id: research-sensor') && bytes.includes('auth: { token_id: research-sensor }'), 'direct research sensor participant invalid');
  assert(bytes.includes('  - id: ops\n    kind: service\n') && bytes.includes('auth: { token_id: ops }'), 'operational error reporter participant invalid');
  const roomPattern = /- \{ id: ([a-z-]+), visibility: private, write_policy: members, federation: (none|all|\[[^\]]+\]), members: \[([^\]]+)\] \}/g;
  const rooms = new Map([...bytes.matchAll(roomPattern)].map((match) => [match[1], { federation: match[2], members: csv(match[3]) }]));
  assert(rooms.size === 7, 'Moltnet room federation declarations invalid');
  // Conference is where reporters pitch and the editor assigns; it holds the nine
  // colleagues and klaxon, and deliberately excludes the external research feeds.
  const conference = rooms.get('conference');
  assert(conference !== undefined, 'conference room declaration missing');
  assert(conference !== undefined && !conference.members.includes('gatherer') && !conference.members.includes('research-sensor'), 'conference room must exclude external feeds');
  for (const [id, room] of rooms) {
    if (id === MACHINES_ROOM) continue;
    assert(room.federation === '[clank-observer, clank-luna]', `${id} must federate only to the observer and Luna pairings`);
    assert(room.members.includes(LUNA_MEMBER), `${id} must include the remote Luna operator`);
    assert(room.members.filter(member => member.includes(':')).every(member => member === LUNA_MEMBER), `${id} has an unauthorized remote member`);
  }
  assert(rooms.get('assignment')?.members.includes('gatherer'), 'assignment kickoff participant invalid');
  const research = rooms.get('research');
  assert(research?.members.includes('research-sensor'), 'research sensor local identity invalid');
  validateMachinesRoom(rooms.get(MACHINES_ROOM));
  assert(research && new Set(research.members).size === researchMembers.size + 1 && research.members.every((member) => member === LUNA_MEMBER || researchMembers.has(member)), 'research room membership invalid');
}
