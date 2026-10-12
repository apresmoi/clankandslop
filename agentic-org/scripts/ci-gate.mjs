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
// The pull_request duplicate is created by the workflow after the push run has
// passed. GitHub has produced two harmless duplicate shapes in production:
// `action_required`, where the bot-authored run was parked before it started,
// and `failure` with zero jobs from github-actions[bot], where no check
// actually ran. Both are admitted only beside a green push run for this exact
// SHA. A failed duplicate with even one job, a human actor, or unknown job
// evidence still blocks, because that is real CI or unknown CI. A failed push
// run always blocks, because the push run is the authority.
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
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) throw new GateError('--timeout-seconds must be positive and finite');
  if (!Number.isFinite(options.pollSeconds) || options.pollSeconds < 0) throw new GateError('--poll-seconds must be non-negative and finite');
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
    // The admitted duplicate shapes are narrow: a non-push run that GitHub did
    // not actually execute, alongside an authoritative push run that did pass.
    if (pushAllGreen && run.event === 'pull_request' && run.conclusion === 'action_required') continue;
    if (pushAllGreen && run.event === 'pull_request' && run.conclusion === 'failure' && run.actor === 'github-actions[bot]' && run.jobCount === 0) continue;
    reasons.push(`the ${run.event} run ${run.id ?? ''} concluded ${run.conclusion}`.trim());
  }
  if (reasons.length) return { verdict: RED, reasons, counts };
  return { verdict: GREEN, reasons: [`${counts.pushSuccess} push run(s) concluded success and nothing else objected`], counts };
}

export function parseJobCount(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new GateError('job-count response was not valid JSON'); }
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new GateError('job-count response was not a non-negative integer');
  return parsed;
}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeoutError = (options) => new GateError(`CI did not conclude within ${options.timeoutSeconds ?? 1800}s — refusing to merge on a timeout`);

export function isTransientApiError(error) {
  const detail = `${error.message ?? ''}\n${error.stderr ?? ''}`;
  const status = /\bHTTP\s+(\d{3})\b/iu.exec(detail)?.[1];
  if (status) return Number(status) === 429 || Number(status) >= 500 && Number(status) <= 599;
  return /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|ENOTFOUND)\b/iu.test(`${error.code ?? ''} ${detail}`)
    || /timed?\s*out|timeout|TLS handshake|connection (?:reset|refused|closed)|network is unreachable|no such host|temporary failure in name resolution|\bEOF\b|broken pipe|error connecting to/iu.test(detail);
}

export async function fetchRuns(options, { exec = execFileSync, now = Date.now, sleep = sleepFor, log = console.log, deadline = now() + (options.timeoutSeconds ?? 1800) * 1000 } = {}) {
  const api = async (args, maxBuffer) => {
    let backoff = 1000;
    for (;;) {
      const remaining = deadline - now();
      if (remaining <= 0) throw timeoutError(options);
      try {
        return exec('gh', args, { encoding: 'utf8', maxBuffer, timeout: Math.max(1, Math.min(30000, remaining)), killSignal: 'SIGKILL' });
      } catch (error) {
        if (!isTransientApiError(error)) throw error;
        const delay = Math.min(backoff, deadline - now());
        if (delay <= 0) throw timeoutError(options);
        log(`CI API transient failure; retrying in ${delay}ms: ${String(error.stderr || error.message).trim()}`);
        await sleep(delay);
        backoff = Math.min(backoff * 2, 10000);
      }
    }
  };
  const listing = JSON.parse(await api([
    'api', `repos/${options.repo}/actions/workflows/${options.workflow}/runs?head_sha=${options.sha}&per_page=100`,
    '--jq', '[.workflow_runs[] | {id, event, status, conclusion, actor: .actor.login}]'
  ], 1 << 24));
  const runs = [];
  for (const run of listing) {
    if (run.event !== 'pull_request' || run.status !== 'completed' || run.conclusion !== 'failure') { runs.push(run); continue; }
    const jobCount = parseJobCount(await api([
      'api', `repos/${options.repo}/actions/runs/${run.id}/jobs`, '--jq', '.total_count'
    ], 1 << 20));
    runs.push({ ...run, jobCount });
  }
  return runs;
}

export async function waitForGreen(options, { runs = fetchRuns, log = console.log, now = Date.now, sleep = sleepFor } = {}) {
  const deadline = now() + options.timeoutSeconds * 1000;
  for (;;) {
    if (now() >= deadline) throw timeoutError(options);
    const result = verdict(await runs(options, { deadline, now, sleep, log }));
    if (now() >= deadline) throw timeoutError(options);
    log(`CI ${options.workflow} @ ${options.sha.slice(0, 8)}: ${result.verdict} — ${result.reasons.join('; ')} (total=${result.counts.total} push=${result.counts.push} pending=${result.counts.pending})`);
    if (result.verdict === GREEN) return result;
    if (result.verdict === RED) throw new GateError(`refusing to merge a red branch:\n  ${result.reasons.join('\n  ')}`);
    await sleep(Math.min(options.pollSeconds * 1000, Math.max(0, deadline - now())));
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  waitForGreen(parseArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((error) => { process.stderr.write(`${error instanceof GateError ? error.message : error.stack}\n`); process.exit(1); });
}
