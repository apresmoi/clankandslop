import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { qualifySignal } from './production-newsroom.mjs';

// Covers the two newest contract fixes that the end-to-end test in
// production-newsroom.test.mjs does not exercise: binding event_key to
// DAIMON_WAKE_ID when Daimon injects one, and the MCP layer's schemas
// actually being typed (not `{}`) for every tool.

const runtimeTest = (name, action) => test(name, { skip: !process.env.CLANK_NEWSROOM_STATE_ADAPTER && 'private newsroom state adapter unavailable; run the private integration gate' }, action);
runtimeTest('event_key must equal DAIMON_WAKE_ID when Daimon binds one, and is unconstrained otherwise', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-wake-bind-'));
  process.env.CLANK_EDITION_STATE_ROOT = path.join(temporary, 'state');
  process.env.CLANK_NEWSROOM_AGENT = 'klaxon';
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


test('Spike contract hands off to Ledger once current PASS coverage can support desk filing', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const files = [
    path.join(root, 'FLOOR.md'),
    path.join(root, 'agents', 'spike', 'AGENTS.md'),
    path.join(root, 'agents', 'spike', 'Spawnfile'),
  ];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    assert.match(text, /passed=5|five or more passed|five or more passed articles/u, `${file} must key the handoff to current PASS coverage`);
    assert.match(text, /@ledger/u, `${file} must name Ledger with a real mention`);
    assert.match(text, /room:release/u, `${file} must use Ledger's declared Moltnet room`);
    assert.match(text, /D ledger\.settlements/u, `${file} must avoid duplicate handoff after Ledger documents exist`);
    assert.match(text, /D ledger\.worlddesk/u, `${file} must avoid duplicate handoff after Ledger documents exist`);
    assert.match(text, /15:30 schedule|scheduled fallback|schedule is only the fallback/u, `${file} must state the native schedule is fallback, not a required gate`);
  }
});


test('shared floor scopes Moltnet history to the active edition', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const sharedFiles = [path.join(root, 'TEAM.md'), path.join(root, 'FLOOR.md')];
  for (const file of sharedFiles) {
    const text = await readFile(file, 'utf8');
    assert.match(text, /active edition is the date in the current wake|active edition is the date in the assignment/u, `${file} must bind active edition to wake or assignment`);
    assert.match(text, /created_at/u, `${file} must require Moltnet timestamp scoping`);
    assert.match(text, /explicit edition.*controls|explicit edition named in a message controls/u, `${file} must give explicit edition precedence`);
    assert.match(text, /Europe\/Berlin/u, `${file} must interpret timestamps in Europe/Berlin`);
    assert.match(text, /previous UTC date can still belong to the current Berlin edition/u, `${file} must account for UTC/Berlin midnight skew`);
    assert.match(text, /previous Berlin edition|historical edition/u, `${file} must make historical today decisions non-current`);
    assert.match(text, /[Ee]xplicit cross-day references[^.]*evidence|Cross-day references[^.]*evidence/u, `${file} must preserve explicit cross-day evidence use`);
    assert.match(text, /old decisions are not fresh orders|historical decisions are not fresh instructions/u, `${file} must reject stale orders`);
  }

  for (const role of ['klaxon', 'cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton', 'vesta', 'brass', 'spike', 'ledger', 'caslon', 'pressman']) {
    const text = await readFile(path.join(root, 'agents', role, 'AGENTS.md'), 'utf8');
    assert.match(text, /repos\/newsroom\/agentic-org\/FLOOR\.md/u, `${role} must receive the shared floor scoping rule`);
  }
});


test('Brass records assignments before any reporter wake handoff', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const files = [
    path.join(root, 'TEAM.md'),
    path.join(root, 'agents', 'brass', 'AGENTS.md'),
    path.join(root, 'agents', 'brass', 'Spawnfile'),
  ];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    assert.match(text, /Only a successful (tool )?response (permits|lets me) commission/u, `${file} must gate commissions on record_assignment success`);
    assert.match(text, /refus(?:es|al) or errors?/u, `${file} must define record_assignment refusal behavior`);
    assert.match(text, /without\s+(?:mentioning\s+reporters|reporter\s+mentions)/u, `${file} must prevent reporter wakes after assignment refusal`);
    assert.match(text, /end(s)? the turn/u, `${file} must stop after assignment refusal`);
    assert.match(text, /room:conference[\s\S]*plain names|plain names[\s\S]*room:conference/u, `${file} must keep accepted lineup summary non-waking`);
    assert.match(text, /once in `?room:assignment`?|one actionable `@<id>` assignment in `room:assignment`/u, `${file} must limit actionable reporter mentions to assignment room`);
  }

  const brassBrief = await readFile(path.join(root, 'agents', 'brass', 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(brassBrief, /forecast=0|paper still goes out/u, 'Brass brief must not say missing forecast still publishes');
  assert.match(brassBrief, /exactly one forecast assignment is mandatory/u, 'Brass brief must state the actual forecast contract');
});

