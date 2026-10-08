import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BUILD_FLOOR_BYTES, DEFAULT_REPO, KEEP_IMAGES, KEEP_IMAGES_AFTER_SETTLE, STAGES, SeamError, TAG_PREFIX, berlinToday, build, deploymentCommand, parseArgs, reclaimBuildSpace, wakeBudget, runtimeBootstrap, runtimePolicy, seam, settle, sweepCompiledOutputs, sweepImages } from './seam-run.mjs';
import { DAIMON_RUNTIME_CONFIG, DAIMON_UID_ENTRYPOINT, GROK_BROKER } from './engine-policy.mjs';
import { DEFAULT_FETCH_KEY, DEFAULT_TRACK_REF, DEFER_ALARM_AFTER_MS, classifyFetchFailure, fetchSshCommand, fetchTracked, RELEASE_LEDGER_VERSION, RELEASE_LOG_NAME, RELEASE_PENDING_NAME, deferRelease, recordRelease, releaseGate } from './release-ledger.mjs';

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
const STAGE_NAMES = ['releaseGate', 'gate', 'reclaimBuildSpace', 'build', 'runtimePolicy', 'wakeBudget', 'deploy', 'settle', 'runtimeBootstrap', 'recordRelease', 'sweepImages'];
const FULL_ORDER = ['gate', 'reclaimBuildSpace', 'build', 'runtimePolicy', 'wakeBudget', 'deploy', 'settle', 'runtimeBootstrap', 'recordRelease', 'sweepImages'];

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

test('check mode stops after the gate and never builds or deploys', () => {
  const { calls, impl } = recorder(null);
  const result = seam(['--check'], { now, log: noop, stageImpl: impl, alarm: noop });
  assert.deepEqual(calls, ['gate']);
  assert.equal(result.ok, true);
  assert.equal(result.deploy, false);
});

