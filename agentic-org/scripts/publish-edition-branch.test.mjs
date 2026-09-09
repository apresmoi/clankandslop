import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBylinesTsv } from './build-bylines-tsv.mjs';
import { buildTopicsTxt } from './build-topics-txt.mjs';
import { bundleDescriptorFindings, repinSource } from './check-bundle-descriptor.mjs';
import {
  BASE_BRANCH, DESCRIPTOR_FILE, GENERATED_INDEX_PATHS, REPINNED_DESCRIPTOR_PATHS, EDITION_PUSH_REMOTE, GITHUB_HOST_KEYS, PROTECTED_REFS, PUSH_REMOTES,
  artifactDigest, assertNoForcedPush, assertNotProtectedRef, assertPushableRef, assertRequestedEdition, berlinToday,
  editionBranch, editionCommitMessage,
  parseArguments, prepareSshIdentity, publishEditionBranch, pushArgv, pushStagedEditionTree,
  regenerateIndexes, repinBundleDescriptor, remoteUrl, resolveStagedEdition, sshConfig
} from './publish-edition-branch.mjs';

const scratch = (label) => mkdtempSync(join(tmpdir(), `clank-${label}-`));
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'seed', GIT_AUTHOR_EMAIL: 'seed@example.invalid', GIT_COMMITTER_NAME: 'seed', GIT_COMMITTER_EMAIL: 'seed@example.invalid' } }).trim();

// A real remote, on disk. Everything below pushes to it for real, so a guard
// that only *claims* to stop a push to main has somewhere to be caught out.
// The base branch carries what the real one carries: the topic registry, and
// the two generated views ci.yml regenerates and diffs. Without them there is
// nothing for the drift check to be wrong about.
const TOPICS_JSON = { topics: { oil: { name: 'Oil', blurb: 'Crude and products.' }, rates: { name: 'Rates', blurb: 'Policy rates.' } } };

function remote({ descriptor = true } = {}) {
  const root = scratch('remote');
  const bare = join(root, 'origin.git'), seed = join(root, 'seed');
  mkdirSync(bare); mkdirSync(seed);
  git(['init', '-q', '--bare', '-b', BASE_BRANCH], bare);
  git(['init', '-q', '-b', BASE_BRANCH], seed);
  writeFileSync(join(seed, 'README.md'), '# seed\n');
  mkdirSync(join(seed, 'content', 'bylines'), { recursive: true });
  writeFileSync(join(seed, 'content', 'topics.json'), JSON.stringify(TOPICS_JSON));
  buildTopicsTxt(seed);
  buildBylinesTsv(seed);
  writeFileSync(join(seed, 'content', 'bylines', '.keep'), '');
  if (descriptor) seedDescriptor(seed);
  git(['add', '--', 'README.md', 'content', ...(descriptor ? ['agentic-org'] : [])], seed);
  // Repin against the staged tree so the seed is self-consistent, exactly as
  // `main` is: descriptor digest == a fresh measurement, and every Spawnfile
  // pins it. That is the state an edition branch is cut from.
  if (descriptor) {
    repinSource(seed);
    git(['add', '--', 'agentic-org'], seed);
  }
  git(['commit', '-q', '-m', 'chore: seed'], seed);
  git(['push', '-q', bare, `refs/heads/${BASE_BRANCH}:refs/heads/${BASE_BRANCH}`], seed);
  return {
    root, url: bare,
    head: () => git(['rev-parse', `refs/heads/${BASE_BRANCH}`], bare),
    refs: () => git(['for-each-ref', '--format=%(refname)'], bare).split('\n').filter(Boolean),
    // Stands in for merge-edition.yml: the edition branch lands on the base.
    merge: (commit) => git(['update-ref', `refs/heads/${BASE_BRANCH}`, commit], bare)
  };
}

// The smallest tree `measureSourceArchive` will measure: the two entrypoints it
// requires unconditionally, one Spawnfile carrying a pin, and a descriptor.
function seedDescriptor(root) {
  mkdirSync(join(root, 'agentic-org', 'scripts'), { recursive: true });
  mkdirSync(join(root, 'agentic-org', 'agents', 'cogsworth'), { recursive: true });
  writeFileSync(join(root, 'agentic-org', 'scripts', 'production-newsroom.mjs'), 'export const newsroom = 1;\n');
  writeFileSync(join(root, 'agentic-org', 'scripts', 'production-newsroom-mcp.mjs'), 'export const mcp = 1;\n');
  const zero = `sha256:${'0'.repeat(64)}`;
  writeFileSync(join(root, 'agentic-org', 'agents', 'cogsworth', 'Spawnfile'),
    `agent: cogsworth\n    - { id: public-content, kind: bundle, source: ../../newsroom-runtime.tar, sha256: ${zero}, mount: ./repos/newsroom, mode: readonly }\n`);
  writeFileSync(join(root, 'agentic-org', 'newsroom-runtime-bundle.json'),
    `${JSON.stringify({ version: 'clank.newsroom-runtime-bundle.v2', source: { archive: 'newsroom-runtime.tar', sha256: zero, file_count: 0, content_bytes: 0 } }, null, 2)}\n`);
}

