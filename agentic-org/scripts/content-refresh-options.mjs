// Every option the host-side public content refresher takes, and the production
// default behind each. The shape mirrors corpus-refresh-options.mjs on purpose:
// same work-root rules, same owner, same lock.
//
//   node agentic-org/scripts/content-refresh.mjs [options]
//     --volume=<path>     the volume's host data directory
//     --repo=<path>       the public checkout to extract from (the release build root)
//     --track=<ref>       the tracked ref whose published content is served (origin/main)
//     --key=<path>        ssh identity for the fetch (the release job's public key)
//     --landed=<path>     the host's record; root-owned 0600, NEVER inside the volume
//     --staging=<path>    extraction and validation; outside the volume, same filesystem
//     --trash=<path>      where retired trees are deleted; same constraints
//     --keep=<n>          retired trees kept beside the serving one (>= 1: a pressman
//                         build that read `current` just before a swap keeps its tree)
//     --owner=<uid:gid>   owner for everything written (the agents' uid)
//     --heal-limit=<n>    drift-and-reland cycles for one tree before auto-repair stands down
//     --lock=<path>       the flock(2) path shared with the corpus refresher and the release job
//     --no-lock           skip locking (tests only)
//     --no-fetch          resolve from refs already in the checkout
//     --no-verify         skip the tamper sweep (tests only)
//     --check             verify only; write nothing, exit non-zero if not current

import path from 'node:path';
import { HEAL_SUSPEND_AFTER } from './corpus-landed.mjs';
import { DEFAULT_LOCK, DEFAULT_OWNER } from './corpus-refresh-options.mjs';
import { DEFAULT_FETCH_KEY, DEFAULT_TRACK_REF } from './release-git.mjs';
import { PublicContentError } from './public-content.mjs';

export const DEFAULT_CONTENT_VOLUME = '/var/lib/docker/volumes/clank-newsroom-content/_data';
// The release job's build root: it is already fetched with the public deploy key,
// and reading refs from it writes nothing to its working tree.
export const DEFAULT_CONTENT_REPO = '/root/work/clankandslop';
export const DEFAULT_CONTENT_WORK = '/var/lib/clank-content';
export const DEFAULT_CONTENT_LANDED = `${DEFAULT_CONTENT_WORK}/landed.json`;
export const DEFAULT_CONTENT_KEEP = 2;

const fail = (message) => { throw new PublicContentError(message); };

export function contentRefreshArgs(argv, { env = process.env } = {}) {
  const options = {
    volume: DEFAULT_CONTENT_VOLUME, repo: DEFAULT_CONTENT_REPO, track: DEFAULT_TRACK_REF,
    key: env.CLANK_RELEASE_FETCH_KEY || DEFAULT_FETCH_KEY, landed: DEFAULT_CONTENT_LANDED,
    staging: `${DEFAULT_CONTENT_WORK}/staging`, trash: `${DEFAULT_CONTENT_WORK}/trash`,
    keep: DEFAULT_CONTENT_KEEP, owner: DEFAULT_OWNER, healLimit: HEAL_SUSPEND_AFTER, lock: DEFAULT_LOCK,
    fetch: true, verify: true, check: false
  };
  for (const arg of argv) {
    const [key, ...rest] = arg.startsWith('--') ? arg.slice(2).split('=') : [null];
    const value = rest.join('=');
    if (['volume', 'repo', 'landed', 'staging', 'trash', 'lock', 'key'].includes(key) && value) options[key] = path.resolve(value);
    else if (key === 'track' && value) options.track = value;
    else if (key === 'keep' && value) options.keep = Number(value);
    else if (key === 'owner' && value) options.owner = value;
    else if (key === 'heal-limit' && value) options.healLimit = Number(value);
    else if (key === 'no-lock') options.lock = null;
    else if (key === 'no-fetch') options.fetch = false;
    else if (key === 'no-verify') options.verify = false;
    else if (key === 'check') options.check = true;
    else fail(`unrecognized argument: ${arg}`);
  }
  if (!Number.isInteger(options.keep) || options.keep < 1) fail(`--keep must be at least 1, got ${options.keep}: the tree a release candidate is copying from must outlive one swap`);
  if (!/^\d+:\d+$/u.test(options.owner)) fail(`--owner must be <uid>:<gid>, got ${options.owner}`);
  if (!Number.isInteger(options.healLimit) || options.healLimit < 1) fail(`--heal-limit must be a positive integer, got ${options.healLimit}`);
  if (!/^[\w.-]+\/[\w./-]+$/u.test(options.track)) fail(`--track must be <remote>/<branch>, got ${options.track}`);
  for (const [name, target] of [['--landed', options.landed], ['--staging', options.staging], ['--trash', options.trash]])
    if (!path.relative(options.volume, target).startsWith('..')) fail(`${name} ${target} is inside the content volume ${options.volume}: the volume root is owned by uid 2000 and writable by all twelve agents`);
  return options;
}
