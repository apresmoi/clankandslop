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
//     --key     ~/.ssh/clank-deploy/clankandslop \
//     --edition today            # refuse anything but today's paper
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildBylinesTsv } from './build-bylines-tsv.mjs';
import { buildTopicsTxt } from './build-topics-txt.mjs';
import { repinSource } from './check-bundle-descriptor.mjs';
import { releaseClock } from './release-time.mjs';

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

// --- which edition a timer is allowed to publish -----------------------------
// `current-edition` is durable: it keeps naming last night's artifact until
// pressman promotes a new one. A job a person runs reads that as "publish what
// was staged"; a job a TIMER runs at 17:00 every day must read it as "publish
// TODAY'S paper or nothing", or the first evening the org fails to compose it
// re-pushes yesterday's — silently, unattended, for as many nights as the org
// stays down. Hence `--edition`: the caller states which date it means, and a
// mismatch is a refusal that alarms rather than a push.
//
// Berlin, not UTC, because every other clock in this system is Berlin: the
// crons, the edition release instant, the seam, the audit. A UTC "today" would
// disagree with all of them for two hours every night, which is exactly the
// window this timer runs in.
const berlinDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
export const berlinToday = (now = new Date()) => berlinDate.format(now);

export function assertRequestedEdition(stagedEdition, requested, now = new Date()) {
  if (requested === undefined) return stagedEdition;
  const wanted = requested === 'today' ? berlinToday(now) : requested;
  if (!EDITION_PATTERN.test(wanted)) throw new Error(`--edition must be "today" or YYYY-MM-DD, got ${JSON.stringify(requested)}`);
  if (stagedEdition !== wanted) throw new Error(`the promoted edition is ${stagedEdition}, but ${JSON.stringify(requested)} means ${wanted} — nothing was pushed. Either pressman has not staged today's paper, or current-edition is stale.`);
  return stagedEdition;
}

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

// --- the generated views CI diff-checks --------------------------------------
// `content/topics.txt` and `content/bylines/*.tsv` are committed views of
// content the edition changes: the topic registry, and every article file.
// ci.yml regenerates both and runs `git diff --exit-code`, and nothing else in
// the pipeline invokes the generators — so an edition branch built from the
// edition directory alone lands red and stays red until a person runs them by
// hand. They are regenerated here, from the branch's own tree, immediately
// before the commit.
//
// `agentic-org/newsroom-runtime-bundle.json` and the twelve Spawnfile source
// pins are the THIRD instance of exactly that defect, and the one that made an
// unattended publication impossible rather than merely annoying. The source
// archive is every tracked file bar a short exclusion list, so
// `content/editions/<date>/**` is IN it: adding an edition changes the source
// digest, and ci.yml's "Check the runtime bundle descriptor describes this
// tree" therefore fails on EVERY edition branch. Verified against `main`
// (green) plus one restored edition directory: source.file_count 1243 -> 1256,
// digest moved, check red. Without this, no edition branch could ever be green
// and an auto-merge would have had nothing to merge, ever.
//
// This widens what the commit may contain by exactly these paths, all
// mechanically derived from the tree being committed, and widens nothing about
// what may be pushed: the branch, the refspec, the remote and the flags are
// untouched, and `main` is still refused as hard as it ever was.
export const GENERATED_INDEX_PATHS = Object.freeze(['content/topics.txt', 'content/bylines']);
export const REPINNED_DESCRIPTOR_PATHS = Object.freeze(['agentic-org/newsroom-runtime-bundle.json', 'agentic-org/agents']);

// Both generators are pure functions of the tree they are handed, so a retry
// rebuilds byte-identical output and the commit stays the same object.
export async function regenerateIndexes(workdir) {
  if (!path.isAbsolute(workdir)) throw new Error('index regeneration workdir must be an absolute path');
  buildTopicsTxt(workdir);
  const { written, articleCount } = buildBylinesTsv(workdir);
  return { topics: 'content/topics.txt', bylines: written.map((item) => `content/bylines/${item.agent}.tsv`), articles: articleCount };
}

// LAST, and after the generated views are staged. `repinSource` measures the
// git INDEX, so the digest it writes only describes the commit if every other
// path the commit carries is already in the index — measuring before
// `content/bylines/<agent>.tsv` is staged produces a pin that is short by
// exactly the files the generators just wrote, and the branch lands red on the
// same check this exists to satisfy.
//
// And it is skipped, loudly and in the result, when a historical base branch
// does not carry a descriptor at all. Public main now carries `agentic-org/`,
// so normal unattended publication repins the descriptor and Spawnfile pins
// from that main-based tree. What is committed remains a function of what the
// base branch actually carries, read from the branch; nothing here decides not
// to repin a tree that has a descriptor.
export const DESCRIPTOR_FILE = 'agentic-org/newsroom-runtime-bundle.json';

