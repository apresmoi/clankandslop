// CI's test coverage was an allowlist, and an allowlist stops covering the thing
// you add next.
//
// WHAT THIS CAUGHT
// ---------------
// On 2026-10-01 the workflow named 22 of the 46 test files under this directory.
// The 24 it did not name included `organization.test.mjs` -- the one check that
// the twelve Spawnfiles, the bundle descriptor and the committed tree agree with
// each other -- and every test belonging to a change that was about to be
// deployed. That change's pull request went GREEN having run none of its own new
// tests. Sixteen of the uncovered files ran clean with no private checkout and no
// state adapter, so the allowlist was never protecting CI from them; it had
// simply stopped being updated, and nothing anywhere said so.
//
// Three invisibly-red tests were found the same week by the same mechanism:
// `organization.test.mjs`'s TEAM.md phrase, `review-handoff.test.mjs`'s
// `passed=6/5`, and four `production-newsroom.test.mjs` cases that skip silently
// without the private state adapter. Each had been failing since the composition
// floor moved, with a green pipeline over it.
//
// So this file is not about tidiness. A pipeline whose green means "the subset
// somebody remembered" is the same defect as a test that restates the number it
// guards: it reads as proof and certifies nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const scripts = new URL('./', import.meta.url);
const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');

// Filenames carry dots -- `engine-policy.fixture.test.mjs` -- and a pattern that
// forgets that under-reports coverage. My first measurement of this gap did
// exactly that and claimed 26 uncovered files instead of 18.
const NAME = /[A-Za-z0-9._-]+\.test\.(?:mjs|ts)/gu;
const named = new Set(workflow.match(NAME) ?? []);
const present = readdirSync(scripts).filter((name) => /\.test\.(?:mjs|ts)$/u.test(name)).sort();

// A test file this workflow genuinely cannot run belongs here WITH ITS REASON,
// so the debt is visible and countable rather than inferred from an absence.
// Empty is the correct state and the one to defend: every file under this
// directory runs in CI today.
const EXEMPT = Object.freeze({});

test('every test file under agentic-org/scripts runs in CI', () => {
  // Vacuity guard: a glob that matched nothing, or a workflow that failed to
  // read, would otherwise make this test pass by having nothing to check.
  assert.ok(present.length >= 40, `expected at least 40 test files beside this one, found ${present.length}`);
  assert.ok(named.size >= 40, `the workflow names only ${named.size} test files; it was not read correctly`);
  const missing = present.filter((name) => !named.has(name) && !(name in EXEMPT));
  assert.deepEqual(missing, [], `these test files exist and no CI step names them, so they never run:\n  ${missing.join('\n  ')}\n`
    + 'Add them to .github/workflows/ci.yml, or add them to EXEMPT here with the reason they cannot run.');
});

test('the exemption list cannot rot', () => {
  for (const [name, reason] of Object.entries(EXEMPT)) {
    assert.ok(present.includes(name), `${name} is exempted but no longer exists -- prune it`);
    assert.ok(!named.has(name), `${name} is exempted and ALSO named by CI -- it runs, so drop the exemption`);
    assert.ok(typeof reason === 'string' && reason.length >= 20, `${name} needs a real reason for being exempt, got ${JSON.stringify(reason)}`);
  }
});

test('CI does not name a test file that no longer exists', () => {
  // A workflow that names a deleted file either fails loudly or, worse, silently
  // runs one fewer test than its author believes. Only this directory's files are
  // checked; the workflow legitimately names tests under ops/ and website/ too.
  const ours = new Set(present);
  const stale = [...named].filter((name) => ours.has(name) === false && workflow.includes(`agentic-org/scripts/${name}`));
  assert.deepEqual(stale, [], `CI names these under agentic-org/scripts but they do not exist: ${stale.join(', ')}`);
});
