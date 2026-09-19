// What each CLI engine must DECLARE, and what its COMPILED runtime must carry.
//
// WHY THIS EXISTS
// ---------------
// Both halves of the organization assumed Codex. `validate-org.mjs` mapped all
// twelve agents to `codex` and treated any other engine as "must not declare a
// model", and `seam-run.mjs` refused to deploy an organization that contained
// no Codex agent at all. Neither of those is the safety property. The safety
// property is:
//
//   every agent runs on an engine whose confinement is declared in the
//   Spawnfile, lowered by the compiler, and checked again before `up`.
//
// Codex and Grok reach that property through different mechanisms, and the
// mechanism is the reason each assertion below exists. Both are read out of
// Spawnfile 0.1.17 (`src/runtime/daimon/`), not invented here:
//
//   Codex  `runtime.options.codex_policy: workspace-no-network` is the only
//          value the compiler lowers, into `engine.codexSandbox`
//          {workspace-write, networkAccess:false, webSearch:disabled}. The
//          Codex CLI enforces it in-process. Omit the option and the compiled
//          agent simply has no sandbox — silently.
//
//   Grok   confinement is not a field on the agent. Every Grok worker runs
//          behind Daimon's engine broker under its own uid, and the compiler
//          renders the whole apparatus into the container entrypoint:
//          a Landlock profile `extends = "strict"` with
//          `restrict_network = true`, pinned by SHA-256 in the broker's
//          service registration; a worker `config.toml` whose only model
//          endpoint is the loopback provider proxy on 127.0.0.1:43123 with
//          `supports_backend_search = false` and `web_fetch = false`; and a
//          per-agent worker uid from 2200 up. The model x effort pair is part
//          of those pinned bytes — the proxy refuses a request body carrying
//          any other pair — which is why the declaration must name both.
//
// So the Grok equivalents of the Codex checks are asserted where they actually
// live: the declaration side here and in `validate-org.mjs`, the compiled side
// in `seam-run.mjs`'s `runtimePolicy` stage, which reads both the Daimon
// organization runtime config AND the rendered broker provisioning.
//
// An engine with no entry in this module is a REFUSAL, never a skipped agent.
// That is the rule the old `if (engine === 'codex') … else …` broke: anything
// that was not Codex fell into a branch that checked almost nothing.

import { readdirSync } from 'node:fs';
import path from 'node:path';

export const DEFERRED_ENGINES = Object.freeze(['agy']);
export const SUPPORTED_ENGINES = Object.freeze(['codex', 'grok']);
export const KNOWN_ENGINES = Object.freeze([...SUPPORTED_ENGINES, ...DEFERRED_ENGINES]);

// Spawnfile's DAIMON_CODEX_WORKSPACE_NO_NETWORK_POLICY, byte for byte.
export const CODEX_STRICT_SANDBOX = Object.freeze({ mode: 'workspace-write', networkAccess: false, webSearch: 'disabled' });
export const CODEX_POLICY_OPTION = 'workspace-no-network';
export const CODEX_ACCOUNT_MODEL = 'gpt-5.5';

// Spawnfile's DAIMON_GROK_BROKER_MODELS / _REASONING_EFFORTS and the pinned
// worker contract bytes those two select.
export const GROK_BROKER = Object.freeze({
  models: Object.freeze(['grok-4.6', 'grok-4.5', 'grok-build']),
  efforts: Object.freeze(['low', 'medium', 'high']),
  providerProxy: 'http://127.0.0.1:43123/v1',
  mcpFacade: 'http://127.0.0.1:43124/mcp',
  serviceVersionPrefix: 'noopolis.daimon.engine-broker-service.v',
  sandboxProfile: 'restrict_network = true',
  sandboxBase: 'extends = "strict"',
  backendSearch: 'supports_backend_search = false',
  webFetch: 'web_fetch = false',
  firstWorkerUid: 2200
});