test('no-deploy builds the image and stops before `up`', () => {
  const { calls, impl } = recorder(null);
  seam(['--no-deploy'], { now, log: noop, stageImpl: impl, alarm: noop });
  assert.deepEqual(calls, ['gate', 'reclaimBuildSpace', 'build', 'runtimePolicy']);
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
  assert.deepEqual(calls, ['gate', 'reclaimBuildSpace', 'build', 'runtimePolicy']);
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
  const expected = { build: 'deploy-failed', runtimePolicy: 'deploy-failed', deploy: 'deploy-failed', settle: 'deploy-failed', runtimeBootstrap: 'deploy-failed', recordRelease: 'deploy-failed' };
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
  // A readable key file, because an unauthenticated fetch is a refusal now: the
  // public remote carries no ssh host alias, so without an identity the real box
  // fetched nothing at all. These tests fetch a local path where ssh is never
  // invoked, so the file only has to exist and be readable.
  const key = path.join(root, 'fetch-key');
  writeFileSync(key, 'not a real key, and nothing in this job ever reads it\n', { mode: 0o600 });
  return {
    root, repo, origin, git, at, key, released: path.join(root, 'released.json'),
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
  const args = ['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`, `--key=${world.key}`];
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
  const args = ['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`, `--key=${world.key}`];
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
  const args = ['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`, `--key=${world.key}`];
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

    // The gate itself refuses rather than returning anything, and marks the
    // refusals the timer is allowed to defer. A remote that is simply not there
    // any more is a fault this job will not pretend to have classified, so it
    // says so and still defers — conservative about paging, still escalated.
    const options = parseArgs([`--repo=${world.repo}`, `--released=${world.released}`, `--key=${world.key}`]);
    assert.throws(() => releaseGate(options, { log: noop }), (error) => error.reason === 'seam-blocked'
      && error.unreachable === true && error.fetchFailure === 'unclear' && /could not be classified/u.test(error.message));
  } finally { rmSync(world.root, { recursive: true, force: true }); }
});

test('the fetch goes out with a configured ssh identity, and refuses rather than going out without one', () => {
  // VERIFIED ON THE BOX FIRST, which is the only reason this exists: the public
  // remote is `git@github.com:apresmoi/clankandslop.git` with no ssh host alias,
  // and root's ~/.ssh/config only keys the aliases — so the bare fetch this gate
  // was written with had no identity and could never see a merge. The private
  // repo's remote IS an alias, which is why corpus-refresh.mjs needed nothing.
  assert.equal(DEFAULT_FETCH_KEY, '/root/.ssh/clank_public', 'a silent change of the identity is a release job that stops fetching');
  assert.equal(parseArgs([]).key, '/root/.ssh/clank_public');
  assert.equal(parseArgs(['--key=/root/.ssh/other']).key, '/root/.ssh/other');

  const world = releaseWorld();
  try {
    // The identity reaches git as GIT_SSH_COMMAND, and it is the one the config
    // decides rather than whatever ssh's agent or default key search would offer.
    const calls = [];
    const exec = (command, args, options) => { calls.push({ args, options }); return ''; };
    fetchTracked({ repo: world.repo, track: 'origin/main', key: world.key }, { exec, log: noop });
    assert.deepEqual(calls[0].args, ['-C', world.repo, 'fetch', '--prune', 'origin']);
    const ssh = calls[0].options.env.GIT_SSH_COMMAND;
    assert.ok(ssh.includes(`-i ${world.key}`), ssh);
    for (const option of ['-o IdentitiesOnly=yes', '-o IdentityAgent=none', '-o BatchMode=yes', '-o PasswordAuthentication=no', '-o StrictHostKeyChecking=yes'])
      assert.ok(ssh.includes(option), `${option} missing from ${ssh}`);
    // Nothing interactive, because a unit that hangs on a prompt tells nobody.
    assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(calls[0].options.env.GIT_ASKPASS, '');

    // A key that is not there is a refusal that NAMES it, and nothing is fetched.
    // An unauthenticated fetch would fail the way a brief outage fails, and the
    // deferral would then wait a day before saying anything at all.
    const missing = [];
    assert.throws(() => fetchTracked({ repo: world.repo, track: 'origin/main', key: '/root/.ssh/not-there' },
      { exec: (...args) => { missing.push(args); return ''; }, log: noop }),
    (error) => error.reason === 'seam-blocked' && error.unreachable === undefined && /\/root\/\.ssh\/not-there cannot be read/u.test(error.message));
    assert.deepEqual(missing, [], 'the key is checked before the fetch, not after it fails');

    // A directory, and a path a shell would read, are refused the same way.
    assert.throws(() => fetchSshCommand(world.root), /is not a file/u);
    assert.throws(() => fetchSshCommand('/root/.ssh/key$(id)'), /free of characters a shell would read/u);
    assert.throws(() => fetchSshCommand('relative/key'), /must be absolute/u);
  } finally { rmSync(world.root, { recursive: true, force: true }); }
});

test('an authentication fault is raised now; only an unreachable remote is deferred', () => {
  // The deferral exists for ONE cause: a remote this run could not see. A key the
  // remote does not accept will still not be accepted in an hour or in a week, so
  // deferring it quietly is the same mistake as a missing key file — and git's own
  // epilogue is identical for both, which is why the ssh lines underneath it are
  // what gets read.
  assert.equal(classifyFetchFailure('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.'), 'auth');
  assert.equal(classifyFetchFailure('ssh: Could not resolve hostname github.com\nfatal: Could not read from remote repository.'), 'unreachable');
  assert.equal(classifyFetchFailure('fatal: Could not read from remote repository.'), 'unclear');

  const world = releaseWorld();
  const args = ['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`, `--key=${world.key}`];
  const failing = (text) => (command, commandArgs, options) => {
    if (commandArgs.includes('fetch')) { const error = new Error(text); error.stderr = text; throw error; }
    return execFileSync(command, commandArgs, options);
  };
  try {
    world.write(ledgerOf('0'.repeat(40)));

    // Authentication: a page on this run, exit non-zero, no deferral to wait out.
    const auth = withRealGate();
    const { raised, alarm } = alarms();
    const result = seam(args, { now, log: noop, alarm, stageImpl: Object.assign(auth.impl, {
      releaseGate: (options, context) => releaseGate(options, { ...context, exec: failing('git@github.com: Permission denied (publickey).') })
    }) });
    assert.equal(result.ok, false);
    assert.equal(result.deferred, undefined, 'a wrong key is not a quiet "not yet"');
    assert.deepEqual(raised.map((entry) => entry.reason), ['seam-blocked']);
    assert.match(raised[0].detail, /AUTHENTICATION OR CONFIGURATION was refused/u);
    assert.deepEqual(auth.calls, []);

    // Unreachable: deferred, silent on the first run, and the log says which.
    const down = withRealGate();
    const quiet = alarms();
    const lines = [];
    const deferred = seam(args, { now, log: (line) => lines.push(String(line)), alarm: quiet.alarm, stageImpl: Object.assign(down.impl, {
      releaseGate: (options, context) => releaseGate(options, { ...context, exec: failing('ssh: connect to host github.com port 22: Connection timed out') })
    }) });
    assert.equal(deferred.ok, true);
    assert.equal(deferred.deferred, true);
    assert.deepEqual(quiet.raised, []);
    assert.match(lines.join('\n'), /COULD NOT BE REACHED/u);
    assert.ok(!lines.join('\n').includes('AUTHENTICATION'), 'the two faults must not read the same on a lock screen');
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
    const offline = parseArgs([`--repo=${world.repo}`, `--released=${world.released}`, `--key=${world.key}`, '--no-fetch']);
    const verdict = releaseGate(offline, { log: noop, fetch });
    assert.equal(fetched, 0);
    assert.equal(verdict.tip, tip);
    assert.equal(world.at('HEAD'), tip);
    // And the default does fetch, exactly once.
    releaseGate(parseArgs([`--repo=${world.repo}`, `--released=${world.released}`, `--key=${world.key}`]), { log: noop, fetch });
    assert.equal(fetched, 1);
    // A ref that is not <remote>/<branch> is refused rather than guessed at.
    assert.throws(() => releaseGate(parseArgs([`--repo=${world.repo}`, `--released=${world.released}`, `--key=${world.key}`, '--track=main', '--no-fetch']), { log: noop }),
      (error) => error.reason === 'seam-blocked' && /<remote>\/<branch>/u.test(error.message));
  } finally { rmSync(world.root, { recursive: true, force: true }); }
});

test('--if-changed on an already-released commit runs zero stages and writes nothing', () => {
  const world = releaseWorld();
  world.write(ledgerOf(world.head));
  const before = readdirSync(world.root).sort();
  try {
    const { calls, impl } = withRealGate();
    const result = seam(['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`, `--key=${world.key}`], { now, log: noop, stageImpl: impl, alarm: noop });
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
    const result = seam(['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`, `--key=${world.key}`], { now, log: noop, stageImpl: impl, alarm: noop });
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
    assert.equal(seam(['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`, `--key=${world.key}`], { now, log: noop, stageImpl: fresh.impl, alarm: noop }).ok, true);
    assert.deepEqual(fresh.calls, FULL_ORDER);

    // Unparseable is NOT assumed-stale, because that assumption deploys. A job
    // that cannot read its own ledger also cannot write the one the next run
    // depends on, so it must not deploy at all.
    for (const broken of ['{', '{"version":"clank.release.v1"}', JSON.stringify({ version: 'something.else.v1', commit: '0'.repeat(40) })]) {
      world.write(broken);
      const { calls, impl } = withRealGate();
      const { raised, alarm } = alarms();
      const result = seam(['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`, `--key=${world.key}`], { now, log: noop, stageImpl: impl, alarm });
      assert.equal(result.ok, false, broken);
      assert.equal(result.reason, 'seam-blocked', broken);
      assert.deepEqual(calls, [], broken);
      assert.deepEqual(raised.map((entry) => entry.reason), ['seam-blocked'], broken);
    }
  } finally { rmSync(world.root, { recursive: true, force: true }); }
});

// NO PATH IS EXEMPT. The `bundle` stage that used to rewrite digest pins into
// the descriptor and the agent Spawnfiles is gone, so a tracked modification of
// any file, a Spawnfile included, is a change that is not in the released commit.
test('a dirty tree is refused whatever the file, Spawnfiles included', () => {
  const world = releaseWorld();
  const spawnfile = path.join(world.repo, 'agentic-org', 'agents', 'brass', 'Spawnfile');
  const run = () => {
    const { calls, impl } = withRealGate();
    const { raised, alarm } = alarms();
    return { calls, raised, result: seam(['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`, `--key=${world.key}`], { now, log: noop, stageImpl: impl, alarm }) };
  };
  try {
    mkdirSync(path.dirname(spawnfile), { recursive: true });
    writeFileSync(spawnfile, 'agent: brass\nprompt: Commission the desks from this edition corpus.\n');
    world.commit('a declaration');
    world.write(ledgerOf('0'.repeat(40)));
    writeFileSync(spawnfile, 'agent: brass\nprompt: Commission the desks from any corpus you like.\n');
    const prompt = run();
    assert.equal(prompt.result.ok, false);
    assert.equal(prompt.result.reason, 'seam-blocked');
    assert.deepEqual(prompt.calls, [], 'nothing is built from an unreviewed prompt');
    assert.match(prompt.raised[0].detail, /agentic-org\/agents\/brass\/Spawnfile is modified in the working tree/u);
    // STAGED is not a way past it either.
    world.git('add', '--', 'agentic-org/agents/brass/Spawnfile');
    assert.equal(run().result.ok, false, '`git add` must not be a way past this');
  } finally { rmSync(world.root, { recursive: true, force: true }); }
});

test('the ledger advances only after settle and runtimeBootstrap have both passed', () => {
  const world = releaseWorld();
  const stale = ledgerOf('0'.repeat(40), 'clank-and-slop:seam-2026-09-01-010101');
  const args = ['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`, `--key=${world.key}`];
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
  const args = ['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`, `--key=${world.key}`];
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
    assert.ok(!repeat.calls.includes('build'));
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
    const result = seam(['--if-changed', `--repo=${world.repo}`, `--released=${world.released}`, `--key=${world.key}`], { now, log: noop, stageImpl: impl, alarm });
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

// --- wakeBudget: the deploy.env contract for an in-process daily budget -------
function wakeEnv(content) {
  const root = mkdtempSync(path.join(tmpdir(), 'clank-wake-budget-'));
  const envFile = path.join(root, 'deploy.env');
  writeFileSync(envFile, content);
  return { root, envFile };
}
const refusesWith = (pattern) => (error) => error instanceof SeamError && error.reason === 'deploy-failed' && pattern.test(error.message);

test('wakeBudget passes a deploy.env that names only the Europe/Berlin zone, and never writes it', () => {
  const content = 'SECRET_TOKEN=s3cr3t\nDAIMON_WAKE_FUSE_EPOCH_ZONE=Europe/Berlin\n';
  const { root, envFile } = wakeEnv(content);
  try {
    const before = statSync(envFile).mtimeMs;
    const logged = [];
    assert.deepEqual(wakeBudget({ envFile }, { log: (line) => logged.push(line) }), { zone: 'Europe/Berlin' });
    assert.equal(readFileSync(envFile, 'utf8'), content);
    assert.equal(statSync(envFile).mtimeMs, before);
    assert.deepEqual(readdirSync(root), ['deploy.env']);
    assert.ok(!logged.join('\n').includes('s3cr3t'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('wakeBudget refuses a pinned epoch, without echoing it, and leaves the file alone', () => {
  const content = 'DAIMON_WAKE_FUSE_EPOCH=clank-2026-10-02\nDAIMON_WAKE_FUSE_EPOCH_ZONE=Europe/Berlin\n';
  const { root, envFile } = wakeEnv(content);
  try {
    assert.throws(() => wakeBudget({ envFile }, { log: noop }),
      (error) => refusesWith(/pins DAIMON_WAKE_FUSE_EPOCH/u)(error) && !error.message.includes('clank-2026-10-02'));
    assert.equal(readFileSync(envFile, 'utf8'), content);
    assert.deepEqual(readdirSync(root), ['deploy.env']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('wakeBudget refuses a missing, wrong or duplicated zone', () => {
  const cases = [
    ['TOKEN=x\n', /0 DAIMON_WAKE_FUSE_EPOCH_ZONE lines/u],
    ['DAIMON_WAKE_FUSE_EPOCH_ZONE=UTC\n', /other than Europe\/Berlin/u],
    ['DAIMON_WAKE_FUSE_EPOCH_ZONE=Europe/Berlin\nDAIMON_WAKE_FUSE_EPOCH_ZONE=Europe/Berlin\n', /2 DAIMON_WAKE_FUSE_EPOCH_ZONE lines/u]
  ];
  for (const [content, pattern] of cases) {
    const { root, envFile } = wakeEnv(content);
    try {
      assert.throws(() => wakeBudget({ envFile }, { log: noop }), refusesWith(pattern), content);
      assert.equal(readFileSync(envFile, 'utf8'), content);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('wakeBudget refuses an unreadable deploy.env', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clank-wake-budget-'));
  try {
    assert.throws(() => wakeBudget({ envFile: path.join(root, 'missing.env') }, { log: noop }), refusesWith(/cannot read the deploy env file/u));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The content-only answer must fail toward releasing. A rename is reported under
// its NEW name alone by default, so a prompt moved into content/editions/ would
// read as an edition without `--no-renames`; a ledger naming a commit this
// checkout has never seen cannot be diffed at all and must release.
test('a rename into published content is still a release, and an undiffable ledger releases', async () => {
  const { contentOnlyChange } = await import('./release-git.mjs');
  const world = releaseWorld();
  try {
    mkdirSync(path.join(world.repo, 'content', 'editions', '2026-10-02'), { recursive: true });
    writeFileSync(path.join(world.repo, 'content', 'editions', '2026-10-02', 'one.json'), '{}\n');
    const edition = world.commit('edition');
    assert.deepEqual(contentOnlyChange(world.repo, world.head, edition), { changed: ['content/editions/2026-10-02/one.json'], contentOnly: true });
    world.git('mv', 'agentic-org/Spawnfile', 'content/editions/2026-10-02/Spawnfile');
    const moved = world.commit('smuggle');
    assert.equal(contentOnlyChange(world.repo, edition, moved).contentOnly, false);
    assert.equal(contentOnlyChange(world.repo, '0'.repeat(40), moved), null);
  } finally { rmSync(world.root, { recursive: true, force: true }); }
});
