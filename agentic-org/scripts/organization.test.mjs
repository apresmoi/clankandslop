import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkRuntime } from './check-runtime.mjs';
import { provision } from './provision.mjs';
import { agents, declaredMoltnetSecretRefs } from './lib.mjs';
import { engineByAgent, validateAgentDeclaration, validateEditorialContracts, validateFixtures, validateLifecycle, validateMessage, validateRootDeclaration, validateRuntimeBindings, validateSchedule } from './validate-org.mjs';

const messages = () => JSON.parse(readFileSync(new URL('../fixtures/daily-cycle.json', import.meta.url), 'utf8')).messages;
const validate = (items) => { const prior = []; for (const item of items) { validateMessage(item, prior); prior.push(item); } };
const admittedEnv = (root) => {
  const env = { CLANK_PRIVATE_ROOT: root, CLANK_BROKER_READY: 'yes', CLANK_MOLTNET_READY: 'yes', CLANK_NETWORK_POLICY_READY: 'yes', CLANK_GIT_POLICY_READY: 'yes' };
  for (const secretRef of declaredMoltnetSecretRefs) env[secretRef] = 'opaque';
  for (const agent of ['WORLD_SCOUT','KLAXON','FRONTIER','CLOSURE','COGSWORTH','SPROCKETT','FOREMAN','GRAVES','TINKERTON','VESTA','BRASS','SPIKE','LEDGER','CASLON','MORGUE','PRESSMAN']) { for (const part of ['HOME','XDG','WORKSPACE']) { const path = join(root, agent, part); mkdirSync(path, { recursive: true }); env[`CLANK_${agent}_${part}`] = path; } env[`CLANK_${agent}_CLI_LOGIN`] = 'opaque'; }
  return env;
};

