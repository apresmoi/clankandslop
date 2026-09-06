#!/usr/bin/env node
// "Did today's cycle actually produce an edition?" — asked after press time by
// something that is not an agent.
//
// WHY THIS EXISTS
// ---------------
// The seam alarm covers the failures that happen BEFORE the org runs: a stale
// pin, a bundle mismatch, a deploy that did not come up. It cannot see the
// failure that matters most to a reader, which is the org running all day and
// producing nothing. Every agent involved is asleep by then, so no agent can
// report it; room:research reaches agents, not people. This runs on the host
// after the last wake and says so out loud.
//
// WHAT IT READS
// -------------
// The durable edition-state volume — the same receipts the agents write through
// mcp_newsroom_* — and pressman's staging volume. Nothing here talks to an
// agent, wakes anything, or has an opinion about cognition: it counts receipts
// that either exist or do not.
//
// The ladder is reported in full rather than as a single boolean, because
// "nothing ran at all" and "everything ran and the composition was refused" are
// different mornings and need different first moves.
//
//   assigned -> filed -> reviewed -> composed -> staged -> published
//
// USAGE
//   node agentic-org/scripts/cycle-audit.mjs [--edition=YYYY-MM-DD]
//     [--state /var/lib/docker/volumes/clank-edition-state/_data]
//     [--staging /var/lib/docker/volumes/clank-release-staging/_data]
//     [--require=composed]   lowest rung that must be reached (default: composed)
//     [--quiet]              report, never raise the alarm

import { existsSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import { raiseDetached } from './alarm.mjs';

export const DEFAULT_STATE = '/var/lib/docker/volumes/clank-edition-state/_data';
export const DEFAULT_STAGING = '/var/lib/docker/volumes/clank-release-staging/_data';
// Receipt filenames are `<kind>-<16 hex>.json`; the kind is the rung.
export const LADDER = Object.freeze(['assigned', 'filed', 'reviewed', 'composed', 'staged']);
export const RECEIPT = /^([a-z-]+)-[0-9a-f]{8,}\.json$/u;

const berlinDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
export const berlinToday = (now = new Date()) => berlinDate.format(now);
export class AuditError extends Error {}

export function parseArgs(argv) {
  const options = { edition: null, state: DEFAULT_STATE, staging: DEFAULT_STAGING, require: 'composed', quiet: false };
  for (const arg of argv) {
    const [key, ...rest] = arg.startsWith('--') ? arg.slice(2).split('=') : [null];
    const value = rest.join('=');
    if (key === 'edition' && value) options.edition = value;
    else if (key === 'state' && value) options.state = path.resolve(value);
    else if (key === 'staging' && value) options.staging = path.resolve(value);
    else if (key === 'require' && value) options.require = value;
    else if (key === 'quiet') options.quiet = true;
    else throw new AuditError(`unrecognized argument: ${arg}`);
  }
  if (!LADDER.includes(options.require)) throw new AuditError(`--require must be one of ${LADDER.join(', ')}`);
  return options;
}

// `desk-filed` is a distinct receipt kind and is deliberately NOT counted as
// `filed`: a desk file is not an article, and a day of nothing but desk files
// is precisely the silent failure this job exists to name.
export function countReceipts(directory) {
  const counts = Object.fromEntries(LADDER.map((rung) => [rung, 0]));
  const other = {};
  let names = [];
  try { names = readdirSync(directory); } catch { return { counts, other, present: false }; }
  for (const name of names) {
    const kind = RECEIPT.exec(name)?.[1];
    if (kind === undefined) continue;
    if (kind in counts) counts[kind] += 1;
    else other[kind] = (other[kind] ?? 0) + 1;
  }
  return { counts, other, present: true };
}

// The staging side of the same question. `current-edition` is the symlink
// stage_release flips only after the validator and the site build both passed,
// so its target naming today is the strongest local evidence an edition exists.
export function stagingState(stagingRoot, edition) {
  const link = path.join(stagingRoot, 'current-edition');
  let target;
  try { target = readlinkSync(link); } catch { return { promoted: false, reason: `no ${link}` }; }
  const artifact = path.join(stagingRoot, target);
  if (!target.startsWith(edition)) return { promoted: false, target, reason: `current-edition points at ${target}, not at ${edition}` };
  if (!existsSync(path.join(artifact, 'content', 'editions', edition))) return { promoted: false, target, reason: `${target} carries no content/editions/${edition}` };
  return { promoted: true, target, artifact };
}

export function audit(options, { now = new Date() } = {}) {
  const edition = options.edition ?? berlinToday(now);
  const editionRoot = path.join(options.state, 'editions', edition);
  const exists = existsSync(editionRoot) && statSync(editionRoot).isDirectory();
  const receipts = countReceipts(path.join(editionRoot, 'receipts'));
  const staging = stagingState(options.staging, edition);
  if (staging.promoted && !receipts.counts.staged) receipts.counts.staged = 1;

  const reached = [];
  for (const rung of LADDER) if (receipts.counts[rung] > 0) reached.push(rung);
  const highest = reached.length ? reached[reached.length - 1] : null;
  const requiredIndex = LADDER.indexOf(options.require);
  const reachedIndex = highest === null ? -1 : LADDER.indexOf(highest);
  const ok = exists && reachedIndex >= requiredIndex;

  const summary = ok
    ? `edition ${edition} reached ${highest} (required ${options.require})`
    : !exists ? `NO EDITION: nothing at ${editionRoot} — the cycle produced no edition state at all today`
      : highest === null ? `NO EDITION: ${edition} has an edition directory but not one receipt on the ladder — no agent got past its first call`
        : `NO EDITION: ${edition} stopped at ${highest}; ${options.require} was required`;
  return { edition, ok, exists, highest, required: options.require, reached, receipts, staging, editionRoot, summary };
}

export function report(result, log = console.log) {
  log(`edition ${result.edition} at ${result.editionRoot}`);
  log(`ladder: ${LADDER.map((rung) => `${rung}=${result.receipts.counts[rung]}`).join('  ')}`);
  const other = Object.entries(result.receipts.other);
  if (other.length) log(`other receipts: ${other.map(([kind, count]) => `${kind}=${count}`).join('  ')}`);
  log(`staging: ${result.staging.promoted ? `promoted ${result.staging.target}` : `not promoted (${result.staging.reason})`}`);
  log(result.summary);
}

function main(argv) {
  const options = parseArgs(argv);
  const result = audit(options);
  report(result);
  if (result.ok) return;
  process.exitCode = 1;
  if (options.quiet) return;
  raiseDetached('no-edition', {
    edition: result.edition, message: result.summary,
    detail: `${result.summary}\nladder: ${LADDER.map((rung) => `${rung}=${result.receipts.counts[rung]}`).join('  ')}\nstaging: ${result.staging.promoted ? result.staging.target : result.staging.reason}`
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof AuditError ? error.message : error.stack}\n`); process.exit(64); }
}
