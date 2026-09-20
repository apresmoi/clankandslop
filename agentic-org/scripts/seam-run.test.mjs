import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_REPO, KNOWN_UNDESCRIBED, SeamError, TAG_PREFIX, berlinToday, deploymentCommand, parseArgs, pinFindings, reclaimBuildSpace, runtimeBootstrap, runtimePolicy, seam, settle, sweepImages } from './seam-run.mjs';
import { DAIMON_RUNTIME_CONFIG, DAIMON_UID_ENTRYPOINT, GROK_BROKER } from './engine-policy.mjs';

const now = new Date('2026-09-06T07:00:00Z');
const noop = () => {};
const repoRoot = path.resolve(import.meta.dirname, '..', '..');

// A recorder for the stage sequence. Every stage is a no-op that writes its own
// name down, so a test can assert the ORDER as well as the membership.
function recorder(failAt, error = new SeamError('boom', 'deploy-failed')) {
  const calls = [];
  const stage = (name) => (options) => { calls.push(name); if (name === failAt) throw error; return options; };
  return { calls, impl: Object.fromEntries(['gate', 'repin', 'bundle', 'reclaimBuildSpace', 'build', 'runtimePolicy', 'deploy', 'settle', 'runtimeBootstrap', 'sweepImages'].map((name) => [name, stage(name)])) };
}
const alarms = () => { const raised = []; return { raised, alarm: (reason, detail) => raised.push({ reason, ...detail }) }; };

test('the repin runs BEFORE the bundle, always', () => {
  // check-bundle-descriptor --repin-source locates Spawnfile pins by searching
  // for the descriptor's current digest, so a bundle build that ran first would
  // advance the descriptor and leave the repin nothing to match. And repinning
  // rewrites a tracked file, so the source tar must be rebuilt after it.
  const { calls, impl } = recorder(null);
  const result = seam([], { now, log: noop, stageImpl: impl, alarm: noop });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['gate', 'repin', 'bundle', 'reclaimBuildSpace', 'build', 'runtimePolicy', 'deploy', 'settle', 'runtimeBootstrap', 'sweepImages']);
  assert.ok(calls.indexOf('repin') < calls.indexOf('bundle'));
});

test('the gate runs first, and a blocked gate stops before anything is written', () => {
  const { calls, impl } = recorder('gate', new SeamError('an agent is awake', 'seam-blocked'));
  const { raised, alarm } = alarms();
  const result = seam([], { now, log: noop, stageImpl: impl, alarm });
  assert.deepEqual(calls, ['gate']);
  assert.equal(result.ok, false);
  assert.deepEqual(raised.map((entry) => entry.reason), ['seam-blocked']);
});

test('check mode stops after the bundle check and never builds or deploys', () => {
  const { calls, impl } = recorder(null);
  const result = seam(['--check'], { now, log: noop, stageImpl: impl, alarm: noop });
  assert.deepEqual(calls, ['gate', 'repin', 'bundle']);
  assert.equal(result.ok, true);
  assert.equal(result.deploy, false);
});

test('no-deploy builds the image and stops before `up`', () => {
  const { calls, impl } = recorder(null);
  seam(['--no-deploy'], { now, log: noop, stageImpl: impl, alarm: noop });
  assert.deepEqual(calls, ['gate', 'repin', 'bundle', 'reclaimBuildSpace', 'build', 'runtimePolicy']);
});

test('compiled Codex policy admission runs after build and before deploy', () => {
  const { calls, impl } = recorder(null);
  seam([], { now, log: noop, stageImpl: impl, alarm: noop });
  assert.ok(calls.indexOf('build') < calls.indexOf('runtimePolicy'));
  assert.ok(calls.indexOf('runtimePolicy') < calls.indexOf('deploy'));
});

test('compiled policy admission rejection stops before provider spawn', () => {
  const { calls, impl } = recorder('runtimePolicy', new SeamError('missing strict policy', 'deploy-failed'));
  const { alarm } = alarms();
  const result = seam([], { now, log: noop, stageImpl: impl, alarm });
  assert.equal(result.ok, false);
  assert.deepEqual(calls, ['gate', 'repin', 'bundle', 'reclaimBuildSpace', 'build', 'runtimePolicy']);
  assert.ok(!calls.includes('deploy'));
});

