#!/usr/bin/env node
// Puts a staged edition on one branch in the public repository.
//
// THIS RUNS ON THE HOST, OUTSIDE EVERY CONTAINER. No agent declares it, no
// agent can call it, and nothing in a compiled workspace reaches it —
// `validate-org.mjs` asserts that mechanically.
//
// That placement is the whole point. The ref guards below are real, but they
// are code, and code that runs inside the process a model drives is a claim
// rather than a boundary: a deploy key with write access can push any ref, so
// whatever narrows it has to sit on the same side of the airlock as the
// credential. Pressman's ceiling is unchanged — it stages, validates, builds,
// promotes into `clank-release-staging`, and stops. This job reads what it
// promoted and pushes the branch with a key the container never sees.
//
// It also never copies the key. `IdentityFile` points at the operator's own
// file, so the material is read by ssh and by nothing else.
//
//   node agentic-org/scripts/publish-edition-branch.mjs \
//     --staging /var/lib/docker/volumes/clank-release-staging/_data \
//     --state   /var/lib/docker/volumes/clank-edition-state/_data \
//     --key     ~/.ssh/clank-deploy/clankandslop
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// One ed25519 deploy key per repository, reached through an SSH host alias so
// the generated config — not ssh's agent or default key search — decides which
// key opens which remote. `IdentitiesOnly yes` makes that binding exclusive.
export const PUSH_REMOTES = Object.freeze({
  clankandslop: Object.freeze({ alias: 'clankandslop.deploy', host: 'github.com', path: 'apresmoi/clankandslop.git' })
});

// The only remote an edition may ever be pushed to, and the only base branch.
export const EDITION_PUSH_REMOTE = 'clankandslop';
export const BASE_BRANCH = 'main';
export const remoteUrl = (remote) => `git@${PUSH_REMOTES[remote].alias}:${PUSH_REMOTES[remote].path}`;

// The branch the edition lands on, and the branch a person opens the pull
// request from. Deriving it from the edition date keeps the naming decision out
// of the job entirely.
const BRANCH_PATTERN = /^edition\/\d{4}-\d{2}-\d{2}$/u;
const EDITION_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
export const editionBranch = (edition) => `edition/${edition}`;
export const editionCommitMessage = (edition) => `chore(edition): add the ${edition} edition`;

// Refused whether they appear as the whole ref or as any component, so a ref
// that survives the pattern check by nesting still cannot land on a branch
// anything is merged or served from. Branch protection on `main` is the control
// that actually holds; this is the second lock, not the first.
export const PROTECTED_REFS = Object.freeze(['main', 'master', 'staging', 'gh-pages', 'HEAD']);

// GitHub's published ed25519 host key. Pinning it means the push fails loudly
// against an unexpected server instead of trusting whatever answers first;
// rotate this line when GitHub rotates the key.
export const GITHUB_HOST_KEYS = Object.freeze([
  'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'
]);

const COMMIT_NAME = 'Clank & Slop release';
const COMMIT_EMAIL = 'release@clankandslop.invalid';

// Independent of the branch pattern on purpose: if the pattern is ever
// loosened, this is the check that still refuses a ref anything is merged or
// served from, and it is tested on its own so that stays true.
export function assertNotProtectedRef(ref) {
  if (typeof ref !== 'string') throw new Error('push ref must be a string');
  const components = ref.split('/');
  for (const protectedRef of PROTECTED_REFS) if (ref === protectedRef || components.includes(protectedRef)) throw new Error(`push ref ${JSON.stringify(ref)} names the protected ref ${JSON.stringify(protectedRef)} — this job never pushes a branch anything is merged or served from`);
  if (components.includes('.') || components.includes('..') || components.some((component) => component.length === 0)) throw new Error(`push ref ${JSON.stringify(ref)} is not a well-formed ref`);
  return ref;
}

export function assertPushableRef(ref) {
  if (typeof ref !== 'string' || !BRANCH_PATTERN.test(ref)) throw new Error(`push ref ${JSON.stringify(ref)} is not an edition branch — this job may only create refs matching edition/YYYY-MM-DD`);
  return assertNotProtectedRef(ref);
}

// Built here rather than at the call site so the refused flags are a property
// of the policy and not of whoever last edited the caller. Fast-forward only,
// one ref, spelled out on both sides: there is no shorthand for git to read.
const REFUSED_PUSH_FLAGS = Object.freeze(['-f', '--force', '--force-with-lease', '--force-if-includes', '--mirror', '--delete', '-d', '--all', '--tags', '--follow-tags', '--prune', '--atomic', '--receive-pack', '--exec']);

