import assert from 'node:assert/strict';
import test from 'node:test';
import { GREEN, GateError, PENDING, RED, fetchRuns, parseArgs, parseJobCount, verdict, waitForGreen } from './ci-gate.mjs';

const run = (event, conclusion, id = 1) => ({ id, event, status: 'completed', conclusion });
const running = (event) => ({ id: 9, event, status: 'in_progress', conclusion: null });
const sha = 'c0b5cc2e046e702b9fc291b3174fe7ce80d54a91';

test('a green push run is green', () => {
  assert.equal(verdict([run('push', 'success')]).verdict, GREEN);
});

test('a failed push run is red, and the reason names it', () => {
  const result = verdict([run('push', 'failure')]);
  assert.equal(result.verdict, RED);
  assert.match(result.reasons[0], /authoritative run and it is not green/u);
});

test('a run still going is pending, never green', () => {
  assert.equal(verdict([running('push')]).verdict, PENDING);
  assert.equal(verdict([run('push', 'success'), running('pull_request')]).verdict, PENDING);
});

test('no push run yet is pending, not green — a commit with no CI has not passed CI', () => {
  assert.equal(verdict([]).verdict, PENDING);
  assert.equal(verdict([run('pull_request', 'success')]).verdict, PENDING);
});

test('a pull_request duplicate GitHub never let start does not veto a green push run', () => {
  const result = verdict([run('push', 'success', 1), run('pull_request', 'action_required', 2)]);
  assert.equal(result.verdict, GREEN);
});

test('a pull_request duplicate GitHub marks failed without running jobs does not veto a green push run', () => {
  // Observed on PR138: the workflow run concluded failure, but its job list was
  // empty and the authoritative push run for the same SHA had already passed.
  const result = verdict([run('push', 'success', 1), { ...run('pull_request', 'failure', 2), actor: 'github-actions[bot]', jobCount: 0 }]);
  assert.equal(result.verdict, GREEN);
});

test('but an action_required PUSH run is red — that really is a check that never ran', () => {
  assert.equal(verdict([run('push', 'action_required')]).verdict, RED);
});

test('and a parked duplicate does NOT excuse a red push run', () => {
  const result = verdict([run('push', 'failure', 1), run('pull_request', 'action_required', 2)]);
  assert.equal(result.verdict, RED);
  assert.equal(result.reasons.length, 2, 'both the red push run and the unexcused duplicate must be reported');
});

test('and a zero-job failed duplicate does NOT excuse a red push run', () => {
  const result = verdict([run('push', 'failure', 1), { ...run('pull_request', 'failure', 2), actor: 'github-actions[bot]', jobCount: 0 }]);
  assert.equal(result.verdict, RED);
  assert.equal(result.reasons.length, 2, 'both the red push run and the unexcused duplicate must be reported');
});

test('a failed duplicate with jobs is real CI and still blocks', () => {
  assert.equal(verdict([run('push', 'success', 1), { ...run('pull_request', 'failure', 2), actor: 'github-actions[bot]', jobCount: 1 }]).verdict, RED);
  assert.equal(verdict([run('push', 'success', 1), { ...run('pull_request', 'failure', 2), actor: 'human', jobCount: 0 }]).verdict, RED);
  assert.equal(verdict([run('push', 'success', 1), { ...run('pull_request', 'failure', 2), jobCount: 0 }]).verdict, RED);
  assert.equal(verdict([run('push', 'success', 1), run('pull_request', 'failure', 2)]).verdict, RED);
});

test('any other non-success duplicate still vetoes', () => {
  for (const conclusion of ['cancelled', 'timed_out', 'startup_failure', 'neutral', 'stale'])
    assert.equal(verdict([run('push', 'success', 1), run('pull_request', conclusion, 2)]).verdict, RED, conclusion);
});

test('every push run must be green, not merely one of them', () => {
  assert.equal(verdict([run('push', 'success', 1), run('push', 'failure', 2)]).verdict, RED);
});



test('job-count parsing requires positive JSON evidence', () => {
  assert.equal(parseJobCount('0'), 0);
  assert.equal(parseJobCount('2'), 2);
  for (const raw of ['', ' ', 'null', '"0"', '{}', '-1', '1.2'])
    assert.throws(() => parseJobCount(raw), GateError, JSON.stringify(raw));
});

