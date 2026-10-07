import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildEditionIndex, renderEditionIndex } from './edition-index.mjs';
import { REFUSAL_LOG, appendRefusal, readRefusals, refusalIndexLine, withRefusalLog } from './refusal-log.mjs';

const edition = '2026-10-08';
async function scratch(action) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clank-refusals-'));
  try { return await action(root, path.join(root, 'editions', edition)); } finally { await rm(root, { recursive: true, force: true }); }
}

test('a refused call is logged with who, what and why, and rethrown unchanged', () => scratch(async (root, base) => {
  const refusal = new Error('article format rejected — nothing was recorded');
  const wrapped = withRefusalLog('file_article', async () => { throw refusal; });
  const previous = [process.env.CLANK_EDITION_STATE_ROOT, process.env.CLANK_NEWSROOM_AGENT];
  process.env.CLANK_EDITION_STATE_ROOT = root; process.env.CLANK_NEWSROOM_AGENT = 'foreman';
  try {
    await assert.rejects(wrapped({ edition, event_key: 'wake-17', article: { id: 'pakistan-cpec', revision: 2 } }), (error) => error === refusal);
  } finally { [process.env.CLANK_EDITION_STATE_ROOT, process.env.CLANK_NEWSROOM_AGENT] = previous; if (previous[0] === undefined) delete process.env.CLANK_EDITION_STATE_ROOT; if (previous[1] === undefined) delete process.env.CLANK_NEWSROOM_AGENT; }
  const { entries, unreadable } = await readRefusals(base);
  assert.equal(unreadable, 0);
  assert.equal(entries.length, 1);
  assert.deepEqual({ ...entries[0], at: undefined }, { at: undefined, agent: 'foreman', tool: 'file_article', kind: 'refused', event_key: 'wake-17', artifact: 'pakistan-cpec/2', message: refusal.message });
}));

test('an accepted filing logs each lint warning; other tools and clean filings log nothing', () => scratch(async (root, base) => {
  process.env.CLANK_EDITION_STATE_ROOT = root;
  try {
    const result = { warnings: ['article.body opens two paragraphs on the same word'] };
    assert.equal(await withRefusalLog('file_article', async () => result)({ edition, event_key: 'w', article: { id: 'a', revision: 1 } }), result);
    await withRefusalLog('review_article', async () => ({ warnings: ['carried from the filing'] }))({ edition, event_key: 'w', article_id: 'a', revision: 1 });
    await withRefusalLog('file_article', async () => ({ warnings: [] }))({ edition, event_key: 'w2', article: { id: 'b', revision: 1 } });
  } finally { delete process.env.CLANK_EDITION_STATE_ROOT; }
  const { entries } = await readRefusals(base);
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.tool, entry.message]), [['warning', 'file_article', 'article.body opens two paragraphs on the same word']]);
}));

test('logging never changes the answer: no root, a bad edition or an unwritable log is swallowed', () => scratch(async (root) => {
  assert.equal(await appendRefusal({ root: undefined, edition, tool: 't', message: 'm' }), false);
  assert.equal(await appendRefusal({ root, edition: '../../etc', tool: 't', message: 'm' }), false);
  await mkdir(path.join(root, 'editions', edition, REFUSAL_LOG), { recursive: true });
  assert.equal(await appendRefusal({ root, edition, tool: 't', message: 'm' }), false);
  const failing = new Error('still the refusal');
  await assert.rejects(withRefusalLog('t', async () => { throw failing; })({ edition }), (error) => error === failing);
}));

test('the INDEX carries one count line, and none on a clean day', () => scratch(async (root, base) => {
  for (const [agent, tool, kind] of [['foreman', 'file_article', 'refused'], ['foreman', 'file_article', 'refused'], ['ledger', 'file_desk', 'refused'], ['vesta', 'file_article', 'warning']]) await appendRefusal({ root, edition, agent, tool, kind, message: 'x' });
  await writeFile(path.join(base, REFUSAL_LOG), `${await readFile(path.join(base, REFUSAL_LOG), 'utf8')}{torn line\n`);
  const lines = refusalIndexLine(await readRefusals(base));
  assert.deepEqual(lines, [`# refusals: refused=3 tools=file_article=2,file_desk=1 agents=foreman=2,ledger=1 warnings=1 unreadable=1 · cat ${REFUSAL_LOG}`]);
  assert.deepEqual(refusalIndexLine({ entries: [], unreadable: 0 }), []);
  const index = renderEditionIndex({ edition, generated: 'now', assignments: [], filings: [], verdicts: [], articles: [], desks: [], pages: [], refusals: lines });
  assert.match(index, /^# refusals: refused=3 /mu);
  // The INDEX build reads the log from the edition state itself.
  assert.match(await buildEditionIndex(root, edition, { knownTopics: new Set() }), /^# refusals: refused=3 tools=file_article=2,file_desk=1 /mu);
}));

test('the newsroom MCP server logs a refused call to the edition it names', () => scratch(async (root, base) => {
  const output = await new Promise((resolve, reject) => {
    const env = { ...process.env, CLANK_NEWSROOM_AGENT: 'graves', CLANK_EDITION_STATE_ROOT: root };
    delete env.CLANK_NEWSROOM_STATE_ADAPTER; delete env.DAIMON_WAKE_ID;
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'production-newsroom-mcp.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (chunk) => { out += chunk; }); child.on('error', reject); child.on('exit', () => resolve(out));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'record_dissent', arguments: { edition, event_key: 'wake-graves-1', article_id: 'x', revision: 1, stance: 'concur', argument: 'Nothing in the call crossed the line.' } } })}\n`);
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'compose_edition', arguments: { edition, event_key: 'wake-graves-1' } } })}\n`);
  });
  const replies = output.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(replies.every((reply) => reply.error), 'both calls are refused');
  const { entries } = await readRefusals(base);
  assert.deepEqual(entries.map((entry) => [entry.agent, entry.tool, entry.kind]), [['graves', 'record_dissent', 'refused'], ['graves', 'compose_edition', 'refused']]);
  assert.equal(entries[0].message, replies[0].error.message);
  assert.equal(entries[1].message, 'tool exceeds agent authority');
}));
