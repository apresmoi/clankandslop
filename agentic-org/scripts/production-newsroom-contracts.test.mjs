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
  assert.deepEqual(art.required, ['kind', 'caption']);
  assert.deepEqual(new Set(art.properties.kind.enum), new Set(['map', 'ascii']));
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

// ---------------------------------------------------------------------------
// The stdio transport.
//
// On 2026-09-06 the org container was found `Exited (1)` from an unhandled
// `write EPIPE` raised in this file for `graves` during daimon startup — one
// start in three. `docker start` was not reliably survivable, and a crash there
// takes the run down before any wake fires.
//
// The peer closing its end of a pipe is a normal end of life for one of these
// processes. A transport that is genuinely broken is not, and must still fail
// where somebody can see it: an agent whose tool server died silently would
// accept calls and answer none.
// ---------------------------------------------------------------------------
function runServer(role, { env = {}, onFirstReply, stdin = [] } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'production-newsroom-mcp.mjs')], { env: { ...process.env, CLANK_NEWSROOM_AGENT: role, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    if (onFirstReply) child.stdout.once('data', () => onFirstReply(child));
    child.on('exit', (code) => resolve({ code, stderr }));
    for (const line of stdin) child.stdin.write(`${JSON.stringify(line)}\n`);
  });
}

test('the peer closing its end of stdout ends the server quietly, not with a crash', async () => {
  // Exactly the shape that killed the container: answer the handshake, have the
  // host hang up, then write again.
  const { code, stderr } = await runServer('graves', {
    stdin: [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }],
    onFirstReply: (child) => {
      child.stdout.destroy();
      setTimeout(() => {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })}\n`);
        child.stdin.end();
      }, 20);
    },
  });
  assert.equal(code, 0, `a closed peer must not be a crash — stderr was:\n${stderr}`);
  assert.doesNotMatch(stderr, /Unhandled 'error' event|EPIPE/u, 'nothing to report, so nothing is reported');
});

test('a transport that is broken rather than closed still fails loudly', async () => {
  // The half a blanket try/catch would have swallowed. Any stream error whose
  // code is not "the other end hung up" is a dead tool server, and a dead tool
  // server that exits 0 is an agent that looks alive and answers nothing.
  const { code, stderr } = await runServer('graves', { env: { CLANK_MCP_INJECT_STREAM_ERROR: 'ENOSPC' } });
  assert.equal(code, 70);
  assert.match(stderr, /clank-newsroom-graves: stdout transport failed \(ENOSPC\)/u);

  // And the classification is by code, not by luck: the three codes that mean
  // "closed normally" all exit 0, everything else does not.
  for (const closed of ['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'])
    assert.equal((await runServer('graves', { env: { CLANK_MCP_INJECT_STREAM_ERROR: closed } })).code, 0, `${closed} must be a quiet exit`);
  for (const broken of ['ECONNRESET', 'ENOSPC', 'EIO'])
    assert.equal((await runServer('graves', { env: { CLANK_MCP_INJECT_STREAM_ERROR: broken } })).code, 70, `${broken} must be a loud exit`);
});
