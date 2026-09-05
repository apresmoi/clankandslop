import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkRuntime } from './check-runtime.mjs';
import { provision } from './provision.mjs';
import { agents, declaredMoltnetSecretRefs, declaredRequiredAgentSecretRefs } from './lib.mjs';
import { PUBLISHER_SECRETS, PUBLISHER_TOOLS, declaredAgentSecretRefs, engineByAgent, validateAgentDeclaration, validatePublisherSurface, validateEditorialContracts, validateFixtures, validateLifecycle, validateMessage, validateRootDeclaration, validateRuntimeBindings, validateSchedule } from './validate-org.mjs';

const messages = () => JSON.parse(readFileSync(new URL('../fixtures/daily-cycle.json', import.meta.url), 'utf8')).messages;
const validate = (items) => { const prior = []; for (const item of items) { validateMessage(item, prior); prior.push(item); } };
const admittedEnv = (root) => {
  const env = { CLANK_PRIVATE_ROOT: root, CLANK_BROKER_READY: 'yes', CLANK_MOLTNET_READY: 'yes', CLANK_NETWORK_POLICY_READY: 'yes', CLANK_GIT_POLICY_READY: 'yes' };
  for (const secretRef of [...declaredMoltnetSecretRefs, ...declaredRequiredAgentSecretRefs]) env[secretRef] = 'opaque';
  for (const agent of ['WORLD_SCOUT','KLAXON','FRONTIER','CLOSURE','COGSWORTH','SPROCKETT','FOREMAN','GRAVES','TINKERTON','VESTA','BRASS','SPIKE','LEDGER','CASLON','MORGUE','PRESSMAN']) { for (const part of ['HOME','XDG','WORKSPACE']) { const path = join(root, agent, part); mkdirSync(path, { recursive: true }); env[`CLANK_${agent}_${part}`] = path; } env[`CLANK_${agent}_CLI_LOGIN`] = 'opaque'; }
  return env;
};

