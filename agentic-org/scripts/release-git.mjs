// Everything a release decision reads out of git, and the one write that moves
// the build root onto the commit being released.
//
// A RELEASE JOB THAT ONLY WATCHED A LOCAL HEAD WOULD NEVER DISCOVER A MERGE.
//
// The first version of the release gate compared the ledger against
// `git -C <repo> rev-parse HEAD`, and nothing in the job ever fetched. The build
// root's HEAD therefore only moved when a person moved it, so the one thing the
// unit exists to do -- release when the organization's code or prompts change --
// could not happen: `origin/main` advanced on merge, the local HEAD did not, and
// the hourly timer no-opped forever on an unchanged commit. Two review seats
// found that independently on 2026-10-01, and it is why the comparison is made
// against a TRACKED REF and why this module exists at all.
//
// WHY IT IS A MODULE AND NOT MORE OF release-ledger.mjs
// ----------------------------------------------------
// The ledger answers "what is running". This answers "what is there to run, and
// is this checkout allowed to become it". They meet in one place, releaseGate,
// and the dependency runs one way only -- the ledger reads this, never the
// reverse -- because the alternative is an import cycle between the pipeline and
// the one piece of it a second unit has to read on its own.

import { execFileSync } from 'node:child_process';

// Carries its own reason word, so seam-run's fixed alarm vocabulary survives
// being split across modules. It is NOT a SeamError subclass on purpose:
// importing one from the other would close an import cycle between the pipeline
// and the pieces of it a second unit has to read on its own. seam-run matches on
// the `reason` FIELD for exactly that reason. Re-exported by release-ledger.mjs,
// which is where the rest of the pipeline already knows it from.
export class ReleaseError extends Error { constructor(message, reason) { super(message); this.reason = reason; } }

