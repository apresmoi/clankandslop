import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SeamError, rollEpoch } from './seam-run.mjs';
import { BLOCKED_MESSAGE, EPOCH_STAGES, IMAGE_PREFIX, epochRoll, inspectContainer, parseArgs, resolveImage } from './epoch-roll-run.mjs';

const now = new Date('2026-10-02T03:30:00Z');
const noop = () => {};
const RUNNING = 'clank-and-slop:seam-2026-10-01-061603';

// Every stage a no-op that writes its own name down, plus the options it was
// handed — the tag this unit passes to `deploy` is the whole point, so it has to
// be observable and not merely plausible.
function recorder(failAt, error = new SeamError('boom', 'deploy-failed'), rolled = { previous: 'clank-2026-10-01', epoch: 'clank-2026-10-02', rolled: true }) {
  const calls = [];
  const tags = [];
  const stage = (name) => (options) => {
    calls.push(name); tags.push(options.tag);
    if (name === failAt) throw error;
    return name === 'rollEpoch' ? rolled : options;
  };
  return { calls, tags, impl: Object.fromEntries(Object.keys(EPOCH_STAGES).map((name) => [name, stage(name)])) };
}
const alarms = () => { const raised = []; return { raised, alarm: (reason, detail) => raised.push({ reason, ...detail }) }; };
// The image is resolved from the box, so every pipeline test injects it. The
// resolver itself is exercised directly further down.
const resolved = (epoch = 'clank-2026-10-01') => () => ({ tag: RUNNING, source: 'running container spawnfile-clank-and-slop', epoch });

test('this unit reuses the seam own stages rather than carrying copies of them', () => {
  // A second copy of `gate` would be a second opinion about whether a wake is in
  // flight, and the one that is not exercised every release is the one that
  // drifts. The recreate here is as dangerous as the release one and gets the
  // identical gate.
  assert.deepEqual(Object.keys(EPOCH_STAGES), ['gate', 'rollEpoch', 'deploy', 'settle', 'runtimeBootstrap']);
  assert.equal(EPOCH_STAGES.rollEpoch, rollEpoch);
  assert.ok(!('build' in EPOCH_STAGES), 'this unit must never be able to build');
});

test('the happy path is gate, rollEpoch, deploy, settle, runtimeBootstrap — on the image already running', () => {
  const { calls, tags, impl } = recorder(null);
  const result = epochRoll([], { now, log: noop, alarm: noop, stageImpl: impl, resolve: resolved() });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['gate', 'rollEpoch', 'deploy', 'settle', 'runtimeBootstrap']);
  // The tag handed to `deploy` is the one resolved from the box, never a freshly
  // minted `seam-<today>` that no image exists for.
  assert.deepEqual(new Set(tags), new Set([RUNNING]));
  assert.equal(result.tag, RUNNING);
  assert.equal(result.epoch, 'clank-2026-10-02');
});

test('a refused gate blocks the roll, names the newsroom as alive, and never recreates', () => {
  const { calls, impl } = recorder('gate', new SeamError('refusing to touch the deployment — vesta woke 6 min ago', 'seam-blocked'));
  const { raised, alarm } = alarms();
  const result = epochRoll([], { now, log: noop, alarm, stageImpl: impl, resolve: resolved() });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'epoch-roll-blocked');
  assert.deepEqual(calls, ['gate']);
  assert.deepEqual(raised.map((entry) => entry.reason), ['epoch-roll-blocked']);
  // The pager has to say the paper is still coming out. A blocked roll is a
  // newsroom sharing yesterday's budget window, not a dead one.
  assert.ok(raised[0].message.includes(BLOCKED_MESSAGE), raised[0].message);
  assert.match(raised[0].message, /RUNNING and degraded, not dead/u);
  assert.equal(raised[0].edition, '2026-10-02');
  assert.match(raised[0].detail, /vesta woke 6 min ago/u);
});

