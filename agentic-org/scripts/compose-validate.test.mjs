import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { assertCandidateValidates, candidateValidationErrors } from './compose-validate.mjs';

// A real published edition stands in for the candidate compose would record.
const publicRoot = path.resolve(import.meta.dirname, '../..'), editionsRoot = path.join(publicRoot, 'content/editions');
const edition = '2026-10-21', base = path.join(editionsRoot, edition);
const tree = Object.fromEntries(await Promise.all(['articles', 'desk', 'pages', 'maps', 'glyphs'].map(async kind => [kind, (await readdir(path.join(base, kind)).catch(() => [])).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).sort()])));
const reader = (override = {}) => async (kind, name) => override[`${kind}/${name}`] ?? JSON.parse(await readFile(path.join(base, kind, `${name}.json`), 'utf8'));
const input = read => ({ edition, tree, read, publicRoot, editionsRoot });

test('a candidate edition the release validator accepts composes', async () => {
  assert.deepEqual(await candidateValidationErrors(input(reader())), []);
});

test('compose refuses compiled_by naming backstage agents with the release validator\'s exact error', async () => {
  const chrome = JSON.parse(await readFile(path.join(base, 'desk/caslon.chrome.json'), 'utf8'));
  const read = reader({ 'desk/caslon.chrome': { ...chrome, compiled_by: [...chrome.compiled_by, 'Caslon', 'Ledger'] } });
  assert.deepEqual(await candidateValidationErrors(input(read)), [
    `content/editions/${edition}/desk: compiled_by names unknown agent "Caslon"`,
    `content/editions/${edition}/desk: compiled_by names unknown agent "Ledger"`,
  ]);
  await assert.rejects(assertCandidateValidates(input(read)), error => error.message.includes(`✗ content/editions/${edition}/desk: compiled_by names unknown agent "Caslon"`) && /nothing was composed/u.test(error.message));
});

test('a candidate page referencing a story from no edition is refused as the release would', async () => {
  const front = JSON.parse(await readFile(path.join(base, 'pages/front.json'), 'utf8'));
  const read = reader({ 'pages/front': { ...front, flow: [...front.flow, { block: 'Teaser', props: { article: 'no-such-story' } }] } });
  assert.deepEqual(await candidateValidationErrors(input(read)), [`content/editions/${edition}/pages/front.json: flow[${front.flow.length}].article references missing article "no-such-story"`]);
});