test('digest-linked reporter lifecycle accepts the fixture', () => assert.doesNotThrow(validateFixtures));
test('hostile envelope mutations reject for their intended reason', () => {
  const cases = [
    ['assigned recipient', 0, (m) => ({ ...m, recipient: 'nobody' }), /assignment recipient/],
    ['causal parent', 5, (m) => ({ ...m, causal_parent: 'assign-20260816' }), /parent transition/],
    ['edition', 5, (m) => ({ ...m, edition: '2026-08-17', release: '2026-08-17T16:00:00+02:00[Europe/Berlin]' }), /lifecycle identity/],
    ['release', 5, (m) => ({ ...m, release: '2026-08-16T16:19:00+02:00[Europe\/Berlin]' }), /release must/],
    ['correlation', 5, (m) => ({ ...m, correlation_id: 'wrong-correlation' }), /lifecycle correlation/],
    ['artifact lineage', 5, (m) => ({ ...m, derived_from: m.derived_from.slice(1) }), /causal artifact lineage/],
    ['revision', 7, (m) => ({ ...m, revision: 0 }), /refile must increment/],
    ['refile source', 7, (m) => ({ ...m, derived_from: m.derived_from.slice(0, 1) }), /refile requires filed artifact lineage/],
    ['article owner', 9, (m) => ({ ...m, article_owner: 'vesta' }), /article owner identity/],
    ['terminal state', 5, (m) => ({ ...m, terminal_state: 'OPEN' }), /terminal state/],
    ['unauthorized role', 8, (m) => ({ ...m, owner: 'cogsworth' }), /unauthorized PASS owner/]
  ];
  for (const [, index, mutate, reason] of cases) { const cycle = messages(); cycle[index] = mutate(cycle[index]); assert.throws(() => validate(cycle.slice(0, index + 1)), reason); }
});
test('native Brass checkpoints replace operator kickoff and polling', () => assert.doesNotThrow(validateSchedule));
test('all Node D policy files agree on 16:00 with no stale deadline',()=>{const runtime=JSON.parse(readFileSync(resolve(import.meta.dirname,'../policies/runtime.json'),'utf8'));const schedule=JSON.parse(readFileSync(resolve(import.meta.dirname,'../policies/schedule.json'),'utf8'));assert.equal(runtime.deadline,'16:00');assert.equal(schedule.deadline,runtime.deadline);const root=resolve(import.meta.dirname,'..');const visit=(directory)=>{for(const name of readdirSync(directory)){const file=join(directory,name);if(statSync(file).isDirectory())visit(file);else if(!name.endsWith('.test.mjs')&&!name.endsWith('.tar'))assert.doesNotMatch(readFileSync(file,'utf8'),/16:20/);}};visit(root);});
test('autonomy mutations fail closed', () => {
  const schedulePath=resolve(import.meta.dirname,'../policies/schedule.json'); const original=readFileSync(schedulePath,'utf8');
  writeFileSync(schedulePath,original.replace('"operator_kickoff": false','"operator_kickoff": true')); assert.throws(validateSchedule,/operator kickoff/); writeFileSync(schedulePath,original);
  const klaxonPath=resolve(import.meta.dirname,'../agents/klaxon/Spawnfile'); const klaxon=readFileSync(klaxonPath,'utf8'); writeFileSync(klaxonPath,klaxon.replace('wake: all, allowed_wake_senders: [research-sensor]','wake: all')); assert.throws(validateSchedule,/Klaxon selective/); writeFileSync(klaxonPath,klaxon);
});
test('lifecycle release receipts reject duplicate publication and broken lineage', () => { const source=JSON.parse(readFileSync(resolve(import.meta.dirname,'../fixtures/lifecycle-receipts.json'),'utf8')).receipts; assert.doesNotThrow(()=>validateLifecycle(source)); assert.throws(()=>validateLifecycle([...source,source.at(-1)]),/unique|cardinality/); const broken=structuredClone(source); broken.at(-1).causal_parent='missing'; assert.throws(()=>validateLifecycle(broken),/parent/); });
test('receipt shape adapter rejects extra and missing fields',()=>{const source=JSON.parse(readFileSync(resolve(import.meta.dirname,'../fixtures/lifecycle-receipts.json'),'utf8')).receipts;const extra=structuredClone(source);extra[0].unexpected=true;assert.throws(()=>validateLifecycle(extra),/shape/);const missing=structuredClone(source);delete missing[0].receipt_ref;assert.throws(()=>validateLifecycle(missing),/shape/);});
test('actual agent Spawnfile bytes select the assigned Daimon CLI engines', () => {
  assert.doesNotThrow(validateRuntimeBindings);
  assert.deepEqual(engineByAgent, {
    klaxon: 'codex', cogsworth: 'codex', sprockett: 'codex', foreman: 'codex', graves: 'codex', tinkerton: 'codex', vesta: 'codex',
    brass: 'codex', spike: 'codex', ledger: 'codex', caslon: 'codex', pressman: 'codex'
  });
  const root = mkdtempSync(join(tmpdir(), 'clank-runtime-bindings-'));
  mkdirSync(join(root, 'agents', 'klaxon'), { recursive: true });
  const source = readFileSync(resolve(import.meta.dirname, '../agents/klaxon/Spawnfile'), 'utf8');
  writeFileSync(join(root, 'agents', 'klaxon', 'Spawnfile'), source.replace('engine: codex', 'engine: agy'));
  assert.throws(() => validateRuntimeBindings(root), /klaxon runtime engine declaration invalid/);
  writeFileSync(join(root, 'agents', 'klaxon', 'Spawnfile'), source.replace('execution:', 'policy: { mode: strict, on_degrade: error }\nexecution:'));
  assert.throws(() => validateRuntimeBindings(root), /klaxon must not override Spawnfile policy/);
});
test('Daimon engine declarations preserve their real model-auth boundary', () => {
  // Every agent currently runs on Codex: the Grok sandbox cannot initialise under this
  // deployment, so no Grok agent is declared. The validator still enforces that a Grok
  // agent omits execution.model (Daimon owns its subscription auth); that branch is
  // unexercised here until a Grok agent exists again, rather than faked against a Codex one.
  const codex = readFileSync(resolve(import.meta.dirname, '../agents/brass/Spawnfile'), 'utf8');
  assert.doesNotThrow(() => validateAgentDeclaration('brass', codex));
  assert.throws(() => validateAgentDeclaration('brass', codex.replace('method: codex', 'method: none')), /Codex subscription intent/);
});
test('workspace resources enforce public modes and private corpus least privilege', () => {
  const scout = readFileSync(resolve(import.meta.dirname, '../agents/klaxon/Spawnfile'), 'utf8');
  assert.throws(() => validateAgentDeclaration('klaxon', scout.replace('mode: readonly', 'mode: mutable')), /public content resource/);
  const reporter = readFileSync(resolve(import.meta.dirname, '../agents/cogsworth/Spawnfile'), 'utf8');
  assert.throws(() => validateAgentDeclaration('cogsworth', reporter.replace('  resources:', '  resources:\n    - { id: private-corpus, kind: volume, name: clank-cogsworth-corpus, mount: ./private/corpus, mode: mutable, sharing: per_agent }')), /must not receive a private corpus/);
  const pressman = readFileSync(resolve(import.meta.dirname, '../agents/pressman/Spawnfile'), 'utf8');
  assert.throws(() => validateAgentDeclaration('pressman', pressman.replace('mode: mutable', 'mode: readonly')), /public content resource/);
  assert.throws(() => validateAgentDeclaration('pressman', pressman.replace('kind: volume', 'kind: git').replace('name: clank-release-staging, ', 'url: https://github.com/apresmoi/clankandslop.git, branch: staging, ')), /public content resource/);
});
test('Pressman implementation contains no network publisher, push, credential, or process execution path', () => { const source=readFileSync(resolve(import.meta.dirname,'newsroom.mjs'),'utf8'); assert.doesNotMatch(source,/child_process|execFile|spawn\(|fetch\(|https?:|git\s+push|credential|token/i); });
test('production roles declare exact newsroom tools and editorial skill closure',()=>{const expected={klaxon:['qualify_signal'],brass:['record_assignment'],cogsworth:['file_article'],sprockett:['file_article'],foreman:['file_article'],graves:['file_article'],tinkerton:['file_article'],vesta:['file_article'],spike:['review_article'],ledger:['file_desk'],caslon:['file_desk','compose_edition'],pressman:['stage_release']};const reporterSkills=['article-composition','record-grounding','repository-ownership'];for(const[agent,tools]of Object.entries(expected)){const source=readFileSync(resolve(import.meta.dirname,`../agents/${agent}/Spawnfile`),'utf8');assert.match(source,/environment:\n  mcp_servers:/u);assert.match(source,/transport: stdio/u);assert.match(source,/command: \/usr\/local\/bin\/node/u);for(const tool of tools)assert.match(source,new RegExp(`tools: \\[[^\\]]*${tool}`,'u'));if(['cogsworth','sprockett','foreman','graves','tinkerton','vesta'].includes(agent))for(const skill of reporterSkills)assert.match(source,new RegExp(`skills/${skill}`,'u'));assert.doesNotMatch(source,/clankandslop-private|deep-research|ChatGPT|Grok\.com/u);}});
test('production instructions require natural-language handoffs and stay free of read-before-acting mandates',()=>{const team=readFileSync(resolve(import.meta.dirname,'../TEAM.md'),'utf8');for(const phrase of ['natural-language','at least five articles','content/editions/<date>/{articles,desk,pages,maps}','never pushes Git'])assert.ok(team.includes(phrase));assert.doesNotMatch(team,/by path — never search for them/u);});
test('production declarations consume only checksum-pinned offline newsroom bundles',()=>{const descriptor=JSON.parse(readFileSync(resolve(import.meta.dirname,'../newsroom-runtime-bundle.json'),'utf8'));for(const agent of agents){const source=readFileSync(resolve(import.meta.dirname,`../agents/${agent}/Spawnfile`),'utf8');assert.ok(source.includes(`sha256: ${descriptor.source.sha256}`));assert.doesNotMatch(source,/kind: git|github\.com\/apresmoi\/clankandslop|branch: staging/u);}const pressman=readFileSync(resolve(import.meta.dirname,'../agents/pressman/Spawnfile'),'utf8');for(const dependency of [...descriptor.dependencies,...descriptor.assets]){assert.ok(pressman.includes(`sha256: ${dependency.sha256}`));assert.ok(pressman.includes(`mount: ./${dependency.mount}`));}assert.match(pressman,/CLANK_WEBSITE_DEPS_ROOTS: .*deps-a:.*deps-b/u);});
test('lifecycle schema is closed and covers every autonomous terminal', () => { const schema=JSON.parse(readFileSync(resolve(import.meta.dirname,'../schemas/lifecycle-receipt.schema.json'),'utf8')); assert.equal(schema.additionalProperties,false); assert.deepEqual(schema.properties.kind.enum,['readiness','blocker','finalization','released','staged']); });
test('receipt-ref JSON Schema and runtime reject the same hostile components',()=>{const schema=JSON.parse(readFileSync(resolve(import.meta.dirname,'../schemas/lifecycle-receipt.schema.json'),'utf8'));const pattern=new RegExp(schema.properties.receipt_ref.pattern);const source=JSON.parse(readFileSync(resolve(import.meta.dirname,'../fixtures/lifecycle-receipts.json'),'utf8')).receipts;assert.equal(pattern.test('state/edition/receipts/lower-case_1.0/file.json'),true);for(const ref of ['state/edition/receipts/has space','state/edition/receipts/Upper','state/edition/receipts/back\\slash','state/edition/receipts/é','state/edition/receipts/../bad','state/edition/receipts//bad','state/edition/receipts/bad/','state/edition/receipts/./bad']){assert.equal(pattern.test(ref),false,ref);const changed=structuredClone(source);changed[1].receipt_ref=ref;assert.throws(()=>validateLifecycle(changed),/reference/);}});
test('Vesta and DATA boundary mutations fail closed',()=>{const vesta=readFileSync(resolve(import.meta.dirname,'../agents/vesta/AGENTS.md'),'utf8');const data=readFileSync(resolve(import.meta.dirname,'../DATA.md'),'utf8');const voices=JSON.parse(readFileSync(resolve(import.meta.dirname,'../fixtures/voice-boundaries.json'),'utf8'));assert.doesNotThrow(()=>validateEditorialContracts(vesta,data,voices));for(const phrase of ['ordinary Record','boring null','observable falsifier','hidden hands','default-spike'])assert.throws(()=>validateEditorialContracts(vesta.replaceAll(phrase,'removed'),data,voices),/Vesta constraint/);assert.throws(()=>validateEditorialContracts(vesta,data.replace('public content: read-only','public content: mutable'),voices),/DATA boundary/);const forged=structuredClone(voices);forged.vesta.bad='A fine pattern.';assert.throws(()=>validateEditorialContracts(vesta,data,forged),/Vesta voice/);});
test('root declaration keeps Moltnet durable, authenticated, direct and secret-backed', () => {
  const root = readFileSync(resolve(import.meta.dirname, '../Spawnfile'), 'utf8');
  assert.doesNotThrow(() => validateRootDeclaration(root));
  assert.throws(() => validateRootDeclaration(root.replace('        mode: bearer', '        mode: none')), /bearer admission/);
  assert.throws(() => validateRootDeclaration(root.replace('        kind: sqlite', '        kind: memory')), /durable store/);
  assert.throws(() => validateRootDeclaration(root.replace('secret: CLANK_MOLTNET_OPERATOR_TOKEN', 'value: hardcoded-relay-token')), /token reference|token declaration/);
  assert.throws(() => validateRootDeclaration(root.replace('scopes: [attach, observe, write]', 'scopes: [attach, write]')), /Moltnet token boundary/);
  assert.throws(() => validateRootDeclaration(root.replace('scopes: [observe]', 'scopes: [observe, write]')), /observe-only console token/);
  assert.throws(() => validateRootDeclaration(root.replace('secret: CLANK_MOLTNET_RESEARCH_SENSOR_TOKEN', 'secret: CLANK_MOLTNET_GATHERER_TOKEN')), /research sensor token boundary/);
  assert.throws(() => validateRootDeclaration(root.replace('federation: none', 'federation: [legacy-peer]')), /cloud-local/);
  assert.throws(() => validateRootDeclaration(root.replace(', research-sensor, cogsworth', ', cogsworth')), /research sensor local identity/);
  assert.throws(() => validateRootDeclaration(root.replace('members: [gatherer, klaxon', 'members: [klaxon')), /assignment kickoff participant/);
});
test('runtime and provision fail closed', () => { assert.equal(checkRuntime({}).ok, false); assert.throws(() => provision({ edition: '2026-08-16', privateRoot: '/tmp/nope', env: {} }), /runtime admission denied/); });
test('runtime rejects a repository private root and shared isolation paths', () => { const bad = { CLANK_PRIVATE_ROOT: process.cwd(), CLANK_WORLD_SCOUT_HOME: process.cwd(), CLANK_KLAXON_HOME: process.cwd() }; assert.match(checkRuntime(bad).missing.join(','), /private-root|not-isolated/); });
test('runtime rejects a private root equal to the repository root', () => { const root = mkdtempSync(join(tmpdir(), 'clank-runtime-')); const env = admittedEnv(root); env.CLANK_PRIVATE_ROOT = resolve(import.meta.dirname, '../..'); assert.deepEqual(checkRuntime(env).missing, ['private-root']); });
test('runtime requires Moltnet readiness and declaration-derived secret references', () => { const root = mkdtempSync(join(tmpdir(), 'clank-runtime-')); const env = admittedEnv(root); delete env.CLANK_MOLTNET_READY; delete env.CLANK_MOLTNET_CONSOLE_TOKEN; delete env.CLANK_MOLTNET_RESEARCH_SENSOR_TOKEN; assert.deepEqual(checkRuntime(env).missing, ['moltnet', 'moltnet-secret:CLANK_MOLTNET_CONSOLE_TOKEN', 'moltnet-secret:CLANK_MOLTNET_RESEARCH_SENSOR_TOKEN']); });
test('provision is dry by default', () => { const root = mkdtempSync(join(tmpdir(), 'clank-private-')); const env = admittedEnv(root); const result = provision({ edition: '2026-08-16', privateRoot: root, env }); assert.equal(result.dryRun, true); assert.equal(existsSync(join(root, '2026-08-16')), false); });
