#!/usr/bin/env node
// The day's wake budget, and nothing else. This is all that is left of the
// daily deploy.
//
// WHY A WHOLE UNIT FOR ONE ENV LINE
// ---------------------------------
// `DAIMON_WAKE_FUSE_EPOCH` names one counting window: admissions are counted
// per epoch, `maxWakes` and `maxTokens` apply per epoch, and a trip marker
// belongs to one epoch, so selecting a new one deliberately clears it. Leave it
// and the second day shares the first day's budget — on 2026-09-21 the edition
// began with 103 of 180 wakes already gone and only finished because a person
// noticed.
//
// Rolling it requires a container RECREATE, for two independent reasons, both
// read out of Daimon's own source rather than assumed:
//
//   * `WakeFuse.open()` builds `admissions` as an in-memory `Set` from the
//     ledger ONCE, and both `snapshot()` and `admitNow()` then count
//     `this.admissions.size`. Nothing re-reads the ledger while the process
//     lives, so a budget that is "reset" on disk is not reset in the running
//     organization.
//   * the epoch itself comes from the environment, and `--env-file` is applied
//     by docker at container CREATION only. Rewriting deploy.env under a
//     running container changes nothing at all.
//
// The seam used to do this for free, because it recreated the container every
// morning anyway to deliver a new day's research corpus. The corpus moved to a
// host-populated volume (see agentic-org/Spawnfile), the seam became a release
// job that runs when code changes, and the turnover was left without a vehicle.
// This is the vehicle: the cheapest possible recreate, carrying no build.
//
// WHAT DELETES THIS FILE
// ----------------------
// A Daimon fix that re-evaluates the window where it is CONSULTED, not only
// where it is spent. Daimon PR #32 is not that fix: its roll is called from
// `admitNow` alone, while the live scheduled-wake path returns earlier — at
// `const budget = await this.options.fuse.snapshot(...)` / `if (budget.state
// !== "available") return;` in `AttentionDispatcher.drain()` — so `admit` is
// never reached on a paused fuse and the roll never happens. When the snapshot
// gate rolls the window too, this unit is dead weight and should be deleted
// rather than kept "just in case".
//
// WHAT IT WILL NOT DO
// -------------------
// It never builds and it never chooses an image. The identity comes from the
// running container itself, and anything it cannot resolve is a REFUSAL: a unit
// whose job is one env line must not be able to roll the newsroom onto a
// different build.
//
// WHICH FIELD IS AUTHORITATIVE, AND WHY IT IS NOT THE TAG
// ------------------------------------------------------
// `.Image` -- the container's immutable `sha256:` image ID -- is the authority on
// what is running. `.Config.Image` is only the TAG it was created from, and a tag
// is a mutable pointer: rebuild anything as `clank-and-slop:local7` and every
// container created from that name still reports it while running completely
// different bytes. This unit used to read the tag alone and then merely check
// that the tag existed locally, which a review proved by injection on 2026-10-01
// -- a tag remapped to another image was accepted, and the recreate would have
// rolled the newsroom onto a build nobody deployed. So the ID is read too, and a
// tag that no longer resolves to it is a refusal rather than a recreate:
// somebody rebuilt underneath the deployment and a person has to look.
//
// USAGE
//   node agentic-org/scripts/epoch-roll-run.mjs
//   node agentic-org/scripts/epoch-roll-run.mjs --check          # verify only, writes nothing
//   node agentic-org/scripts/epoch-roll-run.mjs --edition=2026-10-02
//
// Every failure raises the alarm before exiting non-zero: `epoch-roll-blocked`
// when the deploy window refused, `epoch-roll-failed` for everything else.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { raiseDetached } from './alarm.mjs';
import {
  DEFAULT_CONTAINER, DEFAULT_DEPLOYMENT, DEFAULT_DEPLOY_USER, DEFAULT_ENV_FILE, DEFAULT_REPO, DEFAULT_SPAWNFILE_CLI,
  EPOCH_KEY, EPOCH_PREFIX, SeamError, berlinToday, deploy, gate, rollEpoch, runtimeBootstrap, settle
} from './seam-run.mjs';

