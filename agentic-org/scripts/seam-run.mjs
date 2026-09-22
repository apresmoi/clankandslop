#!/usr/bin/env node
// The seam: the step that was a person, every morning.
//
// WHAT IT REPLACES
// ----------------
// Research lands on `edition/<date>` in clankandslop-private overnight. Before
// the reporters wake, somebody had to repin agentic-org/policies/private-source.json
// to that branch, rebuild the bundles, and redeploy. Nothing watched for the
// trigger, so on 2026-09-06 the pin was stale at wake time and every reporter's
// research pull ENOENTed. This is that person, as a job.
//
// THE ORDER IS NOT A STYLE CHOICE
// -------------------------------
//   1. repin-private-source.mjs            — standalone, FIRST
//   2. check-bundle-descriptor --repin-source
//   3. npm run org:bundle
//   4. check-bundle-descriptor             — the proof
//
// (1) before (2): repinning rewrites policies/private-source.json, which is a
// tracked file and therefore part of the source archive, so the source digest
// is only measurable once the pin is in.
// (2) before (3): `--repin-source` finds the twelve source archive pins by
// searching for the descriptor's CURRENT source digest. `org:bundle` advances
// the descriptor and refreshes generated public asset pins, so running it first
// leaves source repin nothing to match and produces an image whose agents pin a
// source archive that no longer exists. Confirmed on the box, 2026-09-06, by
// doing it wrong.
//
// A REDEPLOY KILLS IN-FLIGHT WAKES
// --------------------------------
// So this job refuses to deploy unless wake-window.mjs says the schedule is
// clear AND the running container is quiet — the second read from daimon's own
// wake-acceptance receipts, its usage ledger and the container's process table,
// never assumed from the hour. See that module's header.
//
// THE BUILD ROOT IS LOAD-BEARING
// ------------------------------
// Durable volume names are derived from the Spawnfile's PATH: the edition-state
// volume is `...-team-clank-and-slop-root-work-clankandslop-agentic-org-spawnfile-016c21d8-...`.
// Building the same tree from a different directory mints different volume
// names and silently detaches every agent's memory. `--repo` therefore defaults
// to the one path the live deployment was built from and is asserted, not
// assumed.
//
// USAGE
//   node agentic-org/scripts/seam-run.mjs                  # the real thing
//   node agentic-org/scripts/seam-run.mjs --check          # verify only, writes nothing
//   node agentic-org/scripts/seam-run.mjs --no-deploy      # repin + bundle + build, no `up`
//   node agentic-org/scripts/seam-run.mjs --edition=2026-09-06 --repo=/tmp/clone
//
// Every stage that fails raises the alarm (alarm.mjs) before exiting non-zero.

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, chownSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { raiseDetached } from './alarm.mjs';
import { assess } from './wake-window.mjs';
import { DAIMON_RUNTIME_CONFIG, DAIMON_UID_ENTRYPOINT, compiledArtifacts, compiledEngineFindings, grokBrokerFindings } from './engine-policy.mjs';

export const DEFAULT_REPO = '/root/work/clankandslop';
export const DEFAULT_CONTAINER = 'spawnfile-clank-and-slop';
export const DEFAULT_DEPLOYMENT = 'clank-and-slop';
export const DEFAULT_SPAWNFILE_CLI = '/home/clank/deploy-work/spawnfile-main/dist/cli/index.js';
export const DEFAULT_ENV_FILE = '/home/clank/deploy-work/deploy.env';
export const DEFAULT_DEPLOY_USER = 'clank';
// Seam-built images are tagged so they can be told apart from every hand-built
// `local<n>`, and so the retention sweep below can only ever touch its own.
export const TAG_PREFIX = 'clank-and-slop:seam-';
export const KEEP_IMAGES = 3;
// `build` writes the compiler's whole output tree to
// `.runtime/seam-compiled-<tag>/` and nothing ever removed it. Twelve of them
// had accumulated by 2026-09-20 — 8.2GB of pure scratch on a 75GB disk, more
// than the images the sweep above bounds — and a run that leaves the host below
// its own build floor blocks the next one. Two are kept: the live deployment's
// tree and the one before it, which is what a "what changed in the compiled
// output" comparison needs. Everything in them is a pure function of the tree
// and the tag, so a deleted one is reproducible by rebuilding.
export const COMPILED_OUTPUT_DIR = '.runtime';
export const COMPILED_OUTPUT_PREFIX = 'seam-compiled-';
export const KEEP_COMPILED_OUTPUTS = 2;
// Archives an agent may pin that newsroom-runtime-bundle.json deliberately does
// not describe, because org:bundle does not build them.
export const KNOWN_UNDESCRIBED = Object.freeze(['etopo-relief.tar']);

const berlinDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
export const berlinToday = (now = new Date()) => berlinDate.format(now);
export class SeamError extends Error { constructor(message, reason) { super(message); this.reason = reason; } }

export function parseArgs(argv) {
  const options = {
    edition: null, ref: null, repo: DEFAULT_REPO, container: DEFAULT_CONTAINER, deployment: DEFAULT_DEPLOYMENT,
    cli: process.env.SPAWNFILE_CLI ?? DEFAULT_SPAWNFILE_CLI, envFile: process.env.CLANK_DEPLOY_ENV_FILE ?? DEFAULT_ENV_FILE,
    compiledOutput: null,
    deployUser: DEFAULT_DEPLOY_USER, tag: null, check: false, deploy: true, skipContainer: false, leadMinutes: 30, tailMinutes: 120
  };
  for (const arg of argv) {
    const [key, ...rest] = arg.startsWith('--') ? arg.slice(2).split('=') : [null];
    const value = rest.join('=');
    if (key === 'edition' && value) options.edition = value;
    else if (key === 'ref' && value) options.ref = value;
    else if (key === 'repo' && value) options.repo = path.resolve(value);
    else if (key === 'container' && value) options.container = value;
    else if (key === 'deployment' && value) options.deployment = value;
    else if (key === 'cli' && value) options.cli = path.resolve(value);
    else if (key === 'env-file' && value) options.envFile = path.resolve(value);
    else if (key === 'deploy-user' && value) options.deployUser = value;
    else if (key === 'tag' && value) options.tag = value;
    else if (key === 'lead-minutes' && value) options.leadMinutes = Number(value);
    else if (key === 'tail-minutes' && value) options.tailMinutes = Number(value);
    else if (key === 'check') { options.check = true; options.deploy = false; }
    else if (key === 'no-deploy') options.deploy = false;
    else if (key === 'no-container') options.skipContainer = true;
    else throw new SeamError(`unrecognized argument: ${arg}`, 'seam-blocked');
  }
  if (options.edition && !/^\d{4}-\d{2}-\d{2}$/u.test(options.edition)) throw new SeamError(`--edition must be YYYY-MM-DD, got ${options.edition}`, 'seam-blocked');
  return options;
}

