import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { agents, assert, digest, orgRoot, policy, privateKinds, reporters, sensors, readJson, releaseFor } from './lib.mjs';

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
  assert(message.release === releaseFor(message.edition, message.release.includes('+01:00') ? '+01:00' : '+02:00'), 'release must be Berlin 16:20');
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
  'world-scout': 'grok', klaxon: 'grok', frontier: 'grok', closure: 'grok', cogsworth: 'grok', sprockett: 'grok', foreman: 'grok', graves: 'grok', tinkerton: 'grok', vesta: 'grok',
  brass: 'codex', spike: 'codex', ledger: 'codex', caslon: 'codex', morgue: 'codex', pressman: 'codex'
});

const expectedExecution = (engine) => engine === 'codex'
  ? 'execution:\n  model:\n    primary:\n      provider: openai\n      name: gpt-5.4-mini\n      auth:\n        method: codex\n  sandbox:\n    mode: workspace\n'
  : `execution:\n  model:\n    primary:\n      provider: local\n      name: ${engine}-cli\n      auth:\n        method: none\n      endpoint:\n        compatibility: openai\n        base_url: http://127.0.0.1:11434/v1\n  sandbox:\n    mode: workspace\n`;

export function validateRuntimeBindings(root = orgRoot) {
  assert(Object.keys(engineByAgent).length === agents.length, 'runtime assignment incomplete');
  assert(policy.enginePolicy?.active?.grok === 10 && policy.enginePolicy?.active?.codex === 6, 'active engine policy invalid');
  assert(policy.enginePolicy?.agy?.hostAuthCheck === true && policy.enginePolicy?.agy?.linuxPortable === false && policy.enginePolicy?.agy?.status === 'deferred-broker', 'AGY portability policy invalid');
  for (const agent of agents) {
    const bytes = readFileSync(resolve(root, 'agents', agent, 'Spawnfile'), 'utf8');
    const engine = engineByAgent[agent];
    assert(engine, `${agent} runtime assignment missing`);
    assert(bytes.includes(`runtime:\n  name: daimon\n  options:\n    engine: ${engine}\n`), `${agent} runtime engine declaration invalid`);
    assert(bytes.includes(expectedExecution(engine)), `${agent} execution model declaration invalid`);
    assert(!bytes.includes('engine: agy'), `${agent} must not declare deferred AGY engine`);
    assert(!/\npolicy:/.test(bytes), `${agent} must not override Spawnfile policy`);
  }
}

export function validateTree() { for (const agent of agents) for (const file of ['Spawnfile', 'AGENTS.md', 'CLAUDE.md']) assert(existsSync(resolve(orgRoot, 'agents', agent, file)), `${agent} missing ${file}`); const root = readFileSync(resolve(orgRoot, 'Spawnfile'), 'utf8'); for (const banned of ['credential', 'browser_profile', 'profile_path', 'raw_html', 'account_name', 'policy:']) assert(!root.includes(banned), `banned root field ${banned}`); assert(root.includes('server:\n      mode: managed\n      listen: { bind: 127.0.0.1, port: 8787 }\n      auth: { mode: none }\n      store: { kind: memory }'), 'root Moltnet server declaration invalid'); validateRuntimeBindings(); }
export function validateSchedule() {
  const schedule = readJson(resolve(orgRoot, 'policies/schedule.json'));
  assert(schedule.timezone === 'Europe/Berlin' && schedule.deadline === '16:20', 'schedule zone or deadline invalid');
  assert(schedule.kickoff?.kind === 'operator' && schedule.kickoff.target === 'brass' && schedule.kickoff.count === 1, 'exactly one operator kickoff to Brass is required');
  assert(schedule.downstream_activation === 'moltnet-addressed-only' && schedule.polling === false, 'downstream work must be addressed through Moltnet without polling');
  for (const agent of agents) {
    const bytes = readFileSync(resolve(orgRoot, 'agents', agent, 'Spawnfile'), 'utf8');
    assert(!/^schedule:/m.test(bytes), `${agent} must not declare a schedule`);
  }
}
export function validateFixtures() { const cycle = readJson(resolve(orgRoot, 'fixtures/daily-cycle.json')); const prior = []; for (const message of cycle.messages) { validateMessage(message, prior); prior.push(message); } validateManifest(readJson(resolve(orgRoot, 'fixtures/corpus-manifest.json'))); const vestaSpike = cycle.messages.find((message) => message.id === 'spike-vesta-20260816'); assert(vestaSpike?.owner === 'spike', 'Spike must own Vesta editorial spike'); }
export function main() { validateTree(); validateSchedule(); validateFixtures(); console.log('organization validation: passed'); }
if (process.argv[1] === new URL(import.meta.url).pathname) { try { main(); } catch (error) { console.error(`organization validation: failed: ${error.message}`); process.exitCode = 1; } }
