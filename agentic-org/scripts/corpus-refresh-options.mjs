// Every option the host-side corpus refresher takes, every default it takes it
// from, and the validation each one has to survive.
//
// Split out of corpus-refresh.mjs, which re-exports all of it: this is the flag
// surface and the production paths, separable from the decision flow that reads
// them. Read corpus-refresh.mjs for WHY the refresher exists at all; the refusals
// below carry the reasons the individual limits are where they are.
//
// USAGE
//   node agentic-org/scripts/corpus-refresh.mjs [options]
//     --edition=YYYY-MM-DD  edition date the next wake will use
//                           (default: today in Europe/Berlin)
//     --ref=<branch>        private branch to extract
//                           (default: edition/<edition>)
//     --volume=<path>       the volume's host data directory
//     --private=<path>      the private corpus checkout to extract from
//     --landed=<path>       the host's authoritative record of what it landed;
//                           root-owned 0600, NEVER inside the volume
//     --staging=<path>      where trees are extracted and validated; must be
//                           OUTSIDE the volume and on the same filesystem
//     --trash=<path>        where retired trees are deleted, same constraints
//     --keep=<n>            unreferenced trees to keep for inspection
//     --owner=<uid:gid>     owner for everything written
//     --require-by=HH:MM    Europe/Berlin time by which edition/<today> must
//                           exist; before it, a missing branch is a logged wait
//                           and a landed date may still follow the branch. After
//                           it, that date's corpus is frozen.
//     --heal-limit=<n>      consecutive drift-and-reland cycles for one tree
//                           before auto-repair stands down and pages
//     --unknown-mib=<n>     how much disk unknown names under trees/ may occupy
//                           before "reported" escalates to a page
//     --lock=<path>         the flock(2) path this run serializes on
//     --no-lock             skip locking (tests only)
//     --no-fetch            resolve from refs already in the local checkout
//     --no-verify           skip the tamper sweep (tests only)
//     --check               verify only; write nothing, exit non-zero if a
//                           refresh is needed

import path from 'node:path';
import { CorpusError, EDITION_PATTERN } from './corpus-contract.mjs';
import { HEAL_SUSPEND_AFTER } from './corpus-landed.mjs';
import { DEFAULT_UNKNOWN_MIB } from './corpus-verify.mjs';

export const DEFAULT_VOLUME = '/var/lib/docker/volumes/clank-newsroom-corpus/_data';
export const DEFAULT_PRIVATE = '/root/work/clankandslop/clankandslop-private';
export const DEFAULT_WORK = '/var/lib/clank-corpus';
export const DEFAULT_STAGING = `${DEFAULT_WORK}/staging`;
export const DEFAULT_TRASH = `${DEFAULT_WORK}/trash`;
// OUTSIDE the volume and outside every container's view of the filesystem. This
// path is the whole of FIX 1: the host's truth cannot live where twelve agents
// can rewrite it.
export const DEFAULT_LANDED = `${DEFAULT_WORK}/landed.json`;
export const DEFAULT_LOCK = '/run/lock/clank-corpus-refresh.lock';
export const REFRESH_LEDGER = `${DEFAULT_WORK}/refresh.jsonl`;
// The host's `clank` user is 2000:2000, the same uid the agents run as.
export const DEFAULT_OWNER = '2000:2000';
export const DEFAULT_KEEP = 3;
// The producers push edition/<today> at roughly 00:50 Berlin. Before this hour a
// missing branch is a wait, after it a failure.
// Noon, not mid-morning: research runs until 12:00 Berlin and reporters wake at
// 13:00, so a 09:00 freeze dropped every late-morning slot on the floor (the
// 09:49 Grok slot never reached a reporter until 2026-10-04).
export const DEFAULT_REQUIRE_BY = '12:00';

const fail = (message) => { throw new CorpusError(message); };

export function corpusRefreshArgs(argv) {
  const options = {
    edition: null, ref: null, volume: DEFAULT_VOLUME, private: DEFAULT_PRIVATE, landed: DEFAULT_LANDED,
    staging: DEFAULT_STAGING, trash: DEFAULT_TRASH, lock: DEFAULT_LOCK, keep: DEFAULT_KEEP, owner: DEFAULT_OWNER,
    requireBy: DEFAULT_REQUIRE_BY, healLimit: HEAL_SUSPEND_AFTER, unknownMib: DEFAULT_UNKNOWN_MIB,
    fetch: true, verify: true, check: false
  };
  for (const arg of argv) {
    const [key, ...rest] = arg.startsWith('--') ? arg.slice(2).split('=') : [null];
    const value = rest.join('=');
    if (key === 'edition' && value) options.edition = value;
    else if (key === 'ref' && value) options.ref = value;
    else if (key === 'volume' && value) options.volume = path.resolve(value);
    else if (key === 'private' && value) options.private = path.resolve(value);
    else if (key === 'landed' && value) options.landed = path.resolve(value);
    else if (key === 'staging' && value) options.staging = path.resolve(value);
    else if (key === 'trash' && value) options.trash = path.resolve(value);
    else if (key === 'lock' && value) options.lock = path.resolve(value);
    else if (key === 'no-lock') options.lock = null;
    else if (key === 'keep' && value) options.keep = Number(value);
    else if (key === 'owner' && value) options.owner = value;
    else if (key === 'require-by' && value) options.requireBy = value;
    else if (key === 'heal-limit' && value) options.healLimit = Number(value);
    else if (key === 'unknown-mib' && value) options.unknownMib = Number(value);
    else if (key === 'no-fetch') options.fetch = false;
    else if (key === 'no-verify') options.verify = false;
    else if (key === 'check') options.check = true;
    else fail(`unrecognized argument: ${arg}`);
  }
  if (options.edition && !EDITION_PATTERN.test(options.edition)) fail(`--edition must be YYYY-MM-DD, got ${options.edition}`);
  if (!Number.isInteger(options.keep) || options.keep < 0) fail(`--keep must be a non-negative integer, got ${options.keep}`);
  if (!/^\d+:\d+$/.test(options.owner)) fail(`--owner must be <uid>:<gid>, got ${options.owner}`);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(options.requireBy)) fail(`--require-by must be HH:MM in 24-hour Europe/Berlin time, got ${options.requireBy}`);
  // A zero heal limit would suspend auto-repair before it ever repaired anything,
  // which is a corpus that never heals dressed up as a safety feature.
  if (!Number.isInteger(options.healLimit) || options.healLimit < 1) fail(`--heal-limit must be a positive integer, got ${options.healLimit}`);
  if (!Number.isFinite(options.unknownMib) || options.unknownMib < 0) fail(`--unknown-mib must be a non-negative number, got ${options.unknownMib}`);
  // The record must never be reachable from inside the volume, whatever anyone
  // passes: a landed.json an agent can rewrite is the defect this file exists to
  // close, and it would be a silent one.
  if (!path.relative(options.volume, options.landed).startsWith('..')) fail(`--landed ${options.landed} is inside the corpus volume ${options.volume}.\n`
    + '  The volume root is owned by uid 2000 and writable by all twelve agents, so a record kept there is an agent-writable input to a root-privileged job.');
  return options;
}