test('shared floor tells reporters to stop without a current assignment row', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const text = await readFile(path.join(root, 'FLOOR.md'), 'utf8');
  assert.match(text, /Reporters need a current assignment row/u, 'FLOOR must require current assignment state');
  assert.match(text, /state\/edition\/editions\/<date>\/INDEX/u, 'FLOOR must name the edition INDEX as assignment authority');
  assert.match(text, /missing current assignment and stop/u, 'FLOOR must stop reporters on missing assignment');
  assert.match(text, /writing from chat alone/u, 'FLOOR must reject writing from chat alone');
});


test('shared floor names Codex Moltnet deferred tools exactly', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const text = await readFile(path.join(root, 'FLOOR.md'), 'utf8');
  assert.match(text, /mcp__daimon\.moltnet_read/u, 'FLOOR must name Codex deferred Moltnet read exactly');
  assert.match(text, /mcp__daimon\.moltnet_send/u, 'FLOOR must name Codex deferred Moltnet send exactly');
  assert.match(text, /shorter\s+`moltnet_read`\s+and\s+`moltnet_send`\s+names in prompts are the operations/u, 'FLOOR must distinguish operation names from advertised Codex tool names');
  assert.match(text, /not proof that the runtime connection is absent/u, 'FLOOR must prevent false unavailable-tool conclusions');
});

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


  assert.match(fileArticleTool.description, /moltnet_send/u);
  assert.match(fileArticleTool.description, /room:filing/u);
  assert.match(fileArticleTool.description, /@spike/u);
  assert.match(fileArticleTool.description, /forecast filings mention @spike and the dissenter in the same message/u);

  const spike = await mcpToolsList('spike');
  const reviewArticleTool = spike.find((tool) => tool.name === 'review_article');
  assert.ok(reviewArticleTool, 'spike must expose review_article');
  assert.match(reviewArticleTool.description, /only saves notes and mentions/u);
  assert.match(reviewArticleTool.description, /does not deliver/u);
  assert.match(reviewArticleTool.description, /REVISION_REQUEST and HOLD/u);
  assert.match(reviewArticleTool.description, /SPIKE/u);
  assert.match(reviewArticleTool.description, /PASS continues from the fresh INDEX/u);
  assert.match(reviewArticleTool.description, /passed>=5/u);
  assert.match(reviewArticleTool.description, /@ledger in room:release/u);

  const caslon = await mcpToolsList('caslon');
  const composeTool = caslon.find((tool) => tool.name === 'compose_edition');
  assert.ok(composeTool, 'caslon must expose compose_edition');
  assert.match(composeTool.description, /only saves the composition/u);
  assert.match(composeTool.description, /does not deliver the release handoff/u);
  assert.match(composeTool.description, /moltnet_send/u);
  assert.match(composeTool.description, /clank-newsroom/u);
  assert.match(composeTool.description, /room:release/u);
  assert.match(composeTool.description, /@pressman/u);
  assert.match(composeTool.description, /prepare_release validation\/build/u);
  assert.match(composeTool.description, /stage_release/u);
  assert.match(composeTool.description, /Then end the turn/u);
  // Everyone outside the six desks is refused the tool at the surface.
  const pressman = await mcpToolsList('pressman');
  const stageTool = pressman.find((tool) => tool.name === 'stage_release');
  assert.ok(stageTool, 'pressman must expose stage_release');
  assert.match(stageTool.description, /Promote the already prepared, mechanically checked edition artifact/u);
  assert.match(stageTool.description, /only saves the staging artifact and receipt/u);
  assert.match(stageTool.description, /does not deliver the final release-room line/u);
  assert.match(stageTool.description, /moltnet_send/u);
  assert.match(stageTool.description, /clank-newsroom/u);
  assert.match(stageTool.description, /room:release/u);
  assert.match(stageTool.description, /staging artifact/u);
  assert.match(stageTool.description, /artifact digest/u);
  assert.match(stageTool.description, /local staging and receipt are complete/u);
  assert.match(stageTool.description, /Then end the turn/u);
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
