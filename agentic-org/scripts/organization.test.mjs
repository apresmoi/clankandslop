import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkRuntime } from './check-runtime.mjs';
import { provision } from './provision.mjs';
import { engineByAgent, validateFixtures, validateMessage, validateRuntimeBindings, validateSchedule } from './validate-org.mjs';

const messages = () => JSON.parse(readFileSync(new URL('../fixtures/daily-cycle.json', import.meta.url), 'utf8')).messages;
const validate = (items) => { const prior = []; for (const item of items) { validateMessage(item, prior); prior.push(item); } };

test('digest-linked reporter lifecycle accepts the fixture', () => assert.doesNotThrow(validateFixtures));
test('hostile envelope mutations reject for their intended reason', () => {
  const cases = [
    ['assigned recipient', 0, (m) => ({ ...m, recipient: 'frontier' }), /assignment recipient/],
    ['causal parent', 5, (m) => ({ ...m, causal_parent: 'assign-20260816' }), /parent transition/],
    ['edition', 5, (m) => ({ ...m, edition: '2026-08-17', release: '2026-08-17T16:20:00+02:00[Europe/Berlin]' }), /lifecycle identity/],
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
test('one operator kickoff replaces every agent schedule', () => assert.doesNotThrow(validateSchedule));
test('actual agent Spawnfile bytes select the assigned Daimon CLI engines', () => {
  assert.doesNotThrow(validateRuntimeBindings);
  assert.deepEqual(engineByAgent, {
    'world-scout': 'grok', klaxon: 'grok', frontier: 'grok', closure: 'grok', cogsworth: 'grok', sprockett: 'grok', foreman: 'grok', graves: 'grok', tinkerton: 'grok', vesta: 'grok',
    brass: 'codex', spike: 'codex', ledger: 'codex', caslon: 'codex', morgue: 'codex', pressman: 'codex'
  });
  const root = mkdtempSync(join(tmpdir(), 'clank-runtime-bindings-'));
  mkdirSync(join(root, 'agents', 'world-scout'), { recursive: true });
  const source = readFileSync(resolve(import.meta.dirname, '../agents/world-scout/Spawnfile'), 'utf8');
  writeFileSync(join(root, 'agents', 'world-scout', 'Spawnfile'), source.replace('engine: grok', 'engine: agy'));
  assert.throws(() => validateRuntimeBindings(root), /world-scout runtime engine declaration invalid/);
  writeFileSync(join(root, 'agents', 'world-scout', 'Spawnfile'), source.replace('execution:', 'policy: { mode: strict, on_degrade: error }\nexecution:'));
  assert.throws(() => validateRuntimeBindings(root), /world-scout must not override Spawnfile policy/);
});
test('runtime and provision fail closed', () => { assert.equal(checkRuntime({}).ok, false); assert.throws(() => provision({ edition: '2026-08-16', privateRoot: '/tmp/nope', env: {} }), /runtime admission denied/); });
test('runtime rejects a repository private root and shared isolation paths', () => { const bad = { CLANK_PRIVATE_ROOT: process.cwd(), CLANK_WORLD_SCOUT_HOME: process.cwd(), CLANK_KLAXON_HOME: process.cwd() }; assert.match(checkRuntime(bad).missing.join(','), /private-root|not-isolated/); });
test('runtime rejects a private root equal to the repository root', () => { const root = mkdtempSync(join(tmpdir(), 'clank-runtime-')); const env = { CLANK_PRIVATE_ROOT: resolve(import.meta.dirname, '../..'), CLANK_BROKER_READY: 'yes', CLANK_MOLTNET_READY: 'yes', CLANK_NETWORK_POLICY_READY: 'yes', CLANK_GIT_POLICY_READY: 'yes' }; for (const agent of ['WORLD_SCOUT','KLAXON','FRONTIER','CLOSURE','COGSWORTH','SPROCKETT','FOREMAN','GRAVES','TINKERTON','VESTA','BRASS','SPIKE','LEDGER','CASLON','MORGUE','PRESSMAN']) { for (const part of ['HOME','XDG','WORKSPACE']) { const path = join(root, agent, part); mkdirSync(path, { recursive: true }); env[`CLANK_${agent}_${part}`] = path; } env[`CLANK_${agent}_CLI_LOGIN`] = 'opaque'; } assert.deepEqual(checkRuntime(env).missing, ['private-root']); });
test('provision is dry by default', () => { const root = mkdtempSync(join(tmpdir(), 'clank-private-')); const env = { CLANK_PRIVATE_ROOT: root, CLANK_BROKER_READY: 'yes', CLANK_MOLTNET_READY: 'yes', CLANK_NETWORK_POLICY_READY: 'yes', CLANK_GIT_POLICY_READY: 'yes' }; for (const agent of ['WORLD_SCOUT','KLAXON','FRONTIER','CLOSURE','COGSWORTH','SPROCKETT','FOREMAN','GRAVES','TINKERTON','VESTA','BRASS','SPIKE','LEDGER','CASLON','MORGUE','PRESSMAN']) { for (const part of ['HOME','XDG','WORKSPACE']) { const path = join(root, agent, part); mkdirSync(path, { recursive: true }); env[`CLANK_${agent}_${part}`] = path; } env[`CLANK_${agent}_CLI_LOGIN`] = 'opaque'; } const result = provision({ edition: '2026-08-16', privateRoot: root, env }); assert.equal(result.dryRun, true); assert.equal(existsSync(join(root, '2026-08-16')), false); });