// Every external command goes through here so a failure carries the stage's
// alarm reason with it, and so the transcript records exactly what ran.
function run(stage, reason, command, args, { cwd, env, log }) {
  log(`\n$ ${command} ${args.join(' ')}${cwd ? `   (in ${cwd})` : ''}`);
  const result = spawnSync(command, args, { cwd, env: env ?? process.env, encoding: 'utf8', maxBuffer: 1 << 28 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (output.trim()) log(output.trimEnd());
  if (result.error) throw new SeamError(`${stage}: ${command} could not run: ${result.error.message}`, reason);
  if (result.status !== 0) throw new SeamError(`${stage} FAILED (exit ${result.status})\n${output.trim().slice(-2000)}`, reason);
  return output;
}

// --- stage 1: may we touch the deployment at all -----------------------------
export function gate(options, { now = new Date(), log = console.log } = {}) {
  const orgRoot = path.join(options.repo, 'agentic-org');
  if (!existsSync(path.join(orgRoot, 'Spawnfile'))) throw new SeamError(`--repo ${options.repo} has no agentic-org/Spawnfile — this is not the organization checkout`, 'seam-blocked');
  const verdict = assess(orgRoot, options.container, { now, leadMinutes: options.leadMinutes, tailMinutes: options.tailMinutes, skipContainer: options.skipContainer });
  log(`schedule (${verdict.window.timezone}) wakes at ${verdict.window.wakeTimes.join(', ')}`);
  log(`derived deploy window ${verdict.window.recommended.from} -> ${verdict.window.recommended.to} (largest gap ${verdict.window.gap.from}->${verdict.window.gap.to}, ${verdict.window.gap.minutes} min; lead ${options.leadMinutes} / tail ${options.tailMinutes})`);
  if (!verdict.state.observed.skipped)
    log(`container ${verdict.state.observed.container ?? 'unknown'}: ${verdict.state.observed.outstanding.length} outstanding wake(s), ${verdict.state.observed.incompleteTurns} incomplete turn(s), last turn ${verdict.state.observed.lastTurnMinutesAgo ?? 'n/a'} min ago, ${verdict.state.observed.extraProcesses.length} non-steady-state process(es)`);
  if (!verdict.safe) throw new SeamError(`refusing to touch the deployment — ${verdict.findings.length} finding(s):\n  ${verdict.findings.join('\n  ')}`, 'seam-blocked');
  log('gate: schedule clear and container quiet.');
  return verdict;
}

// --- stage 2: the pin --------------------------------------------------------
export function repin(options, { log = console.log } = {}) {
  const args = [path.join(options.repo, 'agentic-org/scripts/repin-private-source.mjs'), `--edition=${options.edition}`, `--ref=${options.ref}`];
  if (options.check) args.push('--check');
  return run('repin', 'repin-failed', process.execPath, args, { cwd: options.repo, log });
}

// --- stage 3: the bundles ----------------------------------------------------
// THREE commands, in one order that is the only order that works. Verified on
// the box, 2026-09-06, by getting it wrong first:
//
//   a. `--repin-source` FIRST, because it finds the Spawnfile pins by searching
//      for the descriptor's CURRENT source digest. It has to run while the
//      descriptor still holds the digest the Spawnfiles hold. It also has to
//      run AFTER repin-private-source.mjs, because that rewrites
//      policies/private-source.json — a tracked file, therefore part of the
//      source archive — so the measurement is only correct once the pin is in.
//   b. `org:bundle` SECOND. It writes the six tars and the descriptor, and it
//      refreshes generated public asset pins in Spawnfiles. Running it before
//      (a) advances the source descriptor, leaves (a) nothing to match, and
//      silently produces an image whose agents pin a source archive that no
//      longer exists.
//   c. the plain check LAST, as the proof rather than the hope.
//
// Dependency archives have no automatic repin: their digests are only advanced
// by reviewed source changes, so if `npm ci` moved node_modules underneath this
// job, the descriptor advances and the pins do not. Generated public assets are
// repinned by `org:bundle` and then checked here against the descriptor.
// Dependency drift remains a refusal, not a repair — rewriting a dependency pin
// from an unreviewed rebuild is how you deploy an archive nobody chose.
export function bundle(options, { log = console.log } = {}) {
  if (options.check) {
    log('\n(check mode: not rebuilding the archives; verifying the descriptor against the tree instead)');
    run('bundle-check', 'bundle-mismatch', process.execPath, [path.join(options.repo, 'agentic-org/scripts/check-bundle-descriptor.mjs')], { cwd: options.repo, log });
    return assertPinsMatchDescriptor(options, { log });
  }
  run('bundle-repin-source', 'bundle-mismatch', process.execPath, [path.join(options.repo, 'agentic-org/scripts/check-bundle-descriptor.mjs'), '--repin-source'], { cwd: options.repo, log });
  run('bundle', 'bundle-mismatch', 'npm', ['run', 'org:bundle'], { cwd: options.repo, log });
  run('bundle-verify', 'bundle-mismatch', process.execPath, [path.join(options.repo, 'agentic-org/scripts/check-bundle-descriptor.mjs')], { cwd: options.repo, log });
  return assertPinsMatchDescriptor(options, { log });
}

// Every checksum-pinned bundle resource in every agent Spawnfile, against the
// archive of that name in the descriptor. `check-bundle-descriptor.mjs` only
// covers the source archive — deliberately, because it must be able to run in
// CI without the private checkout or node_modules. This job has both, so it
// checks every archive described by the runtime, tools and article-validation descriptors.
const descriptorEntries = (descriptor) => [descriptor.source, descriptor.private, ...descriptor.dependencies ?? [], ...descriptor.assets ?? []]
  .filter((entry) => entry?.archive);

function describedArchives(repo) {
  const descriptorPath = path.join(repo, 'agentic-org/newsroom-runtime-bundle.json');
  const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
  const entries = descriptorEntries(descriptor);
  for (const name of ['newsroom-tools-bundle.json', 'article-validation-runtime-bundle.json']) {
    const file = path.join(repo, 'agentic-org', name);
    if (existsSync(file)) entries.push(JSON.parse(readFileSync(file, 'utf8')));
  }
  return entries;
}

export function pinFindings(repo) {
  const byArchive = new Map();
  for (const entry of describedArchives(repo)) byArchive.set(entry.archive, entry.sha256);
  // Caslon's relief grid is built by build-etopo-bundle.mjs from a ~395MB
  // external download, not by org:bundle, so the descriptor does not and should
  // not describe it. Named here rather than skipped silently: any OTHER archive
  // the descriptor does not know about is drift and must still be a finding.
  const undescribed = new Set(KNOWN_UNDESCRIBED);
  const agentsRoot = path.join(repo, 'agentic-org/agents');
  const findings = [];
  let checked = 0;
  for (const agent of readdirSync(agentsRoot).sort()) {
    const file = path.join(agentsRoot, agent, 'Spawnfile');
    if (!existsSync(file)) continue;
    for (const [, id, archive, pinned] of readFileSync(file, 'utf8').matchAll(/- \{ id: ([\w-]+), kind: bundle, source: \.\.\/\.\.\/([\w.-]+\.tar), sha256: (sha256:[a-f0-9]{64})/gu)) {
      const expected = byArchive.get(archive);
      checked += 1;
      if (expected === undefined) { if (!undescribed.has(archive)) findings.push(`agents/${agent}/Spawnfile pins ${archive} as ${id}, which the descriptor does not describe`); }
      else if (expected !== pinned) findings.push(`agents/${agent}/Spawnfile pins ${archive} at ${pinned}, the descriptor says ${expected}`);
    }
  }
  if (checked === 0) findings.push(`no agent Spawnfile under ${agentsRoot} declares a checksum-pinned bundle resource — the pin check matched nothing, which is not the same as passing`);
  return { findings, checked, archives: [...byArchive.keys()] };
}

export function assertPinsMatchDescriptor(options, { log = console.log } = {}) {
  const result = pinFindings(options.repo);
  if (result.findings.length) throw new SeamError(`bundle pins disagree with the descriptor — ${result.findings.length} finding(s):\n  ${result.findings.join('\n  ')}`, 'bundle-mismatch');
  log(`pins: ${result.checked} checksum-pinned bundle resource(s) across the agent Spawnfiles all match the descriptor (${result.archives.join(', ')})`);
  return result;
}

// --- stage 3b: room to build in ----------------------------------------------
// On 2026-09-20 the host reached 100% disk mid-`up`: the candidate container died,
// the rollback worked, and `spawnfile`'s own diagnostics file was written zero bytes
// long because there was nowhere to put it - so the failure arrived with no reason
// attached and cost twenty minutes to identify. Reclaiming first is what makes the
// difference: docker build cache was 17.7GB of the 75GB volume that night and a
// prune returned 13.2GB in seconds. The floor is the second half: a build that
// cannot fit must be refused while the deployment is still whole, not discovered
// halfway through an image export.
export const BUILD_FLOOR_BYTES = 10 * 1024 * 1024 * 1024;

export function reclaimBuildSpace(options, { log = console.log, exec = execFileSync, floorBytes = BUILD_FLOOR_BYTES, sweepScratch = sweepCompiledOutputs } = {}) {
  const free = () => {
    const line = exec('df', ['-B1', '--output=avail', options.repo], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim().split('\n').at(-1);
    const bytes = Number(String(line).trim());
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new SeamError(`unreadable free space for ${options.repo}: ${line}`, 'seam-blocked');
    return bytes;
  };
  const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)}GiB`;
  const before = free();
  // Cache only: never an image, never a volume, never a running container's layers.
  try { exec('docker', ['builder', 'prune', '-af', '--filter', 'until=24h'], { stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { log(`  (build cache prune skipped: ${String(error.message).trim().slice(0, 120)})`); }
  sweepImages(options, { log, exec });
  sweepScratch(options, { log });
  let after = free();
  log(`disk: ${gib(before)} free before reclaim, ${gib(after)} after (floor ${gib(floorBytes)})`);
  // Still short, so the 24h filter was the thing holding space back. On a daily
  // cadence yesterday's cache is right on that boundary and may or may not be
  // caught: on 2026-09-21 the box came out of a successful run with 12.8GB of
  // build cache of which only 3.3GB was older than a day, and 9.8GB free —
  // under its own floor, with nothing wrong except the filter.
  //
  // Build cache is pure cache. Dropping all of it costs the next build time and
  // nothing else, which is unambiguously better than refusing to run. It stays
  // a SECOND pass rather than the first so the ordinary day keeps its warm
  // cache, and it still never touches an image, a volume or a container.
  if (after < floorBytes) {
    log(`  below the floor after the filtered prune; dropping the whole build cache`);
    try { exec('docker', ['builder', 'prune', '-af'], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { log(`  (full build cache prune skipped: ${String(error.message).trim().slice(0, 120)})`); }
    after = free();
    log(`disk: ${gib(after)} free after dropping the build cache (floor ${gib(floorBytes)})`);
  }
  if (after < floorBytes) {
    throw new SeamError(`refusing to build with ${gib(after)} free below the ${gib(floorBytes)} floor - reclaim space before deploying`, 'seam-blocked');
  }
  return { before, after };
}

// The scratch equivalent of sweepImages: bounded, prefix-scoped, and it never
// touches the tree THIS run is about to write. Sorted by modification time
// rather than by the timestamp in the name, because the name is the image tag
// and a rebuild of an older tag is still the newer tree.
export function sweepCompiledOutputs(options, { log = console.log, keep = KEEP_COMPILED_OUTPUTS, list = readdirSync, stat = statSync, remove = rmSync } = {}) {
  const root = path.join(options.repo, COMPILED_OUTPUT_DIR);
  const current = path.basename(compiledOutputPath(options));
  try {
    const trees = list(root)
      .filter((name) => name.startsWith(COMPILED_OUTPUT_PREFIX) && name !== current)
      .map((name) => ({ name, at: Number(stat(path.join(root, name)).mtimeMs) }))
      .sort((a, b) => b.at - a.at);
    for (const tree of trees.slice(keep)) {
      try { remove(path.join(root, tree.name), { recursive: true, force: true }); log(`  retired compiled output ${tree.name}`); }
      catch (error) { log(`  (could not retire ${tree.name}: ${String(error.message).trim().slice(0, 120)})`); }
    }
  } catch (error) { log(`  (compiled output sweep skipped: ${String(error.message).trim().slice(0, 120)})`); }
}

// --- stage 4: the image ------------------------------------------------------
// One definition of where the compiler writes, so the sweep above and the build
// below cannot disagree about which tree belongs to this run.
export function compiledOutputPath(options) {
  return path.join(options.repo, COMPILED_OUTPUT_DIR, `${COMPILED_OUTPUT_PREFIX}${String(options.tag ?? '').replace(/[^a-zA-Z0-9_.-]/gu, '_')}`);
}

export function build(options, { log = console.log } = {}) {
  options.compiledOutput = compiledOutputPath(options);
  run('build', 'deploy-failed', process.execPath, [options.cli, 'build', path.join(options.repo, 'agentic-org'), '--tag', options.tag, '--out', options.compiledOutput], { cwd: options.repo, log });
  return options.tag;
}

// --- stage 5: compiled engine policy admission ------------------------------
// Was "compiled Codex policy admission", and it refused any organization with
// no Codex agent in it — which is not a safety property, it is an assumption
// about the roster. What it was protecting is: nothing reaches `up` unless
// EVERY compiled agent carries its engine's confinement.
//
// Codex states that confinement on the agent (`engine.codexSandbox`). Grok
// does not: its workers run behind Daimon's engine broker, and the
// confinement is the broker apparatus the compiler renders into the container
// entrypoint — a network-restricted Landlock profile pinned by digest, a
// loopback-only provider proxy with backend search off, and a dedicated worker
// uid per agent. So both artifacts are read here, and an engine this job has
// no equivalent for is a refusal by name rather than a `continue`.
export function runtimePolicy(options, { log = console.log } = {}) {
  if (!options.compiledOutput || !existsSync(options.compiledOutput)) throw new SeamError('compiled output missing after build', 'deploy-failed');
  const configs = compiledArtifacts(options.compiledOutput, DAIMON_RUNTIME_CONFIG);
  if (!configs.length) throw new SeamError(`compiled output contains no Daimon organization runtime config: ${options.compiledOutput}`, 'deploy-failed');
  const failures = [];
  const byEngine = new Map();
  const grokAgents = new Map();
  for (const file of configs) {
    const config = JSON.parse(readFileSync(file, 'utf8'));
    for (const agent of config.agents ?? []) {
      const kind = agent.engine?.kind;
      byEngine.set(kind, (byEngine.get(kind) ?? 0) + 1);
      failures.push(...compiledEngineFindings(file, agent));
      if (kind === 'grok' && agent.id) grokAgents.set(agent.id, { model: agent.engine.model, reasoningEffort: agent.engine.reasoningEffort });
    }
  }
  const checked = [...byEngine.values()].reduce((total, count) => total + count, 0);
  if (!checked) failures.push('compiled organization declares no agents at all — the policy check matched nothing, which is not the same as passing');
  if (grokAgents.size) {
    const entrypoints = compiledArtifacts(options.compiledOutput, DAIMON_UID_ENTRYPOINT);
    if (!entrypoints.length) failures.push(`compiled output has ${grokAgents.size} Grok agent(s) but no ${DAIMON_UID_ENTRYPOINT}, so their broker confinement cannot be verified at all`);
    for (const file of entrypoints) failures.push(...grokBrokerFindings(file, readFileSync(file, 'utf8'), grokAgents));
  }
  if (failures.length) throw new SeamError(`compiled engine policy refusal:\n  ${failures.join('\n  ')}`, 'deploy-failed');
  const summary = [...byEngine.entries()].map(([kind, count]) => `${count} ${kind}`).join(', ');
  log(`compiled policy: ${summary} agent(s) carry their engine's workspace, network-disabled and search-disabled confinement`);
  return { configs, checked, engines: Object.fromEntries(byEngine) };
}

// --- stage 5b: the day's wake budget ----------------------------------------
// `DAIMON_WAKE_FUSE_EPOCH` names one counting window, and Daimon's wake fuse
// treats it as exactly that: admissions are counted per epoch, `maxWakes` and
// `maxTokens` apply per epoch, tokens are summed from the epoch's own
// `epoch_start` record, and a trip marker belongs to one epoch so selecting a
// new one deliberately clears it. The fuse volume has carried
// `daily-quota-rollover-clank-<date>-to-clank-<date>` directories since
// 2026-09-09, so the day-shaped name is the established convention, not an
// invention here.
//
// It was still a line somebody edited by hand, and that is what makes it
// dangerous: leave it and the second day shares the first day's budget. On
// 2026-09-21 the edition began with 103 of 180 wakes already gone, and the
// only reason it finished is that a person noticed and bumped the value.
//
// The seam's deploy is the one moment per edition day that already rewrites
// what the container runs with, so it is where the turnover belongs.
//
// THREE PROPERTIES, deliberately:
//   * DERIVABLE — the value is `clank-<edition>` and nothing else, so what the
//     container ran with can be recomputed from the edition date alone.
//   * RECORDED — every roll appends one line to `epoch-roll.jsonl` beside the
//     env file, and keeps a 0600 copy of the file as it was.
//   * REVERTIBLE — that copy is a whole `deploy.env`, so a revert is one `cp`.
//
// It rewrites ONE line. The key must be present exactly once or the stage
// refuses: deploy.env also holds the runtime control token, and a file this
// job cannot parse confidently is a file it must not rewrite at all. Nothing
// here ever logs a value read from it.
export const EPOCH_PREFIX = 'clank-';
export const EPOCH_KEY = 'DAIMON_WAKE_FUSE_EPOCH';
export const KEEP_ENV_BACKUPS = 7;

export function rollEpoch(options, { log = console.log, now = new Date() } = {}) {
  const envFile = options.envFile;
  const wanted = `${EPOCH_PREFIX}${options.edition}`;
  let original;
  try { original = readFileSync(envFile, 'utf8'); }
  catch (error) { throw new SeamError(`cannot read the deploy env file ${envFile}: ${error.message}`, 'deploy-failed'); }
  const lines = original.split('\n');
  const indexes = lines.map((line, index) => [line, index]).filter(([line]) => line.startsWith(`${EPOCH_KEY}=`)).map(([, index]) => index);
  if (indexes.length !== 1) {
    throw new SeamError(`${envFile} has ${indexes.length} ${EPOCH_KEY} lines; refusing to rewrite an env file this job cannot read unambiguously`, 'deploy-failed');
  }
  const previous = lines[indexes[0]].slice(EPOCH_KEY.length + 1);
  if (previous === wanted) { log(`epoch: already ${wanted}; nothing to roll`); return { previous, epoch: wanted, rolled: false }; }
  if (!/^[A-Za-z0-9._-]*$/u.test(previous)) throw new SeamError(`${envFile} carries a ${EPOCH_KEY} value this job will not overwrite blind`, 'deploy-failed');

  const stamp = now.toISOString().replace(/[-:.]/gu, '').replace(/\d{3}Z$/u, 'Z');
  const backup = `${envFile}.bak-epoch-${stamp}`;
  const { uid, gid, mode } = statSync(envFile);
  writeFileSync(backup, original, { mode: 0o600 });
  chownSync(backup, uid, gid);

  // Write beside the original and rename, so a crash mid-write cannot leave a
  // truncated env file where the deployment expects a whole one.
  const scratch = `${envFile}.roll-${stamp}`;
  lines[indexes[0]] = `${EPOCH_KEY}=${wanted}`;
  writeFileSync(scratch, lines.join('\n'), { mode: 0o600 });
  chownSync(scratch, uid, gid);
  chmodSync(scratch, mode & 0o7777);
  renameSync(scratch, envFile);

  appendFileSync(path.join(path.dirname(envFile), 'epoch-roll.jsonl'),
    `${JSON.stringify({ v: 'clank.epoch-roll.v1', at: now.toISOString(), edition: options.edition, previous, epoch: wanted, env_file: envFile, backup })}\n`, { mode: 0o600 });

  const stale = readdirSync(path.dirname(envFile))
    .filter((name) => name.startsWith(`${path.basename(envFile)}.bak-epoch-`)).sort().slice(0, -KEEP_ENV_BACKUPS);
  for (const name of stale) { try { unlinkSync(path.join(path.dirname(envFile), name)); } catch { /* a backup that is already gone is fine */ } }

  log(`epoch: ${previous} -> ${wanted} (${envFile} copied to ${backup}; revert with cp -a ${backup} ${envFile})`);
  return { previous, epoch: wanted, rolled: true, backup };
}

// --- stage 6: the deployment -------------------------------------------------
// Through `runuser -l clank` because that is the identity the live deployment
// record belongs to; deploying as root would mint a second record and orphan
// the first.
export function deploymentCommand(options) {
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  const command = [process.execPath, options.cli, 'up', options.tag, '--image', '--name', options.container,
    '--deployment', options.deployment, '--env-file', options.envFile, '-d']
    .map(quote).join(' ');
  return `cd ${quote(path.dirname(options.cli))} && exec ${command}`;
}

export function deploy(options, { log = console.log } = {}) {
  const command = deploymentCommand(options);
  return run('deploy', 'deploy-failed', 'runuser', ['-l', options.deployUser, '-c', command], { log });
}

export function runtimeBootstrap(options, { log = console.log, execute = run } = {}) {
  const script = process.env.CLANK_NEWSROOM_BOOTSTRAP ?? path.join(options.repo, 'clankandslop-private/newsroom/runtime/bootstrap-control-token.sh');
  const output = execute('runtime-bootstrap', 'deploy-failed', '/bin/sh', [script, options.container], { log });
  const rows = output.trim().split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } });
  if (!rows.some(row => row?.status === 'verified' && Number.isSafeInteger(row.items)))
    throw new SeamError('runtime bootstrap produced no authenticated activity verification', 'deploy-failed');
  return { verified: true };
}