test('a failure after the gate is epoch-roll-failed, not blocked', () => {
  for (const failAt of ['rollEpoch', 'deploy', 'settle', 'runtimeBootstrap']) {
    const { impl } = recorder(failAt, new SeamError(`${failAt} exploded`, 'deploy-failed'));
    const { raised, alarm } = alarms();
    const result = epochRoll([], { now, log: noop, alarm, stageImpl: impl, resolve: resolved() });
    assert.equal(result.ok, false, failAt);
    assert.equal(result.reason, 'epoch-roll-failed', failAt);
    assert.deepEqual(raised.map((entry) => entry.reason), ['epoch-roll-failed'], failAt);
    assert.ok(!raised[0].message.includes(BLOCKED_MESSAGE), failAt);
  }
});

test('an epoch that is already today never recreates the container', () => {
  // A recreate kills in-flight wakes and restarts twelve agents. With nothing to
  // change it is pure risk, so the skip is real — but it is decided on what the
  // CONTAINER reports, not on what the env file says.
  const { calls, impl } = recorder(null, undefined, { previous: 'clank-2026-10-02', epoch: 'clank-2026-10-02', rolled: false });
  const result = epochRoll([], { now, log: noop, alarm: noop, stageImpl: impl, resolve: resolved('clank-2026-10-02') });
  assert.equal(result.ok, true);
  assert.equal(result.noop, true);
  assert.deepEqual(calls, ['gate', 'rollEpoch']);
  assert.ok(!calls.includes('deploy'));
});

test('an env file that already says today but a container that does not is still recreated', () => {
  // The failure this closes: a deploy that died after a successful roll leaves
  // today's epoch on disk and yesterday's in the running container. Skipping on
  // the file alone would strand the newsroom on yesterday's budget with nothing
  // ever retrying it.
  const { calls, impl } = recorder(null, undefined, { previous: 'clank-2026-10-02', epoch: 'clank-2026-10-02', rolled: false });
  const result = epochRoll([], { now, log: noop, alarm: noop, stageImpl: impl, resolve: resolved('clank-2026-10-01') });
  assert.equal(result.ok, true);
  assert.equal(result.noop, undefined);
  assert.deepEqual(calls, ['gate', 'rollEpoch', 'deploy', 'settle', 'runtimeBootstrap']);
});

