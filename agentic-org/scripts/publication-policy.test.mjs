import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/merge-edition.yml', import.meta.url), 'utf8');

function assertReviewOnly(source) {
  assert.match(source, /^  contents: read$/mu, 'edition review has no content-write grant');
  assert.match(source, /^  pull-requests: write$/mu, 'edition review can prepare a pull request');
  assert.doesNotMatch(source, /\bgh\s+pr\s+merge\b|enablePullRequestAutoMerge/u, 'publication requires a human merge');
  assert.match(source, /Refuse any ref that is not a dated edition branch/u);
  assert.match(source, /Refuse a branch that changes anything but the edition content/u);
  assert.match(source, /Refuse any change under agentic-org that is not a checksum/u);
  assert.match(source, /Wait for CI on this exact commit/u);
  assert.match(source, /gh pr create/u);
  assert.match(source, /the branch moved from/u);
}

test('edition automation prepares a checked pull request and leaves publication to a human', () => {
  assertReviewOnly(workflow);
});

test('restoring automatic merge or its write grant breaks the publication policy', () => {
  assert.throws(() => assertReviewOnly(`${workflow}\n          gh pr merge "$NUMBER" --merge\n`), /human merge/u);
  assert.throws(() => assertReviewOnly(workflow.replace('contents: read', 'contents: write')), /content-write/u);
});
