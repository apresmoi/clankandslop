#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

export class DispatchError extends Error {}

export function parseArgs(argv) {
  const options = { repo: null, workflow: 'deploy-website.yml', ref: 'main', mergedHeadSha: null, timeoutSeconds: 300, pollSeconds: 5 };
  for (const arg of argv) {
    const [key, ...rest] = arg.startsWith('--') ? arg.slice(2).split('=') : [null];
    const value = rest.join('=');
    if (key === 'repo' && value) options.repo = value;
    else if (key === 'workflow' && value) options.workflow = value;
    else if (key === 'ref' && value) options.ref = value;
    else if (key === 'merged-head-sha' && value) options.mergedHeadSha = value;
    else if (key === 'timeout-seconds' && value) options.timeoutSeconds = Number(value);
    else if (key === 'poll-seconds' && value) options.pollSeconds = Number(value);
    else throw new DispatchError(`unrecognized argument: ${arg}`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/u.test(options.repo ?? '')) throw new DispatchError('--repo=owner/name is required');
  if (!/^[\w.-]+\.ya?ml$/u.test(options.workflow)) throw new DispatchError('--workflow=<file.yml> is required');
  if (!/^[A-Za-z0-9._/-]+$/u.test(options.ref) || options.ref.includes('..') || options.ref.startsWith('/') || options.ref.endsWith('/')) throw new DispatchError('--ref=<branch> is invalid');
  if (!/^[0-9a-f]{40}$/u.test(options.mergedHeadSha ?? '')) throw new DispatchError('--merged-head-sha=<40 hex characters> is required');
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds < 0) throw new DispatchError('--timeout-seconds must be a non-negative number');
  if (!Number.isFinite(options.pollSeconds) || options.pollSeconds <= 0) throw new DispatchError('--poll-seconds must be a positive number');
  return options;
}

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 20 }).trim();

export async function waitForMergedRef(options, { run = gh, log = console.log, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const deadline = now() + options.timeoutSeconds * 1000;
  for (;;) {
    const refSha = run(['api', `repos/${options.repo}/git/ref/heads/${options.ref}`, '--jq', '.object.sha']);
    const status = run(['api', `repos/${options.repo}/compare/${options.mergedHeadSha}...${refSha}`, '--jq', '.status']);
    log(`${options.ref} @ ${refSha.slice(0, 8)} is ${status} of ${options.mergedHeadSha.slice(0, 8)}`);
    if (status === 'identical' || status === 'ahead') return refSha;
    if (status === 'diverged') throw new DispatchError(`${options.ref} diverged from merged head ${options.mergedHeadSha}`);
    if (now() >= deadline) throw new DispatchError(`${options.ref} did not contain merged head ${options.mergedHeadSha} within ${options.timeoutSeconds}s`);
    await sleep(options.pollSeconds * 1000);
  }
}

export async function dispatchPagesDeploy(options, controls = {}) {
  const run = controls.run ?? gh;
  const log = controls.log ?? console.log;
  const refSha = await waitForMergedRef(options, { ...controls, run, log });
  run(['workflow', 'run', options.workflow, '--repo', options.repo, '--ref', options.ref]);
  log(`dispatched ${options.workflow} for ${options.ref} @ ${refSha}`);
  return { refSha };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  dispatchPagesDeploy(parseArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((error) => { process.stderr.write(`${error instanceof DispatchError ? error.message : error.stack}\n`); process.exit(1); });
}