test('compiled policy admission accepts generated strict config and rejects weak or missing policy', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clank-policy-test-'));
  const file = path.join(root, DAIMON_RUNTIME_CONFIG);
  const write = (engine) => writeFileSync(file, JSON.stringify({ agents: [{ id: 'pressman', engine }] }));
  try {
    write({ kind: 'codex', codexSandbox: { mode: 'workspace-write', networkAccess: false, webSearch: 'disabled' } });
    assert.equal(runtimePolicy({ compiledOutput: root }, { log: noop }).checked, 1);
    write({ kind: 'codex' });
    assert.throws(() => runtimePolicy({ compiledOutput: root }, { log: noop }), /missing strict Codex policy/u);
    write({ kind: 'codex', codexSandbox: { mode: 'workspace-write', networkAccess: true, webSearch: 'disabled' } });
    assert.throws(() => runtimePolicy({ compiledOutput: root }, { log: noop }), /missing strict Codex policy/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A Grok-only organization — what the newsroom now compiles to. The old stage
// refused this outright ("compiled organization has no Codex agents"); what it
// has to do instead is check the confinement Grok actually has, which lives in
// the rendered broker provisioning rather than on the agent.
// Shaped like real compiler output: each worker's config.toml and sandbox.toml
// arrive as JSON string values inside `grokWorkers`, escaped, which is why the
// policy reads the parsed structure rather than the script text.
const GROK_WORKER = {
  agentId: 'agent:brass', uid: 2200, slot: 0, model: 'grok-4.6', reasoningEffort: 'low',
  config: `[model.daimon-broker-grok]\nmodel = "grok-4.6"\nbase_url = "${GROK_BROKER.providerProxy}"\nsupports_backend_search = false\nweb_fetch = false\n`,
  profile: '[profiles.daimon-strict]\nextends = "strict"\nrestrict_network = true\ndeny = []\n'
};
const grokEntrypoint = (worker = GROK_WORKER) => [
  `const grokWorkers = ${JSON.stringify([worker])};`,
  `const service = {"version":"${GROK_BROKER.serviceVersionPrefix}2","registrations":[{"agentId":"agent:brass","slot":0,"workerUid":2200,"profileSha256":"${'a'.repeat(64)}","model":{"id":"grok-4.6","reasoningEffort":"low"}}]};`,
  `const providerProxy = '${GROK_BROKER.providerProxy}';`
].join('\n') + '\n';
const GROK_ENTRYPOINT = grokEntrypoint();

test('a Grok-only organization is admitted on its broker confinement, and refused without it', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clank-grok-policy-'));
  const rootfs = path.join(root, 'container', 'rootfs', 'opt', 'spawnfile');
  mkdirSync(rootfs, { recursive: true });
  const config = path.join(root, DAIMON_RUNTIME_CONFIG);
  const entrypoint = path.join(rootfs, DAIMON_UID_ENTRYPOINT);
  const write = (engine) => writeFileSync(config, JSON.stringify({ agents: [{ id: 'agent:brass', engine }] }));
  try {
    write({ kind: 'grok', model: 'grok-4.6', reasoningEffort: 'low' });
    writeFileSync(entrypoint, GROK_ENTRYPOINT);
    assert.deepEqual(runtimePolicy({ compiledOutput: root }, { log: noop }).engines, { grok: 1 });

    // The network restriction, the search restriction and the model/effort pin,
    // one at a time — the three things the Codex check asserted directly.
    writeFileSync(entrypoint, grokEntrypoint({ ...GROK_WORKER, profile: GROK_WORKER.profile.replace('restrict_network = true', 'restrict_network = false') }));
    assert.throws(() => runtimePolicy({ compiledOutput: root }, { log: noop }), /networkAccess:false/u);
    writeFileSync(entrypoint, grokEntrypoint({ ...GROK_WORKER, config: GROK_WORKER.config.replace('supports_backend_search = false', 'supports_backend_search = true') }));
    assert.throws(() => runtimePolicy({ compiledOutput: root }, { log: noop }), /webSearch:disabled/u);
    writeFileSync(entrypoint, GROK_ENTRYPOINT);
    write({ kind: 'grok', model: 'grok-4.6', reasoningEffort: 'high' });
    assert.throws(() => runtimePolicy({ compiledOutput: root }, { log: noop }), /does not pin grok-4\.6\/high/u);

    // No entrypoint at all is the case that must never read as a pass: an
    // unverifiable confinement is not an exempt one.
    write({ kind: 'grok', model: 'grok-4.6', reasoningEffort: 'low' });
    rmSync(entrypoint);
    assert.throws(() => runtimePolicy({ compiledOutput: root }, { log: noop }), /no daimon-uid-entrypoint\.sh/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an engine the job has no policy for stops the deploy instead of being skipped', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clank-engine-policy-'));
  const file = path.join(root, DAIMON_RUNTIME_CONFIG);
  try {
    writeFileSync(file, JSON.stringify({ agents: [{ id: 'agent:klaxon', engine: { kind: 'agy' } }] }));
    assert.throws(() => runtimePolicy({ compiledOutput: root }, { log: noop }), /has no deploy-time policy equivalent/u);
    writeFileSync(file, JSON.stringify({ agents: [] }));
    assert.throws(() => runtimePolicy({ compiledOutput: root }, { log: noop }), /matched nothing, which is not the same as passing/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('each stage raises its own alarm reason, so the message says what broke', () => {
  const expected = { repin: 'repin-failed', bundle: 'bundle-mismatch', build: 'deploy-failed', runtimePolicy: 'deploy-failed', deploy: 'deploy-failed', settle: 'deploy-failed', runtimeBootstrap: 'deploy-failed' };
  for (const [stage, reason] of Object.entries(expected)) {
    const { impl } = recorder(stage, new SeamError(`${stage} exploded`, reason));
    const { raised, alarm } = alarms();
    const result = seam([], { now, log: noop, stageImpl: impl, alarm });
    assert.equal(result.ok, false, stage);
    assert.equal(raised[0].reason, reason, stage);
    assert.equal(raised[0].edition, berlinToday(now));
  }
});

test('a stage that throws a plain Error still raises an alarm rather than dying silently', () => {
  const { impl } = recorder('build', new TypeError('undefined is not a function'));
  const { raised, alarm } = alarms();
  assert.equal(seam([], { now, log: noop, stageImpl: impl, alarm }).ok, false);
  assert.equal(raised.length, 1);
});

test('the defaults name the one build root the live deployment was built from', () => {
  // Durable volume names are derived from the Spawnfile path; building the same
  // tree from another directory mints new volumes and detaches every agent's
  // memory. A change here is a change to which volumes the org attaches.
  assert.equal(DEFAULT_REPO, '/root/work/clankandslop');
  const options = parseArgs([]);
  assert.equal(options.repo, '/root/work/clankandslop');
  assert.equal(options.deploy, true);
});

test('the edition and ref default to today in Berlin, and the ref is the edition branch', () => {
  const { impl } = recorder(null);
  const result = seam([], { now, log: noop, stageImpl: impl, alarm: noop });
  assert.equal(result.edition, '2026-09-06');
  assert.equal(result.ref, 'edition/2026-09-06');
  assert.ok(result.tag.startsWith(`${TAG_PREFIX}2026-09-06-`));
});

test('an unparseable edition or an unknown flag is refused before anything runs', () => {
  assert.throws(() => parseArgs(['--edition=yesterday']), SeamError);
  assert.throws(() => parseArgs(['--force']), SeamError);
});

test('settle refuses a container that is merely up, and accepts only a stable healthy one', () => {
  const script = (values) => { let index = 0; return () => ({ toString: () => values[Math.min(index++, values.length - 1)] }); };
  // "Up, health starting" is what a container looks like three seconds in. It
  // must never be reported as a successful deploy.
  assert.throws(() => settle({ container: 'c' }, { log: noop, rounds: 3, sleepSeconds: 0, exec: script(['running starting 0']) }), /never settled/u);
  // A crash loop reports `running` between restarts; the restart count moving
  // is what gives it away, so the status string must be identical twice.
  assert.throws(() => settle({ container: 'c' }, { log: noop, rounds: 4, sleepSeconds: 0, exec: script(['running healthy 1', 'running healthy 2', 'running healthy 3', 'running healthy 4']) }), /never settled/u);
  const good = settle({ container: 'c' }, { log: noop, rounds: 5, sleepSeconds: 0, exec: script(['running healthy 7']) });
  assert.deepEqual([good.settled, good.status], [true, 'running healthy 7']);
});

test('the image sweep only ever touches the seam s own tags, and never the one just deployed', () => {
  const removed = [];
  const exec = (_docker, args) => {
    if (args[0] === 'images') return { toString: () => [
      'clank-and-slop:seam-2026-09-06-090000\t2026-09-06 09:00:00', 'clank-and-slop:seam-2026-09-05-090000\t2026-09-05 09:00:00',
      'clank-and-slop:seam-2026-09-04-090000\t2026-09-04 09:00:00', 'clank-and-slop:seam-2026-09-03-090000\t2026-09-03 09:00:00',
      'clank-and-slop:seam-backup\t2026-09-01 01:00:00', 'clank-and-slop:seam-manual-test\t2026-09-01 00:00:00', 'clank-and-slop:local7\t2026-09-06 14:00:00', 'registry:2\t2026-09-01 00:00:00'
    ].join('\n') };
    removed.push(args[2]);
    return { toString: () => '' };
  };
  sweepImages({ tag: 'clank-and-slop:seam-2026-09-06-090000' }, { log: noop, exec });
  assert.deepEqual(removed, ['clank-and-slop:seam-2026-09-03-090000']);
  assert.ok(!removed.some((tag) => tag.includes('local7') || tag.includes('registry')));
});

// --- the pin check org:bundle cannot do for itself ---------------------------
// `check-bundle-descriptor.mjs` covers the source archive. The bundle build
// refreshes generated public asset pins, while the seam keeps dependency,
// private, and tool archive drift fail-closed against each Spawnfile pin.
const A = 'sha256:'.concat('a'.repeat(64));
const B = 'sha256:'.concat('b'.repeat(64));

function pinWorld(spawnfilePins, descriptor, sidecars = []) {
  const repo = mkdtempSync(path.join(tmpdir(), 'clank-pin-test-'));
  mkdirSync(path.join(repo, 'agentic-org', 'agents', 'cogsworth'), { recursive: true });
  writeFileSync(path.join(repo, 'agentic-org', 'newsroom-runtime-bundle.json'), JSON.stringify(descriptor));
  for (const [name, value] of sidecars) writeFileSync(path.join(repo, 'agentic-org', name), JSON.stringify(value));
  writeFileSync(path.join(repo, 'agentic-org', 'agents', 'cogsworth', 'Spawnfile'), spawnfilePins.join('\n'));
  return repo;
}
const line = (id, archive, sha) => `    - { id: ${id}, kind: bundle, source: ../../${archive}, sha256: ${sha}, mount: ./x, mode: readonly }`;
const descriptorOf = (source, dependency) => ({
  source: { archive: 'newsroom-runtime.tar', sha256: source },
  private: { archive: 'newsroom-private.tar', sha256: A },
  dependencies: [{ archive: 'newsroom-dependencies-a.tar', sha256: dependency }],
  assets: []
});
const toolsDescriptor = (sha256 = A) => ({ version: 'clank.newsroom-tools-bundle.v1', archive: 'newsroom-tools.tar', sha256 });
const articleValidationDescriptor = (sha256 = A) => ({ version: 'clank.article-validation-runtime-bundle.v1', archive: 'article-validation-runtime.tar', sha256 });
const bundlePinCount = () => readdirSync(path.join(repoRoot, 'agentic-org', 'agents'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .reduce((sum, agent) => sum + (readFileSync(path.join(repoRoot, 'agentic-org', 'agents', agent.name, 'Spawnfile'), 'utf8').match(/kind: bundle/gu)?.length ?? 0), 0);


test('the checked-in descriptors cover every checksum-pinned bundle across the actual agent Spawnfiles', () => {
  const result = pinFindings(repoRoot);
  assert.deepEqual(result.findings, []);
  assert.equal(result.checked, bundlePinCount());
  assert.equal(result.checked, 47);
  assert.ok(result.archives.includes('newsroom-tools.tar'));
  assert.ok(result.archives.includes('article-validation-runtime.tar'));
});

test('sidecar descriptor mismatches are findings for newsroom tools and article validation bundles', () => {
  const repo = pinWorld([
    line('newsroom-tools', 'newsroom-tools.tar', A),
    line('article-validation', 'article-validation-runtime.tar', A),
  ], descriptorOf(A, B), [
    ['newsroom-tools-bundle.json', toolsDescriptor(B)],
    ['article-validation-runtime-bundle.json', articleValidationDescriptor(B)],
  ]);
  try {
    const findings = pinFindings(repo).findings;
    assert.equal(findings.length, 2);
    assert.match(findings.join('\n'), /newsroom-tools\.tar/u);
    assert.match(findings.join('\n'), /article-validation-runtime\.tar/u);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('a Spawnfile pin that disagrees with the descriptor is a finding, for every archive', () => {
  const repo = pinWorld([line('public-content', 'newsroom-runtime.tar', A), line('deps-a', 'newsroom-dependencies-a.tar', A)], descriptorOf(A, B));
  try {
    const result = pinFindings(repo);
    assert.equal(result.checked, 2);
    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0], /newsroom-dependencies-a\.tar/u);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('matching pins produce no findings', () => {
  const repo = pinWorld([line('public-content', 'newsroom-runtime.tar', A), line('deps-a', 'newsroom-dependencies-a.tar', B)], descriptorOf(A, B));
  try { assert.deepEqual(pinFindings(repo).findings, []); } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('an archive the descriptor does not describe is a finding unless it is the known relief grid', () => {
  assert.deepEqual(KNOWN_UNDESCRIBED, ['etopo-relief.tar']);
  const known = pinWorld([line('etopo-relief', 'etopo-relief.tar', A)], descriptorOf(A, B));
  const unknown = pinWorld([line('mystery', 'somebody-elses.tar', A)], descriptorOf(A, B));
  try {
    assert.deepEqual(pinFindings(known).findings, []);
    assert.match(pinFindings(unknown).findings[0], /the descriptor does not describe/u);
  } finally { rmSync(known, { recursive: true, force: true }); rmSync(unknown, { recursive: true, force: true }); }
});

test('a pin check that matched nothing is a finding, not a pass', () => {
  // A regex that stops matching because the Spawnfile format moved would
  // otherwise report a clean bill of health over zero evidence.
  const repo = pinWorld(['agent: cogsworth', 'resources: []'], descriptorOf(A, B));
  try { assert.match(pinFindings(repo).findings[0], /matched nothing/u); } finally { rmSync(repo, { recursive: true, force: true }); }
});


test('deployment shell sets readable cwd and round-trips literal arguments without substitution', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clank-deploy-cwd-'));
  const cli = path.join(root, "a file's name.cjs");
  writeFileSync(cli, "console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));\n");
  const envFile = path.join(root, 'env file');
  writeFileSync(envFile, '');
  const args = { cli, tag: 'tag;$(touch unexpected)', container: 'c`id`', deployment: 'd $HOME', envFile };
  try {
    const actual = JSON.parse(execFileSync('/bin/sh', ['-c', deploymentCommand(args)], { cwd: '/', encoding: 'utf8' }));
    assert.equal(actual.cwd, realpathSync(root));
    assert.deepEqual(actual.args, ['up', args.tag, '--image', '--name', args.container, '--deployment', args.deployment, '--env-file', args.envFile, '-d']);
    assert.deepEqual(readdirSync(root).sort(), [path.basename(cli), 'env file'].sort());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runtime bootstrap invokes private automation and requires positive authenticated verification', () => {
  const options = { repo: '/repo', container: 'candidate' }, calls = [];
  const execute = (...args) => { calls.push(args); return '{"status":"materialized"}\n{"status":"verified","items":0}\n'; };
  assert.deepEqual(runtimeBootstrap(options, { log: noop, execute }), { verified: true });
  assert.deepEqual(calls[0].slice(0, 4), ['runtime-bootstrap', 'deploy-failed', '/bin/sh', ['/repo/clankandslop-private/newsroom/runtime/bootstrap-control-token.sh', 'candidate']]);
  for (const output of ['', '{"status":"materialized"}', '{"status":"verified"}'])
    assert.throws(() => runtimeBootstrap(options, { log: noop, execute: () => output }), /no authenticated activity verification/u);
});

test('policy checks every Codex member across nested compiled configs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clank-multi-policy-'));
  const strict = { mode: 'workspace-write', networkAccess: false, webSearch: 'disabled' };
  const agents = Array.from({ length: 12 }, (_, i) => ({ id: `agent-${i}`, engine: { kind: 'codex', codexSandbox: strict } }));
  try {
    mkdirSync(path.join(root, 'nested'));
    writeFileSync(path.join(root, 'daimon-organization-runtime.json'), JSON.stringify({ agents: agents.slice(0, 6) }));
    const nested = path.join(root, 'nested', 'daimon-organization-runtime.json');
    writeFileSync(nested, JSON.stringify({ agents: agents.slice(6) }));
    assert.equal(runtimePolicy({ compiledOutput: root }, { log: noop }).checked, 12);
    delete agents[11].engine.codexSandbox;
    writeFileSync(nested, JSON.stringify({ agents: agents.slice(6) }));
    assert.throws(() => runtimePolicy({ compiledOutput: root }, { log: noop }), /agent-11 missing strict/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- stage 3b: room to build in ---------------------------------------------
test('the build refuses to start below the disk floor, after reclaiming what it safely can', () => {
  const calls = [];
  const exec = (avail) => (command, args) => {
    calls.push(`${command} ${args[0]}`);
    if (command === 'df') return `avail\n${avail()}\n`;
    return '';
  };
  let free = 4 * 1024 ** 3;
  // Reclaim first, floor second: the prune is what usually clears the failure.
  const reclaimed = reclaimBuildSpace({ repo: '/root/work/clankandslop', tag: 'clank-and-slop:seam-2026-09-20-010101' }, {
    log: () => undefined,
    exec: exec(() => { const now = free; free = 12 * 1024 ** 3; return now; })
  });
  assert.deepEqual([reclaimed.before, reclaimed.after], [4 * 1024 ** 3, 12 * 1024 ** 3]);
  assert.ok(calls.includes('docker builder'), calls.join(', '));
  assert.ok(calls.includes('docker images'), 'the existing image sweep still runs');

  // Still short after reclaiming: refuse while the deployment is whole.
  assert.throws(() => reclaimBuildSpace({ repo: '/root/work/clankandslop', tag: 't' }, {
    log: () => undefined,
    exec: exec(() => 9 * 1024 ** 3)
  }), (error) => error.reason === 'seam-blocked' && /below the 10\.0GiB floor/u.test(error.message));

  // An unreadable df is a refusal too, never an assumed pass.
  assert.throws(() => reclaimBuildSpace({ repo: '/x', tag: 't' }, {
    log: () => undefined,
    exec: () => 'avail\nnot-a-number\n'
  }), (error) => error.reason === 'seam-blocked' && /unreadable free space/u.test(error.message));
});

test('the seam reclaims before it builds, never after', () => {
  const order = [];
  const stub = (name, result) => (...args) => { order.push(name); return result ?? args[0]; };
  const stageImpl = {
    gate: stub('gate'), repin: stub('repin'), bundle: stub('bundle'),
    reclaimBuildSpace: stub('reclaimBuildSpace'), build: stub('build'),
    runtimePolicy: stub('runtimePolicy'), deploy: stub('deploy'), settle: stub('settle'),
    runtimeBootstrap: stub('runtimeBootstrap'), sweepImages: stub('sweepImages')
  };
  const result = seam(['--edition=2026-09-19', '--ref=edition/2026-09-19'], { log: () => undefined, alarm: () => undefined, stageImpl });
  assert.equal(result.ok, true);
  assert.ok(order.indexOf('reclaimBuildSpace') < order.indexOf('build'), order.join(' -> '));
  assert.ok(order.indexOf('bundle') < order.indexOf('reclaimBuildSpace'), order.join(' -> '));
});