export const git = (repo, args, exec) => exec('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

export function headCommit(repo, { exec = execFileSync } = {}) {
  let head;
  try { head = git(repo, ['rev-parse', 'HEAD'], exec).trim(); }
  catch (error) { throw new ReleaseError(`cannot read HEAD in ${repo}: ${String(error.message).trim().slice(0, 200)} — a release has to be identifiable by a commit`, 'seam-blocked'); }
  if (!/^[0-9a-f]{40}$/u.test(head)) throw new ReleaseError(`git -C ${repo} rev-parse HEAD returned ${JSON.stringify(head)}, which is not a commit`, 'seam-blocked');
  return head;
}

// --- what there is to release ------------------------------------------------
// WHAT THIS WILL AND WILL NOT DO TO THE TREE
//
// It brings the build root to exactly the tracked tip, by fast-forward, or it
// refuses. It refuses a checkout that is not on the tracked branch, one carrying
// commits the tip does not contain, and any case where a fast-forward is not
// possible. A release is a reviewed commit that the tracked tip already names; a
// merge this job invented is not reviewable and must never be the thing that
// ships.
//
// The build root itself is NOT negotiable: durable volume names are derived from
// the Spawnfile's path (see seam-run.mjs's header), so this moves the one
// checkout the live deployment was built from rather than cloning the tip
// somewhere else and building there.
export const DEFAULT_TRACK_REF = 'origin/main';

// `origin/main` -> { remote: 'origin', branch: 'main' }. The branch half is what
// the checkout has to be ON, so a ref this cannot split is a refusal rather than
// a guess.
export function trackedRef(ref) {
  const match = /^([\w.-]+)\/([\w./-]+)$/u.exec(String(ref ?? ''));
  if (!match) throw new ReleaseError(`--track must name a remote-tracking ref as <remote>/<branch>, got ${JSON.stringify(ref)}`, 'seam-blocked');
  return { ref: String(ref), remote: match[1], branch: match[2] };
}

// GITHUB BEING BRIEFLY UNREACHABLE IS NOT AN EMERGENCY, AND IS NOT A NO-OP.
//
// A failed fetch means this run cannot tell whether anything was merged, so it
// must not report "nothing to release". The refusal is marked `unreachable`
// instead: under `--if-changed` seam-run defers it exactly as it defers a closed
// wake window -- logged, exit 0, no page -- and the pending record's 24h
// escalation still catches an outage that has stopped being brief. Run by hand it
// fails loudly, like any other refusal.
export function fetchTracked(options, { exec = execFileSync, log = console.log } = {}) {
  const { remote } = trackedRef(options.track);
  try { git(options.repo, ['fetch', '--prune', remote], exec); }
  catch (error) {
    const failure = new ReleaseError(
      `cannot fetch ${remote} in ${options.repo}: ${String(error.message).trim().slice(0, 200)}`
      + ` — refusing to decide there is nothing to release from a ${remote} this run could not reach`, 'seam-blocked');
    failure.unreachable = true;
    throw failure;
  }
  log(`release: fetched ${remote} in ${options.repo}`);
  return { remote };
}

// ONE git invocation for both commits, because the no-op path runs every hour:
// after the fetch it is this and one JSON read, and it writes nothing.
export function trackedTip(options, { exec = execFileSync } = {}) {
  const { ref } = trackedRef(options.track);
  let raw;
  try { raw = git(options.repo, ['rev-parse', 'HEAD', `${ref}^{commit}`], exec); }
  catch (error) { throw new ReleaseError(`cannot resolve HEAD and ${ref} in ${options.repo}: ${String(error.message).trim().slice(0, 200)} — a release has to be identifiable by a commit`, 'seam-blocked'); }
  const lines = raw.trim().split('\n').map((line) => line.trim());
  if (lines.length !== 2 || !lines.every((line) => /^[0-9a-f]{40}$/u.test(line)))
    throw new ReleaseError(`git -C ${options.repo} rev-parse HEAD ${ref} returned ${JSON.stringify(raw.trim().slice(0, 120))}, which is not two commits`, 'seam-blocked');
  return { head: lines[0], tip: lines[1] };
}

// Nothing here improvises. Each refusal below is a state a person has to resolve,
// because every alternative -- a merge, a reset, a build somewhere else -- ships
// something nobody reviewed out of the one checkout the newsroom's durable
// volumes hang off.
export function fastForwardToTip(options, { head, tip, rewritten = [] }, { exec = execFileSync, log = console.log } = {}) {
  const { ref, branch } = trackedRef(options.track);
  if (head === tip) { log(`release: the build root is already at ${ref} ${tip.slice(0, 12)}`); return { moved: false, head: tip }; }
  let current = null;
  try { current = git(options.repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], exec).trim(); }
  catch { current = null; }
  if (current !== branch) throw new ReleaseError(
    `${options.repo} is on ${current ? `branch ${current}` : 'a detached HEAD'}, not ${branch}, while ${ref} has advanced to ${tip.slice(0, 12)}`
    + ` — refusing to move a checkout this job cannot fast-forward on ${branch}`, 'seam-blocked');
  // One question, two findings inside it: a HEAD the tip does not contain means
  // both "there are local commits here" and "a fast-forward is not possible".
  try { git(options.repo, ['merge-base', '--is-ancestor', head, tip], exec); }
  catch { throw new ReleaseError(
    `${options.repo} HEAD ${head.slice(0, 12)} is not contained in ${ref} ${tip.slice(0, 12)} — the build root carries commits the tracked tip does not,`
    + ' so this would be a merge rather than a fast-forward. A release is a reviewed commit; refusing.', 'seam-blocked'); }
  // WHY THIS DISCARD IS NOT A WEAKENING OF THE DIRTY-TREE REFUSAL.
  //
  // `bundle` rewrites digest pins into the working tree and nothing commits them,
  // so after every release the build root is dirty in exactly the files a repin
  // commit touches — and git refuses to fast-forward over a locally modified file
  // ("Your local changes to the following files would be overwritten by merge").
  // Left alone, this unit would discover each merge and then refuse it, hourly,
  // forever: the release job that cannot release, one layer further down.
  //
  // So those rewrites are dropped here, and ONLY the paths the shape check has
  // already proven contain nothing but a digest rewrite. They are reproducible by
  // construction — `bundle` runs two stages later and writes them again from the
  // new descriptor — which is precisely why they were admissible in the first
  // place. Anything else in the tree was a refusal several lines ago.
  if (rewritten.length) {
    try { git(options.repo, ['checkout', 'HEAD', '--', ...rewritten], exec); }
    catch (error) { throw new ReleaseError(`cannot restore the bundle-rewritten path(s) ${rewritten.join(', ')} in ${options.repo} before fast-forwarding: ${String(error.message).trim().slice(0, 200)}`, 'seam-blocked'); }
    log(`release: discarded the last bundle's digest rewrites in ${rewritten.join(', ')} so the fast-forward can land; bundle writes them again from the new descriptor`);
  }
  try { git(options.repo, ['merge', '--ff-only', tip], exec); }
  catch (error) { throw new ReleaseError(`cannot fast-forward ${options.repo} to ${ref} ${tip.slice(0, 12)}: ${String(error.message).trim().slice(0, 200)}`, 'seam-blocked'); }
  // It moved is not it arrived: every stage below compiles whatever is on disk,
  // so the commit they will carry is read back rather than assumed.
  const landed = headCommit(options.repo, { exec });
  if (landed !== tip) throw new ReleaseError(
    `fast-forwarding ${options.repo} to ${tip.slice(0, 12)} left it at ${landed.slice(0, 12)} — refusing to build a tree that is not the commit being released`, 'seam-blocked');
  log(`release: build root fast-forwarded ${head.slice(0, 12)} -> ${tip.slice(0, 12)} on ${branch}`);
  return { moved: true, head: tip };
}