export function assertNoForcedPush(argv) {
  for (const item of argv) {
    if (typeof item !== 'string') throw new Error('push argument list must be strings');
    const flag = item.split('=')[0];
    if (REFUSED_PUSH_FLAGS.includes(flag)) throw new Error(`push argument ${JSON.stringify(item)} is refused — this job pushes fast-forward, one ref, and never force-pushes or deletes a remote ref`);
    if (item.startsWith('+refs/') || item.startsWith('+edition/')) throw new Error(`push refspec ${JSON.stringify(item)} is a forced refspec — the leading "+" overwrites history and is refused`);
    if (item.startsWith(':')) throw new Error(`push refspec ${JSON.stringify(item)} deletes a remote ref and is refused`);
  }
  return argv;
}

export function pushArgv(remoteUrlValue, ref) {
  assertPushableRef(ref);
  return assertNoForcedPush(['push', '--porcelain', remoteUrlValue, `refs/heads/${ref}:refs/heads/${ref}`]);
}

// References the operator's key file; it is never read, copied or re-written by
// this job. The only new files are a config and a known_hosts in a scratch dir.
export const sshConfig = (directory, keyFile) => `${Object.values(PUSH_REMOTES)
  .map((remote) => [
    `Host ${remote.alias}`, `  HostName ${remote.host}`, '  User git',
    `  IdentityFile ${keyFile}`, '  IdentitiesOnly yes', '  IdentityAgent none',
    '  PasswordAuthentication no', '  StrictHostKeyChecking yes',
    `  UserKnownHostsFile ${path.join(directory, 'known_hosts')}`
  ].join('\n'))
  .join('\n\n')}\n`;

export async function prepareSshIdentity(directory, keyFile) {
  if (!path.isAbsolute(keyFile)) throw new Error(`deploy key path ${JSON.stringify(keyFile)} must be absolute`);
  const info = await stat(keyFile).catch(() => { throw new Error(`deploy key ${keyFile} is not readable — this job never invents key material`); });
  if (!info.isFile()) throw new Error(`deploy key ${keyFile} is not a file`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const configFile = path.join(directory, 'config');
  await writeFile(path.join(directory, 'known_hosts'), `${GITHUB_HOST_KEYS.join('\n')}\n`, { mode: 0o600 });
  await writeFile(configFile, sshConfig(directory, keyFile), { mode: 0o600 });
  return { configFile, sshCommand: `ssh -F ${configFile} -o BatchMode=yes` };
}

// --- reading what pressman promoted ----------------------------------------
// `current-edition` is the symlink stage_release flips atomically after its
// validator and build both passed. Following it, rather than scanning for the
// newest directory, means this job can only ever publish an artifact that was
// promoted — a half-written candidate is never named by the link.
export async function resolveStagedEdition(stagingRoot, { stateRoot } = {}) {
  if (!path.isAbsolute(stagingRoot)) throw new Error(`--staging must be an absolute path, got ${JSON.stringify(stagingRoot)}`);
  const link = path.join(stagingRoot, 'current-edition');
  const target = await readlink(link).catch(() => { throw new Error(`no promoted edition at ${link} — pressman has not staged one, or stage_release did not reach promotion`); });
  if (path.isAbsolute(target) || target.includes('/')) throw new Error(`current-edition must name a sibling directory, got ${JSON.stringify(target)}`);
  const artifact = path.join(stagingRoot, target);
  const edition = target.slice(0, 10);
  if (!EDITION_PATTERN.test(edition)) throw new Error(`promoted artifact ${JSON.stringify(target)} does not begin with an edition date`);
  const source = path.join(artifact, 'content', 'editions', edition);
  const info = await stat(source).catch(() => { throw new Error(`promoted artifact carries no ${path.join('content', 'editions', edition)} directory`); });
  if (!info.isDirectory()) throw new Error(`${source} is not a directory`);
  const receipt = stateRoot === undefined ? undefined : await stagedReceipt(stateRoot, edition, artifact);
  return { edition, artifact, source, editionPath: path.posix.join('content', 'editions', edition), receipt };
}

// Optional but recommended: ties the bytes about to be pushed back to the
// durable receipt pressman wrote, so a staging volume edited by hand between
// the build and the push is caught rather than published.
async function stagedReceipt(stateRoot, edition, artifact) {
  if (!path.isAbsolute(stateRoot)) throw new Error(`--state must be an absolute path, got ${JSON.stringify(stateRoot)}`);
  const directory = path.join(stateRoot, 'editions', edition, 'receipts');
  const names = await readdir(directory).catch(() => { throw new Error(`no receipts for edition ${edition} under ${directory}`); });
  const staged = names.filter((name) => name.startsWith('staged-') && name.endsWith('.json'));
  if (staged.length !== 1) throw new Error(`exactly one staged receipt required for edition ${edition}, found ${staged.length}`);
  const value = JSON.parse(await readFile(path.join(directory, staged[0]), 'utf8'));
  if (value.state !== 'staged' || value.edition !== edition) throw new Error(`staged receipt for ${edition} is not a staged receipt for this edition`);
  if (path.resolve(value.staging_root) !== path.resolve(artifact)) throw new Error(`staged receipt names ${value.staging_root}, but current-edition points at ${artifact}`);
  return value;
}

// --- running it -------------------------------------------------------------
// A closed environment for every git invocation: no user or system config, no
// terminal prompt, no credential helper. A git that wants anything interactive
// fails instead of hanging.
const gitEnvironment = (home, sshCommand, date) => ({
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: home, TMPDIR: path.join(home, 'tmp'),
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
  child.once('exit', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`git ${args.slice(0, 4).join(' ')} failed (${code}): ${err.trim().slice(-1500)}`)));
});