function stagedEdition(edition) {
  const root = scratch('staged');
  const directory = join(root, 'content', 'editions', edition);
  mkdirSync(join(directory, 'articles'), { recursive: true });
  // A real article row, so the byline index the base branch carries genuinely
  // goes stale the moment this edition is added to the tree.
  writeFileSync(join(directory, 'articles', 'one.json'), `${JSON.stringify({ id: 'one', edition_date: edition, section: 'world', epistemic: 'fact', topics: ['oil'], headline: 'A headline', byline: { desk: 'Test Desk', agents: ['Cogsworth'] } })}\n`);
  return { root, source: directory, path: `content/editions/${edition}` };
}

// Exactly what ci.yml does: run both generators over the checked-out tree, run
// the bundle descriptor check, and require neither to find anything. The
// descriptor half is the one an edition branch used to fail unconditionally —
// `content/editions/**` is inside the source archive, so landing an edition
// moves the digest — and it is what made an unattended merge impossible.
function ciDriftCheck(workdir) {
  buildTopicsTxt(workdir);
  buildBylinesTsv(workdir);
  const findings = bundleDescriptorFindings(workdir);
  return [git(['status', '--porcelain'], workdir), ...findings].filter(Boolean).join('\n');
}

test('the edition branch is derived from the date and nothing else may be pushed', () => {
  assert.equal(editionBranch('2026-09-05'), 'edition/2026-09-05');
  assert.equal(assertPushableRef('edition/2026-09-05'), 'edition/2026-09-05');
  for (const ref of ['main', 'refs/heads/main', 'edition/main', 'master', 'staging', 'gh-pages', 'HEAD', 'edition/../main', 'edition/2026-09-05/../../main', 'edition/2026-9-5', 'edition/', '', 'edition/2026-09-05 ', undefined, 42])
    assert.throws(() => assertPushableRef(ref), /not an edition branch|protected ref|well-formed/u, String(ref));
});

test('the protected-ref refusal stands on its own, whatever the branch pattern allows', () => {
  assert.equal(assertNotProtectedRef('edition/2026-09-05'), 'edition/2026-09-05');
  assert.equal(assertNotProtectedRef('release/candidate'), 'release/candidate');
  for (const ref of ['main', 'refs/heads/main', 'edition/main', 'master', 'staging', 'gh-pages', 'HEAD', 'topic/HEAD', 'edition/../main', 'edition//2026-09-05', 'edition/./x'])
    assert.throws(() => assertNotProtectedRef(ref), /protected ref|well-formed/u, ref);
  assert.throws(() => assertNotProtectedRef(7), /must be a string/u);
});

test('the push argv is fast-forward, single-ref, and refuses every destructive flag', () => {
  assert.deepEqual(pushArgv('git@host:owner/repo.git', 'edition/2026-09-05'), ['push', '--porcelain', 'git@host:owner/repo.git', 'refs/heads/edition/2026-09-05:refs/heads/edition/2026-09-05']);
  assert.throws(() => pushArgv('git@host:owner/repo.git', 'main'), /not an edition branch|protected ref/u);
  for (const argument of ['-f', '--force', '--force-with-lease', '--mirror', '--delete', '-d', '--all', '--tags', '--prune', '--receive-pack=evil', '+refs/heads/main:refs/heads/main', '+edition/2026-09-05', ':refs/heads/main'])
    assert.throws(() => assertNoForcedPush(['push', argument]), /refused|forced refspec|deletes a remote ref/u, argument);
  assert.throws(() => assertNoForcedPush(['push', 7]), /must be strings/u);
});