// The two compiled artifacts the engine policy is read from: the Daimon
// organization runtime config (per-agent engine) and the container entrypoint
// the compiler renders the Grok broker provisioning into.
export const DAIMON_RUNTIME_CONFIG = 'daimon-organization-runtime.json';
export const DAIMON_UID_ENTRYPOINT = 'daimon-uid-entrypoint.sh';

export function compiledArtifacts(root, name) {
  const found = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.name === name) found.push(candidate);
    }
  };
  visit(root);
  return found;
}

const named = (value) => (value === undefined || value === null || value === '' ? 'none' : String(value));

// --- declaration side: what an agent Spawnfile must say ----------------------
// `manifest` is the parsed Spawnfile (check-instruction-budget.mjs's reader),
// so these read the same fields the compiler reads rather than matching prose.
export function engineDeclarationFindings(agent, engine, manifest) {
  const findings = [];
  const options = manifest.runtime?.options ?? {};
  const declared = options.engine;
  if (declared !== engine) findings.push(`${agent} runtime engine declaration invalid`);
  for (const deferred of DEFERRED_ENGINES) if (declared === deferred) findings.push(`${agent} must not declare deferred ${deferred.toUpperCase()} engine`);
  if (!SUPPORTED_ENGINES.includes(engine)) {
    findings.push(`${agent} is assigned engine ${named(engine)}, which has no confinement contract in engine-policy.mjs — declare one there before an agent runs on it`);
    return findings;
  }
  const model = manifest.execution?.model;
  const primary = model?.primary;
  if (model?.fallback?.length || model?.auth) findings.push(`${agent} ${engine} model must be exactly one primary target with target-level auth — a fallback or a legacy model-level auth block is not lowered and would run unpinned`);
  if (engine === 'codex') {
    if (options.codex_policy !== CODEX_POLICY_OPTION) findings.push(`${agent} Codex sandbox policy invalid — runtime.options.codex_policy must be ${CODEX_POLICY_OPTION}, the only value the compiler lowers into engine.codexSandbox; without it the compiled agent carries no sandbox at all`);
    if (primary?.provider !== 'openai' || primary?.auth?.method !== 'codex' || primary?.endpoint) findings.push(`${agent} Codex subscription intent invalid`);
    if (primary?.name !== CODEX_ACCOUNT_MODEL) findings.push(`${agent} Codex account model invalid: expected ${CODEX_ACCOUNT_MODEL}, found ${named(primary?.name)}`);
    if (primary?.reasoning_effort !== undefined) findings.push(`${agent} declares reasoning_effort on a Codex model, which only a brokered Grok target accepts`);
  }
  if (engine === 'grok') {
    if (options.codex_policy !== undefined) findings.push(`${agent} declares codex_policy on a Grok agent — the compiler never lowers it, so it reads as a sandbox that does not exist`);
    if (!primary) findings.push(`${agent} Grok broker model declaration missing — Daimon's broker pins the worker config per model x effort, so both must be declared`);
    else {
      if (primary.provider !== 'xai' || primary.auth?.method !== 'grok' || primary.endpoint) findings.push(`${agent} Grok broker auth invalid — provider xai with target-level auth.method grok and no endpoint; the worker reaches the provider only through the broker's loopback proxy`);
      if (!GROK_BROKER.models.includes(primary.name)) findings.push(`${agent} Grok broker model invalid: ${named(primary.name)} is not one of ${GROK_BROKER.models.join(', ')}`);
      // Grok drops an effort its model does not declare, and its catalog
      // default for grok-4.6 is `high`: an omitted effort is a silent upgrade,
      // never a default, so it is required rather than inferred.
      if (!GROK_BROKER.efforts.includes(primary.reasoning_effort)) findings.push(`${agent} Grok reasoning_effort invalid: ${named(primary.reasoning_effort)} is not one of ${GROK_BROKER.efforts.join(', ')}`);
    }
  }
  return findings;
}

