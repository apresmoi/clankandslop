import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BUILD_FLOOR_BYTES, DEFAULT_REPO, KEEP_IMAGES, KEEP_IMAGES_AFTER_SETTLE, KNOWN_UNDESCRIBED, STAGES, SeamError, TAG_PREFIX, berlinToday, build, deploymentCommand, parseArgs, pinFindings, reclaimBuildSpace, rollEpoch, runtimeBootstrap, runtimePolicy, seam, settle, sweepCompiledOutputs, sweepImages } from './seam-run.mjs';
import { DAIMON_RUNTIME_CONFIG, DAIMON_UID_ENTRYPOINT, GROK_BROKER } from './engine-policy.mjs';
import { DEFAULT_TRACK_REF, DEFER_ALARM_AFTER_MS, RELEASE_LEDGER_VERSION, RELEASE_LOG_NAME, RELEASE_PENDING_NAME, deferRelease, recordRelease, releaseGate } from './release-ledger.mjs';

const now = new Date('2026-09-06T07:00:00Z');
const noop = () => {};
const repoRoot = path.resolve(import.meta.dirname, '..', '..');

// A recorder for the stage sequence. Every stage is a no-op that writes its own
// name down, so a test can assert the ORDER as well as the membership.
function recorder(failAt, error = new SeamError('boom', 'deploy-failed')) {
  const calls = [];
  const stage = (name) => (options) => { calls.push(name); if (name === failAt) throw error; return options; };
  return { calls, impl: Object.fromEntries(STAGE_NAMES.map((name) => [name, stage(name)])) };
}
const alarms = () => { const raised = []; return { raised, alarm: (reason, detail) => raised.push({ reason, ...detail }) }; };
const STAGE_NAMES = ['releaseGate', 'gate', 'bundle', 'reclaimBuildSpace', 'build', 'runtimePolicy', 'rollEpoch', 'deploy', 'settle', 'runtimeBootstrap', 'recordRelease', 'sweepImages'];
const FULL_ORDER = ['gate', 'bundle', 'reclaimBuildSpace', 'build', 'runtimePolicy', 'rollEpoch', 'deploy', 'settle', 'runtimeBootstrap', 'recordRelease', 'sweepImages'];

test('the pipeline has no repin stage, and STAGES has no repin key', () => {
  // THE test that stops a daily corpus repin being reinstated by habit. The
  // corpus is a host-populated volume now (agentic-org/Spawnfile): a new day's
  // research no longer needs a new image, and a stage that pinned research into
  // one is how the daily ~5GB rebuild comes back.
  const { calls, impl } = recorder(null);
  const result = seam([], { now, log: noop, stageImpl: impl, alarm: noop });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, FULL_ORDER);
  assert.ok(!calls.includes('repin'), calls.join(' -> '));
  assert.ok(!('repin' in STAGES), 'STAGES must not carry a repin stage');
  assert.deepEqual(Object.keys(STAGES), STAGE_NAMES);
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
  assert.deepEqual(calls, ['gate', 'bundle']);
  assert.equal(result.ok, true);
  assert.equal(result.deploy, false);
});

