import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dispatchPagesDeploy, DispatchError, parseArgs } from './dispatch-pages-deploy.mjs';

const SHA = '7a3ac5ebbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MAIN = 'd6aaa46eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

test('dispatch waits for main to contain the merged edition head, then runs deploy workflow', async () => {
  const calls = [];
  const result = await dispatchPagesDeploy(parseArgs([`--repo=owner/repo`, `--merged-head-sha=${SHA}`, '--timeout-seconds=0']), {
    log() {},
    run(args) {
      calls.push(args);
      if (args[0] === 'api' && args[1] === 'repos/owner/repo/git/ref/heads/main') return MAIN;
      if (args[0] === 'api' && args[1] === `repos/owner/repo/compare/${SHA}...${MAIN}`) return 'ahead';
      if (args[0] === 'workflow') return '';
      throw new Error(`unexpected call ${args.join(' ')}`);
    }
  });
  assert.equal(result.refSha, MAIN);
  assert.deepEqual(calls.at(-1), ['workflow', 'run', 'deploy-website.yml', '--repo', 'owner/repo', '--ref', 'main']);
});

test('dispatch refuses a main ref that does not contain the merged edition head', async () => {
  const calls = [];
  await assert.rejects(
    dispatchPagesDeploy(parseArgs([`--repo=owner/repo`, `--merged-head-sha=${SHA}`, '--timeout-seconds=0']), {
      log() {},
      now: () => 0,
      run(args) {
        calls.push(args);
        if (args[1] === 'repos/owner/repo/git/ref/heads/main') return MAIN;
        if (args[1] === `repos/owner/repo/compare/${SHA}...${MAIN}`) return 'behind';
        throw new Error(`unexpected call ${args.join(' ')}`);
      }
    }),
    /did not contain merged head/u
  );
  assert.equal(calls.some((args) => args[0] === 'workflow'), false);
});

test('arguments reject unsafe workflow and ref values', () => {
  assert.throws(() => parseArgs([`--repo=owner/repo`, `--merged-head-sha=${SHA}`, '--workflow=deploy.sh']), DispatchError);
  assert.throws(() => parseArgs([`--repo=owner/repo`, `--merged-head-sha=${SHA}`, '--ref=../main']), DispatchError);
});

test('merge workflow grants actions write and dispatches after guarded merge', () => {
  const source = readFileSync(new URL('../../.github/workflows/merge-edition.yml', import.meta.url), 'utf8');
  assert.match(source, /permissions:\n(?:  .+\n)*  actions: write\n/u);
  assert.match(source, /gh pr merge "\$NUMBER" --merge --delete-branch=false[\s\S]+echo "merged=true" >> "\$GITHUB_OUTPUT"/u);
  assert.match(source, /name: Dispatch website deploy for the merged edition[\s\S]+node agentic-org\/scripts\/dispatch-pages-deploy\.mjs --repo="\$\{\{ github\.repository \}\}" --merged-head-sha="\$SHA"/u);
});
