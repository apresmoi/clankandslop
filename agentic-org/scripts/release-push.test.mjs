import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASE_BRANCH, EDITION_PUSH_REMOTE, GITHUB_HOST_KEYS, PROTECTED_REFS, PUSH_REMOTES,
  assertNoForcedPush, assertNotProtectedRef, assertPushableRef, editionBranch, editionCommitMessage,
  materializeSshIdentity, pushArgv, pushStagedEditionTree, readDeployKey, remoteUrl, sshConfig
} from './release-push.mjs';

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
  assert.equal(PUSH_REMOTES[EDITION_PUSH_REMOTE].secret, 'CLANK_DEPLOY_KEY_PUBLIC');
  assert.equal(PUSH_REMOTES['clankandslop-private'].secret, 'CLANK_DEPLOY_KEY_PRIVATE');
  for (const name of ['main', 'master', 'staging', 'gh-pages', 'HEAD']) assert.ok(PROTECTED_REFS.includes(name), name);
});

test('the ssh config binds one key per remote and pins the host key', () => {
  const rendered = sshConfig('/keys');
  for (const declared of Object.values(PUSH_REMOTES)) {
    assert.match(rendered, new RegExp(`Host ${declared.alias}\\n  HostName ${declared.host}\\n  User git\\n  IdentityFile /keys/${declared.key_file}\\n  IdentitiesOnly yes`, 'u'));
  }
  assert.match(rendered, /StrictHostKeyChecking yes/u);
  assert.match(rendered, /UserKnownHostsFile \/keys\/known_hosts/u);
  assert.ok(GITHUB_HOST_KEYS.every((line) => line.startsWith('github.com ssh-ed25519 ')));
});

test('key material is read from the declared secret, then the mounted file, and never invented', async () => {
  assert.equal(await readDeployKey('clankandslop', { CLANK_DEPLOY_KEY_PUBLIC: 'INLINE' }), 'INLINE\n');
  const directory = scratch('keys');
  writeFileSync(join(directory, 'clankandslop'), 'FROM-VOLUME\n');
  assert.equal(await readDeployKey('clankandslop', { CLANK_DEPLOY_KEY_DIR: directory }), 'FROM-VOLUME\n');
  await assert.rejects(readDeployKey('clankandslop', {}), /CLANK_DEPLOY_KEY_PUBLIC nor an absolute CLANK_DEPLOY_KEY_DIR/u);
  await assert.rejects(readDeployKey('clankandslop', { CLANK_DEPLOY_KEY_DIR: '/nonexistent-clank' }), /is not readable/u);
  writeFileSync(join(directory, 'clankandslop-private'), '   \n');
  await assert.rejects(readDeployKey('clankandslop-private', { CLANK_DEPLOY_KEY_DIR: directory }), /is empty/u);
  await assert.rejects(readDeployKey('somewhere-else', {}), /unknown push remote/u);
});

test('the materialized identity is 0600 in a 0700 directory', async () => {
  const directory = join(scratch('identity'), 'ssh');
  const identity = await materializeSshIdentity(directory, 'clankandslop', 'KEY\n');
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  for (const file of [identity.keyFile, identity.configFile, identity.knownHostsFile]) assert.equal(statSync(file).mode & 0o777, 0o600, file);
  assert.equal(readFileSync(identity.keyFile, 'utf8'), 'KEY\n');
  assert.match(identity.sshCommand, /^ssh -F .*\/config -o BatchMode=yes$/u);
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
