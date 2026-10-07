// Every room a tool tells an agent to post in is a room that agent can write.
//
// All six rooms are private with `write_policy: members`. On 2026-10-07 the
// facts-check tool told every writer to hand the edition to Caslon in
// room:release, where no writer is a member: the send is refused and the
// edition stalls. This test parses the org Spawnfile and runs the real
// instruction text, per addressed agent, against its memberships.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ESCALATION_ROOM, escalationRoom } from './agent-rooms.mjs';
import { recordFreshnessCheck } from './freshness.mjs';
import { ledgerFilingNext } from './ledger-research.mjs';
import { compositionNoticeInstruction, filingNoticeInstruction } from './production-newsroom.mjs';
import { reviewNoticeInstruction } from './review-handoff.mjs';

const WRITERS = ['cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton', 'vesta'];
const AGENTS = ['klaxon', ...WRITERS, 'brass', 'spike', 'ledger', 'caslon', 'pressman'];

/** room id -> Set of members, from the org Spawnfile's room declarations. */
export function orgRooms(source = readFileSync(path.join(import.meta.dirname, '..', 'Spawnfile'), 'utf8')) {
  const rooms = new Map();
  for (const match of source.matchAll(/- \{ id: ([a-z-]+), visibility: private, write_policy: members, [^}]*members: \[([^\]]+)\] \}/gu)) rooms.set(match[1], new Set(match[2].split(',').map((item) => item.trim())));
  return rooms;
}
const ROOMS = orgRooms();
const writable = (agent, room) => ROOMS.get(room)?.has(agent) === true;

/**
 * The rooms `text` tells `agent` to post in, as [{ room, by }]. A request the
 * agent relays for someone else ("send this exact text with moltnet_send to
 * room:research") is posted by the colleague it mentions, not by `agent`.
 */
function postings(agent, text) {
  const out = [];
  const relay = /send this exact text with moltnet_send to room:([a-z-]+)/gu;
  const relayed = new Set();
  for (const match of text.matchAll(relay)) relayed.add(match.index + match[0].length - match[1].length - 'room:'.length);
  const mentioned = [...text.matchAll(/@([a-z]+)/gu)].map((match) => match[1]).filter((name) => AGENTS.includes(name) && name !== agent);
  for (const match of text.matchAll(/room:([a-z-]+)/gu)) out.push({ room: match[1], by: relayed.has(match.index) ? mentioned : [agent] });
  return out;
}
function assertWritable(agent, text, where) {
  for (const { room, by } of postings(agent, text)) {
    assert.ok(ROOMS.has(room), `${where} names room:${room}, which the org Spawnfile does not declare`);
    assert.ok(by.length > 0 && by.every((who) => writable(who, room)), `${where} tells ${by.join('/') || agent} to post in room:${room}, but ${by.filter((who) => !writable(who, room)).join(', ') || agent} is not a member: ${text.slice(0, 200)}`);
  }
}

test('the org Spawnfile declares the six rooms this test reads', () => {
  assert.deepEqual([...ROOMS.keys()].sort(), ['assignment', 'conference', 'filing', 'release', 'research', 'sensor']);
  // The P0 itself: no writer can write room:release.
  for (const writer of WRITERS) assert.equal(writable(writer, 'release'), false, `${writer} unexpectedly writes room:release`);
});

test('each agent escalates in a room it can write', () => {
  assert.deepEqual(Object.keys(ESCALATION_ROOM).sort(), [...AGENTS].sort());
  for (const agent of AGENTS) assert.ok(writable(agent, ESCALATION_ROOM[agent]), `${agent} escalates in room:${ESCALATION_ROOM[agent]} but is not a member`);
  // And Caslon, who acts on most of those escalations, hears them there.
  for (const agent of [...WRITERS, 'brass', 'ledger', 'pressman', 'spike']) assert.ok(writable('caslon', ESCALATION_ROOM[agent]), `caslon cannot read room:${ESCALATION_ROOM[agent]}`);
});

function toolsList(role) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'production-newsroom-mcp.mjs')], { env: { ...process.env, CLANK_NEWSROOM_AGENT: role }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', reject);
    child.on('exit', () => resolve(out.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((line) => line.id === 1)?.result?.tools ?? []));
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`);
  });
}
const descriptions = (value, out = []) => { if (Array.isArray(value)) value.forEach((item) => descriptions(item, out)); else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { if (key === 'description' && typeof item === 'string') out.push(item); else descriptions(item, out); } return out; };

test('every tool description names only rooms its agent can write', async () => {
  for (const agent of AGENTS) {
    const tools = await toolsList(agent);
    assert.ok(tools.length > 0, `${agent} lists no tools`);
    for (const tool of tools) for (const text of descriptions(tool)) assertWritable(agent, text, `${agent}'s ${tool.name} description`);
  }
});

