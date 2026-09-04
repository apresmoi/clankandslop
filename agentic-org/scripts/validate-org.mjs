import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { agents, assert, digest, orgRoot, policy, privateKinds, reporters, sensors, readJson, releaseFor } from './lib.mjs';
import { validateLifecycleGraph } from './lifecycle-graph.mjs';
import { isBerlinRelease } from './release-time.mjs';

const TYPES = new Set(['ASSIGNMENT', 'ACK', 'PINPOINT_REQUEST', 'PINPOINT_CLAIM', 'PINPOINT_RESULT', 'PINPOINT_NOT_FOUND', 'FILED', 'REVISION_REQUEST', 'REFILED', 'PASS', 'HOLD', 'SPIKE', 'COMPOSITION_ISSUE', 'COMPOSED', 'RELEASE_HANDOFF']);
const TERMINALS = { ACK: 'ACKED', PINPOINT_CLAIM: 'CLAIMED', PINPOINT_RESULT: 'CLAIMED', PINPOINT_NOT_FOUND: 'CLAIMED', FILED: 'FILED', REVISION_REQUEST: 'REVISION_REQUESTED', REFILED: 'REFILED', PASS: 'PASSED', HOLD: 'HELD', SPIKE: 'SPIKED', COMPOSED: 'COMPOSED', RELEASE_HANDOFF: 'HANDED_OFF' };
const OWNERS = { ASSIGNMENT: new Set(['brass']), ACK: new Set(agents.filter((agent) => agent !== 'brass')), PINPOINT_REQUEST: reporters, PINPOINT_CLAIM: sensors, PINPOINT_RESULT: sensors, PINPOINT_NOT_FOUND: sensors, FILED: reporters, REVISION_REQUEST: new Set(['spike']), REFILED: reporters, PASS: new Set(['spike']), HOLD: new Set(['spike']), SPIKE: new Set(['spike']), COMPOSITION_ISSUE: new Set(['caslon']), COMPOSED: new Set(['caslon']), RELEASE_HANDOFF: new Set(['brass', 'pressman']) };
const PARENTS = { ACK: ['ASSIGNMENT'], PINPOINT_CLAIM: ['PINPOINT_REQUEST'], PINPOINT_RESULT: ['PINPOINT_CLAIM'], PINPOINT_NOT_FOUND: ['PINPOINT_CLAIM'], FILED: ['ACK'], REVISION_REQUEST: ['FILED', 'REFILED'], REFILED: ['REVISION_REQUEST'], PASS: ['FILED', 'REFILED'], HOLD: ['FILED', 'REFILED'], SPIKE: ['FILED', 'REFILED'], COMPOSITION_ISSUE: ['PASS'], COMPOSED: ['PASS'], RELEASE_HANDOFF: ['COMPOSED'] };
const ARTICLE_TYPES = new Set(['ASSIGNMENT', 'ACK', 'FILED', 'REVISION_REQUEST', 'REFILED', 'PASS', 'HOLD', 'SPIKE', 'COMPOSITION_ISSUE', 'COMPOSED', 'RELEASE_HANDOFF']);
const ROOTS = new Set(['ASSIGNMENT', 'PINPOINT_REQUEST']);
const sameRef = (left, right) => left.ref === right.ref && left.digest === right.digest;
const includesRef = (refs, ref) => refs.some((item) => sameRef(item, ref));

function parentFor(message, prior) {
  if (ROOTS.has(message.type)) { assert(!message.causal_parent, `${message.type} cannot have causal parent`); return undefined; }
  assert(message.causal_parent, `${message.type} requires causal parent`);
  const parent = prior.find((item) => item.id === message.causal_parent);
  assert(parent, `${message.type} causal parent missing`);
  assert(PARENTS[message.type].includes(parent.type), `${message.type} parent transition invalid`);
  assert(parent.edition === message.edition && parent.release === message.release, 'lifecycle identity mismatch');
  assert(parent.correlation_id === message.correlation_id, 'lifecycle correlation mismatch');
  return parent;
}