// Where `spawnfile up` keeps what it deployed, as the deploy user. Read only as
// the SECOND opinion about which image is running, when the container itself
// cannot be inspected.
export const DEPLOYMENT_RECORDS = '/home/clank/.spawnfile/deployments';
// Deliberately looser than seam-run's TAG_PREFIX: a hand-built `clank-and-slop:local7`
// is still a newsroom image and still gets its budget rolled. Anything outside
// the repository is not.
export const IMAGE_PREFIX = 'clank-and-slop:';
// A docker image ID. The tag is what `up --image` takes; this is what that tag
// has to still resolve to.
export const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;

export function parseArgs(argv) {
  const options = {
    edition: null, repo: DEFAULT_REPO, container: DEFAULT_CONTAINER, deployment: DEFAULT_DEPLOYMENT,
    cli: process.env.SPAWNFILE_CLI ?? DEFAULT_SPAWNFILE_CLI, envFile: process.env.CLANK_DEPLOY_ENV_FILE ?? DEFAULT_ENV_FILE,
    deployUser: DEFAULT_DEPLOY_USER, tag: null, check: false, leadMinutes: 30, tailMinutes: 120
  };
  for (const arg of argv) {
    const [key, ...rest] = arg.startsWith('--') ? arg.slice(2).split('=') : [null];
    const value = rest.join('=');
    if (key === 'edition' && value) options.edition = value;
    else if (key === 'repo' && value) options.repo = path.resolve(value);
    else if (key === 'container' && value) options.container = value;
    else if (key === 'deployment' && value) options.deployment = value;
    else if (key === 'cli' && value) options.cli = path.resolve(value);
    else if (key === 'env-file' && value) options.envFile = path.resolve(value);
    else if (key === 'deploy-user' && value) options.deployUser = value;
    else if (key === 'lead-minutes' && value) options.leadMinutes = Number(value);
    else if (key === 'tail-minutes' && value) options.tailMinutes = Number(value);
    else if (key === 'check') options.check = true;
    else throw new SeamError(`unrecognized argument: ${arg}`, 'epoch-roll-failed');
  }
  if (options.edition && !/^\d{4}-\d{2}-\d{2}$/u.test(options.edition)) throw new SeamError(`--edition must be YYYY-MM-DD, got ${options.edition}`, 'epoch-roll-failed');
  return options;
}