test('fetchRuns queries exact commit workflow runs and positive job evidence for failed PR duplicates', async () => {
  const calls = [];
  const result = await fetchRuns({ sha, repo: 'owner/repo', workflow: 'ci.yml' }, {
    exec(command, args) {
      calls.push([command, args]);
      if (args[1] === `repos/owner/repo/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`)
        return JSON.stringify([{ id: 7, event: 'pull_request', status: 'completed', conclusion: 'failure', actor: 'github-actions[bot]' }]);
      if (args[1] === 'repos/owner/repo/actions/runs/7/jobs') return '0';
      throw new Error(`unexpected call ${args.join(' ')}`);
    }
  });
  assert.deepEqual(result, [{ id: 7, event: 'pull_request', status: 'completed', conclusion: 'failure', actor: 'github-actions[bot]', jobCount: 0 }]);
  assert.deepEqual(calls.map(([, args]) => args[1]), [
    `repos/owner/repo/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`,
    'repos/owner/repo/actions/runs/7/jobs'
  ]);
});

test('fetchRuns fails closed when failed duplicate job evidence is blank or malformed', async () => {
  for (const payload of ['', 'not-json', 'null']) {
    await assert.rejects(fetchRuns({ sha, repo: 'owner/repo', workflow: 'ci.yml' }, {
      exec(command, args) {
        if (args[1].includes('/workflows/')) return JSON.stringify([{ id: 7, event: 'pull_request', status: 'completed', conclusion: 'failure', actor: 'github-actions[bot]' }]);
        if (args[1].includes('/jobs')) return payload;
        throw new Error(`unexpected call ${args.join(' ')}`);
      }
    }), GateError, payload);
  }
});

const apiOptions = { sha, repo: 'owner/repo', workflow: 'ci.yml', timeoutSeconds: 60, pollSeconds: 20 };
const apiError = (detail) => Object.assign(new Error('gh failed'), { stderr: Buffer.from(detail) });
function retryClock(exec) {
  let clock = 0;
  const delays = [], logs = [], calls = [];
  return { delays, logs, calls, now: () => clock, sleep: async (ms) => {
    delays.push(ms); clock += ms;
    assert.ok(clock <= 120000, 'retry exceeded the bounded test clock');
  },
    log: (line) => logs.push(line), exec: (...args) => { calls.push(args); return exec(...args); } };
}

test('fetchRuns retries 502 then succeeds within the original wait deadline', async () => {
  let attempt = 0;
  const deps = retryClock(() => {
    if (++attempt === 1) throw apiError('gh: Server Error (HTTP 502)');
    return JSON.stringify([run('push', 'success')]);
  });
  const result = await waitForGreen(apiOptions, { ...deps, runs: (options, runtime) => fetchRuns(options, { ...deps, ...runtime }) });
  assert.equal(result.verdict, GREEN);
  assert.equal(attempt, 2);
  assert.deepEqual(deps.delays, [1000]);
  assert.match(deps.logs[0], /transient failure.*1000ms.*HTTP 502/u);
});

test('persistent 502 exhausts the shared deadline with capped backoff and bounded API calls', async () => {
  const deps = retryClock(() => { throw apiError('gh: Server Error (HTTP 502)'); });
  await assert.rejects(waitForGreen(apiOptions, {
    ...deps, runs: (options, runtime) => fetchRuns(options, { ...deps, ...runtime })
  }), /did not conclude within 60s/u);
  assert.equal(deps.now(), 60000);
  assert.deepEqual(deps.delays, [1000, 2000, 4000, 8000, 10000, 10000, 10000, 10000, 5000]);
  assert.equal(deps.calls.length, 9);
  assert.equal(deps.calls.at(-1)[2].timeout, 5000);
  assert.ok(deps.calls.every(([, , options]) => options.timeout <= 30000 && options.killSignal === 'SIGKILL'));
});

