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
import { PASSED_ARTICLES_MINIMUM, DESK_DOCUMENTS_REQUIRED } from '../../ops/edition-floor.mjs';

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
test('a PASS hands the owner the exact facts request and does not wait on it for the Caslon handoff', () => {
  const articles = owners.map((_, index) => article(index, index === 5 ? 'Policy' : index % 2 ? 'World' : 'Business'));
  const args = { edition, article_id: 'story-5', revision: 4, verdict: 'PASS' };
  const desks = ['caslon.chrome', 'caslon.weather', 'ledger.settlements', 'ledger.worlddesk'];
  // No check yet is not a blocking problem: Spike asks for it AND hands off to Caslon.
  const unchecked = reviewNoticeInstruction(args, 'tinkerton', { articles, desks, problems: [], fresh: false, article: articles[5] });
  assert.match(unchecked, /room:filing.*article story-5 revision 4, mention @tinkerton.*send this exact text with moltnet_send to room:research/u);
  const request = JSON.parse(unchecked.match(/\{"kind":"research\.request\.v1".*?\}(?= )/u)[0]);
  assert.equal(request.request_id, `tinkerton-${edition}-facts-story-5`);
  assert.equal(request.from, 'tinkerton');
  assert.match(request.question, /Verified story 5/u);
  assert.match(unchecked, /room:release now.*@caslon/u);
  // A recorded development holds the edition, and its own revision or record hands off.
  const pending = reviewNoticeInstruction(args, 'tinkerton', { articles, desks, problems: ['"story-2": its owner recorded a material development'], fresh: false, article: articles[5] });
  assert.match(pending, /waits only on recorded developments \(1\).*do not mention @caslon/u);
  assert.doesNotMatch(pending, /target room:release/u);
  const early = reviewNoticeInstruction(args, 'tinkerton', { articles: articles.slice(0, 2), desks, problems: [], fresh: false });
  assert.match(early, new RegExp(`mention @tinkerton.*room:research.*passed>=${PASSED_ARTICLES_MINIMUM} .*@ledger`, 'u'));
  const checked = reviewNoticeInstruction(args, 'tinkerton', { articles, desks, problems: [], fresh: true });
  assert.match(checked, /room:release now.*@caslon/u);
  assert.doesNotMatch(checked, /room:research/u);
});
test('a spiked piece goes to Brass in room:assignment, a room Spike can write, without promising a replacement', () => {
  const spiked = reviewNoticeInstruction({ edition, article_id: 'story-1', revision: 2, verdict: 'SPIKE' }, 'sprockett');
  assert.match(spiked, /target room:filing.*@sprockett.*@brass in room:assignment/u);
  assert.doesNotMatch(spiked, /replacement/u);
});
async function fixture({ section = 'Policy', ledger = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clank-review-ready-'));
  const base = path.join(root, 'editions', edition);
  const save = async (relative, value) => { const file = path.join(base, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); };
  // Every other piece carries its owner's facts check, and story-5 revision 4
  // is the revision that carried a recorded development, so the PASS under
  // test is the one that completes the edition.
  const check = (revision, outcome) => ({ version: 'clank.freshness-check.v1', revision, outcome, facts_checked_utc: '13:42' });
  for (let index = 0; index < 5; index++) { await save(`articles/story-${index}.json`, { ...article(index, index % 2 ? 'World' : 'Business'), facts_checked_utc: '13:42' }); await save(`freshness/story-${index}/1.json`, check(1, 'unchanged')); }
  await save('freshness/story-5/3.json', check(3, 'updated'));
  for (const name of ['caslon.chrome', 'caslon.weather', ...(ledger ? ['ledger.settlements', 'ledger.worlddesk'] : [])]) await save(`desk/${name}.json`, {});
  const filing = { ...article(5, section), facts_checked_utc: '13:42', assignment_ref: { owner: 'tinkerton' } };
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
    // The REQUIRED side is derived, never spelled. This line read `passed=6/5`
    // and went red the moment 10ddd3e lowered the floor to four, invisibly:
    // public CI skips this whole family for want of the private state adapter,
    // so it has been failing since then with nothing to say so. The FOUND side
    // stays literal -- six passes and three sections are what this fixture
    // builds, and that is the thing under test.
    assert.match(await readFile(path.join(f.base, 'INDEX'), 'utf8'),
      new RegExp(`passed=6/${PASSED_ARTICLES_MINIMUM} desks=4/${DESK_DOCUMENTS_REQUIRED} sections=3/3.*→ ready`, 'u'));
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
