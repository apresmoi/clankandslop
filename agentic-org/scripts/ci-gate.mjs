#!/usr/bin/env node
// "Is CI green on exactly this commit?" — the question merge-edition.yml must
// answer before it merges anything, asked here rather than in inline YAML so
// the rule can be tested instead of asserted.
//
// WHY IT IS NOT `gh pr checks`
// ----------------------------
// ci.yml declares both `on: push` and `on: pull_request`, so a commit that has
// a pull request gets TWO runs of the same workflow over the same tree. The
// push run is the authoritative one: it is triggered by the deploy key that
// created the branch and it runs against the branch tip itself.
//
// The pull_request duplicate is created by whoever opened the pull request —
// which, for an automated publication, is `github-actions[bot]`. GitHub parks
// workflow runs from that author behind "Approve and run", so the duplicate
// concludes `action_required`: a run that was never allowed to START. Observed
// on 2026-09-06 for edition/2026-08-21 at c0b5cc2e, where the push run was
// green and the parked duplicate would otherwise have vetoed a correct merge
// forever.
//
// So `action_required` is admitted in exactly one shape and no other: a
// non-push duplicate, of the same workflow, on the same SHA, whose push run
// concluded success. Every other non-success — including an `action_required`
// PUSH run, which really is a check that never ran — is red.
//
// USAGE
//   node agentic-org/scripts/ci-gate.mjs --sha=<40 hex> --repo=owner/name
//     [--workflow=ci.yml] [--timeout-seconds=1800] [--poll-seconds=20]
// Exits 0 when green, 1 when red or when it never concluded.

import { execFileSync } from 'node:child_process';

export const PENDING = 'pending';
export const GREEN = 'green';
export const RED = 'red';

export class GateError extends Error {}

export function parseArgs(argv) {
  const options = { sha: null, repo: null, workflow: 'ci.yml', timeoutSeconds: 1800, pollSeconds: 20 };
  for (const arg of argv) {
    const [key, ...rest] = arg.startsWith('--') ? arg.slice(2).split('=') : [null];
    const value = rest.join('=');
    if (key === 'sha' && value) options.sha = value;
    else if (key === 'repo' && value) options.repo = value;
    else if (key === 'workflow' && value) options.workflow = value;
    else if (key === 'timeout-seconds' && value) options.timeoutSeconds = Number(value);
    else if (key === 'poll-seconds' && value) options.pollSeconds = Number(value);
    else throw new GateError(`unrecognized argument: ${arg}`);
  }
  if (!/^[0-9a-f]{40}$/u.test(options.sha ?? '')) throw new GateError('--sha=<40 hex characters> is required');
  if (!/^[\w.-]+\/[\w.-]+$/u.test(options.repo ?? '')) throw new GateError('--repo=owner/name is required');
  return options;
}

/**
 * The whole rule, over the run list and nothing else.
 *
 * Returns `{ verdict, reasons, counts }`. `pending` means ask again; `red`
 * means refuse and say why; `green` means at least one push run of this
 * workflow concluded success on this commit and nothing else objected.
 */
export function verdict(runs) {
  const reasons = [];
  const push = runs.filter((run) => run.event === 'push');
  const counts = {
    total: runs.length, push: push.length,
    pending: runs.filter((run) => run.status !== 'completed').length,
    pushSuccess: push.filter((run) => run.conclusion === 'success').length
  };
  if (counts.pending > 0) return { verdict: PENDING, reasons: [`${counts.pending} run(s) have not concluded`], counts };
  if (counts.push === 0) return { verdict: PENDING, reasons: ['no push-event run of this workflow exists for this commit yet'], counts };

  for (const run of push)
    if (run.conclusion !== 'success') reasons.push(`the push run ${run.id ?? ''} concluded ${run.conclusion} — this is the authoritative run and it is not green`.trim());
  const pushAllGreen = push.every((run) => run.conclusion === 'success');
  for (const run of runs.filter((item) => item.event !== 'push')) {
    if (run.conclusion === 'success') continue;
    // The one admitted exception, and it is narrow: a duplicate that GitHub
    // never let start, alongside an authoritative push run that did and passed.
    if (run.conclusion === 'action_required' && pushAllGreen) continue;
    reasons.push(`the ${run.event} run ${run.id ?? ''} concluded ${run.conclusion}`.trim());
  }
  if (reasons.length) return { verdict: RED, reasons, counts };
  return { verdict: GREEN, reasons: [`${counts.pushSuccess} push run(s) concluded success and nothing else objected`], counts };
}

const fetchRuns = (options) => JSON.parse(execFileSync('gh', [
  'api', `repos/${options.repo}/actions/workflows/${options.workflow}/runs?head_sha=${options.sha}&per_page=100`,
  '--jq', '[.workflow_runs[] | {id, event, status, conclusion}]'
], { encoding: 'utf8', maxBuffer: 1 << 24 }));

export async function waitForGreen(options, { runs = fetchRuns, log = console.log, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const deadline = now() + options.timeoutSeconds * 1000;
  for (;;) {
    const result = verdict(runs(options));
    log(`CI ${options.workflow} @ ${options.sha.slice(0, 8)}: ${result.verdict} — ${result.reasons.join('; ')} (total=${result.counts.total} push=${result.counts.push} pending=${result.counts.pending})`);
    if (result.verdict === GREEN) return result;
    if (result.verdict === RED) throw new GateError(`refusing to merge a red branch:\n  ${result.reasons.join('\n  ')}`);
    if (now() >= deadline) throw new GateError(`CI did not conclude within ${options.timeoutSeconds}s — refusing to merge on a timeout`);
    await sleep(options.pollSeconds * 1000);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  waitForGreen(parseArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((error) => { process.stderr.write(`${error instanceof GateError ? error.message : error.stack}\n`); process.exit(1); });
}
