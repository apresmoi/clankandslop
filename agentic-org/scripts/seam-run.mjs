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
//   1. repin-private-source.mjs   — standalone, FIRST
//   2. npm run org:bundle         — second
// `check-bundle-descriptor.mjs --repin-source` locates the Spawnfile pins by
// searching for the descriptor's CURRENT digest, so a bundle build that runs
// first advances the descriptor and leaves the repin with nothing to match.
// Beyond that, `policies/private-source.json` is a tracked file and therefore
// part of the source archive: repinning it CHANGES newsroom-runtime.tar, so the
// bundle build has to come after the repin or the tar on disk no longer matches
// the digest every Spawnfile pins, and the build fails closed at verification.
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
import { existsSync } from 'node:fs';
import path from 'node:path';
import { raiseDetached } from './alarm.mjs';
import { assess } from './wake-window.mjs';

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

const berlinDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
export const berlinToday = (now = new Date()) => berlinDate.format(now);
export class SeamError extends Error { constructor(message, reason) { super(message); this.reason = reason; } }

export function parseArgs(argv) {
  const options = {
    edition: null, ref: null, repo: DEFAULT_REPO, container: DEFAULT_CONTAINER, deployment: DEFAULT_DEPLOYMENT,
    cli: process.env.SPAWNFILE_CLI ?? DEFAULT_SPAWNFILE_CLI, envFile: process.env.CLANK_DEPLOY_ENV_FILE ?? DEFAULT_ENV_FILE,
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
// The full build, not `--repin-source`. `--repin-source` refreshes the
// descriptor and the twelve Spawnfile pins from a fresh MEASUREMENT of the tree
// but writes no tar, and the repin has just changed a tracked file — so the
// newsroom-runtime.tar on disk would no longer be the archive those pins
// describe, and the image would carry a resource no agent can verify.
export function bundle(options, { log = console.log } = {}) {
  if (options.check) {
    log('\n(check mode: not rebuilding the archives; verifying the committed descriptor against the tree instead)');
    return run('bundle-check', 'bundle-mismatch', process.execPath, [path.join(options.repo, 'agentic-org/scripts/check-bundle-descriptor.mjs')], { cwd: options.repo, log });
  }
  run('bundle', 'bundle-mismatch', 'npm', ['run', 'org:bundle'], { cwd: options.repo, log });
  return run('bundle-verify', 'bundle-mismatch', process.execPath, [path.join(options.repo, 'agentic-org/scripts/check-bundle-descriptor.mjs')], { cwd: options.repo, log });
}

// --- stage 4: the image ------------------------------------------------------
export function build(options, { log = console.log } = {}) {
  run('build', 'deploy-failed', process.execPath, [options.cli, 'build', path.join(options.repo, 'agentic-org'), '--tag', options.tag], { cwd: options.repo, log });
  return options.tag;
}

// --- stage 5: the deployment -------------------------------------------------
// Through `runuser -l clank` because that is the identity the live deployment
// record belongs to; deploying as root would mint a second record and orphan
// the first.
export function deploy(options, { log = console.log } = {}) {
  const command = `${process.execPath} ${options.cli} up ${options.tag} --image --name ${options.container}`
    + ` --deployment ${options.deployment} --env-file ${options.envFile} -d`;
  return run('deploy', 'deploy-failed', 'runuser', ['-l', options.deployUser, '-c', command], { log });
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
      .split('\n').filter((line) => line.startsWith(TAG_PREFIX)).map((line) => line.split('\t'))
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
export const STAGES = Object.freeze({ gate, repin, bundle, build, deploy, settle, sweepImages });

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
    stageImpl.build(options, { log }); stages.push('build');
    if (!options.deploy) { log(`\nno-deploy: built ${options.tag} and stopped before \`up\`.`); return { ...options, stages, ok: true }; }
    stageImpl.deploy(options, { log }); stages.push('deploy');
    stageImpl.settle(options, { log }); stages.push('settle');
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
