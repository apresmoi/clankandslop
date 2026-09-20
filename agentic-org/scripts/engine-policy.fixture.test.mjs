// The matcher against a REAL compiled entrypoint.
//
// `fixtures/compiled-grok-entrypoint.sh` is verbatim output of `spawnfile build`
// for this organization (image clank-and-slop:seam-2026-09-19-020345, the build the
// newsroom ran the 2026-09-19 edition on), trimmed to two of its twelve workers and
// the lines the engine policy reads. Nothing in it is hand-written: the escaping is
// the compiler's own, which is the whole point — a substring search for the profile
// bytes cannot match this file, and one did not on 2026-09-20, refusing a correctly
// confined organization at seam stage 5.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { GROK_BROKER, grokBrokerFindings, parseCompiledGrokWorkers } from './engine-policy.mjs';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'compiled-grok-entrypoint.sh');
const source = readFileSync(fixture, 'utf8');
const expected = new Map([
  ['agent:brass', { model: 'grok-4.6', reasoningEffort: 'low' }],
  ['agent:caslon', { model: 'grok-4.6', reasoningEffort: 'low' }]
]);

test('a real compiled entrypoint escapes the profile bytes, so substring matching cannot see them', () => {
  assert.equal(source.includes(GROK_BROKER.sandboxBase), false, 'fixture must carry the compiler escaping, not raw profile bytes');
  assert.ok(source.includes('extends = \\"strict\\"'), 'fixture must carry the escaped strict base');
  const workers = parseCompiledGrokWorkers(source);
  assert.equal(workers?.length, 2);
  for (const worker of workers) assert.ok(worker.profile.includes(GROK_BROKER.sandboxBase));
});

test('the policy accepts a real confined compiled entrypoint', () => {
  assert.deepEqual(grokBrokerFindings(fixture, source, expected), []);
});

test('it still refuses a worker whose confinement was actually removed', () => {
  const workers = parseCompiledGrokWorkers(source);
  const stripped = workers.map((worker, index) => index === 0
    ? { ...worker, profile: worker.profile.replace(GROK_BROKER.sandboxBase, 'extends = "workspace"') }
    : worker);
  const weakened = source.replace(/const grokWorkers = \[[\s\S]*?\];\n/u, `const grokWorkers = ${JSON.stringify(stripped)};\n`);
  const findings = grokBrokerFindings(fixture, weakened, expected);
  assert.equal(findings.length, 1, findings.join('\n'));
  assert.match(findings[0], /agent:brass carries no strict Grok worker sandbox profile/u);
});

test('it refuses an entrypoint whose worker provisioning cannot be read at all', () => {
  const blinded = source.replace(/const grokWorkers = \[[\s\S]*?\];\n/u, 'const grokWorkers = "redacted";\n');
  assert.match(grokBrokerFindings(fixture, blinded, expected).join('\n'), /no readable Grok worker provisioning array/u);
});