test('the publisher may only ever address the public repository', () => {
  assert.equal(EDITION_PUSH_REMOTE, 'clankandslop');
  assert.equal(remoteUrl(EDITION_PUSH_REMOTE), 'git@clankandslop.deploy:apresmoi/clankandslop.git');
  // The private repository is not in the table at all: nothing here reaches it.
  assert.deepEqual(Object.keys(PUSH_REMOTES), ['clankandslop']);
  for (const name of ['main', 'master', 'staging', 'gh-pages', 'HEAD']) assert.ok(PROTECTED_REFS.includes(name), name);
});

test('the ssh config binds the operator key per remote and pins the host key', () => {
  const rendered = sshConfig('/scratch', '/keys/clankandslop');
  for (const declared of Object.values(PUSH_REMOTES)) {
    assert.match(rendered, new RegExp(`Host ${declared.alias}\\n  HostName ${declared.host}\\n  User git\\n  IdentityFile /keys/clankandslop\\n  IdentitiesOnly yes`, 'u'));
  }
  assert.match(rendered, /StrictHostKeyChecking yes/u);
  assert.match(rendered, /UserKnownHostsFile \/scratch\/known_hosts/u);
  assert.ok(GITHUB_HOST_KEYS.every((line) => line.startsWith('github.com ssh-ed25519 ')));
});

test('the ssh identity references the operator key and never copies it', async () => {
  const root = scratch('identity');
  const keyFile = join(root, 'clankandslop');
  writeFileSync(keyFile, 'PRIVATE-KEY-MATERIAL\n', { mode: 0o600 });
  const directory = join(root, 'ssh');
  const identity = await prepareSshIdentity(directory, keyFile);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(identity.configFile).mode & 0o777, 0o600);
  assert.match(identity.sshCommand, /^ssh -F .*\/config -o BatchMode=yes$/u);
  // The key stays exactly where the operator put it: nothing in the scratch
  // directory contains the material, only a path to it.
  for (const name of readdirSync(directory)) assert.doesNotMatch(readFileSync(join(directory, name), 'utf8'), /PRIVATE-KEY-MATERIAL/u, name);
  assert.match(readFileSync(identity.configFile, 'utf8'), new RegExp(`IdentityFile ${keyFile}`, 'u'));
  await assert.rejects(prepareSshIdentity(directory, join(root, 'absent')), /is not readable/u);
  await assert.rejects(prepareSshIdentity(directory, 'relative/key'), /must be absolute/u);
  await assert.rejects(prepareSshIdentity(directory, root), /is not a file/u);
});

// Shapes a promoted artifact the way stage_release does, and the receipt the
// way pressman writes it FROM INSIDE THE CONTAINER: `staging_root` is the
// workspace symlink pressman sees, which is not the path the host reads the
// same volume at. A receipt binding that compares those two strings refuses
// every real artifact; verified against the first one ever produced, on the box
// on 2026-09-06.
const CONTAINER_STAGING = '/var/lib/spawnfile/instances/daimon/daimon-organization/workspace/agents/pressman/staging';
async function promoted(edition, short, seed = '{"page":"front"}\n') {
  const root = scratch('staging'), artifact = `${edition}-${short}`;
  const directory = join(root, artifact, 'content', 'editions', edition);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'front.json'), seed);
  symlinkSync(artifact, join(root, 'current-edition'));
  const state = scratch('state'), receipts = join(state, 'editions', edition, 'receipts');
  mkdirSync(receipts, { recursive: true });
  const receipt = {
    version: 'clank.newsroom-release-receipt.v1', state: 'staged', edition,
    composition_digest: `sha256:${short}${'0'.repeat(48)}`,
    artifact_digest: await artifactDigest(join(root, artifact)),
    staging_root: `${CONTAINER_STAGING}/${artifact}`
  };
  const file = join(receipts, `staged-${short}.json`);
  const write = (value) => writeFileSync(file, JSON.stringify(value));
  write(receipt);
  return { root, state, artifact, artifactPath: join(root, artifact), receipts, receipt, write };
}

