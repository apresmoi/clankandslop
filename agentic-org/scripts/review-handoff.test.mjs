import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { reviewArticle } from './production-newsroom.mjs';
import { buildEditionIndex } from './edition-index.mjs';
import { reviewNoticeInstruction } from './review-handoff.mjs';

const runtimeTest = (name, action) => test(name, { skip: !process.env.CLANK_NEWSROOM_STATE_ADAPTER && 'private newsroom state adapter required' }, action);
const edition = '2026-09-11';
const owners = ['Cogsworth', 'Sprockett', 'Foreman', 'Graves', 'Vesta', 'Tinkerton'];
const article = (index, section) => ({
  id: `story-${index}`, edition_date: edition, revision: index === 5 ? 4 : 1, section,
  headline: `Verified story ${index}`, deck: 'The source describes a concrete event.', kicker: 'Test',
  byline: { agents: [owners[index]], desk: 'Test Desk' }, epistemic: 'fact', timestamp: '20:54 UTC',
  topics: ['unclos'], body: ['The source records this event [E1].'], key_numbers: [], refs: ['E1'],
  evidence_box: [{ source: `Source ${index}`, fragment: 'A concrete event.', as_of: edition,
    source_note: { source_id: 'E1', source_kind: 'public_url', source_url: `https://source${index}.example/report`, used_by_agent: owners[index], retrieved_at: `${edition}T18:00:00Z` } }]
});
const hash = value => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
test('review handoffs use the shared readiness floors and name the accepted revision', () => {
  const articles = owners.map((_, index) => article(index, index === 5 ? 'Policy' : index % 2 ? 'World' : 'Business'));
  const args = { edition, article_id: 'story-5', revision: 4, verdict: 'PASS' };
  const desks = ['caslon.chrome', 'caslon.weather', 'ledger.settlements', 'ledger.worlddesk'];
  const ready = reviewNoticeInstruction(args, 'tinkerton', { articles, desks });
  assert.match(ready, /edition 2026-09-11, article story-5 revision 4/u);
  assert.match(ready, /moltnet_send.*room:release.*@caslon/u);
  assert.match(ready, /Verify.*succeeded.*before.*(?:ending|completing)/u);
  for (const inputs of [{ articles: articles.slice(0, 5), desks }, { articles, desks: desks.slice(0, 2) }, { articles, desks: [] }]) {
    assert.doesNotMatch(reviewNoticeInstruction(args, 'tinkerton', inputs), /@caslon/u);
  }
});
async function fixture({ section = 'Policy', ledger = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clank-review-ready-'));
  const base = path.join(root, 'editions', edition);
  const save = async (relative, value) => { const file = path.join(base, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); };
  for (let index = 0; index < 5; index++) await save(`articles/story-${index}.json`, article(index, index % 2 ? 'World' : 'Business'));
  for (const name of ['caslon.chrome', 'caslon.weather', ...(ledger ? ['ledger.settlements', 'ledger.worlddesk'] : [])]) await save(`desk/${name}.json`, {});
  const filing = { ...article(5, section), assignment_ref: { owner: 'tinkerton' } };
  await save('filings/story-5/4.json', filing);
  const previous = Object.fromEntries(['CLANK_EDITION_STATE_ROOT', 'CLANK_NEWSROOM_AGENT', 'CLANK_STATE_OFFLINE_FIXTURE', 'DAIMON_WAKE_ID'].map(key => [key, process.env[key]]));
  process.env.CLANK_EDITION_STATE_ROOT = root;
  process.env.CLANK_NEWSROOM_AGENT = 'spike';
  process.env.CLANK_STATE_OFFLINE_FIXTURE = '1';
  delete process.env.DAIMON_WAKE_ID;
  const args = { edition, event_key: 'review-third-section', article_id: filing.id, revision: filing.revision, filing_digest: hash(filing), verdict: 'PASS', notes: 'The exact revised filing passes the editorial review.' };
  return { root, base, save, args, cleanup: async () => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; await rm(root, { recursive: true, force: true }); } };
}

runtimeTest('the PASS that supplies the third section gives Spike the exact Caslon handoff', async () => {
  const f = await fixture();
  try {
    assert.match(await buildEditionIndex(f.root, edition), /sections=2\/3.*→ blocked/u);
    const result = await reviewArticle(f.args);
    assert.match(await readFile(path.join(f.base, 'INDEX'), 'utf8'), /passed=6\/5 desks=4\/4 sections=3\/3.*→ ready/u);
    assert.match(result.next, /edition 2026-09-11, article story-5 revision 4/u);
    assert.match(result.next, /no Moltnet message was sent/u);
    assert.match(result.next, /moltnet_send.*clank-newsroom.*room:release.*@caslon/u);
    assert.match(result.next, /fresh .*INDEX/u);
    assert.match(result.next, /Verify.*succeeded.*before.*(?:ending|completing)/u);
    assert.doesNotMatch(result.next, /@ledger/u);
    const operation = (await readdir(path.join(f.base, 'operations'))).find(name => name.startsWith('review_article-'));
    const saved = JSON.parse(await readFile(path.join(f.base, 'operations', operation), 'utf8'));
    assert.deepEqual(saved.result, result, 'handoff must be part of the durable accepted result');
  } finally { await f.cleanup(); }
});

runtimeTest('a PASS that still leaves two sections gives no composition handoff', async () => {
  const f = await fixture({ section: 'World' });
  try {
    const result = await reviewArticle(f.args);
    assert.match(await readFile(path.join(f.base, 'INDEX'), 'utf8'), /sections=2\/3.*→ blocked/u);
    assert.doesNotMatch(result.next, /@caslon/u);
    assert.match(result.next, /review other unreviewed filings one at a time/u);
  } finally { await f.cleanup(); }
});

runtimeTest('a PASS with missing Ledger documents retains the Ledger handoff', async () => {
  const f = await fixture({ ledger: false });
  try {
    const result = await reviewArticle(f.args);
    assert.match(await readFile(path.join(f.base, 'INDEX'), 'utf8'), /desks=2\/4.*→ blocked/u);
    assert.match(result.next, /@ledger/u);
    assert.doesNotMatch(result.next, /@caslon/u);
  } finally { await f.cleanup(); }
});

runtimeTest('an exact PASS retry retains its recorded handoff and creates no second acceptance', async () => {
  const f = await fixture();
  try {
    const result = await reviewArticle(f.args);
    const files = async () => Object.fromEntries(await Promise.all(['operations', 'receipts', 'verdicts/story-5'].map(async dir => [dir, await readdir(path.join(f.base, dir))])));
    const before = await files();
    const history = path.join(f.base, '.history.git');
    const head = () => execFileSync('git', ['--git-dir', history, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const beforeHead = head();
    await rm(path.join(f.base, 'desk/caslon.weather.json'));
    assert.deepEqual(await reviewArticle(f.args), result);
    assert.deepEqual(await files(), before);
    assert.equal(head(), beforeHead);
    assert.match(await readFile(path.join(f.base, 'INDEX'), 'utf8'), /desks=3\/4.*→ blocked/u);
  } finally { await f.cleanup(); }
});