test('transient 429, 5xx, network and timeouts retry; permanent failures and malformed JSON fail fast', async () => {
  for (const error of [apiError('HTTP 429'), apiError('HTTP 503'), apiError('dial tcp: no such host'), apiError('TLS handshake timeout'), apiError('error connecting to api.github.com'), apiError('Get "https://api.github.com/": EOF'), apiError('write: broken pipe'), Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' }), apiError('read: connection reset by peer')]) {
    let calls = 0;
    const deps = retryClock(() => { if (++calls === 1) throw error; return '[]'; });
    assert.deepEqual(await fetchRuns(apiOptions, deps), []);
    assert.equal(calls, 2);
  }
  for (const error of [apiError('HTTP 400'), apiError('HTTP 401'), apiError('HTTP 403'), apiError('HTTP 404 network timeout'), new Error('spawnSync gh ENOENT')]) {
    const deps = retryClock(() => { throw error; });
    await assert.rejects(fetchRuns(apiOptions, deps), (actual) => actual === error);
    assert.equal(deps.calls.length, 1);
    assert.deepEqual(deps.delays, []);
  }
  const deps = retryClock(() => 'not JSON');
  await assert.rejects(fetchRuns(apiOptions, deps), SyntaxError);
  assert.equal(deps.calls.length, 1);
  assert.deepEqual(deps.delays, []);
});

test('failed duplicate job lookup retries without losing job evidence or resetting the deadline', async () => {
  let jobs = 0;
  const deps = retryClock((command, args) => {
    if (args[1].includes('/workflows/')) return JSON.stringify([run('push', 'success'), { ...run('pull_request', 'failure', 7), actor: 'github-actions[bot]' }]);
    if (++jobs === 1) throw apiError('HTTP 502');
    return '0';
  });
  assert.equal(verdict(await fetchRuns(apiOptions, deps)).verdict, GREEN);
  assert.equal(jobs, 2);
  assert.deepEqual(deps.delays, [1000]);
});

test('pending polls and API retries share one deadline, and pending sleeps do not overshoot it', async () => {
  let calls = 0;
  const deps = retryClock(() => {
    if (++calls === 1) return '[]';
    throw apiError('HTTP 502');
  });
  await assert.rejects(waitForGreen({ ...apiOptions, timeoutSeconds: 3, pollSeconds: 2 }, {
    ...deps, runs: (options, runtime) => fetchRuns(options, { ...deps, ...runtime })
  }), /did not conclude within 3s/u);
  assert.equal(deps.now(), 3000);
  assert.equal(calls, 2);
  const pending = retryClock(() => '[]');
  await assert.rejects(waitForGreen({ ...apiOptions, timeoutSeconds: 1 }, { ...pending, runs: () => [] }), /timeout/u);
  assert.deepEqual(pending.delays, [1000]);
});


test('waiting stops on red immediately and on green immediately, and gives up on a timeout', async () => {
  const options = { sha, repo: 'o/r', workflow: 'ci.yml', timeoutSeconds: 60, pollSeconds: 0 };
  const log = () => {};
  await assert.rejects(waitForGreen(options, { runs: () => [run('push', 'failure')], log }), /refusing to merge a red branch/u);
  assert.equal((await waitForGreen(options, { runs: () => [run('push', 'success')], log })).verdict, GREEN);
  let clock = 0;
  await assert.rejects(
    waitForGreen(options, { runs: () => [running('push')], log, now: () => (clock += 30000), sleep: async () => {} }),
    /did not conclude within 60s/u);
});

test('the arguments are checked before a single API call is made', () => {
  assert.throws(() => parseArgs([]), GateError);
  assert.throws(() => parseArgs([`--sha=${sha}`]), GateError);
  assert.throws(() => parseArgs(['--sha=nope', '--repo=o/r']), GateError);
  assert.throws(() => parseArgs([`--sha=${sha}`, '--repo=o/r', '--admin']), GateError);
  for (const flag of ['--timeout-seconds=0', '--timeout-seconds=-1', '--timeout-seconds=Infinity', '--poll-seconds=NaN', '--poll-seconds=-1'])
    assert.throws(() => parseArgs([`--sha=${sha}`, '--repo=o/r', flag]), GateError);
  assert.deepEqual(parseArgs([`--sha=${sha}`, '--repo=o/r']), { sha, repo: 'o/r', workflow: 'ci.yml', timeoutSeconds: 1800, pollSeconds: 20 });
});