test('only a promoted artifact can be resolved, and the receipt must agree with it', async () => {
  const root = scratch('staging');
  await assert.rejects(resolveStagedEdition(root), /no promoted edition/u);
  await assert.rejects(resolveStagedEdition('relative'), /must be an absolute path/u);
  const staged = await promoted('2026-09-05', 'abcdef0123456789');
  const resolved = await resolveStagedEdition(staged.root);
  assert.equal(resolved.edition, '2026-09-05');
  assert.equal(resolved.editionPath, 'content/editions/2026-09-05');
  // The receipt pressman actually writes — container path and all — is ACCEPTED.
  // This is the case the old path comparison refused, and the reason `--state`
  // could never be passed by an unattended timer.
  assert.equal((await resolveStagedEdition(staged.root, { stateRoot: staged.state })).receipt.state, 'staged');
  // A receipt naming a different artifact directory is still refused, whatever
  // volume it was written against: the directory NAME is the artifact identity.
  staged.write({ ...staged.receipt, staging_root: `${CONTAINER_STAGING}/2026-09-05-0123456789abcdef` });
  await assert.rejects(resolveStagedEdition(staged.root, { stateRoot: staged.state }), /but current-edition points at/u);
  // And the name has to be the one stage_release derives from the composition
  // it recorded, so a promoted directory that belongs to another composition
  // cannot be published under this receipt.
  staged.write({ ...staged.receipt, composition_digest: `sha256:${'b'.repeat(64)}` });
  await assert.rejects(resolveStagedEdition(staged.root, { stateRoot: staged.state }), /is not the artifact this composition produced/u);
  staged.write({ ...staged.receipt, artifact_digest: undefined });
  await assert.rejects(resolveStagedEdition(staged.root, { stateRoot: staged.state }), /carries no artifact_digest/u);
  staged.write(staged.receipt);
  writeFileSync(join(staged.receipts, 'staged-0000000000000000.json'), JSON.stringify(staged.receipt));
  await assert.rejects(resolveStagedEdition(staged.root, { stateRoot: staged.state }), /exactly one staged receipt/u);
});

test('a staging volume edited after the build is caught by the artifact digest', async () => {
  const staged = await promoted('2026-09-05', 'abcdef0123456789');
  assert.equal((await resolveStagedEdition(staged.root, { stateRoot: staged.state })).receipt.state, 'staged');
  // One byte, in a file the edition directory does not even contain. The path
  // comparison this replaced could not see it; the digest is the whole point.
  writeFileSync(join(staged.artifactPath, 'README.md'), 'tampered\n');
  await assert.rejects(resolveStagedEdition(staged.root, { stateRoot: staged.state }), /the staging volume changed after pressman built it/u);
});

test('the artifact digest is the producer rule: sorted names, typed entries, no symlinks', async () => {
  const root = scratch('digest');
  mkdirSync(join(root, 'b'), { recursive: true });
  writeFileSync(join(root, 'a.txt'), 'one\n');
  writeFileSync(join(root, 'b', 'c.txt'), 'two\n');
  const digest = await artifactDigest(root);
  assert.match(digest, /^sha256:[0-9a-f]{64}$/u);
  // Content-addressed: same bytes, same digest, whatever the directory is called.
  const copy = scratch('digest');
  mkdirSync(join(copy, 'b'), { recursive: true });
  writeFileSync(join(copy, 'a.txt'), 'one\n');
  writeFileSync(join(copy, 'b', 'c.txt'), 'two\n');
  assert.equal(await artifactDigest(copy), digest);
  writeFileSync(join(copy, 'b', 'c.txt'), 'three\n');
  assert.notEqual(await artifactDigest(copy), digest);
  // A symlink in a release artifact is a refusal, exactly as it is in the
  // producer: a hash that follows links describes something other than the tree.
  symlinkSync('/etc/passwd', join(root, 'link'));
  await assert.rejects(artifactDigest(root), /contains a symlink/u);
});

test('the promoted link may not escape the staging volume', async () => {
  const root = scratch('staging');
  symlinkSync('/etc', join(root, 'current-edition'));
  await assert.rejects(resolveStagedEdition(root), /must name a sibling directory/u);
  const other = scratch('staging');
  symlinkSync('../elsewhere', join(other, 'current-edition'));
  await assert.rejects(resolveStagedEdition(other), /must name a sibling directory/u);
  const undated = scratch('staging');
  mkdirSync(join(undated, 'not-an-edition'));
  symlinkSync('not-an-edition', join(undated, 'current-edition'));
  await assert.rejects(resolveStagedEdition(undated), /does not begin with an edition date/u);
});

test('the command line refuses to run without a staging volume or a key', () => {
  assert.throws(() => parseArguments([]), /--staging/u);
  assert.throws(() => parseArguments(['--staging', '/s']), /--key/u);
  assert.throws(() => parseArguments(['--staging', '/s', '--nope', 'x']), /unknown argument/u);
  assert.throws(() => parseArguments(['--staging']), /requires a value/u);
  assert.deepEqual(parseArguments(['--staging', '/s', '--dry-run']), { dryRun: true, staging: '/s' });
});