// One read of the running container: the image ID it IS, the tag it was created
// from, and the epoch it was created WITH. All three answers come from the same
// inspect because they are the same question — what is actually running right now
// — and taking them from two places is how they could disagree.
//
// `{{.Image}} {{json .Config}}`, separated by one space: an image ID contains no
// space and the JSON object that follows cannot begin with one, so both answers
// are separable without asking docker twice.
export function inspectContainer(options, { log = console.log, exec = execFileSync } = {}) {
  let raw;
  try { raw = exec('docker', ['inspect', options.container, '--format', '{{.Image}} {{json .Config}}'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(); }
  catch (error) { log(`  (could not inspect ${options.container}: ${String(error.message).trim().slice(0, 160)})`); return null; }
  const split = raw.indexOf(' ');
  let config = null;
  try { config = JSON.parse(raw.slice(split + 1)); }
  catch (error) { log(`  (could not read the config of ${options.container}: ${String(error.message).trim().slice(0, 160)})`); }
  const epochLine = (config?.Env ?? []).find((entry) => typeof entry === 'string' && entry.startsWith(`${EPOCH_KEY}=`));
  const id = split > 0 ? raw.slice(0, split) : '';
  return {
    imageId: IMAGE_ID.test(id) ? id : null,
    image: typeof config?.Image === 'string' && config.Image ? config.Image : null,
    epoch: epochLine ? epochLine.slice(EPOCH_KEY.length + 1) : null
  };
}

// The deployment record is the fallback, not the first answer: it says what was
// deployed, the container says what is running, and when they disagree the
// container is the one serving the newsroom.
function recordedImage(options, { log = console.log, read = readFileSync } = {}) {
  const file = path.join(DEPLOYMENT_RECORDS, options.deployment, 'record.json');
  try {
    const record = JSON.parse(read(file, 'utf8'));
    const units = Array.isArray(record?.units) ? record.units : [];
    const unit = units.find((entry) => entry?.container_name === options.container) ?? units[0];
    return unit?.image_tag ?? (record?.source?.kind === 'image' ? record.source.ref : null);
  } catch (error) { log(`  (could not read the deployment record ${file}: ${String(error.message).trim().slice(0, 160)})`); return null; }
}

// REFUSES rather than guesses. "I could not tell which image is running" and
// "this image is running" must never produce the same recreate, because the
// recreate is what decides which build the newsroom wakes up on.
export function resolveImage(options, { log = console.log, exec = execFileSync, read = readFileSync, inspect = inspectContainer } = {}) {
  const observed = inspect(options, { log, exec });
  const fromContainer = observed?.image ?? null;
  const tag = fromContainer ?? recordedImage(options, { log, read });
  const source = fromContainer ? `running container ${options.container}` : `deployment record ${options.deployment}`;
  if (!tag) throw new SeamError(
    `cannot resolve the image ${options.container} is running, from the container or from ${path.join(DEPLOYMENT_RECORDS, options.deployment, 'record.json')}`
    + ' — refusing to recreate the newsroom without knowing which build it is already on', 'epoch-roll-failed');
  if (!tag.startsWith(IMAGE_PREFIX)) throw new SeamError(`${source} reports image ${tag}, which is not a ${IMAGE_PREFIX}* newsroom image — refusing to deploy it`, 'epoch-roll-failed');
  // A container that could name its tag but not its image ID is half an answer,
  // and half an answer is exactly what this unit may not act on: without the
  // immutable identity there is nothing to check the tag against.
  if (fromContainer && !observed.imageId) throw new SeamError(
    `${options.container} reports tag ${tag} but no immutable image id — refusing to recreate the newsroom without knowing which build it is on`, 'epoch-roll-failed');
  // Present LOCALLY, before anything is touched: `up --image` against a tag
  // docker cannot find fails after the running container is already gone. The
  // same inspect answers the question that matters more — what the tag resolves
  // to NOW.
  let resolved;
  try { resolved = exec('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(); }
  catch (error) { throw new SeamError(`${source} reports image ${tag} but docker cannot find it locally (${String(error.message).trim().slice(0, 160)}) — refusing a recreate that would have nothing to start`, 'epoch-roll-failed'); }
  if (!IMAGE_ID.test(resolved)) throw new SeamError(`docker resolved ${tag} to ${JSON.stringify(resolved.slice(0, 120))}, which is not an image id — refusing to recreate on an identity this unit cannot read`, 'epoch-roll-failed');
  // THE TAG MOVED. `up --image <tag>` would start different bytes than the ones
  // serving the newsroom right now, which is the one thing this unit exists not
  // to do. Not repairable here and not worth guessing at: somebody rebuilt
  // underneath the deployment, and whether that build should be running is a
  // person's call, not a budget roll's.
  if (observed?.imageId && observed.imageId !== resolved) throw new SeamError(
    `${options.container} is running image ${observed.imageId.slice(7, 19)} but the tag ${tag} now resolves to ${resolved.slice(7, 19)}`
    + ' — the tag has been remapped since the deployment, so a recreate would roll the newsroom onto a different build. REFUSING: somebody rebuilt underneath the deployment and a person has to look.', 'epoch-roll-failed');
  return { tag, imageId: observed?.imageId ?? resolved, source, epoch: observed?.epoch ?? null };
}

// Reused, never copied: these are seam-run's own stages, so the gate that
// protects a release protects this recreate identically, and a fix to either
// lands in one place.
export const EPOCH_STAGES = Object.freeze({ gate, rollEpoch, deploy, settle, runtimeBootstrap });
export const BLOCKED_MESSAGE = "the newsroom keeps yesterday's budget window today";

export function epochRoll(argv = [], { now = new Date(), log = console.log, alarm = raiseDetached, stageImpl = EPOCH_STAGES, resolve = resolveImage } = {}) {
  const stages = [];
  // Seeded before parsing, so a refusal on the arguments themselves still puts
  // the day on the page rather than `null`.
  let options = { edition: berlinToday(now) };
  try {
    options = parseArgs(argv);
    options.edition ??= berlinToday(now);
    log(`epoch-roll ${options.check ? '(check) ' : ''}edition ${options.edition} container ${options.container} repo ${options.repo}`);
    const image = resolve(options, { log });
    options.tag = image.tag;
    log(`image: ${image.tag} = ${image.imageId.slice(7, 19)} (from ${image.source}); this unit never builds and never chooses an image`);
    // Before the roll, because a recreate kills in-flight wakes exactly as a
    // release does — the budget is not worth a turn.
    stageImpl.gate(options, { now, log }); stages.push('gate');
    if (options.check) {
      log(`\ncheck PASSED: ${options.container} is quiet, runs ${image.tag}, and its epoch is ${image.epoch ?? 'unreadable'} against today's ${EPOCH_PREFIX}${options.edition}.`);
      return { ...options, stages, ok: true, check: true, epoch: image.epoch };
    }
    const rolled = stageImpl.rollEpoch(options, { log, now }); stages.push('rollEpoch');
    // A recreate with nothing to change is pure risk, so the skip is real — but
    // the env FILE is not the authority on what is running. A deploy that died
    // after a successful roll leaves today's epoch on disk and yesterday's in
    // the container, and skipping on the file alone would strand the newsroom
    // there with nothing ever retrying. The container's own epoch is what has
    // to match.
    if (!rolled.rolled && image.epoch === rolled.epoch) {
      log(`epoch: ${options.container} already runs ${rolled.epoch}; skipping the recreate entirely`);
      return { ...options, stages, ok: true, noop: true, epoch: rolled.epoch };
    }
    if (!rolled.rolled) log(`epoch: ${options.envFile} already says ${rolled.epoch} but the container reports ${image.epoch ?? 'nothing readable'} — recreating, because the container is what counts`);
    stageImpl.deploy(options, { log }); stages.push('deploy');
    stageImpl.settle(options, { log }); stages.push('settle');
    stageImpl.runtimeBootstrap(options, { log }); stages.push('runtimeBootstrap');
    log(`\nepoch-roll complete: ${options.container} recreated on ${image.tag} with ${rolled.epoch} (was ${rolled.previous}).`);
    return { ...options, stages, ok: true, epoch: rolled.epoch };
  } catch (error) {
    // Only the gate refuses with `seam-blocked`, and it refuses before it is
    // recorded — so this cannot mistake a failed deploy for a closed window.
    const blocked = !stages.includes('gate') && error?.reason === 'seam-blocked';
    const reason = blocked ? 'epoch-roll-blocked' : 'epoch-roll-failed';
    // A blocked roll is a DEGRADED newsroom, not a dead one: the container is
    // still up and still publishing, it is simply sharing yesterday's wake
    // budget. Whoever reads this on a lock screen has to be able to tell that
    // apart from "the paper did not come out".
    const message = blocked
      ? `${BLOCKED_MESSAGE} — the deploy window was not clear, so the budget was not rolled. The newsroom is RUNNING and degraded, not dead.`
      : `epoch roll failed after [${stages.join(', ') || 'none'}]`;
    process.stderr.write(`\nepoch-roll FAILED after stage(s) [${stages.join(', ') || 'none'}]: ${error.message}\n`);
    alarm(reason, { edition: options.edition, message, detail: error.message });
    return { ...options, stages, ok: false, reason };
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(epochRoll(process.argv.slice(2)).ok ? 0 : 1);
}