test('an image it cannot resolve is a refusal, and deploy is never reached', () => {
  const { calls, impl } = recorder(null);
  const { raised, alarm } = alarms();
  const result = epochRoll([], {
    now, log: noop, alarm, stageImpl: impl,
    resolve: () => { throw new SeamError('cannot resolve the image spawnfile-clank-and-slop is running', 'epoch-roll-failed'); }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'epoch-roll-failed');
  assert.deepEqual(calls, [], 'not even the gate runs before the image is known');
  assert.ok(!calls.includes('deploy'));
  assert.deepEqual(raised.map((entry) => entry.reason), ['epoch-roll-failed']);
});

// --- resolving the image, which is the one thing it must not guess at ---------
const options = { container: 'spawnfile-clank-and-slop', deployment: 'clank-and-slop' };
const dockerThat = (config, { imagePresent = true } = {}) => (command, args) => {
  if (args[0] === 'inspect' && args[1] === 'spawnfile-clank-and-slop') {
    if (config === null) throw new Error('No such object');
    return { toString: () => JSON.stringify(config) };
  }
  if (args[0] === 'image' && args[1] === 'inspect') {
    if (!imagePresent) throw new Error(`No such image: ${args[2]}`);
    return { toString: () => '[]' };
  }
  throw new Error(`unexpected docker ${args.join(' ')}`);
};
const envOf = (epoch) => [`DAIMON_WAKE_FUSE_EPOCH=${epoch}`, 'OTHER=1'];

test('the image and the epoch both come from one read of the running container', () => {
  const observed = inspectContainer(options, { log: noop, exec: dockerThat({ Image: RUNNING, Env: envOf('clank-2026-10-01') }) });
  assert.deepEqual(observed, { image: RUNNING, epoch: 'clank-2026-10-01' });
  const resolvedImage = resolveImage(options, { log: noop, exec: dockerThat({ Image: RUNNING, Env: envOf('clank-2026-10-01') }), read: () => { throw new Error('the record must not be needed'); } });
  assert.deepEqual(resolvedImage, { tag: RUNNING, source: 'running container spawnfile-clank-and-slop', epoch: 'clank-2026-10-01' });
});

test('an uninspectable container falls back to the deployment record, and refuses when that is empty too', () => {
  const record = JSON.stringify({ version: 'spawnfile.deployment.v2', units: [{ container_name: 'spawnfile-clank-and-slop', image_tag: RUNNING }] });
  const fallback = resolveImage(options, { log: noop, exec: dockerThat(null), read: () => record });
  assert.equal(fallback.tag, RUNNING);
  assert.match(fallback.source, /deployment record/u);
  // Nothing readable anywhere: a unit whose job is one env line must never be
  // able to roll the newsroom onto a different build, so "I could not tell" and
  // "this image" must not produce the same recreate.
  assert.throws(() => resolveImage(options, { log: noop, exec: dockerThat(null), read: () => { throw new Error('ENOENT'); } }),
    (error) => error.reason === 'epoch-roll-failed' && /refusing to recreate the newsroom without knowing which build/u.test(error.message));
});

test('a foreign image, or one docker cannot find locally, is refused before anything is touched', () => {
  assert.throws(() => resolveImage(options, { log: noop, exec: dockerThat({ Image: 'ubuntu:24.04', Env: [] }), read: () => '{}' }),
    (error) => error.reason === 'epoch-roll-failed' && error.message.includes(IMAGE_PREFIX));
  assert.throws(() => resolveImage(options, { log: noop, exec: dockerThat({ Image: RUNNING, Env: [] }, { imagePresent: false }), read: () => '{}' }),
    (error) => error.reason === 'epoch-roll-failed' && /docker cannot find it locally/u.test(error.message));
});

test('check mode stops after the gate and writes nothing', () => {
  const { calls, impl } = recorder(null);
  const result = epochRoll(['--check'], { now, log: noop, alarm: noop, stageImpl: impl, resolve: resolved() });
  assert.equal(result.ok, true);
  assert.equal(result.check, true);
  assert.deepEqual(calls, ['gate']);
});

test('the edition defaults to today in Berlin, and a malformed argument is refused before anything runs', () => {
  const { impl } = recorder(null);
  assert.equal(epochRoll([], { now, log: noop, alarm: noop, stageImpl: impl, resolve: resolved() }).edition, '2026-10-02');
  assert.equal(parseArgs(['--edition=2026-10-05']).edition, '2026-10-05');
  assert.throws(() => parseArgs(['--edition=tomorrow']), SeamError);
  assert.throws(() => parseArgs(['--tag=clank-and-slop:local7']), SeamError, 'choosing an image is exactly what this unit may not do');
  const { raised, alarm } = alarms();
  assert.equal(epochRoll(['--nonsense'], { now, log: noop, alarm, stageImpl: recorder(null).impl, resolve: resolved() }).ok, false);
  assert.deepEqual(raised.map((entry) => entry.reason), ['epoch-roll-failed']);
});

test('the roll it performs is the seam own rollEpoch, against a real env file', () => {
  // Not a stub: the one write this unit makes is the env line, and `rolled`
  // deciding the recreate means a wrong answer here is a wrong recreate.
  const root = mkdtempSync(path.join(tmpdir(), 'clank-epoch-roll-'));
  const envFile = path.join(root, 'deploy.env');
  try {
    writeFileSync(envFile, 'DAIMON_WAKE_FUSE_EPOCH=clank-2026-10-01\nCLANK_RUNTIME_TOKEN=secret\n');
    const first = rollEpoch({ envFile, edition: '2026-10-02' }, { log: noop, now });
    assert.deepEqual([first.previous, first.epoch, first.rolled], ['clank-2026-10-01', 'clank-2026-10-02', true]);
    const written = readFileSync(envFile, 'utf8');
    assert.match(written, /^DAIMON_WAKE_FUSE_EPOCH=clank-2026-10-02$/mu);
    assert.match(written, /^CLANK_RUNTIME_TOKEN=secret$/mu, 'it rewrites one line and leaves the rest alone');
    assert.equal(rollEpoch({ envFile, edition: '2026-10-02' }, { log: noop, now }).rolled, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