test('an unattended caller must name the edition, and naming it binds the receipt', () => {
  assert.deepEqual(parseArguments(['--staging', '/s', '--state', '/t', '--edition', 'today', '--dry-run']), { dryRun: true, staging: '/s', state: '/t', edition: 'today' });
  assert.equal(parseArguments(['--staging', '/s', '--state', '/t', '--edition', '2026-09-05', '--dry-run']).edition, '2026-09-05');
  for (const value of ['tomorrow', '2026-9-5', '', 'edition/2026-09-05', '2026-09-05 '])
    assert.throws(() => parseArguments(['--staging', '/s', '--state', '/t', '--edition', value, '--dry-run']), /must be "today" or YYYY-MM-DD/u, value);
  // The two halves of an unattended publication are not separable: the date
  // proves current-edition is not stale, the receipt proves the bytes are the
  // ones pressman built. `--edition` without `--state` is refused outright.
  assert.throws(() => parseArguments(['--staging', '/s', '--edition', 'today', '--dry-run']), /--edition requires --state/u);
});

test('the timer publishes today\'s paper or nothing, on the Berlin clock', () => {
  // 2026-09-06 17:00 Berlin is 15:00 UTC. Berlin remains the edition clock for
  // timer runs and manual retries near local midnight.
  assert.equal(berlinToday(new Date('2026-09-06T15:00:00Z')), '2026-09-06');
  assert.equal(berlinToday(new Date('2026-09-06T22:30:00Z')), '2026-09-07');
  assert.equal(assertRequestedEdition('2026-09-06', undefined), '2026-09-06');
  assert.equal(assertRequestedEdition('2026-09-06', 'today', new Date('2026-09-06T15:00:00Z')), '2026-09-06');
  assert.equal(assertRequestedEdition('2026-09-06', '2026-09-06'), '2026-09-06');
  // A stale current-edition — yesterday's paper, or a rehearsal's — is the
  // failure this exists for: it refuses and nothing is pushed.
  assert.throws(() => assertRequestedEdition('2026-09-05', 'today', new Date('2026-09-06T15:00:00Z')), /the promoted edition is 2026-09-05, but "today" means 2026-09-06/u);
  assert.throws(() => assertRequestedEdition('2026-09-05', '2026-09-06'), /the promoted edition is 2026-09-05/u);
  assert.throws(() => assertRequestedEdition('2026-09-05', 'tomorrow'), /must be "today" or YYYY-MM-DD/u);
});

test('the generated indexes are rebuilt from the branch tree, and only those paths are added', async () => {
  assert.deepEqual(GENERATED_INDEX_PATHS, ['content/topics.txt', 'content/bylines']);
  assert.deepEqual(REPINNED_DESCRIPTOR_PATHS, ['agentic-org/newsroom-runtime-bundle.json', 'agentic-org/agents']);
  await assert.rejects(repinBundleDescriptor('relative/tree'), /must be an absolute path/u);
  await assert.rejects(regenerateIndexes('relative/tree'), /must be an absolute path/u);

  const tree = scratch('tree');
  mkdirSync(join(tree, 'content', 'editions', '2026-09-05', 'articles'), { recursive: true });
  writeFileSync(join(tree, 'content', 'topics.json'), JSON.stringify(TOPICS_JSON));
  seedDescriptor(tree);
  git(['init', '-q', '-b', BASE_BRANCH], tree);
  git(['add', '-A'], tree);
  writeFileSync(join(tree, 'content', 'editions', '2026-09-05', 'articles', 'one.json'), JSON.stringify({ id: 'one', edition_date: '2026-09-05', section: 'world', epistemic: 'fact', topics: ['oil'], headline: 'A headline', byline: { desk: 'Test Desk', agents: ['Cogsworth'] } }));

  const first = await regenerateIndexes(tree);
  git(['add', '-A'], tree);
  first.descriptor = await repinBundleDescriptor(tree);
  assert.equal(first.topics, 'content/topics.txt');
  assert.deepEqual(first.bylines, ['content/bylines/cogsworth.tsv']);
  assert.equal(first.articles, 1);
  // The descriptor is repinned from the same tree, and the Spawnfile follows
  // it. Without this the branch is red on ci.yml's descriptor check forever.
  assert.match(first.descriptor.source, /^sha256:[a-f0-9]{64}$/u);
  assert.notEqual(first.descriptor.source, first.descriptor.previous);
  assert.deepEqual(first.descriptor.repinned, ['cogsworth']);
  assert.match(readFileSync(join(tree, 'agentic-org', 'agents', 'cogsworth', 'Spawnfile'), 'utf8'), new RegExp(first.descriptor.source, 'u'));
  assert.equal(readFileSync(join(tree, 'content', 'topics.txt'), 'utf8'), 'oil\tOil\nrates\tRates\n');
  assert.match(readFileSync(join(tree, 'content', 'bylines', 'cogsworth.tsv'), 'utf8'), /^2026-09-05\tone\tworld\tfact\toil\tA headline$/mu);

  // Pure functions of the tree: a second run is byte-identical, which is what
  // keeps a retried push rebuilding the same commit object.
  const before = readFileSync(join(tree, 'content', 'bylines', 'cogsworth.tsv'), 'utf8');
  await regenerateIndexes(tree);
  git(['add', '-A'], tree);
  assert.equal((await repinBundleDescriptor(tree)).source, first.descriptor.source);
  assert.equal(readFileSync(join(tree, 'content', 'bylines', 'cogsworth.tsv'), 'utf8'), before);
});