function lineage(message, parent, prior) {
  assert(Array.isArray(message.derived_from), 'derived_from invalid');
  if (ROOTS.has(message.type)) { assert(message.derived_from.length === 0, 'root derived_from must be empty'); return; }
  assert(message.derived_from.length > 0, 'artifact lineage missing');
  const sources = prior.flatMap((item) => item.artifact_refs);
  assert(message.derived_from.every((ref) => includesRef(sources, ref)), 'derived artifact unknown');
  assert(includesRef(message.derived_from, parent.artifact_refs[0]) || parent.artifact_refs.some((ref) => includesRef(message.derived_from, ref)), 'causal artifact lineage missing');
  if (message.type === 'FILED') assert(message.derived_from.some((ref) => /^private:dossiers\//.test(ref.ref)), 'filing requires dossier lineage');
}

export function validateMessage(message, prior = []) {
  for (const key of ['version', 'id', 'type', 'edition', 'release', 'owner', 'artifact_refs', 'derived_from', 'revision', 'correlation_id', 'deadline', 'terminal_state', 'summary']) assert(key in message, `message missing ${key}`);
  assert(message.version === 'v1' && TYPES.has(message.type), 'message version/type invalid');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(message.edition), 'edition invalid');
  assert(isBerlinRelease(message.edition, message.release), 'release must be Berlin 16:00');
  assert(agents.includes(message.owner), 'unknown owner');
  for (const refs of [message.artifact_refs, message.derived_from]) assert(Array.isArray(refs) && refs.every((ref) => digest.test(ref.digest) && !/(credential|profile|html|prompt)/i.test(ref.ref)), 'artifact reference invalid');
  assert(message.artifact_refs.length > 0, 'output artifact missing');
  assert(!/(credential|password|token|profile|<html|prompt:)/i.test(message.summary), 'private content leaked');
  assert(OWNERS[message.type].has(message.owner), `unauthorized ${message.type} owner`);
  assert(message.terminal_state === (TERMINALS[message.type] ?? 'OPEN'), 'terminal state incompatible');
  const parent = parentFor(message, prior);
  lineage(message, parent, prior);
  if (parent && message.type !== 'REFILED') assert(message.revision === parent.revision, 'lifecycle revision mismatch');
  if (ARTICLE_TYPES.has(message.type)) assert(reporters.has(message.article_owner), 'article owner invalid');
  if (message.type === 'ASSIGNMENT') assert(message.recipient === message.article_owner && reporters.has(message.recipient), 'assignment recipient must be reporter article owner');
  if (message.type === 'ACK') assert(message.owner === parent.recipient && message.article_owner === parent.article_owner, 'ack must be owned by assignment recipient');
  if (message.type === 'FILED') assert(message.owner === parent.owner && message.article_owner === parent.article_owner, 'filing must descend from assigned reporter ACK');
  if (ARTICLE_TYPES.has(message.type) && parent && message.type !== 'ACK') assert(message.article_owner === parent.article_owner, 'article owner identity mismatch');
  if (message.type === 'PINPOINT_CLAIM') assert(message.owner !== parent.owner, 'request owner cannot claim pinpoint work');
  if (['PINPOINT_RESULT', 'PINPOINT_NOT_FOUND'].includes(message.type)) assert(message.owner === parent.owner, 'pinpoint resolution must use claim owner');
  if (message.type === 'REFILED') { const filed = prior.find((item) => item.id === parent.causal_parent); assert(filed?.owner === message.owner && message.revision === parent.revision + 1, 'refile must increment filing owner revision'); assert(filed.artifact_refs.some((ref) => includesRef(message.derived_from, ref)), 'refile requires filed artifact lineage'); }
}

export function validateManifest(manifest) { for (const artifact of manifest.artifacts) { assert(privateKinds.has(artifact.kind), 'unknown private kind'); assert(artifact.path.startsWith(`${artifact.kind}/`) && digest.test(artifact.digest), 'private manifest artifact invalid'); } }
export const engineByAgent = Object.freeze({
  klaxon: 'codex', cogsworth: 'codex', sprockett: 'codex', foreman: 'codex', graves: 'codex', tinkerton: 'codex', vesta: 'codex',
  brass: 'codex', spike: 'codex', ledger: 'codex', caslon: 'codex', pressman: 'codex'
});

const corpusAgents = new Set(['klaxon']);
const publicWriters = new Set(['pressman']);
const researchMembers = new Set(['gatherer', 'research-sensor', ...reporters, 'brass']);
const section = (source, name) => {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line === `${name}:`);
  assert(start >= 0, `missing ${name} section`);
  const end = lines.findIndex((line, index) => index > start && /^\S/.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
};
const resourceLine = (workspace, id) => workspace.split('\n').find((line) => line.includes(`{ id: ${id},`));
const csv = (value) => value.split(',').map((item) => item.trim()).filter(Boolean);

// The one federation link the newsroom is allowed to declare: a read-only
// laptop observer reached over the Moltnet relay. Its transport coordinates are
// pinned here on purpose — a relay room id that silently drifts out of sync with
// ~/.moltnet/clank-observer/Moltnet produces no error, just an empty console.
const OBSERVER_PAIRING_ID = 'clank-observer';
const OBSERVER_NETWORK_ID = 'clank-observer';
const OBSERVER_NETWORK_NAME = 'Clank & Slop Observer';
const OBSERVER_PAIR_SECRET = 'CLANK_MOLTNET_PAIR_OBSERVER_TOKEN';
const OBSERVER_RELAY_SECRET = 'CLANK_MOLTNET_RELAY_OBSERVER_TOKEN';
const OBSERVER_RELAY_URL = 'wss://moltnet-relay.alicenet.workers.dev';
const OBSERVER_RELAY_ROOM = 'VdoP-HC5isGQksHo5dYpnQ';

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

export function validateAgentDeclaration(agent, bytes) {
  const engine = engineByAgent[agent];
  assert(engine, `${agent} runtime assignment missing`);
  const runtime = section(bytes, 'runtime');
  const execution = section(bytes, 'execution');
  const surfaces = section(bytes, 'surfaces');
  const workspace = section(bytes, 'workspace');
  assert(runtime.includes(`engine: ${engine}`), `${agent} runtime engine declaration invalid`);
  assert(execution.includes('sandbox:\n    mode: workspace'), `${agent} workspace sandbox declaration invalid`);
  if (engine === 'codex') {
    assert(execution.includes('provider: openai') && execution.includes('method: codex') && !execution.includes('endpoint:'), `${agent} Codex subscription intent invalid`);
  } else {
    assert(!/^\s+model:/m.test(execution), `${agent} Daimon ${engine} execution.model must be omitted`);
  }
  assert(!bytes.includes('engine: agy'), `${agent} must not declare deferred AGY engine`);
  assert(!/^policy:/m.test(bytes), `${agent} must not override Spawnfile policy`);
  assert(surfaces.includes('network: clank-newsroom') && surfaces.includes(`token_id: ${agent}`), `${agent} Moltnet binding invalid`);
  assert(surfaces.includes('research:') === researchMembers.has(agent), `${agent} research room binding invalid`);
  const publicResource = resourceLine(workspace, 'public-content');
  const bundled = line => line?.includes('kind: bundle') && line.includes('source: ../../newsroom-runtime.tar') && /sha256: sha256:[a-f0-9]{64}/u.test(line) && line.includes('mount: ./repos/newsroom') && line.includes('mode: readonly') && !/kind: git|url:|branch:/.test(line);
  if (publicWriters.has(agent)) {
    assert(publicResource?.includes('kind: volume') && publicResource.includes('name: clank-release-staging') && publicResource.includes('mount: ./staging') && publicResource.includes('mode: mutable') && publicResource.includes('sharing: per_agent') && !/kind: git|url:|branch:/.test(publicResource), `${agent} public content resource invalid`);
    assert(bundled(resourceLine(workspace,'newsroom-runtime')), `${agent} newsroom runtime bundle invalid`);
  } else assert(bundled(publicResource), `${agent} public content resource invalid`);
  const corpus = resourceLine(workspace, 'private-corpus');
  if (corpusAgents.has(agent)) {
    assert(corpus?.includes('kind: volume') && corpus.includes(`name: clank-${agent}-corpus`) && corpus.includes('mount: ./private/corpus') && corpus.includes('mode: mutable') && corpus.includes('sharing: per_agent'), `${agent} private corpus resource invalid`);
  } else {
    assert(!corpus, `${agent} must not receive a private corpus resource`);
  }
}

export function validateRootDeclaration(bytes) {
  const shared = section(bytes, 'shared');
  assert(shared.includes('id: edition-state') && shared.includes('kind: volume') && shared.includes('name: clank-edition-state') && shared.includes('mount: ./state/edition') && shared.includes('mode: mutable') && shared.includes('sharing: team'), 'shared edition state resource invalid');
  assert(bytes.includes('id: clank-newsroom') && bytes.includes('provider: moltnet'), 'Moltnet network identity invalid');
  assert(bytes.includes('bind: 0.0.0.0, port: 8787'), 'Moltnet cloud listener invalid');
  assert(bytes.includes('mode: bearer') && bytes.includes('public_read: false') && bytes.includes('agent_registration: disabled') && bytes.includes('client: { token_id: operator }'), 'Moltnet bearer admission invalid');
  assert(bytes.includes('kind: sqlite') && bytes.includes('path: /var/lib/spawnfile/moltnet/networks/clank-newsroom/moltnet.sqlite') && bytes.includes('mode: durable') && bytes.includes('mount: /var/lib/spawnfile/moltnet/networks/clank-newsroom'), 'Moltnet durable store invalid');
  assert(!/auth:\s*\{\s*mode:\s*none/.test(bytes) && !/store:\s*\{\s*kind:\s*memory/.test(bytes), 'Moltnet must not use unauthenticated memory mode');
  assert(!/^\s+(?:token|value):/m.test(bytes), 'Moltnet declarations must contain secret references only');

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
  assert(tokens.size === agents.length + 5, 'unexpected Moltnet token declaration');
  // Narrowed federation policy. The newsroom still must not *depend* on
  // federation: it runs identically whether the laptop observer is connected or
  // not. What is now permitted is exactly one declared pairing — the read-only
  // clank-observer relay link — carrying a pair-scoped credential bound to no
  // agent. A second pairing, a different remote network, an inbound
  // remote_base_url peer, or a pair token with agents or extra scopes still fails.
  const pairings = declaredPairings(bytes);
  assert(pairings.length === 1, 'cloud Moltnet may declare exactly one read-only observer pairing');
  const [pairing] = pairings;
  assert(pairing.id === OBSERVER_PAIRING_ID && pairing.remote_network_id === OBSERVER_NETWORK_ID && pairing.remote_network_name === OBSERVER_NETWORK_NAME && pairing.token_secret === OBSERVER_PAIR_SECRET, 'observer pairing identity invalid');
  assert(pairing.remote_base_url === undefined && pairing.relay !== undefined, 'observer pairing must reach the laptop over the relay, never an inbound base url');
  assert(inlineField(pairing.relay, 'url') === OBSERVER_RELAY_URL && inlineField(pairing.relay, 'room') === OBSERVER_RELAY_ROOM && inlineField(pairing.relay, 'token_secret') === OBSERVER_RELAY_SECRET, 'observer relay transport must match the paired laptop coordinates');
  const pairToken = tokens.get(OBSERVER_PAIRING_ID);
  assert(pairToken?.secret === pairing.token_secret && pairToken.scopes.join(',') === 'pair' && pairToken.agents.length === 0, 'observer pair token must be pair-scoped, agent-free and bound to the pairing secret');
  assert(!/^\s+remote_base_url:/m.test(bytes), 'cloud Moltnet must not accept an inbound federation peer');
  assert(bytes.includes('id: gatherer') && bytes.includes('network: clank-newsroom') && bytes.includes('auth: { token_id: gatherer }') && bytes.includes('dms: { enabled: true }'), 'research intake participant invalid');
  assert(bytes.includes('id: research-sensor') && bytes.includes('auth: { token_id: research-sensor }'), 'direct research sensor participant invalid');
  const roomPattern = /- \{ id: ([a-z-]+), visibility: private, write_policy: members, federation: (none|all|\[[^\]]+\]), members: \[([^\]]+)\] \}/g;
  const rooms = new Map([...bytes.matchAll(roomPattern)].map((match) => [match[1], { federation: match[2], members: csv(match[3]) }]));
  assert(rooms.size === 6, 'Moltnet room federation declarations invalid');
  // Conference is where reporters pitch and the editor assigns; it holds the nine
  // colleagues and klaxon, and deliberately excludes the external research feeds.
  const conference = rooms.get('conference');
  assert(conference !== undefined, 'conference room declaration missing');
  assert(conference !== undefined && !conference.members.includes('gatherer') && !conference.members.includes('research-sensor'), 'conference room must exclude external feeds');
  // Every room, conference included, is either cloud-local or federated to the
  // single read-only observer pairing and nothing else. The narrowing is about
  // *who* may federate, never which room: `federation: all` stays forbidden so
  // that adding a future pairing can never widen an existing room implicitly,
  // and a room may never name a pairing this server does not declare.
  assert([...rooms.values()].every((room) => room.federation === 'none' || room.federation === `[${OBSERVER_PAIRING_ID}]`), `Moltnet rooms must stay cloud-local or federate only to the read-only ${OBSERVER_PAIRING_ID} pairing`);
  assert(rooms.get('assignment')?.members.includes('gatherer'), 'assignment kickoff participant invalid');
  const research = rooms.get('research');
  assert(research?.members.includes('research-sensor'), 'research sensor local identity invalid');
  assert(research && new Set(research.members).size === researchMembers.size && research.members.every((member) => researchMembers.has(member)), 'research room membership invalid');
}

export function validateRuntimeBindings(root = orgRoot) {
  assert(Object.keys(engineByAgent).length === agents.length, 'runtime assignment incomplete');
  assert(policy.enginePolicy?.active?.grok === 10 && policy.enginePolicy?.active?.codex === 6, 'active engine policy invalid');
  assert(policy.enginePolicy?.agy?.hostAuthCheck === true && policy.enginePolicy?.agy?.linuxPortable === false && policy.enginePolicy?.agy?.status === 'deferred-broker', 'AGY portability policy invalid');
  for (const agent of agents) {
    const bytes = readFileSync(resolve(root, 'agents', agent, 'Spawnfile'), 'utf8');
    validateAgentDeclaration(agent, bytes);
  }
}

export function validateTree() { for (const agent of agents) for (const file of ['Spawnfile', 'AGENTS.md', 'CLAUDE.md']) assert(existsSync(resolve(orgRoot, 'agents', agent, file)), `${agent} missing ${file}`); const root = readFileSync(resolve(orgRoot, 'Spawnfile'), 'utf8'); for (const banned of ['browser_profile', 'profile_path', 'raw_html', 'account_name']) assert(!root.includes(banned), `banned root field ${banned}`); assert(!/^policy:/m.test(root), 'root must not override Spawnfile policy'); validateRootDeclaration(root); validateRuntimeBindings(); }
export function validateSchedule() {
  const schedule = readJson(resolve(orgRoot, 'policies/schedule.json'));
  assert(schedule.timezone === 'Europe/Berlin' && schedule.deadline === '16:00', 'schedule zone or deadline invalid');
  assert(policy.deadline === schedule.deadline, 'runtime and schedule deadline drift');
  assert(JSON.stringify(schedule.checkpoints?.map(({id,time,owner}) => ({id,time,owner}))) === JSON.stringify([{id:'pitch',time:'10:00',owner:'reporters'},{id:'conference',time:'10:30',owner:'brass'},{id:'review',time:'14:00',owner:'spike'},{id:'composition',time:'15:00',owner:'caslon'},{id:'release',time:'16:00',owner:'pressman'}]), 'conference checkpoints invalid');
  assert(schedule.operator_kickoff === false && schedule.task_orchestrator === false, 'operator kickoff and task orchestrators are prohibited');
  assert(schedule.downstream_activation === 'moltnet-addressed-only' && schedule.polling === false, 'downstream work must be addressed through Moltnet without polling');
  const owners = schedule.spawnfile_schedule?.owners ?? {};
  assert(schedule.spawnfile_schedule?.status === 'native' && Object.keys(owners).length === 9, 'native schedule roster invalid');
  for (const agent of agents) {
    const bytes = readFileSync(resolve(orgRoot, 'agents', agent, 'Spawnfile'), 'utf8');
    assert(Object.hasOwn(owners, agent) === /^schedule:/m.test(bytes), `${agent} schedule authority invalid`);
    if (Object.hasOwn(owners, agent)) assert(bytes.includes(`cron: "${owners[agent]}"`), `${agent} schedule cron drift`);
  }
  for (const agent of Object.keys(owners)) {
    const bytes = readFileSync(resolve(orgRoot, 'agents', agent, 'Spawnfile'), 'utf8');
    assert(bytes.includes('timezone: Europe/Berlin'), `${agent} schedule timezone invalid`);
  }
  const klaxon = readFileSync(resolve(orgRoot, 'agents/klaxon/Spawnfile'), 'utf8'); assert(klaxon.includes('wake: all, allowed_wake_senders: [research-sensor]') && klaxon.includes('sensor: { wake: mentions }'), 'Klaxon selective sensor wake policy invalid');
}
export function validateEditorialContracts(vesta, data, voices) {
  for (const phrase of ['ordinary Record','boring null','observable falsifier','hidden hands','default-spike']) assert(vesta.includes(phrase), `Vesta constraint missing: ${phrase}`);
  assert(/ordinary Record.*boring null.*observable falsifier/i.test(voices.vesta.good) && /hidden hand/i.test(voices.vesta.bad), 'Vesta voice boundary invalid');
  for (const owner of ['World Scout, Klaxon, Frontier, Closure','reporters','Ledger','Caslon','Morgue']) assert(new RegExp(`\\| ${owner} \\|[^\\n]*public content: read-only`).test(data), `${owner} DATA boundary invalid`);
  assert(/\| Pressman \|[^\n]*public content: mutable[^\n]*\| sole owner/.test(data), 'Pressman DATA ownership invalid');
}
export function validateLifecycle(receipts, options = {}) {
  const keys=['version','id','kind','edition','release','owner','correlation_id','causal_parent','artifact_digest','receipt_ref','status'];
  const adapt=(receipt)=>{assert(receipt&&Object.keys(receipt).sort().join()===[...keys].sort().join()&&receipt.version==='v1','lifecycle receipt shape invalid');return{id:receipt.id,kind:receipt.kind,parent:receipt.causal_parent,edition:receipt.edition,release:receipt.release,correlation:receipt.correlation_id,digest:receipt.artifact_digest,ref:receipt.receipt_ref,owner:receipt.owner,status:receipt.status};};
  const nodes=receipts.map(adapt);validateLifecycleGraph(nodes,{mode:options.mode??'full',externalFinalization:options.externalFinalization?adapt(options.externalFinalization):undefined});
}
export function validateFixtures() { const cycle = readJson(resolve(orgRoot, 'fixtures/daily-cycle.json')); const prior = []; for (const message of cycle.messages) { validateMessage(message, prior); prior.push(message); } validateManifest(readJson(resolve(orgRoot, 'fixtures/corpus-manifest.json'))); validateLifecycle(readJson(resolve(orgRoot, 'fixtures/lifecycle-receipts.json')).receipts); const voices=readJson(resolve(orgRoot,'fixtures/voice-boundaries.json')); assert(agents.every((agent)=>voices[agent]?.good && voices[agent]?.bad), 'every persona requires concrete good/bad voice examples'); validateEditorialContracts(readFileSync(resolve(orgRoot,'agents/vesta/AGENTS.md'),'utf8'),readFileSync(resolve(orgRoot,'DATA.md'),'utf8'),voices); const vestaSpike = cycle.messages.find((message) => message.id === 'spike-vesta-20260816'); assert(vestaSpike?.owner === 'spike', 'Spike must own Vesta editorial spike'); }
export function main() { validateTree(); validateSchedule(); validateFixtures(); console.log('organization validation: passed'); }
if (process.argv[1] === new URL(import.meta.url).pathname) { try { main(); } catch (error) { console.error(`organization validation: failed: ${error.message}`); process.exitCode = 1; } }
