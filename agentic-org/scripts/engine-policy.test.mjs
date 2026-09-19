import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { agents } from './lib.mjs';
import { parseManifest } from './check-instruction-budget.mjs';
import { engineByAgent } from './validate-org.mjs';
import { CODEX_STRICT_SANDBOX, GROK_BROKER, SUPPORTED_ENGINES, compiledEngineFindings, engineDeclarationFindings, grokBrokerFindings } from './engine-policy.mjs';

const spawnfile = (agent) => readFileSync(resolve(import.meta.dirname, `../agents/${agent}/Spawnfile`), 'utf8');
const manifestFor = (agent) => parseManifest(spawnfile(agent));

// A Codex declaration as the organization carried it before the Grok move:
// kept as a fixture because no agent runs on Codex today and a branch that
// nothing exercises is a branch that quietly stops working.
const codexManifest = () => ({
  runtime: { name: 'daimon', options: { engine: 'codex', codex_policy: 'workspace-no-network' } },
  execution: { model: { primary: { provider: 'openai', name: 'gpt-5.5', auth: { method: 'codex' } } }, sandbox: { mode: 'workspace' } }
});

test('every agent is assigned a supported engine and its Spawnfile declares that same engine', () => {
  for (const agent of agents) {
    const engine = engineByAgent[agent];
    assert.ok(SUPPORTED_ENGINES.includes(engine), `${agent} must be assigned an engine with a confinement contract`);
    assert.equal(manifestFor(agent).runtime?.options?.engine, engine, `${agent} Spawnfile must declare ${engine}`);
    assert.deepEqual(engineDeclarationFindings(agent, engine, manifestFor(agent)), [], agent);
  }
});

// The organization is Grok-only. This is the assertion that says so, and the
// one that has to be revisited — rather than silently satisfied — when an
// agent moves back onto another engine.
test('the whole newsroom runs on the brokered Grok engine, model and effort pinned', () => {
  for (const agent of agents) {
    const primary = manifestFor(agent).execution?.model?.primary;
    assert.equal(engineByAgent[agent], 'grok', agent);
    assert.equal(primary.provider, 'xai', agent);
    assert.equal(primary.auth?.method, 'grok', agent);
    assert.ok(GROK_BROKER.models.includes(primary.name), `${agent} pins ${primary.name}`);
    assert.ok(GROK_BROKER.efforts.includes(primary.reasoning_effort), `${agent} pins effort ${primary.reasoning_effort}`);
  }
});

test('a Grok declaration is refused for each thing the broker pins, one at a time', () => {
  const base = manifestFor('foreman');
  const mutate = (change) => { const copy = structuredClone(base); change(copy); return copy; };
  const cases = [
    ['api provider substituted', (m) => { m.execution.model.primary.provider = 'openai'; }, /Grok broker auth invalid/u],
    ['subscription auth dropped', (m) => { m.execution.model.primary.auth.method = 'api_key'; }, /Grok broker auth invalid/u],
    ['direct endpoint declared', (m) => { m.execution.model.primary.endpoint = { base_url: 'https://api.x.ai/v1', compatibility: 'openai' }; }, /Grok broker auth invalid/u],
    ['unbrokered model', (m) => { m.execution.model.primary.name = 'grok-9'; }, /Grok broker model invalid/u],
    ['effort omitted', (m) => { delete m.execution.model.primary.reasoning_effort; }, /Grok reasoning_effort invalid/u],
    ['effort outside the closed set', (m) => { m.execution.model.primary.reasoning_effort = 'xhigh'; }, /Grok reasoning_effort invalid/u],
    ['model block removed', (m) => { delete m.execution.model; }, /Grok broker model declaration missing/u],
    ['second model target', (m) => { m.execution.model.fallback = [{ provider: 'xai', name: 'grok-4.5' }]; }, /exactly one primary target/u],
    ['codex policy carried over', (m) => { m.runtime.options.codex_policy = 'workspace-no-network'; }, /sandbox that does not exist/u],
    ['engine flipped in the manifest only', (m) => { m.runtime.options.engine = 'codex'; }, /runtime engine declaration invalid/u],
    ['deferred engine declared', (m) => { m.runtime.options.engine = 'agy'; }, /deferred AGY engine/u]
  ];
  for (const [name, change, reason] of cases) {
    const findings = engineDeclarationFindings('foreman', 'grok', mutate(change));
    assert.ok(findings.length > 0, `${name} must be refused`);
    assert.match(findings.join('; '), reason, name);
  }
});