test('a real push creates the edition branch and leaves main exactly where it was', async () => {
  const origin = remote(), before = origin.head();
  const staged = stagedEdition('2026-09-09');
  const work = scratch('work');
  const result = await pushStagedEditionTree({
    url: origin.url, branch: editionBranch('2026-09-09'), editionSource: staged.source, editionPath: staged.path,
    workdir: join(work, 'repo'), home: join(work, 'home'), message: editionCommitMessage('2026-09-09')
  });
  assert.equal(result.branch, 'edition/2026-09-09');
  assert.match(result.commit, /^[0-9a-f]{40}$/u);
  assert.equal(result.base, before);
  assert.deepEqual(origin.refs().sort(), ['refs/heads/edition/2026-09-09', 'refs/heads/main']);
  assert.equal(origin.head(), before, 'main moved');
  const bare = origin.url;
  assert.equal(execFileSync('git', ['-C', bare, 'show', '--no-patch', '--format=%s', result.commit], { encoding: 'utf8' }).trim(), 'chore(edition): add the 2026-09-09 edition');
  assert.match(execFileSync('git', ['-C', bare, 'show', `${result.commit}:content/editions/2026-09-09/articles/one.json`], { encoding: 'utf8' }), /"id":"one"/u);
  // The pushed tree is what ci.yml will check out: regenerating both indexes
  // over it must leave the working tree clean, which is `git diff --exit-code`.
  const checkout = scratch('ci');
  git(['clone', '-q', '--branch', result.branch, bare, checkout], checkout);
  assert.equal(ciDriftCheck(checkout), '', 'the pushed branch would fail the CI drift check');
  // The commit is pinned to the edition's release instant, so a retry after a
  // failed push rebuilds the identical object rather than a new one.
  assert.equal(execFileSync('git', ['-C', bare, 'show', '--no-patch', '--format=%aI', result.commit], { encoding: 'utf8' }).trim(), '2026-09-09T18:00:00+02:00');
});

test('a push aimed at main is refused before git runs and the remote is untouched', async () => {
  const origin = remote(), before = origin.head();
  const staged = stagedEdition('2026-09-05');
  const work = scratch('work');
  for (const branch of ['main', 'refs/heads/main', 'edition/main', 'staging']) {
    await assert.rejects(pushStagedEditionTree({
      url: origin.url, branch, editionSource: staged.source, editionPath: staged.path,
      workdir: join(work, 'repo'), home: join(work, 'home'), message: 'chore: nope'
    }), /not an edition branch|protected ref/u, branch);
  }
  assert.deepEqual(origin.refs(), ['refs/heads/main']);
  assert.equal(origin.head(), before);
});