// Writes one agent's Spawnfile into a throwaway org root so a declaration
// mutation can be validated without touching the real tree.
const mutatedOrg = (agent, mutate) => {
  const root = mkdtempSync(join(tmpdir(), 'clank-org-'));
  for (const name of agents) {
    mkdirSync(join(root, 'agents', name), { recursive: true });
    const source = readFileSync(resolve(import.meta.dirname, `../agents/${name}/Spawnfile`), 'utf8');
    writeFileSync(join(root, 'agents', name, 'Spawnfile'), name === agent ? mutate(source) : source);
  }
  return root;
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
  // try/finally throughout: an assertion that fails here must not leave a
  // mutated declaration behind for every later test and run to trip over.
  writeFileSync(schedulePath,original.replace('"operator_kickoff": false','"operator_kickoff": true'));
  try { assert.throws(validateSchedule,/operator kickoff/); } finally { writeFileSync(schedulePath,original); }
  const klaxonPath=resolve(import.meta.dirname,'../agents/klaxon/Spawnfile'); const klaxon=readFileSync(klaxonPath,'utf8');
  writeFileSync(klaxonPath,klaxon.replace('wake: all, allowed_wake_senders: [research-sensor]','wake: all'));
  try { assert.throws(validateSchedule,/Klaxon selective/); } finally { writeFileSync(klaxonPath,klaxon); }
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
test('production roles declare exact newsroom tools and carry the folded editorial rules',()=>{const expected={klaxon:['qualify_signal'],brass:['record_assignment'],cogsworth:['file_article'],sprockett:['file_article'],foreman:['file_article'],graves:['file_article'],tinkerton:['file_article'],vesta:['file_article'],spike:['review_article'],ledger:['file_desk'],caslon:['file_desk','compose_edition'],pressman:['stage_release','push_edition']};// Skill documents are gone: six reporters used to `cat` two or three
// identical SKILL.md files at the top of every wake. Their content now
// lives in AGENTS.md, which Codex loads into the prefix natively, so the
// closure to hold is the opposite one — no agent declares a skill, and the
// editorial constraints those skills carried are in the reporter's own doc.
const foldedIntoAgentsMd=['a reporter alone revises its article','never fabricate provenance','six to eight flowing paragraphs'];for(const[agent,tools]of Object.entries(expected)){const source=readFileSync(resolve(import.meta.dirname,`../agents/${agent}/Spawnfile`),'utf8');assert.match(source,/environment:\n  mcp_servers:/u);assert.match(source,/transport: stdio/u);assert.match(source,/command: \/usr\/local\/bin\/node/u);for(const tool of tools)assert.match(source,new RegExp(`tools: \\[[^\\]]*${tool}`,'u'));assert.doesNotMatch(source,/^  skills:/mu,`${agent} must not declare a skill document`);assert.doesNotMatch(source,/SKILL\.md/u);const doc=readFileSync(resolve(import.meta.dirname,`../agents/${agent}/AGENTS.md`),'utf8').replace(/\s+/gu,' ').toLowerCase();if(['cogsworth','sprockett','foreman','graves','tinkerton','vesta'].includes(agent))for(const phrase of foldedIntoAgentsMd)assert.ok(doc.includes(phrase),`${agent} AGENTS.md lost the folded skill rule: ${phrase}`);assert.doesNotMatch(source,/clankandslop-private|deep-research|ChatGPT|Grok\.com/u);}});
test('production instructions require natural-language handoffs and stay free of read-before-acting mandates',()=>{const team=readFileSync(resolve(import.meta.dirname,'../TEAM.md'),'utf8');for(const phrase of ['natural-language','at least five articles','content/editions/<date>/{articles,desk,pages,maps}','never reaches `main`','never force-pushes','never deletes a remote ref','never merges','A deploy key can push Git and cannot open a pull request'])assert.ok(team.includes(phrase));assert.doesNotMatch(team,/by path — never search for them/u);});
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
  assert.throws(() => validateRootDeclaration(root.replace('federation: [clank-observer]', 'federation: [legacy-peer]')), /federate only to the read-only clank-observer pairing/);
  assert.throws(() => validateRootDeclaration(root.replace(', research-sensor, cogsworth', ', cogsworth')), /research sensor local identity/);
  assert.throws(() => validateRootDeclaration(root.replace('members: [gatherer, klaxon', 'members: [klaxon')), /assignment kickoff participant/);
});
test('the observer pairing relaxation still forbids everything else', () => {
  const root = readFileSync(resolve(import.meta.dirname, '../Spawnfile'), 'utf8');
  const pairing = '        - id: clank-observer';
  assert.doesNotThrow(() => validateRootDeclaration(root));
  // A second pairing — even a well-formed one — reintroduces the federation
  // dependency the policy exists to prevent.
  const second = root.replace(pairing, [
    '        - id: rogue-peer',
    '          remote_network_id: rogue-peer',
    '          remote_network_name: Rogue Peer',
    '          token_secret: CLANK_MOLTNET_PAIR_ROGUE_TOKEN',
    '          relay: { url: "wss://rogue.invalid", room: rogue-room, token_secret: CLANK_MOLTNET_RELAY_ROGUE_TOKEN }',
    pairing
  ].join('\n'));
  assert.throws(() => validateRootDeclaration(second), /exactly one read-only observer pairing/);
  // federation: all would silently widen every future pairing -- on one room or all six.
  assert.throws(() => validateRootDeclaration(root.replaceAll('federation: [clank-observer]', 'federation: all')), /federate only to the read-only clank-observer pairing/);
  // Per-room coverage: no room -- conference included -- may be quietly pointed at
  // a pairing this server does not declare, or opened up with `all`.
  for (const room of ['conference', 'assignment', 'filing', 'sensor', 'research', 'release']) {
    const prefix = `id: ${room}, visibility: private, write_policy: members, federation: `;
    assert.ok(root.includes(`${prefix}[clank-observer]`), `${room} is not federated to the observer`);
    assert.throws(() => validateRootDeclaration(root.replace(`${prefix}[clank-observer]`, `${prefix}[rogue-peer]`)), /federate only to the read-only clank-observer pairing/, room);
    assert.throws(() => validateRootDeclaration(root.replace(`${prefix}[clank-observer]`, `${prefix}[clank-observer, rogue-peer]`)), /federate only to the read-only clank-observer pairing/, room);
    assert.throws(() => validateRootDeclaration(root.replace(`${prefix}[clank-observer]`, `${prefix}all`)), /federate only to the read-only clank-observer pairing/, room);
  }
  // The inbound pair credential must stay agent-free, pair-only, and bound to the pairing secret.
  assert.throws(() => validateRootDeclaration(root.replace('{ id: clank-observer, secret: CLANK_MOLTNET_PAIR_OBSERVER_TOKEN, scopes: [pair] }', '{ id: clank-observer, secret: CLANK_MOLTNET_PAIR_OBSERVER_TOKEN, scopes: [pair], agents: [brass] }')), /pair-scoped, agent-free/);
  assert.throws(() => validateRootDeclaration(root.replace('scopes: [pair] }', 'scopes: [pair, admin] }')), /pair-scoped, agent-free/);
  assert.throws(() => validateRootDeclaration(root.replace('- { id: clank-observer, secret: CLANK_MOLTNET_PAIR_OBSERVER_TOKEN, scopes: [pair] }\n', '')), /pair-scoped, agent-free|token declaration/);
  // Pairing identity and transport must keep pointing at the paired laptop.
  assert.throws(() => validateRootDeclaration(root.replace('remote_network_id: clank-observer', 'remote_network_id: clank-newsroom')), /observer pairing identity invalid/);
  assert.throws(() => validateRootDeclaration(root.replace('room: VdoP-HC5isGQksHo5dYpnQ', 'room: some-other-room')), /paired laptop coordinates/);
  assert.throws(() => validateRootDeclaration(root.replace('          relay: { url: "wss://moltnet-relay.alicenet.workers.dev", room: VdoP-HC5isGQksHo5dYpnQ, token_secret: CLANK_MOLTNET_RELAY_OBSERVER_TOKEN }', '          remote_base_url: https://observer.invalid')), /inbound base url|inbound federation peer/);
  // Secrets stay references: a literal token value in the declaration fails.
  assert.throws(() => validateRootDeclaration(root.replace('token_secret: CLANK_MOLTNET_PAIR_OBSERVER_TOKEN', 'token: an-actual-secret-value')), /secret references only|pairing identity/);
});
test('runtime and provision fail closed', () => { assert.equal(checkRuntime({}).ok, false); assert.throws(() => provision({ edition: '2026-08-16', privateRoot: '/tmp/nope', env: {} }), /runtime admission denied/); });
test('runtime rejects a repository private root and shared isolation paths', () => { const bad = { CLANK_PRIVATE_ROOT: process.cwd(), CLANK_WORLD_SCOUT_HOME: process.cwd(), CLANK_KLAXON_HOME: process.cwd() }; assert.match(checkRuntime(bad).missing.join(','), /private-root|not-isolated/); });
test('runtime rejects a private root equal to the repository root', () => { const root = mkdtempSync(join(tmpdir(), 'clank-runtime-')); const env = admittedEnv(root); env.CLANK_PRIVATE_ROOT = resolve(import.meta.dirname, '../..'); assert.deepEqual(checkRuntime(env).missing, ['private-root']); });
test('runtime requires Moltnet readiness and declaration-derived secret references', () => { const root = mkdtempSync(join(tmpdir(), 'clank-runtime-')); const env = admittedEnv(root); delete env.CLANK_MOLTNET_READY; delete env.CLANK_MOLTNET_CONSOLE_TOKEN; delete env.CLANK_MOLTNET_RESEARCH_SENSOR_TOKEN; assert.deepEqual(checkRuntime(env).missing, ['moltnet', 'moltnet-secret:CLANK_MOLTNET_CONSOLE_TOKEN', 'moltnet-secret:CLANK_MOLTNET_RESEARCH_SENSOR_TOKEN']); });
test('provision is dry by default', () => { const root = mkdtempSync(join(tmpdir(), 'clank-private-')); const env = admittedEnv(root); const result = provision({ edition: '2026-08-16', privateRoot: root, env }); assert.equal(result.dryRun, true); assert.equal(existsSync(join(root, '2026-08-16')), false); });