test('the Codex branch still refuses everything it refused before the Grok move', () => {
  assert.deepEqual(engineDeclarationFindings('brass', 'codex', codexManifest()), []);
  const mutate = (change) => { const copy = codexManifest(); change(copy); return copy; };
  const cases = [
    ['subscription auth dropped', (m) => { m.execution.model.primary.auth.method = 'none'; }, /Codex subscription intent invalid/u],
    ['provider substituted', (m) => { m.execution.model.primary.provider = 'xai'; }, /Codex subscription intent invalid/u],
    ['direct endpoint declared', (m) => { m.execution.model.primary.endpoint = { base_url: 'https://example.invalid', compatibility: 'openai' }; }, /Codex subscription intent invalid/u],
    ['retired account model', (m) => { m.execution.model.primary.name = 'gpt-5.4-mini'; }, /Codex account model invalid/u],
    // The gap this closes: the sandbox the seam checks after the build only
    // exists because of this one option, and nothing here ever read it.
    ['sandbox policy option dropped', (m) => { delete m.runtime.options.codex_policy; }, /codex_policy must be workspace-no-network/u],
    ['sandbox policy weakened', (m) => { m.runtime.options.codex_policy = 'danger-full-access'; }, /codex_policy must be workspace-no-network/u],
    ['grok effort on a Codex model', (m) => { m.execution.model.primary.reasoning_effort = 'low'; }, /only a brokered Grok target accepts/u]
  ];
  for (const [name, change, reason] of cases) assert.match(engineDeclarationFindings('brass', 'codex', mutate(change)).join('; '), reason, name);
});

test('an engine with no contract is named and refused, never skipped', () => {
  const manifest = { runtime: { options: { engine: 'agy' } }, execution: {} };
  const findings = engineDeclarationFindings('klaxon', 'agy', manifest);
  assert.match(findings.join('; '), /no confinement contract in engine-policy\.mjs/u);
});

// --- the compiled side -------------------------------------------------------
const compiledGrok = (over = {}) => ({ id: 'agent:foreman', engine: { kind: 'grok', model: 'grok-4.6', reasoningEffort: 'low', ...over } });

test('a compiled Grok agent must carry exactly the broker-selecting pair', () => {
  assert.deepEqual(compiledEngineFindings('config.json', compiledGrok()), []);
  assert.match(compiledEngineFindings('config.json', compiledGrok({ model: 'grok-9' })).join('; '), /compiled Grok model invalid/u);
  assert.match(compiledEngineFindings('config.json', compiledGrok({ reasoningEffort: 'xhigh' })).join('; '), /compiled Grok reasoning effort invalid/u);
  const withoutEffort = compiledGrok();
  delete withoutEffort.engine.reasoningEffort;
  assert.match(compiledEngineFindings('config.json', withoutEffort).join('; '), /expected exactly kind, model, reasoningEffort/u);
  // A Codex sandbox on a Grok agent means the compiler lowered something this
  // check does not model; stopping is the only honest answer.
  assert.match(compiledEngineFindings('config.json', compiledGrok({ codexSandbox: CODEX_STRICT_SANDBOX })).join('; '), /expected exactly kind, model, reasoningEffort/u);
});

test('a compiled agent on an engine with no deploy-time equivalent is refused by name', () => {
  for (const engine of [{ kind: 'agy' }, {}, undefined]) {
    const findings = compiledEngineFindings('config.json', { id: 'agent:klaxon', engine });
    assert.match(findings.join('; '), /has no deploy-time policy equivalent/u, JSON.stringify(engine));
  }
});

test('the strict Codex policy check is unchanged', () => {
  assert.deepEqual(compiledEngineFindings('c', { id: 'a', engine: { kind: 'codex', codexSandbox: { ...CODEX_STRICT_SANDBOX } } }), []);
  for (const sandbox of [undefined, { ...CODEX_STRICT_SANDBOX, networkAccess: true }, { ...CODEX_STRICT_SANDBOX, webSearch: 'enabled' }, { ...CODEX_STRICT_SANDBOX, extra: 1 }])
    assert.match(compiledEngineFindings('c', { id: 'a', engine: { kind: 'codex', codexSandbox: sandbox } }).join('; '), /missing strict Codex policy/u);
});

