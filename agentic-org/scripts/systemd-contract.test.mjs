import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';

const unitDir = new URL('../ops/systemd/', import.meta.url);
const unit = (name) => readFileSync(new URL(name, unitDir), 'utf8');
// ENUMERATED, not listed. This once read a fixed list of three units, so the units added
// when the corpus moved out of the image -- corpus-refresh, epoch-roll (since retired), release
// -- were outside the one contract that is supposed to hold for every host job,
// and nothing said so. An allowlist of names stops covering the thing you add
// next, silently, which is the same defect as a test that restates the number it
// guards. The template unit has its own test below.
const serviceUnits = readdirSync(unitDir).filter((name) => name.endsWith('.service') && !name.includes('@')).sort();

test('every host job unit is covered, and the list cannot fall behind the directory', () => {
  assert.ok(serviceUnits.length >= 6, `expected at least the six known host job units, found ${serviceUnits.length}: ${serviceUnits.join(', ')}`);
  for (const name of ['clank-publish.service', 'clank-cycle-audit.service', 'clank-feed-corpus.service', 'clank-feed-content.service', 'clank-feed-private-tools.service', 'clank-release.service'])
    assert.ok(serviceUnits.includes(name), `${name} is missing from ops/systemd -- a host job unit must be tracked in the repository`);
});

test('host job units do not require the retired alarm EnvironmentFile before ExecStart', () => {
  for (const name of serviceUnits) {
    const text = unit(name);
    assert.doesNotMatch(text, /EnvironmentFile=\/etc\/clank-alarm\/alarm\.env/u, `${name} must not fail before ExecStart on the retired alarm env file`);
    assert.match(text, /OnFailure=clank-alarm@%n\.service/u, `${name} must still raise the alarm on service failure`);
  }
});

test('the alarm handler itself uses the local standalone recorder, not the retired ntfy environment', () => {
  const text = unit('clank-alarm@.service');
  assert.doesNotMatch(text, /^EnvironmentFile=.*alarm\.env$/mu, 'the retired env file must not block or configure the local alarm');
  assert.doesNotMatch(text, /^ExecStart=.*alarm\.mjs/mu, 'the handler must not reactivate the legacy network alarm');
  assert.match(text, /^Environment=CLANK_ALARM_SCOPE=--system$/mu, 'system units must read systemd state through the system manager');
  assert.match(text, /^StateDirectory=clank-alarm$/mu, 'the local alarm must have a durable systemd-owned log directory');
  assert.match(text, /^ExecStart=\/usr\/local\/lib\/clank-alarm\/clank-alarm\.sh %i$/mu, 'the standalone local recorder must run');
});

// One writer across every newsroom volume and the release job: every fed-volume
// refresh runs under the release unit's flock(1) lock. Two different paths would be mutual exclusion that only one
// side observes, which reads as protection and is none.
test('the fed-volume refreshes and the release job serialize on one lock', () => {
  const lock = '/run/lock/clank-corpus-refresh\\.lock';
  assert.match(unit('clank-release.service'), new RegExp(`^ExecStart=/usr/bin/flock ${lock} `, 'mu'));
  for (const [kind, id] of [['content', 'public-content-volume'], ['private-tools', 'newsroom-private-tools'], ['corpus', 'research-corpus']]) {
    const service = unit(`clank-feed-${kind}.service`);
    assert.match(service, new RegExp(`^ExecStart=/usr/bin/flock -n -E 0 ${lock} \\S+node \\S+/dist/cli/index\\.js volume refresh ${id} /root/work/clankandslop/agentic-org$`, 'mu'), kind);
    assert.match(unit(`clank-feed-${kind}.timer`), new RegExp(`^Unit=clank-feed-${kind}\\.service$`, 'mu'), kind);
  }
  assert.match(unit('clank-feed-content.service'), /^Environment="GIT_SSH_COMMAND=ssh -i \/root\/\.ssh\/clank_public -o IdentitiesOnly=yes"$/mu, 'the public fetch names the release identity, quoted so systemd keeps the whole value');
});

// The release is `spawnfile release`. Each assertion is a property a past or
// likely regression would break: Node claims `--env-file` from the script's
// argv, a deferral (75) must not page hourly, the private control token must be
// installed before the release counts, the source must be pulled first, and the
// host's local Daimon receipt stays pinned until the published one carries the
// attention attestation.
test('the release unit runs a drained spawnfile release from the pulled checkout', () => {
  const text = unit('clank-release.service');
  const exec = text.match(/^ExecStart=(.*)$/mu)?.[1] ?? '';
  const argv = exec.split(' ');
  const flag = (name) => argv[argv.indexOf(name) + 1];
  assert.match(exec, /\/dist\/cli\/index\.js release \/root\/work\/clankandslop\/agentic-org /u);
  assert.equal(flag('--deployment'), 'clank-and-slop');
  assert.equal(flag('--runtime-env-file'), '/home/clank/deploy-work/deploy.env');
  assert.ok(!argv.includes('--env-file'), 'Node itself claims --env-file from the argv; use --runtime-env-file');
  assert.ok(!argv.includes('--no-drain'), 'production runs Daimon with drain/resume; never deploy over running turns');
  assert.match(flag('--drain-timeout'), /^\d+m$/u);
  const notifier = flag('--notify-command');
  assert.equal(notifier, '/root/work/clankandslop/agentic-org/scripts/release-notify.mjs');
  assert.ok(statSync(new URL('./release-notify.mjs', import.meta.url)).mode & 0o111, 'the notifier is executed directly, so it must be executable');
  assert.equal(flag('--post-deploy-command'), '/bin/sh');
  const hookArgs = argv.flatMap((value, index) => (argv[index - 1] === '--post-deploy-arg' ? [value] : []));
  assert.deepEqual(hookArgs, ['/root/work/clankandslop/clankandslop-private/newsroom/runtime/bootstrap-control-token.sh', 'spawnfile-clank-and-slop']);
  assert.match(text, /^SuccessExitStatus=75$/mu, 'a deferred release is not a unit failure');
  assert.match(text, /^ExecStartPre=\/usr\/bin\/flock \/run\/lock\/clank-corpus-refresh\.lock \/usr\/bin\/git -C \/root\/work\/clankandslop pull --ff-only/mu);
  assert.match(text, /^Environment=SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY=\/home\/clank\/deploy-work\/grok-runtime-identity-20261009b\.json$/mu);
  assert.match(text, /^Environment="GIT_SSH_COMMAND=ssh -i \/root\/\.ssh\/clank_public -o IdentitiesOnly=yes"$/mu);
  const timeout = Number(text.match(/^TimeoutStartSec=(\d+)$/mu)?.[1]);
  assert.ok(timeout >= Number(flag('--drain-timeout').slice(0, -1)) * 60 + 1200, 'the unit must outlast build + drain bound + deploy + post-deploy');
});

// D1 (daimon-harness#42) fixed the leaked engine-broker handlers at the source
// and is live, so the reaper is retired. It must not come back by accident.
test('the retired seam and reaper units stay retired', () => {
  for (const name of ['clank-seam.service', 'clank-seam.timer', 'clank-handler-reaper.service', 'clank-handler-reaper.timer'])
    assert.ok(!readdirSync(unitDir).includes(name), `${name} is retired`);
});
