// Publishing policy for the release desk, kept apart from the tool that runs
// it so every rule here is a pure function a test can attack directly.
//
// The whole point of this file is that none of it is configurable. An agent
// that could choose its own remote, its own refspec or its own git flags could
// reach `main`, and nothing a wake carries makes that choice safer. The remote
// table, the branch shape, the refused refs and the argv are all constants or
// derived from the edition date, and the only thing that arrives from outside
// is the key material.
import { spawn } from 'node:child_process';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// One ed25519 deploy key per repository, reached through an SSH host alias so
// the config below — not ssh's default agent or key search — decides which key
// opens which remote. `IdentitiesOnly yes` makes that binding exclusive.
export const PUSH_REMOTES = Object.freeze({
  clankandslop: Object.freeze({
    alias: 'clankandslop.deploy', host: 'github.com', path: 'apresmoi/clankandslop.git',
    key_file: 'clankandslop', secret: 'CLANK_DEPLOY_KEY_PUBLIC'
  }),
  'clankandslop-private': Object.freeze({
    alias: 'clankandslop-private.deploy', host: 'github.com', path: 'apresmoi/clankandslop-private.git',
    key_file: 'clankandslop-private', secret: 'CLANK_DEPLOY_KEY_PRIVATE'
  })
});

// The only remote an edition may ever be pushed to.
export const EDITION_PUSH_REMOTE = 'clankandslop';
export const remoteUrl = (remote) => `git@${PUSH_REMOTES[remote].alias}:${PUSH_REMOTES[remote].path}`;

// The branch the edition lands on, and the branch a human opens the pull
// request from. Deriving it from the edition date is what keeps the agent out
// of the naming decision entirely.
const BRANCH_PATTERN = /^edition\/\d{4}-\d{2}-\d{2}$/u;
export const editionBranch = (edition) => `edition/${edition}`;

// Refused whether they appear as the whole ref or as its last component, so a
// ref that survives the pattern check by nesting still cannot land on a branch
// anything is served or merged from.
export const PROTECTED_REFS = Object.freeze(['main', 'master', 'staging', 'gh-pages', 'HEAD']);

// The base branch the edition branch is cut from. Fetched, never written.
export const BASE_BRANCH = 'main';

// GitHub's published ed25519 host key. Pinning it means the push fails loudly
// against an unexpected server instead of trusting whatever answers first;
// rotate this line when GitHub rotates the key.
export const GITHUB_HOST_KEYS = Object.freeze([
  'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'
]);

// Independent of the branch pattern on purpose: if the pattern is ever
// loosened, this is the check that still refuses a ref anything is merged or
// served from, and it is tested on its own so that stays true.
export function assertNotProtectedRef(ref) {
  if (typeof ref !== 'string') throw new Error('push ref must be a string');
  const components = ref.split('/');
  for (const protectedRef of PROTECTED_REFS) if (ref === protectedRef || components.includes(protectedRef)) throw new Error(`push ref ${JSON.stringify(ref)} names the protected ref ${JSON.stringify(protectedRef)} — the release desk never pushes a branch anything is merged or served from`);
  if (components.includes('.') || components.includes('..') || components.some((component) => component.length === 0)) throw new Error(`push ref ${JSON.stringify(ref)} is not a well-formed ref`);
  return ref;
}

export function assertPushableRef(ref) {
  if (typeof ref !== 'string' || !BRANCH_PATTERN.test(ref)) throw new Error(`push ref ${JSON.stringify(ref)} is not an edition branch — the release desk may only create refs matching edition/YYYY-MM-DD`);
  return assertNotProtectedRef(ref);
}

// Built here rather than at the call site so the refused flags are a property
// of the policy and not of whoever last edited the tool. Fast-forward only, one
// ref, spelled out on both sides: there is no shorthand for git to interpret.
const REFUSED_PUSH_FLAGS = Object.freeze(['-f', '--force', '--force-with-lease', '--force-if-includes', '--mirror', '--delete', '-d', '--all', '--tags', '--follow-tags', '--prune', '--atomic', '--receive-pack', '--exec']);

