import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const caslonCheck = (text) => {
  assert.match(text, /successful `mcp_newsroom_compose_edition` response/u, 'Caslon must act only after accepted composition');
  assert.match(text, /`moltnet_send`/u, 'Caslon must own the Moltnet send');
  assert.match(text, /`clank-newsroom`/u, 'Caslon must name the declared network');
  assert.match(text, /`room:release`/u, 'Caslon must use Pressman\'s release room');
  assert.match(text, /`@pressman`/u, 'Caslon must wake Pressman by mention');
  assert.match(text, /returned composition digest/u, 'Caslon must include the durable composition identity');
  assert.match(text, /`prepare_release` validation\/build and `stage_release`/u, 'Caslon must request Pressman\'s declared tools');
  assert.match(text, /If\s+composition\s+is\s+refused,\s+(?:I\s+)?do\s+not\s+mention\s+Pressman/u, 'Caslon must not hand off after refusal');
};

const pressmanCheck = (text) => {
  assert.match(text, /successful `stage_release` response/u, 'Pressman must act only after accepted staging');
  assert.match(text, /`moltnet_send`/u, 'Pressman must own the Moltnet send');
  assert.match(text, /`clank-newsroom`/u, 'Pressman must name the declared network');
  assert.match(text, /`room:release`/u, 'Pressman must use the release room');
  assert.match(text, /staging\s+artifact\s+and\s+artifact\s+digest/u, 'Pressman must include the durable staged identity');
  assert.match(text, /local\s+staging\s+and\s+receipt\s+are\s+complete/u, 'Pressman must report the actual terminal local state');
  assert.match(text, /If\s+staging\s+is\s+refused,\s+(?:I\s+)?do\s+not\s+send\s+that\s+line/u, 'Pressman must not hand off after refusal');
};

test('Caslon prompt requires an agent-owned Pressman handoff after successful composition', async () => {
  const original = await readFile(resolve(root, 'agents/caslon/AGENTS.md'), 'utf8');
  caslonCheck(original);
  const mutated = original.replace('successful `mcp_newsroom_compose_edition` response', '');
  assert.notEqual(mutated, original, 'mutation anchor must exist');
  assert.throws(() => caslonCheck(mutated), /accepted composition|successful/u);
});

test('Pressman prompt requires an agent-owned release-room line after successful staging', async () => {
  const original = await readFile(resolve(root, 'agents/pressman/AGENTS.md'), 'utf8');
  pressmanCheck(original);
  const mutated = original.replace('successful `stage_release` response', '');
  assert.notEqual(mutated, original, 'mutation anchor must exist');
  assert.throws(() => pressmanCheck(mutated), /accepted staging|successful/u);
});