// --- the broker apparatus in the compiled entrypoint -------------------------
// The literal contract bytes Spawnfile renders into daimon-uid-entrypoint.sh
// for a Grok organization. Trimmed to the lines this check reads; every one of
// them is a byte the compiler actually emits.
const registration = (id, uid, model = 'grok-4.6', effort = 'low') =>
  `{"agentId":"${id}","slot":0,"workerUid":${uid},"workspace":"/w/${uid}","profilePath":"/h/${uid}/.grok/sandbox.toml","profileSha256":"${'a'.repeat(64)}","model":{"id":"${model}","reasoningEffort":"${effort}"}}`;
const entrypoint = (registrations) => [
  `const config = '[model.daimon-broker-grok]\\nmodel = "grok-4.6"\\nbase_url = "${GROK_BROKER.providerProxy}"\\nsupports_backend_search = false\\nweb_fetch = false\\n';`,
  `const profile = '[profiles.daimon-strict]\\nextends = "strict"\\nrestrict_network = true\\ndeny = []\\n';`,
  `const service = {"version":"${GROK_BROKER.serviceVersionPrefix}2","registrations":[${registrations.join(',')}]};`
].join('\n');

test('a Grok organization is admitted only when the compiled entrypoint carries the broker confinement', () => {
  const expected = new Map([['agent:foreman', { model: 'grok-4.6', reasoningEffort: 'low' }], ['agent:brass', { model: 'grok-4.6', reasoningEffort: 'low' }]]);
  const source = entrypoint([registration('agent:foreman', 2200), registration('agent:brass', 2201)]);
  assert.deepEqual(grokBrokerFindings('entrypoint.sh', source, expected), []);
  // Each confinement byte removed on its own. Every one of these is a property
  // the Codex policy check asserted directly and Grok reaches another way.
  const removals = [
    [GROK_BROKER.sandboxProfile, /equivalent of the Codex networkAccess:false policy/u],
    [GROK_BROKER.backendSearch, /equivalent of the Codex webSearch:disabled policy/u],
    [GROK_BROKER.webFetch, /does not disable Grok web fetch/u],
    [GROK_BROKER.sandboxBase, /no strict Grok worker sandbox profile/u],
    [GROK_BROKER.providerProxy, /loopback provider proxy/u],
    [`"${GROK_BROKER.serviceVersionPrefix}`, /no Daimon engine-broker service registration/u]
  ];
  for (const [needle, reason] of removals) {
    const stripped = source.replaceAll(needle, 'REMOVED');
    assert.notEqual(stripped, source, `${needle} must be present to begin with`);
    assert.match(grokBrokerFindings('entrypoint.sh', stripped, expected).join('; '), reason, needle);
  }
});

test('every Grok agent needs its own registration, its own worker uid and a digest-pinned profile', () => {
  const one = new Map([['agent:foreman', { model: 'grok-4.6', reasoningEffort: 'low' }]]);
  const two = new Map([...one, ['agent:brass', { model: 'grok-4.6', reasoningEffort: 'low' }]]);
  assert.match(grokBrokerFindings('e', entrypoint([registration('agent:foreman', 2200)]), two).join('; '), /no Grok broker registration for agent:brass/u);
  assert.match(grokBrokerFindings('e', entrypoint([registration('agent:foreman', 2200), registration('agent:brass', 2200)]), two).join('; '), /shares Grok worker uid 2200/u);
  assert.match(grokBrokerFindings('e', entrypoint([registration('agent:foreman', 12)]), one).join('; '), /no dedicated Grok worker uid/u);
  assert.match(grokBrokerFindings('e', entrypoint([registration('agent:foreman', 2200)]).replace(/"profileSha256":"[a-f0-9]{64}"/u, '"profileSha256":""'), one).join('; '), /sandbox profile is not pinned by digest/u);
  // The compiled agent and its worker config must name the same pair: the
  // broker's provider proxy refuses a request body carrying any other one.
  assert.match(grokBrokerFindings('e', entrypoint([registration('agent:foreman', 2200, 'grok-4.6', 'high')]), one).join('; '), /does not pin grok-4\.6\/low/u);
});
