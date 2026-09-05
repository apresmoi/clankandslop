import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASE_BRANCH, EDITION_PUSH_REMOTE, GITHUB_HOST_KEYS, PROTECTED_REFS, PUSH_REMOTES,
  assertNoForcedPush, assertNotProtectedRef, assertPushableRef, editionBranch, editionCommitMessage,
  parseArguments, prepareSshIdentity, publishEditionBranch, pushArgv, pushStagedEditionTree,
  remoteUrl, resolveStagedEdition, sshConfig
} from './publish-edition-branch.mjs';

const scratch = (label) => mkdtempSync(join(tmpdir(), `clank-${label}-`));
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'seed', GIT_AUTHOR_EMAIL: 'seed@example.invalid', GIT_COMMITTER_NAME: 'seed', GIT_COMMITTER_EMAIL: 'seed@example.invalid' } }).trim();

// A real remote, on disk. Everything below pushes to it for real, so a guard
// that only *claims* to stop a push to main has somewhere to be caught out.
function remote() {
  const root = scratch('remote');
  const bare = join(root, 'origin.git'), seed = join(root, 'seed');
  mkdirSync(bare); mkdirSync(seed);
  git(['init', '-q', '--bare', '-b', BASE_BRANCH], bare);
  git(['init', '-q', '-b', BASE_BRANCH], seed);
  writeFileSync(join(seed, 'README.md'), '# seed\n');
  git(['add', '--', 'README.md'], seed);
  git(['commit', '-q', '-m', 'chore: seed'], seed);
  git(['push', '-q', bare, `refs/heads/${BASE_BRANCH}:refs/heads/${BASE_BRANCH}`], seed);
  return { root, url: bare, head: () => git(['rev-parse', `refs/heads/${BASE_BRANCH}`], bare), refs: () => git(['for-each-ref', '--format=%(refname)'], bare).split('\n').filter(Boolean) };
}

function stagedEdition(edition) {
  const root = scratch('staged');
  const directory = join(root, 'content', 'editions', edition);
  mkdirSync(join(directory, 'articles'), { recursive: true });
  writeFileSync(join(directory, 'articles', 'one.json'), '{"id":"one"}\n');
  return { root, source: directory, path: `content/editions/${edition}` };
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

test('only a promoted artifact can be resolved, and the receipt must agree with it', async () => {
  const root = scratch('staging');
  await assert.rejects(resolveStagedEdition(root), /no promoted edition/u);
  await assert.rejects(resolveStagedEdition('relative'), /must be an absolute path/u);
  const artifact = '2026-09-05-abcdef0123456789';
  mkdirSync(join(root, artifact, 'content', 'editions', '2026-09-05'), { recursive: true });
  symlinkSync(artifact, join(root, 'current-edition'));
  const resolved = await resolveStagedEdition(root);
  assert.equal(resolved.edition, '2026-09-05');
  assert.equal(resolved.editionPath, 'content/editions/2026-09-05');
  // With a state root the durable receipt has to name the same artifact, so a
  // staging volume edited by hand between the build and the push is caught.
  const state = scratch('state');
  const receipts = join(state, 'editions', '2026-09-05', 'receipts');
  mkdirSync(receipts, { recursive: true });
  const receipt = { version: 'clank.newsroom-release-receipt.v1', state: 'staged', edition: '2026-09-05', staging_root: join(root, artifact) };
  writeFileSync(join(receipts, 'staged-abcdef0123456789.json'), JSON.stringify(receipt));
  assert.equal((await resolveStagedEdition(root, { stateRoot: state })).receipt.state, 'staged');
  writeFileSync(join(receipts, 'staged-abcdef0123456789.json'), JSON.stringify({ ...receipt, staging_root: '/somewhere/else' }));
  await assert.rejects(resolveStagedEdition(root, { stateRoot: state }), /but current-edition points at/u);
  writeFileSync(join(receipts, 'staged-0000000000000000.json'), JSON.stringify(receipt));
  await assert.rejects(resolveStagedEdition(root, { stateRoot: state }), /exactly one staged receipt/u);
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

test('a real push creates the edition branch and leaves main exactly where it was', async () => {
  const origin = remote(), before = origin.head();
  const staged = stagedEdition('2026-09-05');
  const work = scratch('work');
  const result = await pushStagedEditionTree({
    url: origin.url, branch: editionBranch('2026-09-05'), editionSource: staged.source, editionPath: staged.path,
    workdir: join(work, 'repo'), home: join(work, 'home'), message: editionCommitMessage('2026-09-05')
  });
  assert.equal(result.branch, 'edition/2026-09-05');
  assert.match(result.commit, /^[0-9a-f]{40}$/u);
  assert.equal(result.base, before);
  assert.deepEqual(origin.refs().sort(), ['refs/heads/edition/2026-09-05', 'refs/heads/main']);
  assert.equal(origin.head(), before, 'main moved');
  const bare = origin.url;
  assert.equal(execFileSync('git', ['-C', bare, 'show', '--no-patch', '--format=%s', result.commit], { encoding: 'utf8' }).trim(), 'chore(edition): add the 2026-09-05 edition');
  assert.equal(execFileSync('git', ['-C', bare, 'show', `${result.commit}:content/editions/2026-09-05/articles/one.json`], { encoding: 'utf8' }), '{"id":"one"}\n');
  // The commit is pinned to the edition's release instant, so a retry after a
  // failed push rebuilds the identical object rather than a new one.
  assert.equal(execFileSync('git', ['-C', bare, 'show', '--no-patch', '--format=%aI', result.commit], { encoding: 'utf8' }).trim(), '2026-09-05T16:00:00+02:00');
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
  assert.deepEqual(files, ['content/editions/2026-09-06/articles/one.json']);
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
  writeFileSync(join(receipts, 'staged-fedcba9876543210.json'), JSON.stringify({ state: 'staged', edition: '2026-09-08', staging_root: join(staging, artifact) }));

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
