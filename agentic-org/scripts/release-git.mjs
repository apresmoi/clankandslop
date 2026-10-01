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
import { constants, accessSync, statSync } from 'node:fs';
import path from 'node:path';

// Carries its own reason word, so seam-run's fixed alarm vocabulary survives
// being split across modules. It is NOT a SeamError subclass on purpose:
// importing one from the other would close an import cycle between the pipeline
// and the pieces of it a second unit has to read on its own. seam-run matches on
// the `reason` FIELD for exactly that reason. Re-exported by release-ledger.mjs,
// which is where the rest of the pipeline already knows it from.
export class ReleaseError extends Error { constructor(message, reason) { super(message); this.reason = reason; } }

// `extra` is how the one invocation that talks to the network gets its identity
// and its closed environment; every other call inherits this process's.
export const git = (repo, args, exec, extra = {}) => exec('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'pipe'], ...extra }).toString();

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

// --- the identity the fetch goes out with ------------------------------------
// VERIFIED ON THE BOX, and it did not work before this: the public remote is
// `git@github.com:apresmoi/clankandslop.git` with no SSH host alias, while
// root's ~/.ssh/config only supplies a key for the aliases
// `github-clank-public` and `github-clank-private`. So a bare `git fetch origin`
// as root has no identity at all and dies on "Could not read from remote
// repository" — which means the release gate below could fetch nothing, forever.
// (The PRIVATE repo's remote IS an alias, which is why corpus-refresh.mjs's bare
// fetch works and needed no change. Only this path was affected.)
//
// Same shape as publish-edition-branch.mjs's `prepareSshIdentity`, deliberately:
// the identity is decided HERE and not by ssh's agent or its default key search
// (`IdentitiesOnly yes`, `IdentityAgent none`), nothing interactive can happen in
// a systemd unit (`BatchMode=yes`, `PasswordAuthentication no`, and git's own
// prompt and askpass disabled), and an unexpected server fails loudly rather than
// being trusted (`StrictHostKeyChecking yes`). The key material is read by ssh and
// by nothing else: this job never reads it, never copies it, and never logs
// anything out of it.
//
// It does NOT write a scratch ssh config and known_hosts the way the publisher
// does, and that difference is the reason rather than laziness: the publisher runs
// git in a disposable HOME that has no known_hosts to pin against, while this runs
// as the operator whose known_hosts already holds github.com — the entry the
// private-repo fetch uses every hour. Writing two files per run would also break
// the property the stage below is built on, that an hourly no-op writes nothing.
export const DEFAULT_FETCH_KEY = '/root/.ssh/clank_public';
// A path that needs quoting inside GIT_SSH_COMMAND, which git parses as a shell
// command. Refused rather than escaped: the one key this job uses lives at a path
// nobody has to be clever about.
const PLAIN_PATH = /^[A-Za-z0-9._\/-]+$/u;

export function fetchSshCommand(keyFile, { stat = statSync, access = accessSync } = {}) {
  const named = String(keyFile ?? '');
  if (!path.isAbsolute(named) || !PLAIN_PATH.test(named))
    throw new ReleaseError(`the fetch key path ${JSON.stringify(named)} must be absolute and free of characters a shell would read — refusing to build a GIT_SSH_COMMAND around it`, 'seam-blocked');
  // A MISSING KEY MUST NOT LOOK LIKE AN OUTAGE. Falling back to an
  // unauthenticated fetch would fail the way a brief GitHub outage fails, and the
  // deferral below would then wait a day before telling anybody — so the key is
  // checked before the fetch and its absence is said in its own words.
  let info;
  try { info = stat(named); }
  catch (error) { throw new ReleaseError(`the fetch key ${named} cannot be read (${String(error.message).trim().slice(0, 160)}) — refusing an unauthenticated fetch, which would fail like an outage and be deferred for a day instead of naming the real fault`, 'seam-blocked'); }
  if (!info.isFile()) throw new ReleaseError(`the fetch key ${named} is not a file — refusing an unauthenticated fetch`, 'seam-blocked');
  try { access(named, constants.R_OK); }
  catch (error) { throw new ReleaseError(`the fetch key ${named} is not readable by this job (${String(error.message).trim().slice(0, 160)}) — refusing an unauthenticated fetch`, 'seam-blocked'); }
  return ['ssh', '-i', named, '-o IdentitiesOnly=yes', '-o IdentityAgent=none',
    '-o PasswordAuthentication=no', '-o StrictHostKeyChecking=yes', '-o BatchMode=yes'].join(' ');
}

// WHY THE CAUSE IS CLASSIFIED AND NOT JUST REPORTED.
//
// The deferral below exists for one cause only: a remote this run could not
// reach. An authentication or configuration fault is not that — it is a state
// that will still be there in an hour, in a day, and in a week, so deferring it
// quietly is the same mistake as deferring a missing key. Different fault,
// different human response, so they are told apart here and the log says which.
//
// git's own epilogue ("Could not read from remote repository") is identical for
// both, so the classification reads the ssh-level lines underneath it and treats
// anything it cannot place as an outage — conservative about paging, and still
// escalated by the pending record if it persists.
const AUTH_EVIDENCE = /permission denied|publickey|host key verification|no such identity|load key|invalid format|authentication failed|access denied|repository not found|too many authentication failures/iu;
const UNREACHABLE_EVIDENCE = /could not resolve|name or service not known|temporary failure in name resolution|connection (timed out|refused|reset)|network is unreachable|operation timed out|no route to host|unexpected eof/iu;

export function classifyFetchFailure(output) {
  const text = String(output ?? '');
  if (AUTH_EVIDENCE.test(text)) return 'auth';
  if (UNREACHABLE_EVIDENCE.test(text)) return 'unreachable';
  return 'unclear';
}

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
  const key = options.key ?? DEFAULT_FETCH_KEY;
  // Built before the fetch, so a key fault is a refusal in its own words rather
  // than an ssh failure that reads like weather.
  const env = {
    ...process.env, GIT_SSH_COMMAND: fetchSshCommand(key),
    // git's own interactive paths, closed: a unit that hangs on a prompt is worse
    // than one that fails, because nothing ever tells anybody.
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_ADVICE: '0'
  };
  try { git(options.repo, ['fetch', '--prune', remote], exec, { env }); }
  catch (error) {
    const detail = `${String(error.message ?? '')}\n${String(error.stderr ?? '')}`;
    const kind = classifyFetchFailure(detail);
    const failure = new ReleaseError(
      `cannot fetch ${remote} in ${options.repo} with the identity at ${key}: ${String(error.message).trim().slice(0, 200)}\n`
      + (kind === 'auth'
        ? `  AUTHENTICATION OR CONFIGURATION was refused, not the network. This will not clear on its own: nothing can be released until ${key} is the key ${remote} accepts, so it is being raised now rather than deferred.`
        : kind === 'unreachable'
          ? `  ${remote} COULD NOT BE REACHED. Refusing to decide there is nothing to release from a remote this run could not see; retrying on the next timer.`
          : `  the cause could not be classified as either authentication or reachability, so it is being treated as an outage and retried; the pending record still escalates it if it persists.`),
      'seam-blocked');
    // Only a remote this run could not reach is a "not yet". See seam-run.mjs.
    failure.unreachable = kind !== 'auth';
    failure.fetchFailure = kind;
    throw failure;
  }
  log(`release: fetched ${remote} in ${options.repo} (ssh identity ${key})`);
  return { remote, key };
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