// --- compiled side: what one agent in daimon-organization-runtime.json carries
export function compiledEngineFindings(where, agent) {
  const id = agent?.id ?? 'agent';
  const engine = agent?.engine;
  const kind = engine?.kind;
  const label = `${where}:${id}`;
  if (!SUPPORTED_ENGINES.includes(kind)) return [`${label} runs on engine ${named(kind)}, which has no deploy-time policy equivalent in this job — add one to engine-policy.mjs before deploying it`];
  if (kind === 'codex') {
    const sandbox = engine.codexSandbox;
    const expected = Object.entries(CODEX_STRICT_SANDBOX);
    if (!sandbox || Object.keys(sandbox).length !== expected.length || expected.some(([key, value]) => sandbox[key] !== value)) return [`${label} missing strict Codex policy`];
    return [];
  }
  // Grok carries no sandbox field: `{kind, model, reasoningEffort}` is the
  // whole of it, and the pair is what selects the pinned worker bytes. Any
  // extra key means the compiler lowered something this check does not know
  // about, which is exactly when it must stop rather than pass.
  const keys = Object.keys(engine).sort().join(',');
  const findings = [];
  if (keys !== 'kind,model,reasoningEffort') findings.push(`${label} compiled Grok engine has fields [${keys}], expected exactly kind, model, reasoningEffort`);
  if (!GROK_BROKER.models.includes(engine.model)) findings.push(`${label} compiled Grok model invalid: ${named(engine.model)}`);
  if (!GROK_BROKER.efforts.includes(engine.reasoningEffort)) findings.push(`${label} compiled Grok reasoning effort invalid: ${named(engine.reasoningEffort)}`);
  return findings;
}

// --- compiled side: the broker apparatus, rendered into the entrypoint -------
// `expected` is a Map of compiled agent id -> {model, reasoningEffort}. The
// entrypoint is a shell script with the broker's provisioning program inlined,
// so these read the literal contract bytes the compiler embedded. A Grok
// organization whose entrypoint carries none of this is refused: an absent
// confinement is not an exempt one.
export function grokBrokerFindings(where, source, expected) {
  const findings = [];
  const requires = (needle, reason) => { if (!source.includes(needle)) findings.push(`${where} ${reason} (${JSON.stringify(needle)} absent)`); };
  requires(`"${GROK_BROKER.serviceVersionPrefix}`, 'carries no Daimon engine-broker service registration — every Grok worker would run unbrokered');
  requires(GROK_BROKER.sandboxBase, 'carries no strict Grok worker sandbox profile');
  requires(GROK_BROKER.sandboxProfile, 'does not confine the Grok workers to no network — this is the equivalent of the Codex networkAccess:false policy');
  requires(GROK_BROKER.backendSearch, 'does not disable Grok backend search — this is the equivalent of the Codex webSearch:disabled policy');
  requires(GROK_BROKER.webFetch, 'does not disable Grok web fetch');
  requires(GROK_BROKER.providerProxy, 'does not pin the workers to the broker loopback provider proxy');
  const uids = new Map();
  for (const [id, model] of expected) {
    const start = source.indexOf(`"agentId":"${id}"`);
    if (start < 0) { findings.push(`${where} has no Grok broker registration for ${id}`); continue; }
    const next = source.indexOf('"agentId":"', start + 1);
    const registration = source.slice(start, next < 0 ? undefined : next);
    const uid = /"workerUid":(\d+)/u.exec(registration)?.[1];
    if (uid === undefined || Number(uid) < GROK_BROKER.firstWorkerUid) findings.push(`${where}:${id} has no dedicated Grok worker uid at or above ${GROK_BROKER.firstWorkerUid}`);
    else if (uids.has(uid)) findings.push(`${where}:${id} shares Grok worker uid ${uid} with ${uids.get(uid)} — one confinement cannot cover two agents`);
    else uids.set(uid, id);
    if (!/"profileSha256":"[a-f0-9]{64}"/u.test(registration)) findings.push(`${where}:${id} Grok sandbox profile is not pinned by digest`);
    const pair = `"model":{"id":"${model.model}","reasoningEffort":"${model.reasoningEffort}"}`;
    if (!registration.includes(pair)) findings.push(`${where}:${id} broker registration does not pin ${model.model}/${model.reasoningEffort}; the compiled agent and its worker config disagree`);
  }
  return findings;
}