test('the commit carries only the edition directory, whatever else is in the tree', async () => {
  const origin = remote();
  const staged = stagedEdition('2026-09-06');
  const work = scratch('work'), workdir = join(work, 'repo');
  mkdirSync(join(workdir, '.home'), { recursive: true });
  // Scratch the run leaves behind in its own workdir: a credential-shaped file
  // and the git home the push runs under. Neither may ride along in the commit.
  writeFileSync(join(workdir, '.home', 'leftover-key'), 'PRIVATE\n');
  writeFileSync(join(workdir, 'stray.txt'), 'not part of the edition\n');
  const result = await pushStagedEditionTree({
    url: origin.url, branch: editionBranch('2026-09-06'), editionSource: staged.source, editionPath: staged.path,
    workdir, home: join(work, 'home'), message: editionCommitMessage('2026-09-06')
  });
  const files = execFileSync('git', ['-C', origin.url, 'diff', '--name-only', `${result.base}..${result.commit}`], { encoding: 'utf8' }).trim().split('\n');
  // The edition directory, the two generated views ci.yml diff-checks and the
  // bundle pins ci.yml checks against the tree — and nothing else: neither the
  // stray file nor the git home rides along.
  assert.deepEqual(files.sort(), [
    'agentic-org/agents/cogsworth/Spawnfile', 'agentic-org/newsroom-runtime-bundle.json',
    'content/bylines/cogsworth.tsv', 'content/editions/2026-09-06/articles/one.json'
  ]);
  for (const name of files) assert.ok([...GENERATED_INDEX_PATHS, ...REPINNED_DESCRIPTOR_PATHS].some((prefix) => name.startsWith(prefix)) || name.startsWith('content/editions/2026-09-06/'), name);
  // The only thing that changed in the Spawnfile is a checksum. That is what
  // lets merge-edition.yml admit these paths without admitting arbitrary code.
  const spawnfileDiff = execFileSync('git', ['-C', origin.url, 'diff', '-U0', `${result.base}..${result.commit}`, '--', 'agentic-org/agents'], { encoding: 'utf8' })
    .split('\n').filter((line) => /^[+-][^+-]/u.test(line));
  assert.equal(spawnfileDiff.length, 2);
  for (const line of spawnfileDiff) assert.match(line, /sha256:[a-f0-9]{64}/u);
});

test('a retry of the same edition converges, and changed content is refused rather than forced', async () => {
  const origin = remote();
  const staged = stagedEdition('2026-09-07');
  const work = scratch('work');
  let attempt = 0;
  const call = () => pushStagedEditionTree({
    url: origin.url, branch: editionBranch('2026-09-07'), editionSource: staged.source, editionPath: staged.path,
    workdir: join(work, `repo-${attempt += 1}`), home: join(work, 'home'), message: editionCommitMessage('2026-09-07')
  });
  const first = await call();
  // The commit is fully determined by the base, the staged tree, the pinned
  // author identity and the pinned release instant, so a retry after a network
  // failure rebuilds the same object and the push is a no-op fast-forward.
  const second = await call();
  assert.equal(second.commit, first.commit);
  assert.deepEqual(origin.refs().sort(), ['refs/heads/edition/2026-09-07', 'refs/heads/main']);
  // Different staged content is a different commit that is not a descendant of
  // what is already on the branch. Without a force flag git must refuse it.
  writeFileSync(join(staged.source, 'articles', 'two.json'), '{"id":"two"}\n');
  await assert.rejects(call(), /non-fast-forward|rejected|failed/iu);
  assert.equal(execFileSync('git', ['-C', origin.url, 'rev-parse', 'refs/heads/edition/2026-09-07'], { encoding: 'utf8' }).trim(), first.commit);
});

test('an edition already merged into the base is a quiet success, not a nightly alarm', async () => {
  const origin = remote();
  const staged = stagedEdition('2026-09-09');
  const work = scratch('work');
  let attempt = 0;
  const call = () => pushStagedEditionTree({
    url: origin.url, branch: editionBranch('2026-09-09'), editionSource: staged.source, editionPath: staged.path,
    workdir: join(work, `repo-${attempt += 1}`), home: join(work, 'home'), message: editionCommitMessage('2026-09-09')
  });
  const first = await call();
  assert.equal(first.pushed, true);
  assert.equal(first.already_published, false);
  // merge-edition.yml merges it. The timer fires again the next night with the
  // same `current-edition` still on the volume: there is nothing to push, and
  // saying so is a success. An error here raises the alarm every night after a
  // successful publication, which is how an alarm stops being read.
  origin.merge(first.commit);
  const second = await call();
  assert.equal(second.already_published, true);
  assert.equal(second.pushed, false);
  assert.equal(second.commit, origin.head());
  assert.equal(second.generated, null, 'nothing is regenerated for a branch that will not be built');
});