test('every tool result that names a room names one its addressee can write', async () => {
  const edition = '2026-10-07';
  // Spike: every verdict, and every PASS branch.
  const articles = WRITERS.map((owner, index) => ({ id: `s${index}`, revision: 1, section: ['World', 'Business', 'Policy'][index % 3], byline: { agents: [owner] }, evidence_box: [{ source_note: { source_url: `https://s${index}.example/a` } }] }));
  const desks = ['caslon.chrome', 'caslon.weather', 'ledger.settlements', 'ledger.worlddesk'];
  for (const verdict of ['REVISION_REQUEST', 'HOLD', 'SPIKE']) assertWritable('spike', reviewNoticeInstruction({ edition, article_id: 's1', revision: 1, verdict }, 'sprockett'), `review ${verdict}`);
  for (const inputs of [{ articles, desks }, { articles, desks, fresh: false, article: articles[1] }, { articles, desks, problems: ['held'], fresh: false }, { articles: articles.slice(0, 1), desks: [], fresh: false }]) assertWritable('spike', reviewNoticeInstruction({ edition, article_id: 's1', revision: 1, verdict: 'PASS' }, 'sprockett', inputs), 'review PASS');
  // Writers and Brass: every facts-check result and refusal.
  for (const agent of [...WRITERS, 'brass']) {
    const owner = agent === 'brass' ? 'graves' : agent;
    const article = { id: 'piece', revision: 1, byline: { agents: [owner[0].toUpperCase() + owner.slice(1)] } };
    const io = (over = {}) => ({ agent, article: async () => article, records: async () => [{ revision: 1, outcome: 'updated' }], composed: async () => false, corpusFetchedAt: async () => '2026-10-07T10:00:00Z', now: () => new Date('2026-10-07T15:00:00Z'), write: async () => {}, stamp: async () => {}, ready: async () => true, ...over });
    const args = (outcome) => ({ edition, event_key: 'wake-1', article_id: 'piece', revision: 1, outcome, request_id: `${owner}-${edition}-facts-piece`, ...(outcome === 'unavailable' ? {} : { checked_at: '2026-10-07T13:00:00Z' }), ...(outcome === 'updated' ? { changes: 'A dated development that moved the count.' } : {}) });
    for (const outcome of agent === 'brass' ? ['unavailable'] : ['unavailable', 'updated']) assertWritable(agent, (await recordFreshnessCheck(args(outcome), io())).next, `${agent} record_freshness_check ${outcome}`);
    await assert.rejects(recordFreshnessCheck(args('unavailable'), io({ composed: async () => true })), (error) => { assertWritable(agent, error.message, `${agent} refusal after compose`); return true; });
    await assert.rejects(recordFreshnessCheck({ ...args('unavailable'), request_id: undefined }, io()), (error) => { assertWritable(agent, error.message, `${agent} missing request refusal`); return true; });
  }
  for (const writer of WRITERS) { assertWritable(writer, filingNoticeInstruction(edition, 'piece', 1), `${writer} filing notice`); assertWritable(writer, filingNoticeInstruction(edition, 'piece', 1, 'vesta'), `${writer} forecast filing notice`); }
  assertWritable('caslon', compositionNoticeInstruction(edition, 'sha256:0'), 'composition notice');
  assertWritable('ledger', ledgerFilingNext(edition, [{ call: 'A call that came due', deadline: '2026-10-06' }]), 'ledger filing next');
  // The escalation tail every corpus refusal ends with.
  for (const agent of AGENTS) assertWritable(agent, `say so in ${escalationRoom(agent)}`, `${agent} corpus refusal`);
});

test('fixed refusal and result strings in single-role modules name rooms their role can write', () => {
  for (const [file, agent] of [['worlddesk-filing.mjs', 'ledger'], ['signal-disposition.mjs', 'klaxon'], ['ledger-research.mjs', 'ledger']]) {
    const source = readFileSync(path.join(import.meta.dirname, file), 'utf8').split('\n').filter((line) => !/^\s*(?:\/\/|\*)/u.test(line)).join('\n');
    assertWritable(agent, source, file);
  }
});
