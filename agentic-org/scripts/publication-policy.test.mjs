import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/merge-edition.yml', import.meta.url), 'utf8');

const required = [
  'contents: write', 'pull-requests: write', 'actions: write',
  "grep -Eq '^refs/heads/edition/[0-9]{4}-[0-9]{2}-[0-9]{2}$'",
  '[ "$bad" -eq 0 ] ||', '[ -n "$offending" ]',
  'gh pr create', '[ "$head" = "$SHA" ] ||',
  'node agentic-org/scripts/ci-gate.mjs --sha="$SHA"',
  'gh pr merge "$NUMBER" --merge --delete-branch=false',
  "if: steps.merge.outputs.merged == 'true'",
  'node agentic-org/scripts/dispatch-pages-deploy.mjs'
];

function assertGuardedPublication(source) {
  const executable = source.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
  for (const rule of required) assert.ok(executable.includes(rule), `missing publication gate: ${rule}`);
  assert.doesNotMatch(executable, /--admin|enablePullRequestAutoMerge/u);
  const merge = executable.indexOf('gh pr merge');
  assert.ok(executable.indexOf('[ "$head" = "$SHA" ] ||') < merge);
  assert.ok(executable.indexOf('node agentic-org/scripts/ci-gate.mjs --sha="$SHA"') < merge);
  assert.ok(executable.indexOf('node agentic-org/scripts/dispatch-pages-deploy.mjs') > merge);
}

test('operator-authorized edition publication preserves content, exact-head CI and deployment gates', () => {
  assertGuardedPublication(workflow);
});

test('removing any required publication gate fails the contract', () => {
  for (const rule of required)
    assert.throws(() => assertGuardedPublication(workflow.replaceAll(rule, 'REMOVED')), /missing publication gate/u, rule);
});