export function pushArgv(remoteUrlValue, ref) {
  assertPushableRef(ref);
  const argv = ['push', '--porcelain', remoteUrlValue, `refs/heads/${ref}:refs/heads/${ref}`];
  assertNoForcedPush(argv);
  return argv;
}

export function assertNoForcedPush(argv) {
  for (const item of argv) {
    if (typeof item !== 'string') throw new Error('push argument list must be strings');
    const flag = item.split('=')[0];
    if (REFUSED_PUSH_FLAGS.includes(flag)) throw new Error(`push argument ${JSON.stringify(item)} is refused — the release desk pushes fast-forward, one ref, and never force-pushes or deletes a remote ref`);
    if (item.startsWith('+refs/') || item.startsWith('+edition/')) throw new Error(`push refspec ${JSON.stringify(item)} is a forced refspec — the leading "+" overwrites history and is refused`);
    if (item.startsWith(':')) throw new Error(`push refspec ${JSON.stringify(item)} deletes a remote ref and is refused`);
  }
  return argv;
}

export const sshConfig = (directory) => Object.values(PUSH_REMOTES)
  .map((remote) => [
    `Host ${remote.alias}`,
    `  HostName ${remote.host}`,
    '  User git',
    `  IdentityFile ${path.join(directory, remote.key_file)}`,
    '  IdentitiesOnly yes',
    '  IdentityAgent none',
    '  PasswordAuthentication no',
    '  StrictHostKeyChecking yes',
    `  UserKnownHostsFile ${path.join(directory, 'known_hosts')}`
  ].join('\n'))
  .join('\n\n')
  .concat('\n');

// The declared secret is the intended source: `environment.secrets` names it,
// `spawnfile up --env-file` refuses to start without it, and no value is
// committed. Daimon builds a positive environment for a stdio MCP child, so a
// container env var does not reach this process on its own yet — until it
// forwards named secrets, the same material arrives as a read-only file in the
// `deploy-keys` volume. Both routes are declared; neither is a literal.
export async function readDeployKey(remote, env = process.env) {
  const declared = PUSH_REMOTES[remote];
  if (!declared) throw new Error(`unknown push remote ${JSON.stringify(remote)}`);
  const inline = env[declared.secret];
  if (typeof inline === 'string' && inline.trim().length > 0) return inline.endsWith('\n') ? inline : `${inline}\n`;
  const directory = env.CLANK_DEPLOY_KEY_DIR;
  if (typeof directory !== 'string' || !directory.startsWith('/')) throw new Error(`deploy key for ${JSON.stringify(remote)} unavailable — neither the declared secret ${declared.secret} nor an absolute CLANK_DEPLOY_KEY_DIR is present`);
  const file = path.join(directory, declared.key_file);
  const bytes = await readFile(file, 'utf8').catch(() => { throw new Error(`deploy key for ${JSON.stringify(remote)} unavailable — ${declared.secret} is unset and ${file} is not readable`); });
  if (bytes.trim().length === 0) throw new Error(`deploy key for ${JSON.stringify(remote)} is empty at ${file}`);
  return bytes.endsWith('\n') ? bytes : `${bytes}\n`;
}

// Written 0600 into a directory the calling process owns, which inside the
// container is uid 2000, and unlinked by the caller when the push is over: the
// key is on disk only for the seconds ssh needs to read it.
export async function materializeSshIdentity(directory, remote, key) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const keyFile = path.join(directory, PUSH_REMOTES[remote].key_file);
  const configFile = path.join(directory, 'config');
  const knownHostsFile = path.join(directory, 'known_hosts');
  await writeFile(keyFile, key, { mode: 0o600 });
  await writeFile(configFile, sshConfig(directory), { mode: 0o600 });
  await writeFile(knownHostsFile, `${GITHUB_HOST_KEYS.join('\n')}\n`, { mode: 0o600 });
  for (const file of [keyFile, configFile, knownHostsFile]) await chmod(file, 0o600);
  return { keyFile, configFile, knownHostsFile, sshCommand: `ssh -F ${configFile} -o BatchMode=yes` };
}

