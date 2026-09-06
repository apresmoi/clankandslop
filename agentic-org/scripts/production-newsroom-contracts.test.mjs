import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { qualifySignal } from './production-newsroom.mjs';

// Covers the two newest contract fixes that the end-to-end test in
// production-newsroom.test.mjs does not exercise: binding event_key to
// DAIMON_WAKE_ID when Daimon injects one, and the MCP layer's schemas
// actually being typed (not `{}`) for every tool.

test('event_key must equal DAIMON_WAKE_ID when Daimon binds one, and is unconstrained otherwise', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-wake-bind-'));
  process.env.CLANK_EDITION_STATE_ROOT = path.join(temporary, 'state');
  const edition = '2026-08-26';
  const qualified = (eventKey) => ({ edition, event_key: eventKey, summary: 'A sufficiently detailed qualified signal for the daily paper.', selected_desks: ['foreman'], evidence_refs: ['https://source.example/evidence'] });
  try {
    // No DAIMON_WAKE_ID bound: any event_key of legal length/type is accepted, unchanged.
    delete process.env.DAIMON_WAKE_ID;
    await assert.doesNotReject(qualifySignal(qualified('moltnet:self-chosen-key')));

    // DAIMON_WAKE_ID bound: an agent can no longer mint its own key — the
    // mismatch is rejected and the error names the correct value.
    process.env.DAIMON_WAKE_ID = 'moltnet:wake-42';
    await assert.rejects(qualifySignal(qualified('moltnet:minted-by-agent')), /event_key must equal the current wake id "moltnet:wake-42"/u);
    await assert.doesNotReject(qualifySignal(qualified('moltnet:wake-42')));
  } finally {
    delete process.env.DAIMON_WAKE_ID;
    await rm(temporary, { recursive: true, force: true });
  }
});

function mcpToolsList(role) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'production-newsroom-mcp.mjs')], { env: { ...process.env, CLANK_NEWSROOM_AGENT: role }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', reject);
    child.on('exit', () => {
      const lines = out.split('\n').filter(Boolean).map((line) => JSON.parse(line));
      resolve(lines.find((line) => line.id === 2)?.result?.tools ?? []);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    child.stdin.end();
  });
}

test('mcp tool schemas type every property beyond edition/event_key', async () => {
  const brass = await mcpToolsList('brass');
  const recordAssignment = brass.find((tool) => tool.name === 'record_assignment');
  assert.ok(recordAssignment, 'brass must expose record_assignment');
  assert.equal(recordAssignment.inputSchema.properties.assignments.type, 'array');
  assert.equal(recordAssignment.inputSchema.properties.assignments.items.type, 'object');
  assert.deepEqual(new Set(recordAssignment.inputSchema.properties.assignments.items.required), new Set(['id', 'owner', 'brief', 'evidence_refs']));

  const cogsworth = await mcpToolsList('cogsworth');
  const fileArticleTool = cogsworth.find((tool) => tool.name === 'file_article');
  assert.ok(fileArticleTool, 'cogsworth must expose file_article');
  assert.deepEqual(fileArticleTool.inputSchema.required, ['edition', 'event_key', 'article']);
  assert.equal(fileArticleTool.inputSchema.properties.article.type, 'object');
  assert.ok(fileArticleTool.inputSchema.properties.article.properties.epistemic.enum.includes('fact'));
  assert.ok(!fileArticleTool.inputSchema.required.includes('assignment_event_key'), 'assignment_event_key must never be required');

  // `dissent` is not an article key any more, at any layer: the schema does not
  // advertise it and file_article refuses it. A schema that still offered it
  // would be an invitation to the exact call the server rejects.
  assert.equal(fileArticleTool.inputSchema.properties.article.properties.dissent, undefined, 'the article schema must not offer a dissent key');
  const art = fileArticleTool.inputSchema.properties.article.properties.art;
  assert.deepEqual(art.required, ['kind']);
  assert.deepEqual(art.properties.kind.enum, ['map', 'ascii']);
  assert.equal(art.properties.map.type, 'string');
  assert.equal(art.properties.hero_map.type, 'string');
  assert.deepEqual(art.properties.spots.items.required, ['name', 'lat', 'lon']);

  // record_dissent is typed, and it is the six desks that hold it.
  const recordDissentTool = cogsworth.find((tool) => tool.name === 'record_dissent');
  assert.ok(recordDissentTool, 'a reporter must expose record_dissent');
  assert.deepEqual(recordDissentTool.inputSchema.required, ['edition', 'event_key', 'article_id', 'revision', 'stance', 'argument']);
  assert.deepEqual(recordDissentTool.inputSchema.properties.stance.enum, ['dissent', 'concur']);
  assert.equal(recordDissentTool.inputSchema.properties.revision.type, 'integer');
  assert.equal(recordDissentTool.inputSchema.properties.p.maximum, 1);
  // No agent/name parameter, ever: identity is the process, not an argument.
  for (const forbidden of ['agent', 'name', 'dissenter']) assert.equal(recordDissentTool.inputSchema.properties[forbidden], undefined, `record_dissent must not accept a "${forbidden}" argument`);
  assert.equal(recordDissentTool.inputSchema.additionalProperties, false);

  // The assignment item carries the forecast slot the filing gate reads.
  assert.deepEqual(recordAssignment.inputSchema.properties.assignments.items.properties.slot.enum, ['forecast']);
  assert.deepEqual(new Set(recordAssignment.inputSchema.properties.assignments.items.properties.dissenter.enum), new Set(['cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton', 'vesta']));

  // Everyone outside the six desks is refused the tool at the surface.
  for (const role of ['spike', 'caslon', 'brass', 'ledger', 'pressman', 'klaxon']) {
    const tools = await mcpToolsList(role);
    assert.ok(!tools.some((tool) => tool.name === 'record_dissent'), `${role} must not be offered record_dissent`);
  }
});