test('a base branch that carries no bundle descriptor is committed without one', async () => {
  // `main` today: `content/` and `website/`, no `agentic-org/` at all. Repinning
  // a descriptor that is not there threw ENOENT on the first unattended
  // publication, and committing a pathspec that matches nothing makes git
  // refuse the commit. Both are the same bug: assuming the base carries the org.
  const origin = remote({ descriptor: false });
  const staged = stagedEdition('2026-09-10');
  const work = scratch('work');
  const result = await pushStagedEditionTree({
    url: origin.url, branch: editionBranch('2026-09-10'), editionSource: staged.source, editionPath: staged.path,
    workdir: join(work, 'repo'), home: join(work, 'home'), message: editionCommitMessage('2026-09-10')
  });
  assert.equal(result.pushed, true);
  assert.equal(result.generated.descriptor.skipped, true);
  assert.match(result.generated.descriptor.reason, new RegExp(DESCRIPTOR_FILE.replaceAll('.', '\\.'), 'u'));
  const files = execFileSync('git', ['-C', origin.url, 'diff', '--name-only', `${result.base}..${result.commit}`], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(files.sort(), ['content/bylines/cogsworth.tsv', 'content/editions/2026-09-10/articles/one.json']);
  for (const name of files) assert.doesNotMatch(name, /^agentic-org\//u);
  // And a base that DOES carry one is still repinned: the skip is a fact about
  // the branch, read from the branch, not a switch anybody can leave off.
  const withDescriptor = remote();
  const other = stagedEdition('2026-09-10');
  const repinned = await pushStagedEditionTree({
    url: withDescriptor.url, branch: editionBranch('2026-09-10'), editionSource: other.source, editionPath: other.path,
    workdir: join(work, 'repo-descriptor'), home: join(work, 'home'), message: editionCommitMessage('2026-09-10')
  });
  assert.equal(repinned.generated.descriptor.skipped, false);
  assert.deepEqual(repinned.generated.descriptor.repinned, ['cogsworth']);
});

test('the edition path may not escape the branch', async () => {
  const origin = remote();
  const staged = stagedEdition('2026-09-05');
  const work = scratch('work');
  for (const editionPath of ['/etc', '../outside', 'content/../../outside']) {
    await assert.rejects(pushStagedEditionTree({
      url: origin.url, branch: editionBranch('2026-09-05'), editionSource: staged.source, editionPath,
      workdir: join(work, 'repo'), home: join(work, 'home'), message: 'chore: nope'
    }), /must stay inside the branch/u, editionPath);
  }
});

test('end to end: a promoted artifact becomes an edition branch on a real remote', async () => {
  const origin = remote(), before = origin.head();
  const staging = scratch('staging'), state = scratch('state');
  const artifact = '2026-09-08-fedcba9876543210';
  const editionDir = join(staging, artifact, 'content', 'editions', '2026-09-08');
  mkdirSync(join(editionDir, 'pages'), { recursive: true });
  writeFileSync(join(editionDir, 'pages', 'front.json'), '{"page":"front"}\n');
  symlinkSync(artifact, join(staging, 'current-edition'));
  const receipts = join(state, 'editions', '2026-09-08', 'receipts');
  mkdirSync(receipts, { recursive: true });
  writeFileSync(join(receipts, 'staged-fedcba9876543210.json'), JSON.stringify({
    state: 'staged', edition: '2026-09-08',
    composition_digest: `sha256:fedcba9876543210${'0'.repeat(48)}`,
    artifact_digest: await artifactDigest(join(staging, artifact)),
    staging_root: `${CONTAINER_STAGING}/${artifact}`
  }));

  const key = join(scratch('keys'), 'clankandslop');
  writeFileSync(key, 'unused-for-a-file-remote\n', { mode: 0o600 });
  const result = await publishEditionBranch({ staging, state, key }, origin.url);
  assert.equal(result.edition, '2026-09-08');
  assert.equal(result.branch, 'edition/2026-09-08');
  assert.equal(result.pushed, true);
  assert.equal(result.published, false);
  assert.deepEqual(origin.refs().sort(), ['refs/heads/edition/2026-09-08', 'refs/heads/main']);
  assert.equal(origin.head(), before, 'main moved');
  assert.equal(execFileSync('git', ['-C', origin.url, 'show', `${result.commit}:content/editions/2026-09-08/pages/front.json`], { encoding: 'utf8' }), '{"page":"front"}\n');
  // A dry run builds the same commit and touches nothing on the remote.
  const dry = await publishEditionBranch({ staging, state, dryRun: true }, origin.url);
  assert.equal(dry.pushed, false);
  assert.equal(dry.commit, result.commit);
  // The remote is a compile-time constant: no command line can redirect it.
  assert.throws(() => parseArguments(['--staging', '/s', '--url', 'git@evil.invalid:x/y.git']), /unknown argument/u);
  assert.throws(() => parseArguments(['--staging', '/s', '--remote', 'other']), /unknown argument/u);
});