// --- running it -------------------------------------------------------------
// A closed environment for every git invocation: no user or system config, no
// terminal prompt, no credential helper, and PATH narrowed to the image's own
// binaries. Nothing here reads the caller's environment except PATH's contents
// on disk, so a git that asks for anything interactive fails instead of hanging.
const gitEnvironment = (home, sshCommand, date) => ({
  PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, TMPDIR: path.join(home, 'tmp'),
  LANG: 'C.UTF-8', TZ: 'UTC', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_CONFIG_NOSYSTEM: '1', GIT_ADVICE: '0',
  ...(date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }),
  ...(sshCommand === undefined ? {} : { GIT_SSH_COMMAND: sshCommand })
});

const git = (args, { home, sshCommand, date }) => new Promise((resolve, reject) => {
  const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'], env: gitEnvironment(home, sshCommand, date) });
  let out = '', err = '';
  child.stdout.on('data', (chunk) => { if (out.length < 65536) out += chunk; });
  child.stderr.on('data', (chunk) => { if (err.length < 65536) err += chunk; });
  child.once('error', (error) => reject(new Error(`git ${args[0]} could not run: ${error.message}`)));
  child.once('exit', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`git ${args.filter((item) => !item.startsWith('-----')).slice(0, 4).join(' ')} failed (${code}): ${err.trim().slice(-1500)}`)));
});

export const editionCommitMessage = (edition) => `chore(edition): add the ${edition} edition`;
const COMMIT_NAME = 'Clank & Slop pressman';
const COMMIT_EMAIL = 'pressman@clankandslop.invalid';

// Cuts one branch from the remote's base branch, adds exactly the edition
// directory to it, and fast-forward pushes that one ref. `add`, `commit` and
// `status` are all path-scoped to the edition directory, so a stray file
// anywhere else in the scratch tree cannot ride along in the commit.
export async function pushStagedEditionTree({ url, branch, editionSource, editionPath, workdir, home, sshCommand, base = BASE_BRANCH, message }) {
  assertPushableRef(branch);
  if (!path.isAbsolute(workdir) || !path.isAbsolute(editionSource) || !path.isAbsolute(home)) throw new Error('push workdir, source and home must be absolute paths');
  const scoped = path.normalize(editionPath);
  if (path.isAbsolute(scoped) || scoped.split('/').includes('..')) throw new Error(`edition path ${JSON.stringify(editionPath)} must stay inside the branch`);
  const options = { home, sshCommand };
  await mkdir(path.join(home, 'tmp'), { recursive: true });
  await mkdir(workdir, { recursive: true });
  await git(['-C', workdir, 'init', '-q'], options);
  await git(['-C', workdir, 'fetch', '-q', '--depth=1', '--no-tags', url, `refs/heads/${base}`], options);
  await git(['-C', workdir, 'checkout', '-q', '-b', branch, 'FETCH_HEAD'], options);
  const baseCommit = await git(['-C', workdir, 'rev-parse', 'HEAD'], options);
  await rm(path.join(workdir, scoped), { recursive: true, force: true });
  await mkdir(path.dirname(path.join(workdir, scoped)), { recursive: true });
  await cp(editionSource, path.join(workdir, scoped), { recursive: true });
  await git(['-C', workdir, 'add', '--', scoped], options);
  const staged = await git(['-C', workdir, 'status', '--porcelain', '--', scoped], options);
  if (staged.length === 0) throw new Error(`nothing to push — ${scoped} is already identical to ${base} on the remote`);
  // Pinned to the edition's own 16:00 Berlin release instant so a retry after a
  // failed push rebuilds the identical commit instead of a new one every minute.
  const date = `${branch.slice('edition/'.length)}T16:00:00+02:00`;
  await git(['-C', workdir, '-c', `user.name=${COMMIT_NAME}`, '-c', `user.email=${COMMIT_EMAIL}`, 'commit', '-q', '-m', message, '--', scoped], { ...options, date });
  const commit = await git(['-C', workdir, 'rev-parse', 'HEAD'], options);
  await git(['-C', workdir, ...pushArgv(url, branch)], options);
  return { branch, commit, base: baseCommit, remote_url: url };
}