// Cuts one branch from the remote's base branch, adds exactly the edition
// directory to it, and fast-forward pushes that one ref. `add`, `commit` and
// `status` are all path-scoped to the edition directory, so nothing else in the
// scratch tree can ride along in the commit.
export async function pushStagedEditionTree({ url, branch, editionSource, editionPath, workdir, home, sshCommand, base = BASE_BRANCH, message, dryRun = false }) {
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
  // failed push rebuilds the identical commit instead of a new one every run.
  const date = `${branch.slice('edition/'.length)}T16:00:00+02:00`;
  await git(['-C', workdir, '-c', `user.name=${COMMIT_NAME}`, '-c', `user.email=${COMMIT_EMAIL}`, 'commit', '-q', '-m', message, '--', scoped], { ...options, date });
  const commit = await git(['-C', workdir, 'rev-parse', 'HEAD'], options);
  if (dryRun) return { branch, commit, base: baseCommit, remote_url: url, pushed: false };
  await git(['-C', workdir, ...pushArgv(url, branch)], options);
  return { branch, commit, base: baseCommit, remote_url: url, pushed: true };
}

export function parseArguments(argv) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--dry-run') { options.dryRun = true; continue; }
    const value = argv[index += 1];
    if (value === undefined) throw new Error(`${name} requires a value`);
    if (name === '--staging') options.staging = path.resolve(value);
    else if (name === '--state') options.state = path.resolve(value);
    else if (name === '--key') options.key = path.resolve(value);
    else throw new Error(`unknown argument ${JSON.stringify(name)}`);
  }
  if (!options.staging) throw new Error('--staging <clank-release-staging volume path> is required');
  if (!options.key && !options.dryRun) throw new Error('--key <deploy key path> is required unless --dry-run');
  return options;
}

// `url` defaults to the one constant remote and is a test seam, not a knob:
// `parseArguments` has no flag that can set it, so the command line cannot
// redirect this job at another repository.
export async function publishEditionBranch(options, url = remoteUrl(EDITION_PUSH_REMOTE)) {
  const staged = await resolveStagedEdition(options.staging, { stateRoot: options.state });
  const scratch = await mkdtemp(path.join(tmpdir(), 'clank-publish-'));
  try {
    const identity = options.key === undefined ? {} : await prepareSshIdentity(path.join(scratch, 'ssh'), options.key);
    const result = await pushStagedEditionTree({
      url, branch: editionBranch(staged.edition),
      editionSource: staged.source, editionPath: staged.editionPath,
      workdir: path.join(scratch, 'repo'), home: path.join(scratch, 'home'),
      sshCommand: identity.sshCommand, message: editionCommitMessage(staged.edition), dryRun: options.dryRun
    });
    return { ...result, edition: staged.edition, remote: EDITION_PUSH_REMOTE, artifact: staged.artifact, published: false };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const result = await publishEditionBranch(parseArguments(argv));
  // A positive signal, not an exit code: the branch and commit are what a
  // person needs to open the pull request, and their absence is the failure.
  console.log(JSON.stringify(result, undefined, 2));
  console.log(result.pushed
    ? `pushed ${result.branch} (${result.commit.slice(0, 12)}) — open the pull request against ${BASE_BRANCH} to publish`
    : `dry run: ${result.branch} (${result.commit.slice(0, 12)}) built and not pushed`);
  return result;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => { console.error(`publish-edition-branch: ${error.message}`); process.exitCode = 1; });
}
