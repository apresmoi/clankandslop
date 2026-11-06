import test from 'node:test';
import assert from 'node:assert/strict';
import { CACHE_PRUNE, cleanup, plan, releaseTags } from './release-disk-cleanup.mjs';

const ledger = JSON.stringify({
  version: 'spawnfile.release-ledger.v1',
  image_tag: 'clank-and-slop:r-current',
  previous_image_tag: 'clank-and-slop:r-previous',
});

// The host on 2026-11-06, plus the cases a careless prune would take.
const images = [
  { Id: 'sha256:current', RepoTags: ['clank-and-slop:r-current'], RepoDigests: [] },
  { Id: 'sha256:previous', RepoTags: ['clank-and-slop:r-previous'], RepoDigests: [] },
  { Id: 'sha256:stale', RepoTags: ['clank-and-slop:r-stale', 'clank-and-slop:r-stale-alias'], RepoDigests: [], Size: 5e9 },
  { Id: 'sha256:stopped', RepoTags: ['clank-and-slop:r-stopped'], RepoDigests: [] },
  { Id: 'sha256:rollback', RepoTags: ['clank-rollback:r-26afcbbe8cf9'], RepoDigests: [] },
  { Id: 'sha256:mixed', RepoTags: ['clank-and-slop:r-old', 'clank-rollback:r-old'], RepoDigests: [] },
  { Id: 'sha256:mirror', RepoTags: ['clank-mirror-moltnet:0.1.20'], RepoDigests: [] },
  { Id: 'sha256:registry', RepoTags: ['registry:2'], RepoDigests: [] },
  { Id: 'sha256:pinned', RepoTags: [], RepoDigests: ['noopolis/spawnfile-runtime-daimon@sha256:8216'] },
  { Id: 'sha256:dangling', RepoTags: [], RepoDigests: [], Size: 1e8 },
];
const containerImageIds = ['sha256:current', 'sha256:stopped', 'sha256:registry'];

test('only unused release images and undigested leftovers are removed', () => {
  const { remove, kept } = plan({ images, containerImageIds, keepTags: releaseTags(ledger), repository: 'clank-and-slop' });
  assert.deepEqual(remove.map(({ ref }) => ref), ['clank-and-slop:r-stale', 'clank-and-slop:r-stale-alias', 'sha256:dangling']);
  const reason = Object.fromEntries(kept.map(({ id, reason }) => [id, reason]));
  assert.equal(reason['sha256:current'], 'used by a container');
  assert.equal(reason['sha256:stopped'], 'used by a container', 'a stopped container still holds its image');
  assert.equal(reason['sha256:previous'], 'current or previous release', 'the rollback image survives with no container');
  assert.equal(reason['sha256:rollback'], 'rollback image');
  assert.equal(reason['sha256:mixed'], 'rollback image', 'a rollback tag protects every tag on that image');
  assert.equal(reason['sha256:mirror'], 'not a release image');
  assert.equal(reason['sha256:pinned'], 'digest-pinned pull');
});

test('the ledger must vouch for the rollback pair', () => {
  assert.deepEqual(releaseTags(ledger), ['clank-and-slop:r-current', 'clank-and-slop:r-previous']);
  assert.equal(releaseTags(''), null);
  assert.equal(releaseTags('{"version":"other","image_tag":"x:y"}'), null);
});

const fakeDocker = (calls, { failRm = false } = {}) => (args) => {
  calls.push(args.join(' '));
  if (args[0] === 'builder') return 'Total:\t2.1GB\n';
  if (args[0] === 'ps') return 'c1\nc2\nc3\n';
  if (args[0] === 'inspect') return `${containerImageIds.join('\n')}\n`;
  if (args.join(' ') === 'image ls --quiet --no-trunc') return `${images.map(({ Id }) => Id).join('\n')}\n`;
  if (args[1] === 'inspect') return JSON.stringify(images);
  if (args[1] === 'rm') { if (failRm) throw new Error('conflict'); return ''; }
  throw new Error(`unexpected docker ${args.join(' ')}`);
};

test('a run prunes cache older than a day and never forces, prunes volumes or touches containers', () => {
  const calls = [];
  assert.equal(cleanup({ ledgerText: ledger, repository: 'clank-and-slop', docker: fakeDocker(calls), log: () => {} }), 0);
  assert.equal(calls[0], CACHE_PRUNE.join(' '));
  assert.equal(CACHE_PRUNE.join(' '), 'builder prune --filter until=24h -f');
  assert.deepEqual(calls.filter((call) => call.startsWith('image rm')), ['image rm clank-and-slop:r-stale', 'image rm clank-and-slop:r-stale-alias', 'image rm sha256:dangling']);
  for (const call of calls) {
    assert.doesNotMatch(call, /volume|system prune|--force|container rm|\b(stop|kill|restart)\b|--all.*prune/u, call);
    if (call.startsWith('image rm')) assert.doesNotMatch(call, / -f\b/u);
  }
});

test('a dry run removes nothing', () => {
  const calls = [], log = [];
  cleanup({ ledgerText: ledger, repository: 'clank-and-slop', dryRun: true, docker: fakeDocker(calls), log: (line) => log.push(line) });
  assert.ok(!calls.some((call) => call.startsWith('builder') || call.includes(' rm ')));
  assert.ok(log.includes('would remove clank-and-slop:r-stale (sha256:stale, 4.66 GiB)'));
});

test('without a ledger it prunes cache only, and a Docker refusal is reported, not forced', () => {
  const calls = [];
  assert.equal(cleanup({ ledgerText: '', repository: 'clank-and-slop', docker: fakeDocker(calls), log: () => {} }), 0);
  assert.deepEqual(calls, [CACHE_PRUNE.join(' ')]);
  assert.equal(cleanup({ ledgerText: ledger, repository: 'clank-and-slop', docker: fakeDocker([], { failRm: true }), log: () => {} }), 1);
});