test('no-deploy builds the image and stops before `up`', () => {
  const { calls, impl } = recorder(null);
  seam(['--no-deploy'], { now, log: noop, stageImpl: impl, alarm: noop });
  assert.deepEqual(calls, ['gate', 'bundle', 'reclaimBuildSpace', 'build', 'runtimePolicy']);
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
  assert.deepEqual(calls, ['gate', 'bundle', 'reclaimBuildSpace', 'build', 'runtimePolicy']);
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
  const expected = { bundle: 'bundle-mismatch', build: 'deploy-failed', runtimePolicy: 'deploy-failed', deploy: 'deploy-failed', settle: 'deploy-failed', runtimeBootstrap: 'deploy-failed', recordRelease: 'deploy-failed' };
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

test('the edition defaults to today in Berlin and names the tag; nothing names an edition branch any more', () => {
  const { impl } = recorder(null);
  const result = seam([], { now, log: noop, stageImpl: impl, alarm: noop });
  assert.equal(result.edition, '2026-09-06');
  assert.ok(result.tag.startsWith(`${TAG_PREFIX}2026-09-06-`));
  // `--ref` named the corpus branch the repin pinned. There is no repin, so
  // there is no ref: an option that implies this job still chooses research is
  // worse than no option.
  assert.throws(() => parseArgs(['--ref=edition/2026-09-06']), SeamError);
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
  // KEEP_IMAGES is 2: the live image and the one it would roll back to. The
  // third and fourth are a different corpus pin and a different day's paper,
  // and on a 75GB disk they are 9.9GB standing between the build and its own
  // floor. Asserted against the constant so the two cannot drift apart.
  assert.equal(KEEP_IMAGES, 2);
  assert.deepEqual(removed, ['clank-and-slop:seam-2026-09-04-090000', 'clank-and-slop:seam-2026-09-03-090000']);
  assert.ok(!removed.includes('clank-and-slop:seam-2026-09-05-090000'), 'yesterday stays: it is the rollback target');
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
// No `private` block: the research corpus is a volume now, so the descriptor
// describes no archive for it and no Spawnfile pins one.
const descriptorOf = (source, dependency) => ({
  source: { archive: 'newsroom-runtime.tar', sha256: source },
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
  // 47 before the corpus left the image: twelve of those pins were
  // newsroom-private.tar, one per agent.
  assert.equal(result.checked, 35);
  assert.ok(!result.archives.includes('newsroom-private.tar'), 'the descriptor must not describe a corpus archive any more');
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
  // And the corpus archive is now one of those: nothing describes
  // newsroom-private.tar any more, so a Spawnfile that still pins one is drift
  // rather than an exemption. It must never join KNOWN_UNDESCRIBED.
  const corpus = pinWorld([line('private-archive', 'newsroom-private.tar', A)], descriptorOf(A, B));
  try {
    assert.deepEqual(pinFindings(known).findings, []);
    assert.match(pinFindings(unknown).findings[0], /the descriptor does not describe/u);
    assert.match(pinFindings(corpus).findings[0], /newsroom-private\.tar.*the descriptor does not describe/u);
  } finally { for (const repo of [known, unknown, corpus]) rmSync(repo, { recursive: true, force: true }); }
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
    exec: exec(() => { const now = free; free = 30 * 1024 ** 3; return now; })
  });
  assert.deepEqual([reclaimed.before, reclaimed.after], [4 * 1024 ** 3, 30 * 1024 ** 3]);
  assert.ok(calls.includes('docker builder'), calls.join(', '));
  assert.ok(calls.includes('docker images'), 'the existing image sweep still runs');

  // Still short after reclaiming: refuse while the deployment is whole.
  assert.throws(() => reclaimBuildSpace({ repo: '/root/work/clankandslop', tag: 't' }, {
    log: () => undefined,
    exec: exec(() => 9 * 1024 ** 3)
  }), (error) => error.reason === 'seam-blocked' && /below the 20\.0GiB floor/u.test(error.message));

  // An unreadable df is a refusal too, never an assumed pass.
  assert.throws(() => reclaimBuildSpace({ repo: '/x', tag: 't' }, {
    log: () => undefined,
    exec: () => 'avail\nnot-a-number\n'
  }), (error) => error.reason === 'seam-blocked' && /unreadable free space/u.test(error.message));
});

test('the whole build cache is dropped on every run, not a 24h slice', () => {
  // 2026-09-23: the box held 22.9GB of build cache, of which `until=24h` could
  // reclaim 3.3GB. The run passed a 10GiB floor check and then died in deploy
  // with 2.1GB left. What the cache buys is a faster next build, and the next
  // build changes the corpus layer anyway.
  const prunes = [];
  const exec = (command, args) => {
    if (command === 'df') return `avail\n${30 * 1024 ** 3}\n`;
    if (command === 'docker' && args[0] === 'builder') prunes.push(args.join(' '));
    return '';
  };
  reclaimBuildSpace({ repo: '/root/work/clankandslop', tag: 't' }, { log: () => undefined, exec, sweepScratch: () => undefined });
  assert.deepEqual(prunes, ['builder prune -af'], 'no until filter, and only one pass');

  // The floor is what a build actually consumes, not a number that reads well.
  assert.equal(BUILD_FLOOR_BYTES, 20 * 1024 ** 3);

  // Short is still a refusal — pruning harder frees cache, it does not lower the bar.
  const short = [12 * 1024 ** 3, 12 * 1024 ** 3];
  assert.throws(() => reclaimBuildSpace({ repo: '/root/work/clankandslop', tag: 't' }, {
    log: () => undefined, sweepScratch: () => undefined,
    exec: (command) => (command === 'df' ? `avail\n${short.shift()}\n` : '')
  }), (error) => error.reason === 'seam-blocked' && /below the 20\.0GiB floor/u.test(error.message));
});

test('once the container is healthy the previous image survives for rollback', () => {
  // This kept ONE for as long as every org image was pinned to one day's
  // corpus, because rolling back then restored yesterday's research under
  // today's date. The corpus is a host volume now, so the image that was
  // running an hour ago is a complete newsroom and `up <previous tag> --image`
  // is a one-minute recovery. Affordable because builds are rare.
  assert.equal(KEEP_IMAGES_AFTER_SETTLE, 2);
  const removed = [];
  const exec = (_docker, args) => {
    if (args[0] === 'images') return { toString: () => [
      'clank-and-slop:seam-2026-09-23-090007\t2026-09-23 09:00:00',
      'clank-and-slop:seam-2026-09-22-090008\t2026-09-22 09:00:00',
      'clank-and-slop:seam-2026-09-21-090022\t2026-09-21 09:00:00'
    ].join('\n') };
    removed.push(args[2]);
    return { toString: () => '' };
  };
  sweepImages({ tag: 'clank-and-slop:seam-2026-09-23-090007' }, { log: noop, exec, keep: KEEP_IMAGES_AFTER_SETTLE });
  assert.deepEqual(removed, ['clank-and-slop:seam-2026-09-21-090022']);

  // During the run, before the new image exists, two are kept: the running one
  // cannot be removed and the new one is not built yet.
  const during = [];
  sweepImages({ tag: 'clank-and-slop:seam-2026-09-23-090007' }, { log: noop, keep: KEEP_IMAGES, exec: (_d, args) => {
    if (args[0] === 'images') return { toString: () => [
      'clank-and-slop:seam-2026-09-23-090007\t2026-09-23 09:00:00',
      'clank-and-slop:seam-2026-09-22-090008\t2026-09-22 09:00:00',
      'clank-and-slop:seam-2026-09-21-090022\t2026-09-21 09:00:00'
    ].join('\n') };
    during.push(args[2]); return { toString: () => '' };
  } });
  assert.deepEqual(during, ['clank-and-slop:seam-2026-09-21-090022']);
});

test('the build no longer has an opinion about which edition the corpus is from', () => {
  // It used to refuse unless policies/private-source.json named the edition
  // being built, because the corpus was an archive inside the image. It is a
  // host-populated volume now, so an image is day-agnostic and that assertion
  // would refuse every release on every day the committed pin is not today's —
  // which is every day, and is how the daily rebuild gets reinvented.
  //
  // The guard did not weaken, its subject moved: corpus-contract.mjs checks the
  // tree the host fetched, and the newsroom tools refuse a corpus that is not
  // this edition's at call time.
  const repo = mkdtempSync(path.join(tmpdir(), 'clank-pin-build-'));
  try {
    mkdirSync(path.join(repo, 'agentic-org', 'policies'), { recursive: true });
    writeFileSync(path.join(repo, 'agentic-org/policies/private-source.json'),
      JSON.stringify({ version: 'v1', commit: 'b'.repeat(40), ref: 'edition/2026-09-09-prepared', edition: '2026-09-09' }));
    // Reaches the compiler and fails there — on the missing CLI, not on a pin.
    assert.throws(() => build({ repo, edition: '2026-09-23', tag: 'clank-and-slop:seam-t', cli: '/nonexistent/cli.js' }, { log: () => undefined }),
      (error) => error.reason === 'deploy-failed' && /build FAILED|could not run/u.test(error.message) && !/another day|corpus pin/u.test(error.message));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('the compiled-output scratch is swept, bounded, and never the tree this run will write', () => {
  // Twelve of these had accumulated on the host by 2026-09-20 — 8.2GB, more
  // than the images the tag sweep bounds — and they are what pushed the box
  // under its own build floor. Exercised against a real directory rather than
  // stubs, because "did the bytes actually go" is the whole claim.
  const repo = mkdtempSync(path.join(tmpdir(), 'clank-scratch-test-'));
  const root = path.join(repo, '.runtime');
  const make = (name, at) => {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'container.json'), '{}');
    utimesSync(dir, at, at);
    return dir;
  };
  try {
    const tag = 'clank-and-slop:seam-2026-09-20-061603';
    const current = make(`seam-compiled-${tag.replace(/[^a-zA-Z0-9_.-]/gu, '_')}`, 100);
    const newest = make('seam-compiled-clank-and-slop_seam-2026-09-19-020345_', 90);
    const second = make('seam-compiled-clank-and-slop_seam-2026-09-19-020003_', 80);
    const stale = ['a', 'b', 'c'].map((suffix, index) => make(`seam-compiled-clank-and-slop_seam-2026-09-1${index}-0000${suffix}`, 10 + index));
    const unrelated = make('some-other-scratch', 5);

    sweepCompiledOutputs({ repo, tag }, { log: () => undefined });

    // The current run's tree survives even though it is the newest: it is about
    // to be written into, and `keep` is counted over the others.
    assert.ok(existsSync(current), 'the tree this run will write must never be swept');
    assert.ok(existsSync(newest) && existsSync(second), 'the two most recent other trees are kept');
    assert.ok(existsSync(unrelated), 'only the seam-compiled- prefix is ever touched');
    for (const dir of stale) assert.ok(!existsSync(dir), `${dir} should have been retired`);
    assert.deepEqual(readdirSync(root).sort(), [
      'seam-compiled-clank-and-slop_seam-2026-09-19-020003_',
      'seam-compiled-clank-and-slop_seam-2026-09-19-020345_',
      `seam-compiled-${tag.replace(/[^a-zA-Z0-9_.-]/gu, '_')}`,
      'some-other-scratch'
    ].sort());

    // A missing .runtime is a no-op, not a crash: the first seam on a fresh
    // checkout has nothing to sweep and must still reach the floor check.
    rmSync(root, { recursive: true, force: true });
    assert.doesNotThrow(() => sweepCompiledOutputs({ repo, tag }, { log: () => undefined }));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('reclaiming disk sweeps the compiled-output scratch as well as the image tags', () => {
  const swept = [];
  const calls = [];
  reclaimBuildSpace({ repo: '/root/work/clankandslop', tag: 'clank-and-slop:seam-2026-09-20-010101' }, {
    log: () => undefined,
    exec: (command, args) => { calls.push(`${command} ${args[0]}`); return command === 'df' ? `avail\n${30 * 1024 ** 3}\n` : ''; },
    sweepScratch: (options) => swept.push(options.tag)
  });
  assert.deepEqual(swept, ['clank-and-slop:seam-2026-09-20-010101']);
  assert.ok(calls.includes('docker images'), 'the image tag sweep still runs too');
});

test('the seam reclaims before it builds, never after', () => {
  const order = [];
  const stub = (name, result) => (...args) => { order.push(name); return result ?? args[0]; };
  const stageImpl = Object.fromEntries(STAGE_NAMES.map((name) => [name, stub(name)]));
  const result = seam(['--edition=2026-09-19'], { log: () => undefined, alarm: () => undefined, stageImpl });
  assert.equal(result.ok, true);
  assert.ok(order.indexOf('reclaimBuildSpace') < order.indexOf('build'), order.join(' -> '));
  assert.ok(order.indexOf('bundle') < order.indexOf('reclaimBuildSpace'), order.join(' -> '));
});

// --- stage 0: is there anything to release at all ----------------------------
// The seam runs on a timer and is expected to do NOTHING most of the time: the
// corpus moved to a host volume, so a new day is not a reason to build. These
// are the tests that keep the no-op path a no-op, and the ledger honest about
// what is actually running.
function releaseWorld() {
  const root = mkdtempSync(path.join(tmpdir(), 'clank-release-'));
  const repo = path.join(root, 'repo');
  mkdirSync(path.join(repo, 'agentic-org'), { recursive: true });
  writeFileSync(path.join(repo, 'agentic-org', 'Spawnfile'), 'team: clank-and-slop\n');
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('add', '-A');
  git('commit', '-qm', 'first');
  // AN ORIGIN, because "has anything been merged" is a question about a tracked
  // ref and not about this checkout. A world where the build root was the only
  // thing that could move is the world the first release gate was written for,
  // and in it a release job can never discover a release.
  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', origin], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('remote', 'add', 'origin', origin);
  git('push', '-q', '-u', 'origin', 'main');
  const at = (ref) => execFileSync('git', ['-C', repo, 'rev-parse', ref], { encoding: 'utf8' }).trim();
  return {
    root, repo, origin, git, at, released: path.join(root, 'released.json'),
    head: at('HEAD'),
    // A merged pull request, as the box sees it: origin/main has advanced and the
    // build root has not moved an inch.
    merge: (file, content, message = 'merged') => {
      writeFileSync(path.join(repo, file), content);
      git('add', '-A'); git('commit', '-qm', message); git('push', '-q', 'origin', 'main');
      const tip = at('HEAD');
      git('reset', '-q', '--hard', 'HEAD~1');
      return tip;
    },
    // A commit that is already on the tracked tip, so nothing has to move for it
    // to be releasable.
    commit: (message = 'committed') => { git('add', '-A'); git('commit', '-qm', message); git('push', '-q', 'origin', 'main'); return at('HEAD'); },
    ledger: () => JSON.parse(readFileSync(path.join(root, 'released.json'), 'utf8')),
    write: (value) => writeFileSync(path.join(root, 'released.json'), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`)
  };
}
const ledgerOf = (commit, tag = 'clank-and-slop:seam-2026-09-05-090000') => ({ version: RELEASE_LEDGER_VERSION, commit, tag, at: '2026-09-05T07:00:00.000Z' });
// The real release gate over the recorder's stages: everything that touches the
// tree, docker or the deployment stays a stub, and the decision is real.
const withRealGate = (overrides = {}) => {
  const { calls, impl } = recorder(null);
  return { calls, impl: Object.assign(impl, { releaseGate }, overrides) };
};

test('the release gate releases what origin/main has merged, and brings the build root to that commit', () => {
  // THE test for a release job that could never release. The first version of
  // this gate compared the ledger against `git rev-parse HEAD` and nothing in the
  // job ever fetched, so the build root's HEAD only moved when a person moved it:
  // origin/main advanced on merge, the local HEAD did not, and the hourly timer
  // no-opped forever on an unchanged commit.
  const world = releaseWorld();
  const args = ['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`];
  try {
    // Nothing merged: the ledger names the tip, so the hourly run does nothing.
    world.write(ledgerOf(world.head));
    const quiet = withRealGate();
    assert.equal(seam(args, { now, log: noop, stageImpl: quiet.impl, alarm: noop }).noop, true);
    assert.deepEqual(quiet.calls, []);

    // Now a merge lands on the tracked ref and the checkout knows nothing about it.
    const tip = world.merge('agentic-org/prompts.md', 'reviewed\n');
    assert.notEqual(tip, world.head);
    assert.equal(world.at('HEAD'), world.head, 'the merge is on the remote, not in the checkout');

    const { calls, impl } = withRealGate();
    const result = seam(args, { now, log: noop, stageImpl: impl, alarm: noop });
    assert.equal(result.ok, true);
    assert.equal(result.noop, undefined, 'a merged commit is something to release');
    assert.deepEqual(calls, FULL_ORDER);
    // The commit being released is the TIP, because that is what was reviewed —
    // and the tree the stages below compiled is that same commit, fast-forwarded
    // in the one build root whose path the durable volume names derive from.
    assert.equal(result.releaseCommit, tip);
    assert.equal(world.at('HEAD'), tip);
    assert.equal(world.at('origin/main'), tip);
  } finally { rmSync(world.root, { recursive: true, force: true }); }
});

test('a build root the tracked tip cannot fast-forward is refused, never merged or reset', () => {
  // A release is a fast-forward onto a reviewed commit. Every alternative ships
  // something nobody reviewed out of the one checkout the newsroom's durable
  // volumes hang off, so each of these is a state a person has to resolve.
  const world = releaseWorld();
  const args = ['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`];
  const run = () => {
    const { calls, impl } = withRealGate();
    const { raised, alarm } = alarms();
    return { calls, raised, result: seam(args, { now, log: noop, stageImpl: impl, alarm }) };
  };
  try {
    world.write(ledgerOf('0'.repeat(40)));
    const tip = world.merge('agentic-org/prompts.md', 'reviewed\n');

    // Local commits the tip does not contain: fast-forwarding is impossible and
    // the only way forward would be a merge this job invented.
    writeFileSync(path.join(world.repo, 'agentic-org', 'local.md'), 'mine\n');
    world.git('add', '-A'); world.git('commit', '-qm', 'local work');
    const mine = world.at('HEAD');
    const local = run();
    assert.equal(local.result.ok, false);
    assert.equal(local.result.reason, 'seam-blocked');
    assert.deepEqual(local.calls, [], 'nothing is built from a tree that cannot be the tip');
    assert.match(local.raised[0].detail, /carries commits the tracked tip does not/u);
    assert.equal(world.at('HEAD'), mine, 'a refused release leaves the build root exactly where it was');
    world.git('reset', '-q', '--hard', 'HEAD~1');

    // Not on the tracked branch at all: a detached build root is one somebody was
    // working in, and `main` is what the tip advances.
    world.git('checkout', '-q', '--detach', 'HEAD');
    const detached = run();
    assert.equal(detached.result.ok, false);
    assert.deepEqual(detached.calls, []);
    assert.match(detached.raised[0].detail, /detached HEAD/u);
    world.git('checkout', '-q', 'main');

    // Cleared: the same tip is now a plain fast-forward and the release proceeds.
    const clear = run();
    assert.equal(clear.result.ok, true);
    assert.equal(world.at('HEAD'), tip);
  } finally { rmSync(world.root, { recursive: true, force: true }); }
});

test('a remote this run cannot reach defers under the timer instead of reporting nothing to do', () => {
  // A fetch that failed means this run cannot tell whether anything was merged,
  // so it must not say "nothing changed" — but GitHub being briefly unreachable
  // is not an emergency either. Same treatment as a closed wake window: logged,
  // exit 0, no page, and the pending record still escalates an outage that has
  // stopped being brief.
  const world = releaseWorld();
  const args = ['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`];
  try {
    world.write(ledgerOf('0'.repeat(40)));
    rmSync(world.origin, { recursive: true, force: true });
    const { calls, impl } = withRealGate();
    const { raised, alarm } = alarms();
    const result = seam(args, { now, log: noop, stageImpl: impl, alarm });
    assert.equal(result.ok, true);
    assert.equal(result.deferred, true);
    assert.equal(result.noop, undefined, 'unreachable is not up to date');
    assert.deepEqual(calls, [], 'nothing past the gate runs');
    assert.deepEqual(raised, [], 'an unreachable remote must not page on the first run');
    const pending = JSON.parse(readFileSync(path.join(world.root, RELEASE_PENDING_NAME), 'utf8'));
    assert.equal(pending.commit, world.head, 'the deferral keys its clock on the commit the build root is on');

    // A day of not being able to look is not a quiet system either.
    const late = alarms();
    const stale = seam(args, { now: new Date(now.getTime() + 25 * 3600000), log: noop, stageImpl: withRealGate().impl, alarm: late.alarm });
    assert.equal(stale.deferred, true);
    assert.deepEqual(late.raised.map((entry) => entry.reason), ['release-deferred']);

    // The gate itself refuses rather than returning anything, and marks the one
    // refusal the timer is allowed to defer. Every other refusal stays a failure.
    const options = parseArgs([`--repo=${world.repo}`, `--released=${world.released}`]);
    assert.throws(() => releaseGate(options, { log: noop }), (error) => error.reason === 'seam-blocked' && error.unreachable === true && /could not reach/u.test(error.message));
  } finally { rmSync(world.root, { recursive: true, force: true }); }
});

test('--track names the ref the ledger is compared against, and --no-fetch keeps this run off the network', () => {
  assert.equal(DEFAULT_TRACK_REF, 'origin/main');
  assert.equal(parseArgs([]).track, 'origin/main');
  assert.equal(parseArgs([]).fetch, true);
  assert.equal(parseArgs(['--track=origin/release']).track, 'origin/release');
  assert.equal(parseArgs(['--no-fetch']).fetch, false);
  const world = releaseWorld();
  try {
    const tip = world.merge('agentic-org/prompts.md', 'reviewed\n');
    let fetched = 0;
    const fetch = () => { fetched += 1; };
    // --no-fetch still compares against the tracked ref and still fast-forwards;
    // it only declines to go and look for a newer one.
    const offline = parseArgs([`--repo=${world.repo}`, `--released=${world.released}`, '--no-fetch']);
    const verdict = releaseGate(offline, { log: noop, fetch });
    assert.equal(fetched, 0);
    assert.equal(verdict.tip, tip);
    assert.equal(world.at('HEAD'), tip);
    // And the default does fetch, exactly once.
    releaseGate(parseArgs([`--repo=${world.repo}`, `--released=${world.released}`]), { log: noop, fetch });
    assert.equal(fetched, 1);
    // A ref that is not <remote>/<branch> is refused rather than guessed at.
    assert.throws(() => releaseGate(parseArgs([`--repo=${world.repo}`, `--released=${world.released}`, '--track=main', '--no-fetch']), { log: noop }),
      (error) => error.reason === 'seam-blocked' && /<remote>\/<branch>/u.test(error.message));
  } finally { rmSync(world.root, { recursive: true, force: true }); }
});

test('--if-changed on an already-released commit runs zero stages and writes nothing', () => {
  const world = releaseWorld();
  world.write(ledgerOf(world.head));
  const before = readdirSync(world.root).sort();
  try {
    const { calls, impl } = withRealGate();
    const result = seam(['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`], { now, log: noop, stageImpl: impl, alarm: noop });
    assert.equal(result.ok, true);
    assert.equal(result.noop, true);
    assert.deepEqual(result.stages, []);
    // Nothing ran: every docker call, every Spawnfile rewrite and every deploy
    // in this pipeline lives inside a stage, and no stage was reached.
    assert.deepEqual(calls, []);
    assert.deepEqual(readdirSync(world.root).sort(), before, 'the no-op path must not write a byte');
    assert.deepEqual(world.ledger(), ledgerOf(world.head));
  } finally { rmSync(world.root, { recursive: true, force: true }); }
});

test('--if-changed on a commit the ledger does not name runs the whole pipeline, in order', () => {
  const world = releaseWorld();
  world.write(ledgerOf('0'.repeat(40), 'clank-and-slop:seam-2026-09-01-010101'));
  try {
    const { calls, impl } = withRealGate();
    const result = seam(['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`], { now, log: noop, stageImpl: impl, alarm: noop });
    assert.equal(result.ok, true);
    assert.equal(result.noop, undefined);
    assert.deepEqual(calls, FULL_ORDER);
    assert.deepEqual(result.stages, ['releaseGate', ...FULL_ORDER.filter((name) => name !== 'sweepImages')]);
    assert.equal(result.releaseCommit, world.head);
  } finally { rmSync(world.root, { recursive: true, force: true }); }
});

test('a missing ledger releases; a ledger that cannot be read refuses and runs nothing', () => {
  const world = releaseWorld();
  try {
    // Nothing recorded as running yet is the first release on a fresh box.
    const fresh = withRealGate();
    assert.equal(seam(['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`], { now, log: noop, stageImpl: fresh.impl, alarm: noop }).ok, true);
    assert.deepEqual(fresh.calls, FULL_ORDER);

    // Unparseable is NOT assumed-stale, because that assumption deploys. A job
    // that cannot read its own ledger also cannot write the one the next run
    // depends on, so it must not deploy at all.
    for (const broken of ['{', '{"version":"clank.release.v1"}', JSON.stringify({ version: 'something.else.v1', commit: '0'.repeat(40) })]) {
      world.write(broken);
      const { calls, impl } = withRealGate();
      const { raised, alarm } = alarms();
      const result = seam(['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`], { now, log: noop, stageImpl: impl, alarm });
      assert.equal(result.ok, false, broken);
      assert.equal(result.reason, 'seam-blocked', broken);
      assert.deepEqual(calls, [], broken);
      assert.deepEqual(raised.map((entry) => entry.reason), ['seam-blocked'], broken);
    }
  } finally { rmSync(world.root, { recursive: true, force: true }); }
});

// A PATH ALLOWLIST IS NOT A GUARD, IT IS A HOLE WITH A LIST OF NAMES ON IT.
//
// `bundle` legitimately rewrites digest pins in the descriptor and in the twelve
// agent Spawnfiles mid-run, so those paths were exempted wholesale — which meant
// ANY uncommitted edit to any of them passed the gate and shipped: a changed
// prompt, a new tool grant, a widened Moltnet room, a raised token ceiling, in
// the twelve most security-relevant declarations in the repository. Found by
// review on 2026-10-01. What is allowlisted now is the SHAPE of the change.
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const descriptorAt = (sha256, fileCount, bytes) => `${JSON.stringify({
  version: 'clank.newsroom-runtime-bundle.v2',
  source: { archive: 'newsroom-runtime.tar', sha256, file_count: fileCount, content_bytes: bytes },
  entrypoint: 'agentic-org/scripts/production-newsroom-mcp.mjs'
}, null, 2)}\n`;
const spawnfileAt = (digest, { instructions = 'Commission the desks from this edition corpus.', rule = 'Never commission from an unverified source.', extra = '' } = {}) =>
  `agent: brass\ninstructions: |\n  ${instructions}\n  ${rule}\nresources:\n`
  + `    - { id: public-content, kind: bundle, source: ../../newsroom-runtime.tar, sha256: ${digest}, mount: ./repos/newsroom, mode: readonly }\n${extra}`;

test('a dirty tree is refused unless the change is a digest rewrite, in the files bundle rewrites too', () => {
  const world = releaseWorld();
  const descriptor = path.join(world.repo, 'agentic-org', 'newsroom-runtime-bundle.json');
  const spawnfile = path.join(world.repo, 'agentic-org', 'agents', 'brass', 'Spawnfile');
  const run = () => {
    const { calls, impl } = withRealGate();
    const { raised, alarm } = alarms();
    return { calls, raised, result: seam(['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`], { now, log: noop, stageImpl: impl, alarm }) };
  };
  try {
    mkdirSync(path.dirname(spawnfile), { recursive: true });
    writeFileSync(descriptor, descriptorAt(DIGEST_A, 1644, 12065500));
    writeFileSync(spawnfile, spawnfileAt(DIGEST_A));
    world.commit('the descriptor and a declaration');
    world.write(ledgerOf('0'.repeat(40)));

    // What `bundle` actually leaves behind mid-run: the digests it measured, and
    // the two measurements that travel with them. Still releasable.
    writeFileSync(descriptor, descriptorAt(DIGEST_B, 1700, 12099999));
    writeFileSync(spawnfile, spawnfileAt(DIGEST_B));
    assert.equal(run().result.ok, true, 'a digest rewrite is what bundle is expected to do to these files');

    // ONE WORD OF A PROMPT, in a file the old check waved through.
    writeFileSync(spawnfile, spawnfileAt(DIGEST_B, { instructions: 'Commission the desks from any corpus you like.' }));
    const prompt = run();
    assert.equal(prompt.result.ok, false);
    assert.equal(prompt.result.reason, 'seam-blocked');
    assert.deepEqual(prompt.calls, [], 'nothing is built from an unreviewed prompt');
    assert.match(prompt.raised[0].detail, /agentic-org\/agents\/brass\/Spawnfile:\d+/u, 'the refusal names the file and the line');

    // A new tool grant, which adds a line rather than changing one. The refusal
    // has to say WHICH line and why, because "something in a Spawnfile changed"
    // sends whoever reads it to diff twelve files by hand at 04:00.
    writeFileSync(spawnfile, spawnfileAt(DIGEST_B, { extra: '    - { id: shell, kind: tool, command: /bin/sh }\n' }));
    const grant = run();
    assert.equal(grant.result.ok, false, 'an added grant is not a digest rewrite');
    assert.match(grant.raised[0].detail, /carries no digest/u);
    assert.match(grant.raised[0].detail, /id: shell, kind: tool/u, 'the refusal quotes the line it will not wave through');

    // A widened mount ON the pinned line itself — the case a check that only
    // asked "does this line carry a digest" would have passed.
    writeFileSync(spawnfile, spawnfileAt(DIGEST_B).replace('mode: readonly', 'mode: readwrite'));
    assert.equal(run().result.ok, false, 'a digest on the line is not a licence to change the rest of it');

    // A pure REORDER of two prompt lines, which a check that only compared the
    // changed lines as a set would have passed: the lines are the same lines, and
    // what changed is which one the agent reads first.
    const swapped = spawnfileAt(DIGEST_B).split('\n');
    [swapped[2], swapped[3]] = [swapped[3], swapped[2]];
    writeFileSync(spawnfile, swapped.join('\n'));
    assert.equal(run().result.ok, false, 'a line with no digest on it cannot be part of a digest rewrite');

    // And in the descriptor, a field that is neither a digest nor a measurement.
    writeFileSync(spawnfile, spawnfileAt(DIGEST_B));
    writeFileSync(descriptor, descriptorAt(DIGEST_B, 1700, 12099999).replace('production-newsroom-mcp.mjs', 'something-else.mjs'));
    assert.equal(run().result.ok, false, 'the descriptor is allowlisted for its measurements, not for everything');

    // Anything outside the allowlist is still refused on its path alone.
    writeFileSync(descriptor, descriptorAt(DIGEST_B, 1700, 12099999));
    writeFileSync(path.join(world.repo, 'agentic-org', 'Spawnfile'), 'team: clank-and-slop\nedited: true\n');
    const outside = run();
    assert.equal(outside.result.ok, false);
    assert.match(outside.raised[0].detail, /agentic-org\/Spawnfile is modified in the working tree/u);
  } finally { rmSync(world.root, { recursive: true, force: true }); }
});

test('the digest rewrites the last bundle left behind do not block the fast-forward', () => {
  // THE WAY FIX ONE WOULD HAVE STALLED ONE LAYER DOWN. `bundle` rewrites digest
  // pins into the working tree and nothing commits them, so after every release
  // the tree is dirty in exactly the files a repin commit touches — and
  // `git merge --ff-only` refuses to overwrite a locally modified file
  // ("Your local changes to the following files would be overwritten by merge").
  // The job would then discover the merge and refuse it, hourly, forever.
  //
  // Those rewrites are discarded before the fast-forward, and ONLY the ones the
  // shape check has just proven to be digest rewrites: `bundle` runs two stages
  // later and writes them again from the new descriptor, so they are reproducible
  // by construction rather than work somebody would lose.
  const world = releaseWorld();
  const descriptor = path.join(world.repo, 'agentic-org', 'newsroom-runtime-bundle.json');
  const spawnfile = path.join(world.repo, 'agentic-org', 'agents', 'brass', 'Spawnfile');
  try {
    mkdirSync(path.dirname(spawnfile), { recursive: true });
    writeFileSync(descriptor, descriptorAt(DIGEST_A, 1644, 12065500));
    writeFileSync(spawnfile, spawnfileAt(DIGEST_A));
    world.commit('the descriptor and a declaration');

    // A reviewed repin lands on origin/main, touching the very lines the previous
    // run left dirty...
    writeFileSync(descriptor, descriptorAt(DIGEST_B, 1700, 12099999));
    writeFileSync(spawnfile, spawnfileAt(DIGEST_B));
    const tip = world.merge('agentic-org/notes.md', 'why the digests moved\n', 'repin');
    // ...and the last bundle's output is still sitting in the checkout.
    writeFileSync(descriptor, descriptorAt(`sha256:${'c'.repeat(64)}`, 1800, 12100000));
    writeFileSync(spawnfile, spawnfileAt(`sha256:${'c'.repeat(64)}`));
    world.write(ledgerOf('0'.repeat(40)));

    const { calls, impl } = withRealGate();
    const { raised, alarm } = alarms();
    const result = seam(['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`], { now, log: noop, stageImpl: impl, alarm });
    assert.deepEqual(raised, [], JSON.stringify(raised));
    assert.equal(result.ok, true);
    assert.deepEqual(calls, FULL_ORDER);
    assert.equal(world.at('HEAD'), tip);
    // The tree the build will compile is the reviewed commit's, not a mixture.
    assert.equal(readFileSync(spawnfile, 'utf8'), spawnfileAt(DIGEST_B));
    assert.equal(execFileSync('git', ['-C', world.repo, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '');
  } finally { rmSync(world.root, { recursive: true, force: true }); }
});

test('the ledger advances only after settle and runtimeBootstrap have both passed', () => {
  const world = releaseWorld();
  const stale = ledgerOf('0'.repeat(40), 'clank-and-slop:seam-2026-09-01-010101');
  const args = ['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`];
  try {
    for (const failAt of ['settle', 'runtimeBootstrap']) {
      world.write(stale);
      const { calls, impl } = recorder(failAt, new SeamError(`${failAt} exploded`, 'deploy-failed'));
      Object.assign(impl, { releaseGate, recordRelease });
      const result = seam(args, { now, log: noop, stageImpl: impl, alarm: noop });
      assert.equal(result.ok, false, failAt);
      assert.ok(!calls.includes('recordRelease'), failAt);
      // The claim the ledger makes is "this commit is RUNNING". A container that
      // never settled is not running it, and a ledger that advanced anyway would
      // make the next timer run see nothing to do.
      assert.deepEqual(world.ledger(), stale, failAt);
      assert.equal(existsSync(path.join(world.root, RELEASE_LOG_NAME)), false, failAt);
    }

    world.write(stale);
    const { calls, impl } = recorder(null);
    Object.assign(impl, { releaseGate, recordRelease });
    const result = seam(args, { now, log: noop, stageImpl: impl, alarm: noop });
    assert.equal(result.ok, true);
    assert.deepEqual(world.ledger(), { version: RELEASE_LEDGER_VERSION, commit: world.head, tag: result.tag, at: now.toISOString() });
    assert.equal(statSync(world.released).mode & 0o777, 0o644);
    const log = readFileSync(path.join(world.root, RELEASE_LOG_NAME), 'utf8').trim().split('\n');
    assert.equal(log.length, 1);
    assert.equal(JSON.parse(log[0]).commit, world.head);
  } finally { rmSync(world.root, { recursive: true, force: true }); }
});

test('under --if-changed a closed wake window defers instead of paging', () => {
  // The release unit is on an hourly timer and the gate refuses whenever an
  // agent is awake or the container is not quiet, which is most of the day. A
  // job that paged on every busy hour would page ~20 times a day and train the
  // operator to ignore the pager — which is how the 2026-09-23 failure reached
  // nobody.
  const world = releaseWorld();
  world.write(ledgerOf('0'.repeat(40)));
  const args = ['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`];
  const blocked = () => {
    const { calls, impl } = recorder('gate', new SeamError('refusing to touch the deployment — cogsworth wakes in 4 min', 'seam-blocked'));
    return { calls, impl: Object.assign(impl, { releaseGate }) };
  };
  try {
    const first = blocked();
    const quiet = alarms();
    const result = seam(args, { now, log: noop, stageImpl: first.impl, alarm: quiet.alarm });
    assert.equal(result.ok, true);
    assert.equal(result.deferred, true);
    assert.deepEqual(result.stages, ['releaseGate']);
    assert.deepEqual(quiet.raised, [], 'a closed window must not page');
    assert.deepEqual(first.calls, ['gate'], 'nothing past the gate runs');
    // Observable without reading the journal: how long this commit has been
    // waiting lives in a file beside the ledger.
    const pending = JSON.parse(readFileSync(path.join(world.root, RELEASE_PENDING_NAME), 'utf8'));
    assert.equal(pending.commit, world.head);
    assert.equal(pending.since, now.toISOString());
    assert.equal(pending.alarmed_at, null);

    // Still inside the day: still silent.
    const soon = alarms();
    seam(args, { now: new Date(now.getTime() + 23 * 3600000), log: noop, stageImpl: blocked().impl, alarm: soon.alarm });
    assert.deepEqual(soon.raised, []);

    // Past a day it is not a quiet system any more, it is one that has stopped
    // shipping — said once, then not again for this commit.
    const late = alarms();
    const stale = seam(args, { now: new Date(now.getTime() + 25 * 3600000), log: noop, stageImpl: blocked().impl, alarm: late.alarm });
    assert.equal(stale.ok, true);
    assert.equal(stale.deferred, true);
    assert.deepEqual(late.raised.map((entry) => entry.reason), ['release-deferred']);
    assert.match(late.raised[0].message, /deferred for 25h00m/u);
    const again = alarms();
    const repeat = blocked();
    seam(args, { now: new Date(now.getTime() + 26 * 3600000), log: noop, stageImpl: repeat.impl, alarm: again.alarm });
    assert.deepEqual(again.raised, [], 'the staleness alarm is raised once per pending commit');
    assert.ok(!repeat.calls.includes('bundle') && !repeat.calls.includes('build'));
  } finally { rmSync(world.root, { recursive: true, force: true }); }
});

// A DEFERRAL THAT CANNOT BE TRACKED MUST NOT BE QUIET.
//
// The pending record is the only thing that knows when this commit first
// deferred, so it is the only thing that can escalate. If it cannot be written
// or read, the 24h clock restarts every hour and the release can defer forever
// with nothing ever paging -- the mechanism that would have escalated is the
// thing that failed, and it failed silently. These are the tests that keep that
// failure loud.
test('a deferral whose staleness record cannot be written raises immediately', () => {
  const world = releaseWorld();
  try {
    const options = { released: world.released, releaseCommit: world.head, edition: '2026-09-06' };
    const { raised, alarm } = alarms();
    const lines = [];
    const result = deferRelease(options, 'cogsworth wakes in 4 min', {
      now, alarm, log: (line) => lines.push(line),
      write: () => { throw new Error('EROFS: read-only file system'); }
    });
    // Still a deferral: the deployment path is not failed by a bookkeeping fault.
    assert.equal(result.deferred, true);
    assert.equal(result.ageMs, 0, 'the first deferral of this commit is not stale');
    // But not a silent one. The alarm fires on THIS run rather than waiting for
    // an escalation that can no longer happen.
    assert.equal(result.alarmed, true);
    assert.match(result.tracking_broken, /could not be written/u);
    assert.deepEqual(raised.map((entry) => entry.reason), ['release-deferred']);
    assert.match(raised[0].message, /staleness tracking is broken/u);
    assert.match(raised[0].message, /24h escalation cannot be relied on/u);
    assert.equal(raised[0].detail, 'cogsworth wakes in 4 min');
    assert.match(lines.join('\n'), /cannot be relied on/u);
  } finally { rmSync(world.root, { recursive: true, force: true }); }
});

test('a deferral whose staleness record cannot be read raises immediately', () => {
  const world = releaseWorld();
  try {
    const options = { released: world.released, releaseCommit: world.head, edition: '2026-09-06' };
    // A truncated or corrupt record: the instant this commit started waiting is
    // gone, so the age is wrong and the escalation it drives cannot be trusted.
    writeFileSync(path.join(world.root, RELEASE_PENDING_NAME), '{ "version": "clank.release-pending');
    const { raised, alarm } = alarms();
    const result = deferRelease(options, 'the container is not quiet', { now, alarm, log: noop });
    assert.equal(result.deferred, true);
    assert.equal(result.alarmed, true);
    assert.match(result.tracking_broken, /cannot be read/u);
    assert.deepEqual(raised.map((entry) => entry.reason), ['release-deferred']);
    assert.match(raised[0].message, /staleness tracking is broken/u);
    // The record is rewritten, so the next run is tracked again and silent.
    const quiet = alarms();
    const next = deferRelease(options, 'the container is not quiet', { now, alarm: quiet.alarm, log: noop });
    assert.deepEqual(quiet.raised, [], 'a repaired record is tracked, so it waits the day out again');
    assert.equal(next.tracking_broken, null);
    // A MISSING record is the ordinary first deferral and must stay silent, or
    // every first deferral of every new commit pages.
    rmSync(path.join(world.root, RELEASE_PENDING_NAME));
    const first = alarms();
    assert.equal(deferRelease(options, 'the container is not quiet', { now, alarm: first.alarm, log: noop }).alarmed, false);
    assert.deepEqual(first.raised, []);
  } finally { rmSync(world.root, { recursive: true, force: true }); }
});

test('the real seam raises when the pending record is unwritable, and still exits ok', () => {
  // End to end through `seam`, with nothing injected into deferRelease: the
  // pending path is a directory, so both the read and the write fail for real.
  const world = releaseWorld();
  world.write(ledgerOf('0'.repeat(40)));
  mkdirSync(path.join(world.root, RELEASE_PENDING_NAME));
  writeFileSync(path.join(world.root, RELEASE_PENDING_NAME, 'occupied'), 'x');
  try {
    const { impl } = recorder('gate', new SeamError('cogsworth wakes in 4 min', 'seam-blocked'));
    Object.assign(impl, { releaseGate });
    const { raised, alarm } = alarms();
    const result = seam(['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`], { now, log: noop, stageImpl: impl, alarm });
    assert.equal(result.ok, true, 'a bookkeeping fault must not fail the deployment path');
    assert.equal(result.deferred, true);
    assert.deepEqual(raised.map((entry) => entry.reason), ['release-deferred']);
    assert.match(raised[0].message, /staleness tracking is broken/u);
    assert.ok(DEFER_ALARM_AFTER_MS > 0);
  } finally { rmSync(world.root, { recursive: true, force: true }); }
});

test('without --if-changed a refused gate still alarms and still fails', () => {
  // A person who asked for a release now deserves to be told it was refused.
  const { calls, impl } = recorder('gate', new SeamError('an agent is awake', 'seam-blocked'));
  const { raised, alarm } = alarms();
  const result = seam([], { now, log: noop, stageImpl: impl, alarm });
  assert.equal(result.ok, false);
  assert.equal(result.deferred, undefined);
  assert.deepEqual(raised.map((entry) => entry.reason), ['seam-blocked']);
  // The gate's own words reach the page, not a deferral's: a run that quietly
  // became a deferral would report something else entirely.
  assert.match(raised[0].detail, /an agent is awake/u);
  assert.deepEqual(calls, ['gate']);
});

test('the release gate runs before the wake gate, and only under --if-changed', () => {
  const { calls, impl } = recorder(null);
  seam(['--if-changed'], { now, log: noop, stageImpl: impl, alarm: noop });
  assert.equal(calls[0], 'releaseGate', calls.join(' -> '));
  assert.ok(calls.indexOf('releaseGate') < calls.indexOf('gate'));
  const manual = recorder(null);
  seam([], { now, log: noop, stageImpl: manual.impl, alarm: noop });
  assert.ok(!manual.calls.includes('releaseGate'), 'a deliberate run does not consult the ledger');
});