test('the publisher declares a branch push, deploy keys by name, and nothing that reaches main', () => {
  const pressman = readFileSync(resolve(import.meta.dirname, '../agents/pressman/Spawnfile'), 'utf8');
  assert.doesNotThrow(() => validatePublisherSurface(pressman));
  assert.deepEqual(declaredAgentSecretRefs(pressman), [...PUBLISHER_SECRETS]);
  assert.deepEqual([...PUBLISHER_TOOLS], ['stage_release', 'push_edition']);
  // Losing the push tool, the key declaration, the binaries the push runs, or
  // the read-only key mount each has to fail on its own.
  assert.throws(() => validatePublisherSurface(pressman.replace('tools: [stage_release, push_edition]', 'tools: [stage_release]')), /exactly the release tools/u);
  assert.throws(() => validatePublisherSurface(pressman.replace('tools: [stage_release, push_edition]', 'tools: [stage_release, push_edition, compose_edition]')), /exactly the release tools/u);
  assert.throws(() => validatePublisherSurface(pressman.replace('    - { name: CLANK_DEPLOY_KEY_PUBLIC, required: true }\n', '')), /deploy key declaration/u);
  assert.throws(() => validatePublisherSurface(pressman.replace('- { id: openssh-client, manager: apt, name: openssh-client }', '')), /apt package openssh-client/u);
  assert.throws(() => validatePublisherSurface(pressman.replace('mount: ./secrets/ssh, mode: readonly', 'mount: ./secrets/ssh, mode: mutable')), /read-only per-agent volume/u);
  assert.throws(() => validatePublisherSurface(pressman.replace('{ id: deploy-keys,', '{ id: deploy-keys-renamed,')), /read-only per-agent volume/u);
  // A key value in the declaration, or a Git workspace resource, is the exact
  // shape this desk must never grow.
  assert.throws(() => validatePublisherSurface(pressman.replace('- { name: CLANK_DEPLOY_KEY_PUBLIC, required: true }', '- { name: CLANK_DEPLOY_KEY_PUBLIC, required: true }\n    # -----BEGIN OPENSSH PRIVATE KEY-----')), /never key material/u);
  assert.throws(() => validatePublisherSurface(pressman.replace('{ id: deploy-keys, kind: volume', '{ id: deploy-keys, kind: git, url: https://example.invalid/x.git, branch: main, x: volume')), /read-only per-agent volume|Git workspace resource/u);
});