// --- stage 6: it started is not it works -------------------------------------
// Poll until the state is STABLE, not until it exists: a container that is "Up
// 3 seconds (health: starting)" has proved nothing, and one that is crash-
// looping reports `running` between restarts.
export function settle(options, { log = console.log, sleepSeconds = 10, rounds = 30, exec = execFileSync } = {}) {
  let stable = 0, last = null;
  for (let round = 0; round < rounds; round += 1) {
    let status;
    try { status = exec('docker', ['inspect', '--format', '{{.State.Status}} {{.State.Health.Status}} {{.RestartCount}}', options.container], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(); }
    catch (error) { status = `unreadable (${String(error.message).trim().slice(0, 120)})`; }
    log(`  settle ${String(round + 1).padStart(2)}/${rounds}: ${status}`);
    const healthy = /^running healthy /u.test(status);
    stable = healthy && status === last ? stable + 1 : 0;
    last = status;
    if (stable >= 2) { log(`deployed: ${options.container} is ${status} and has not moved for ${stable} consecutive polls`); return { status, settled: true }; }
    execFileSync('sleep', [String(sleepSeconds)]);
  }
  throw new SeamError(`the container never settled: last observed "${last}" after ${rounds} polls`, 'deploy-failed');
}

// Keeps the seam's own image tags bounded. Only ever removes tags this job
// created, never a volume, never a dangling-image sweep, never `prune`.
export function sweepImages(options, { log = console.log, exec = execFileSync } = {}) {
  try {
    const tags = exec('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}\t{{.CreatedAt}}'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
      .split('\n').filter((line) => /^clank-and-slop:seam-\d{4}-\d{2}-\d{2}-\d{6}\t/u.test(line)).map((line) => line.split('\t'))
      .sort((a, b) => (a[1] < b[1] ? 1 : -1)).map(([tag]) => tag);
    for (const tag of tags.slice(KEEP_IMAGES)) {
      if (tag === options.tag) continue;
      try { exec('docker', ['image', 'rm', tag], { stdio: ['ignore', 'pipe', 'pipe'] }); log(`  retired image ${tag}`); } catch { /* still referenced; leave it */ }
    }
  } catch (error) { log(`  (image sweep skipped: ${String(error.message).trim().slice(0, 120)})`); }
}

// The stages are injectable so the order — gate, then repin, then bundle — can
// be asserted by a test rather than only asserted by this comment. Reversing
// repin and bundle is the failure mode the header describes, and a test is the
// only thing that keeps a future edit from doing it.
export const STAGES = Object.freeze({ gate, repin, bundle, reclaimBuildSpace, build, runtimePolicy, rollEpoch, deploy, settle, runtimeBootstrap, sweepImages });

export function seam(argv = [], { now = new Date(), log = console.log, alarm = raiseDetached, stageImpl = STAGES } = {}) {
  const options = parseArgs(argv);
  options.edition ??= berlinToday(now);
  options.ref ??= `edition/${options.edition}`;
  options.tag ??= `${TAG_PREFIX}${options.edition}-${now.toISOString().slice(11, 19).replace(/:/gu, '')}`;
  log(`seam ${options.check ? '(check)' : options.deploy ? '' : '(no-deploy)'} edition ${options.edition} ref ${options.ref} repo ${options.repo}`);
  const stages = [];
  try {
    stageImpl.gate(options, { now, log }); stages.push('gate');
    stageImpl.repin(options, { log }); stages.push('repin');
    stageImpl.bundle(options, { log }); stages.push('bundle');
    if (options.check) { log('\ncheck PASSED: the pin, the descriptor and the deploy window are all current.'); return { ...options, stages, ok: true }; }
    stageImpl.reclaimBuildSpace(options, { log }); stages.push('reclaimBuildSpace');
    stageImpl.build(options, { log }); stages.push('build');
    stageImpl.runtimePolicy(options, { log }); stages.push('runtimePolicy');
    if (!options.deploy) { log(`\nno-deploy: built and checked ${options.tag} and stopped before \`up\`.`); return { ...options, stages, ok: true }; }
    // After the policy refusal and before `up`: a run that is not going to
    // deploy must not leave the day's budget rolled behind it.
    stageImpl.rollEpoch(options, { log, now }); stages.push('rollEpoch');
    stageImpl.deploy(options, { log }); stages.push('deploy');
    stageImpl.settle(options, { log }); stages.push('settle');
    stageImpl.runtimeBootstrap(options, { log }); stages.push('runtimeBootstrap');
    stageImpl.sweepImages(options, { log });
    log(`\nseam complete: edition ${options.edition} pinned, bundled, built as ${options.tag}, deployed and settled.`);
    return { ...options, stages, ok: true };
  } catch (error) {
    const reason = error instanceof SeamError ? error.reason ?? 'seam-blocked' : 'seam-blocked';
    process.stderr.write(`\nseam FAILED after stage(s) [${stages.join(', ') || 'none'}]: ${error.message}\n`);
    alarm(reason, { edition: options.edition, message: `${reason} after [${stages.join(', ') || 'none'}]`, detail: error.message });
    return { ...options, stages, ok: false, reason };
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(seam(process.argv.slice(2)).ok ? 0 : 1);
}