export async function repinBundleDescriptor(workdir) {
  if (!path.isAbsolute(workdir)) throw new Error('descriptor repin workdir must be an absolute path');
  const present = await stat(path.join(workdir, DESCRIPTOR_FILE)).then((info) => info.isFile()).catch(() => false);
  if (!present) return { skipped: true, reason: `${DESCRIPTOR_FILE} is not on the base branch — nothing to repin, and nothing on the branch checks it` };
  const pins = repinSource(workdir);
  return { skipped: false, source: pins.digest, previous: pins.previous, file_count: pins.file_count, content_bytes: pins.content_bytes, repinned: pins.repinned };
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

// The producer's own artifact hash, recomputed here. Byte-identical rule to
// `directoryDigest` in production-newsroom.mjs (the function `promoteCandidate`
// hashes the candidate with before it renames it into place): names sorted,
// `d\0<path>\0` or `f\0<path>\0` per entry, file contents appended, any symlink
// or device node a refusal. It is deliberately a second implementation on the
// other side of the airlock — a digest a host recomputes is evidence; a digest
// it copies out of the receipt is a restatement.
export async function artifactDigest(directory) {
  const hash = createHash('sha256');
  const visit = async (base, relative = '') => {
    for (const name of (await readdir(base)).sort()) {
      const file = path.join(base, name), next = path.posix.join(relative, name), info = await lstat(file);
      if (info.isSymbolicLink()) throw new Error(`release artifact contains a symlink at ${next}`);
      hash.update(`${info.isDirectory() ? 'd' : 'f'}\0${next}\0`);
      if (info.isDirectory()) await visit(file, next);
      else if (info.isFile()) hash.update(await readFile(file));
      else throw new Error(`release artifact contains an unsupported node at ${next}`);
    }
  };
  await visit(directory);
  return `sha256:${hash.digest('hex')}`;
}

// Ties the bytes about to be pushed back to the durable receipt pressman wrote,
// so a staging volume edited by hand between the build and the push is caught
// rather than published.
//
// IT CANNOT COMPARE THE PATH, and used to. `stage_release` records
// `staging_root` as it sees it — CLANK_RELEASE_STAGING_ROOT, which for pressman
// is the workspace symlink `…/agents/pressman/staging/<artifact>`. This job sees
// the same directory as the host mount point of the same volume,
// `/var/lib/docker/volumes/clank-release-staging/_data/<artifact>`. The two
// strings never match, so `--state` — the flag the unattended timer must pass —
// refused every real artifact. Verified on the box on 2026-09-06 against the
// first artifact `stage_release` has ever produced: the check fired on the
// prefix and nothing else was ever examined.
//
// What replaces it is not weaker, it is the thing the path comparison was
// reaching for and never had:
//
//   * the artifact's DIRECTORY NAME must match the receipt's, and must be the
//     name `stage_release` derives from the composition digest it recorded —
//     `<edition>-<composition digest[0:16]>`. Mount-point independent, and it
//     binds the artifact to the composition rather than to a mount.
//   * the artifact's CONTENT must hash to the receipt's `artifact_digest`,
//     recomputed here from the bytes on disk. A hand-edited staging volume is
//     caught by this and was never caught by the path.
async function stagedReceipt(stateRoot, edition, artifact) {
  if (!path.isAbsolute(stateRoot)) throw new Error(`--state must be an absolute path, got ${JSON.stringify(stateRoot)}`);
  const directory = path.join(stateRoot, 'editions', edition, 'receipts');
  const names = await readdir(directory).catch(() => { throw new Error(`no receipts for edition ${edition} under ${directory}`); });
  const staged = names.filter((name) => name.startsWith('staged-') && name.endsWith('.json'));
  if (staged.length !== 1) throw new Error(`exactly one staged receipt required for edition ${edition}, found ${staged.length}`);
  const value = JSON.parse(await readFile(path.join(directory, staged[0]), 'utf8'));
  if (value.state !== 'staged' || value.edition !== edition) throw new Error(`staged receipt for ${edition} is not a staged receipt for this edition`);
  const name = path.basename(path.resolve(artifact));
  if (path.basename(path.resolve(String(value.staging_root ?? ''))) !== name) throw new Error(`staged receipt names the artifact ${JSON.stringify(value.staging_root)}, but current-edition points at ${JSON.stringify(name)}`);
  if (typeof value.composition_digest !== 'string' || name !== `${edition}-${value.composition_digest.slice(7, 23)}`) throw new Error(`promoted artifact ${JSON.stringify(name)} is not the artifact this composition produced — stage_release names it <edition>-<composition digest>, and the receipt records ${JSON.stringify(value.composition_digest)}`);
  if (typeof value.artifact_digest !== 'string') throw new Error(`staged receipt for ${edition} carries no artifact_digest — nothing binds the bytes on disk to what pressman built`);
  const measured = await artifactDigest(artifact);
  if (measured !== value.artifact_digest) throw new Error(`the promoted artifact hashes to ${measured}, but the staged receipt records ${value.artifact_digest} — the staging volume changed after pressman built it, and this job does not publish bytes nobody staged`);
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
  for (const item of [scoped, ...GENERATED_INDEX_PATHS, ...REPINNED_DESCRIPTOR_PATHS])
    if (path.isAbsolute(item) || item.split('/').includes('..')) throw new Error(`edition path ${JSON.stringify(editionPath)} must stay inside the branch`);
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
  // Whether the edition is worth a branch is still decided by the edition
  // directory alone: a re-run of an edition already on the base branch is
  // refused here, exactly as before, and never on generated-index drift.
  await git(['-C', workdir, 'add', '--', scoped], options);
  const staged = await git(['-C', workdir, 'status', '--porcelain', '--', scoped], options);
  // Already on the base branch, byte for byte: the edition was published and
  // merged, and this is a second run of a timer that fires every night. That is
  // a SUCCESS with nothing to do, not a failure — a nightly alarm for "the
  // paper you published is published" trains a person to ignore the alarm, and
  // the alarm is the only thing standing between a broken cycle and a silent
  // one. A branch that exists at a DIFFERENT commit is still a refusal below:
  // that one really does need a person.
  if (staged.length === 0)
    return { branch, commit: baseCommit, base: baseCommit, remote_url: url, generated: null, pushed: false, already_published: true };
  const generated = await regenerateIndexes(workdir);
  await git(['-C', workdir, 'add', '--', ...GENERATED_INDEX_PATHS], options);
  generated.descriptor = await repinBundleDescriptor(workdir);
  const descriptorPaths = generated.descriptor.skipped ? [] : REPINNED_DESCRIPTOR_PATHS;
  if (descriptorPaths.length > 0) await git(['-C', workdir, 'add', '--', ...descriptorPaths], options);
  // Pinned to the edition's own Berlin release instant so a retry after a
  // failed push rebuilds the identical commit instead of a new one every run.
  const edition = branch.slice('edition/'.length);
  const date = `${edition}T${releaseClock(edition)}:00+02:00`;
  const committed = [scoped, ...GENERATED_INDEX_PATHS, ...descriptorPaths];
  await git(['-C', workdir, '-c', `user.name=${COMMIT_NAME}`, '-c', `user.email=${COMMIT_EMAIL}`, 'commit', '-q', '-m', message, '--', ...committed], { ...options, date });
  const commit = await git(['-C', workdir, 'rev-parse', 'HEAD'], options);
  if (dryRun) return { branch, commit, base: baseCommit, remote_url: url, generated, pushed: false, already_published: false };
  await git(['-C', workdir, ...pushArgv(url, branch)], options);
  return { branch, commit, base: baseCommit, remote_url: url, generated, pushed: true, already_published: false };
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
    else if (name === '--edition') {
      if (value !== 'today' && !EDITION_PATTERN.test(value)) throw new Error(`--edition must be "today" or YYYY-MM-DD, got ${JSON.stringify(value)}`);
      options.edition = value;
    } else throw new Error(`unknown argument ${JSON.stringify(name)}`);
  }
  if (!options.staging) throw new Error('--staging <clank-release-staging volume path> is required');
  if (!options.key && !options.dryRun) throw new Error('--key <deploy key path> is required unless --dry-run');
  // An unattended caller states which edition it means; it must also let the
  // durable receipt vouch for the bytes it is about to push. Naming a date
  // proves current-edition is not stale; the receipt proves the artifact behind
  // it was not edited by hand since pressman built it. Neither substitutes for
  // the other, so `--edition` without `--state` is refused rather than half-run.
  if (options.edition && !options.state) throw new Error('--edition requires --state <clank-edition-state volume path>: an unattended publication binds the pushed bytes to the staged receipt');
  return options;
}

// `url` defaults to the one constant remote and is a test seam, not a knob:
// `parseArguments` has no flag that can set it, so the command line cannot
// redirect this job at another repository.
export async function publishEditionBranch(options, url = remoteUrl(EDITION_PUSH_REMOTE), { now = new Date() } = {}) {
  const staged = await resolveStagedEdition(options.staging, { stateRoot: options.state });
  assertRequestedEdition(staged.edition, options.edition, now);
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
  console.log(result.already_published
    ? `edition/${result.edition} already published as ${result.commit.slice(0, 12)} — the edition is already on ${BASE_BRANCH}, nothing to push`
    : result.pushed
      ? `pushed ${result.branch} (${result.commit.slice(0, 12)}) — open the pull request against ${BASE_BRANCH} to publish`
      : `dry run: ${result.branch} (${result.commit.slice(0, 12)}) built and not pushed`);
  return result;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => { console.error(`publish-edition-branch: ${error.message}`); process.exitCode = 1; });
}