test('no agent but the publisher can reach the branch push or a deploy key', () => {
  for (const agent of agents.filter((name) => name !== 'pressman')) {
    const source = readFileSync(resolve(import.meta.dirname, `../agents/${agent}/Spawnfile`), 'utf8');
    assert.doesNotMatch(source, /push_edition|CLANK_DEPLOY_KEY/u, agent);
  }
  assert.throws(() => validateRuntimeBindings(mutatedOrg('ledger', (source) => source.replace('tools: [file_desk]', 'tools: [file_desk, push_edition]'))), /must not reach the publisher/u);
});

test('every scheduled checkpoint owner carries a schedule that actually fires', () => {
  assert.doesNotThrow(validateSchedule);
  const owners = JSON.parse(readFileSync(resolve(import.meta.dirname, '../policies/schedule.json'), 'utf8')).spawnfile_schedule.owners;
  // Both publishing desks described a daily slot in prose and had no schedule
  // wiring at all, so neither had ever run on its own. This is the check.
  for (const [agent, cron] of Object.entries({ ledger: '0 14 * * *', pressman: '0 16 * * *' })) {
    assert.equal(owners[agent], cron, agent);
    const source = readFileSync(resolve(import.meta.dirname, `../agents/${agent}/Spawnfile`), 'utf8');
    assert.ok(source.startsWith(`schedule:\n  kind: cron\n  cron: "${cron}"\n  timezone: Europe/Berlin\n  jitter_seconds: 900\n  prompt: `, source.indexOf('schedule:\n')) && /^schedule:$/mu.test(source), agent);
  }
});

test('removing either publishing desk schedule fails closed', () => {
  const schedulePath = resolve(import.meta.dirname, '../policies/schedule.json');
  const original = readFileSync(schedulePath, 'utf8');
  for (const agent of ['ledger', 'pressman']) {
    const agentPath = resolve(import.meta.dirname, `../agents/${agent}/Spawnfile`);
    const source = readFileSync(agentPath, 'utf8');
    const start = source.indexOf('schedule:\n'), end = source.indexOf('\nsurfaces:\n') + 1;
    writeFileSync(agentPath, source.slice(0, start) + source.slice(end));
    try { assert.throws(validateSchedule, /schedule authority invalid/u, agent); } finally { writeFileSync(agentPath, source); }
    // And the reverse: dropping it from the roster while the Spawnfile keeps it.
    writeFileSync(schedulePath, original.replace(new RegExp(`\\s*"${agent}": "[^"]+",?`, 'u'), '').replace(',\n    }', '\n    }'));
    try { assert.throws(validateSchedule, /schedule roster invalid|schedule authority invalid|checkpoint with no schedule/u, agent); } finally { writeFileSync(schedulePath, original); }
  }
});
