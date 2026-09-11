import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileArticle, recordAssignment, reviewArticle } from './production-newsroom.mjs';

const stateAdapter = process.env.CLANK_NEWSROOM_STATE_ADAPTER;
const runtimeTest = (name, action) => test(name, { skip: (!stateAdapter || !existsSync(stateAdapter)) && 'CLANK_NEWSROOM_STATE_ADAPTER is required for transaction integration' }, action);
const edition = '2026-09-12';
const assignmentEvent = 'schedule:prose-review-gate';
const owners = ['cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton'];
const display = value => value[0].toUpperCase() + value.slice(1);
const hash = value => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const names = async directory => (await readdir(directory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))).sort();

function article({ revision = 1, leaky = false } = {}) {
  return {
    id: 'story-0',
    edition_date: edition,
    section: 'world',
    kicker: 'Test',
    headline: 'A verified story',
    deck: 'A complete sourced test deck.',
    epistemic: 'fact',
    byline: { desk: 'Test Desk', agents: ['Cogsworth'] },
    timestamp: '12:00 UTC',
    revision,
    next_update_utc: '14:30',
    topics: ['unclos'],
    body: [
      leaky ? 'The same sensor answer describes the operating fact [E1].' : 'The ministry describes the operating fact [E1].',
      'Officials confirm the second step [E1].',
      'The record leaves the timing open [E1].',
      'The next update depends on the published order [E1].'
    ],
    key_numbers: [],
    evidence_box: [{
      source: 'Official record',
      fragment: 'fact',
      as_of: edition,
      source_note: { source_id: 'E1', source_kind: 'public_url', used_by_agent: 'Cogsworth', source_url: 'https://source0.example/evidence', retrieved_at: `${edition}T10:00:00Z` }
    }],
    refs: ['E1']
  };
}

async function saveJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value)}\n`);
}

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-prose-review-'));
  const root = path.join(temporary, 'state');
  const base = path.join(root, 'editions', edition);
  const previous = Object.fromEntries(['CLANK_EDITION_STATE_ROOT', 'CLANK_NEWSROOM_AGENT', 'CLANK_NEWSROOM_STATE_ADAPTER', 'CLANK_STATE_OFFLINE_FIXTURE', 'DAIMON_WAKE_ID'].map(key => [key, process.env[key]]));
  process.env.CLANK_EDITION_STATE_ROOT = root;
  process.env.CLANK_NEWSROOM_STATE_ADAPTER = stateAdapter;
  process.env.CLANK_STATE_OFFLINE_FIXTURE = '1';
  delete process.env.DAIMON_WAKE_ID;
  process.env.CLANK_NEWSROOM_AGENT = 'brass';
  await recordAssignment({
    edition,
    event_key: assignmentEvent,
    assignments: owners.map((owner, index) => ({ id: `story-${index}`, owner, brief: `Report the verified mechanism for story number ${index}.`, evidence_refs: ['https://source0.example/evidence'], ...(index === 1 ? { slot: 'forecast', dissenter: 'vesta' } : {}) }))
  });
  const leaky = { ...article({ leaky: true }), assignment_ref: { event_key: assignmentEvent, id: 'story-0', owner: 'cogsworth' } };
  await saveJson(path.join(base, 'filings/story-0/1.json'), leaky);
  process.env.CLANK_NEWSROOM_AGENT = 'spike';
  return {
    root,
    base,
    leaky,
    cleanup: async () => {
      for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      await rm(temporary, { recursive: true, force: true });
    }
  };
}

runtimeTest('Spike cannot PASS a saved prose leak but can request revision and pass the owner correction', async () => {
  const f = await fixture();
  try {
    const history = path.join(f.base, '.history.git');
    const head = () => execFileSync('git', ['--git-dir', history, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const before = {
      head: head(),
      operations: await names(path.join(f.base, 'operations')),
      verdicts: await names(path.join(f.base, 'verdicts/story-0')),
      articles: await names(path.join(f.base, 'articles')),
      reviews: await names(path.join(f.base, 'reviews'))
    };
    const pass = { edition, event_key: 'pass-leaky-prose', article_id: 'story-0', revision: 1, filing_digest: hash(f.leaky), verdict: 'PASS', notes: 'Sources and voice pass.' };
    await assert.rejects(reviewArticle(pass), /PASS refused.*REVISION_REQUEST.*notify the owner.*do not rewrite.*article\.body\[0\] \[prose_leak\]/su);
    assert.deepEqual({
      head: head(),
      operations: await names(path.join(f.base, 'operations')),
      verdicts: await names(path.join(f.base, 'verdicts/story-0')),
      articles: await names(path.join(f.base, 'articles')),
      reviews: await names(path.join(f.base, 'reviews'))
    }, before);

    const sentBack = await reviewArticle({ ...pass, event_key: 'send-back-leaky-prose', verdict: 'REVISION_REQUEST', notes: 'Remove the internal sensor wording and file a clean revision.' });
    assert.equal(sentBack.verdict, 'REVISION_REQUEST');

    process.env.CLANK_NEWSROOM_AGENT = 'cogsworth';
    const corrected = await fileArticle({ edition, event_key: 'owner-corrects-prose', article: article({ revision: 2 }) });
    assert.equal(corrected.revision, 2);

    process.env.CLANK_NEWSROOM_AGENT = 'spike';
    const cleanFiling = JSON.parse(await readFile(path.join(f.base, 'filings/story-0/2.json'), 'utf8'));
    const cleanPass = { edition, event_key: 'pass-clean-prose', article_id: 'story-0', revision: 2, filing_digest: hash(cleanFiling), verdict: 'PASS', notes: 'Sources and voice pass.' };
    const passed = await reviewArticle(cleanPass);
    assert.equal(passed.verdict, 'PASS');
    const published = JSON.parse(await readFile(path.join(f.base, 'articles/story-0.json'), 'utf8'));
    const { assignment_ref: _, lint: __, ...expected } = cleanFiling;
    assert.deepEqual(published, expected);
    assert.deepEqual(await reviewArticle(cleanPass), passed);
  } finally {
    await f.cleanup();
  }
});
