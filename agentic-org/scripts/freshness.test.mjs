import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFreshnessRecord, clockOf, freshnessStatus, recordFreshnessCheck, updateFor } from './freshness.mjs';

const corpusFetchedAt = '2026-10-07T10:00:00Z', now = new Date('2026-10-07T15:00:00Z');
const article = (revision = 1, over = {}) => ({ id: 'nigeria-crash', revision, byline: { agents: ['Sprockett'] }, ...over });
const record = (revision, outcome, facts = '13:42') => ({ article_id: 'nigeria-crash', revision, outcome, facts_checked_utc: facts });
const args = (over = {}) => ({ edition: '2026-10-07', event_key: 'wake-facts-1', article_id: 'nigeria-crash', revision: 1, outcome: 'unchanged', request_id: 'sprockett-2026-10-07-facts-nigeria', checked_at: '2026-10-07T13:42:10Z', ...over });

test('a PASSed piece with no facts check is refused, with the remedy', () => {
  const status = freshnessStatus(article(), []);
  assert.equal(status.ok, false);
  assert.match(status.problem, /no facts check recorded after its PASS.*record_freshness_check/u);
});

test('an unchanged or unavailable check covers exactly the revision it was recorded against', () => {
  assert.equal(freshnessStatus(article(1, { facts_checked_utc: '13:42' }), [record(1, 'unchanged')]).ok, true);
  assert.equal(freshnessStatus(article(1, { facts_checked_utc: '10:00' }), [record(1, 'unavailable', '10:00')]).ok, true);
  // A revision after the check needs its own: the check read the older copy.
  assert.match(freshnessStatus(article(2, { facts_checked_utc: '13:42' }), [record(1, 'unchanged')]).problem, /changed to revision 2 after its facts check on revision 1/u);
});

test('an updated check holds the piece until the revision carrying the development passes', () => {
  assert.match(freshnessStatus(article(1), [record(1, 'updated')]).problem, /revision 2 carrying it must be filed and passed/u);
  assert.equal(freshnessStatus(article(2, { facts_checked_utc: '13:42' }), [record(1, 'updated')]).ok, true);
  // A REVISION_REQUEST on the update keeps the same check: revision 3 is still covered.
  assert.equal(freshnessStatus(article(3, { facts_checked_utc: '13:42' }), [record(1, 'updated')]).ok, true);
  assert.equal(updateFor([record(1, 'updated')], 2).revision, 1);
  assert.equal(updateFor([record(1, 'unchanged')], 2), undefined);
  assert.equal(updateFor([record(2, 'updated')], 2), undefined);
});

test('the printed stamp must be the stamp the check recorded', () => {
  assert.match(freshnessStatus(article(1), [record(1, 'unchanged')]).problem, /carries facts_checked_utc null/u);
  assert.match(freshnessStatus(article(1, { facts_checked_utc: '09:00' }), [record(1, 'unchanged')]).problem, /stamped 13:42/u);
});

test('the record takes its stamp from the answer, or from the research time when there is none', () => {
  assert.equal(clockOf('2026-10-07T13:42:10Z'), '13:42');
  const checked = buildFreshnessRecord(args(), { agent: 'sprockett', article: article(), corpusFetchedAt, now });
  assert.equal(checked.facts_checked_utc, '13:42');
  assert.equal(checked.request_id, 'sprockett-2026-10-07-facts-nigeria');
  const unavailable = buildFreshnessRecord(args({ outcome: 'unavailable', checked_at: undefined }), { agent: 'sprockett', article: article(), corpusFetchedAt, now });
  assert.equal(unavailable.facts_checked_utc, '10:00');
  assert.equal(unavailable.checked_at, null);
  const updated = buildFreshnessRecord(args({ outcome: 'updated', changes: 'Air Force confirmed 25 dead at 07:14; supersedes E2 (32 aboard, casualties unconfirmed).' }), { agent: 'sprockett', article: article(), corpusFetchedAt, now });
  assert.match(updated.changes, /supersedes E2/u);
});

test('a check that did not happen after research froze, or names no request, is refused', () => {
  const build = (over, context = {}) => () => buildFreshnessRecord(args(over), { agent: 'sprockett', article: article(), corpusFetchedAt, now, ...context });
  assert.throws(build({ checked_at: '2026-10-07T09:59:00Z' }), /before the research time/u);
  assert.throws(build({ checked_at: '2026-10-07T18:00:00Z' }), /in the future/u);
  assert.throws(build({ checked_at: '13:42' }), /ISO UTC instant/u);
  assert.throws(build({ request_id: undefined }), /needs request_id/u);
  assert.throws(build({ request_id: 'has spaces' }), /request_id must be/u);
  assert.throws(build({ outcome: 'stale' }), /outcome must be one of/u);
  assert.throws(build({ outcome: 'updated' }), /needs changes/u);
  assert.throws(build({ changes: 'Nothing material changed today at all.' }), /changes belongs to outcome "updated" only/u);
  assert.throws(build({ outcome: 'unavailable' }), /carries no checked_at/u);
  assert.throws(build({ revision: 2 }), /passed at revision 1, not 2/u);
});

const io = (over = {}) => {
  const writes = [], stamps = [];
  return { writes, stamps, agent: 'sprockett', article: async () => article(), composed: async () => false, filed: async () => false, corpusFetchedAt: async () => corpusFetchedAt, now: () => now, write: async (...value) => writes.push(value), stamp: async (...value) => stamps.push(value), ready: async () => false, ...over };
};

test('only the owner records a check, Brass only "unavailable", and never before PASS or after composition', async () => {
  await assert.rejects(recordFreshnessCheck(args(), io({ agent: 'graves' })), /belongs to sprockett; only its owner/u);
  await assert.rejects(recordFreshnessCheck(args(), io({ agent: 'brass' })), /Brass may record only outcome "unavailable"/u);
  const fallback = io({ agent: 'brass' });
  assert.equal((await recordFreshnessCheck(args({ outcome: 'unavailable', checked_at: undefined, request_id: undefined }), fallback)).facts_checked_utc, '10:00');
  await assert.rejects(recordFreshnessCheck(args(), io({ article: async () => undefined })), /has no PASSed revision/u);
  await assert.rejects(recordFreshnessCheck(args(), io({ composed: async () => true })), /is composed/u);
  await assert.rejects(recordFreshnessCheck(args(), io({ filed: async () => true })), /revision 2 of "nigeria-crash" is already filed/u);
});

test('unchanged stamps the passed article; updated leaves it for the new revision; the last check hands off to Caslon', async () => {
  const quiet = io();
  const saved = await recordFreshnessCheck(args(), quiet);
  assert.equal(quiet.writes.length, 1);
  assert.equal(quiet.stamps[0][1].facts_checked_utc, '13:42');
  assert.match(saved.next, /Facts as of 13:42 UTC.*End the turn/u);
  assert.doesNotMatch(saved.next, /@caslon/u);
  const last = await recordFreshnessCheck(args(), io({ ready: async () => true }));
  assert.match(last.next, /room:release.*@caslon/u);
  const moved = io({ ready: async () => true });
  const update = await recordFreshnessCheck(args({ outcome: 'updated', changes: 'Air Force confirmed 25 dead at 07:14; supersedes E2.' }), moved);
  assert.equal(moved.stamps.length, 0);
  assert.match(update.next, /File revision 2 of "nigeria-crash" now.*@spike/u);
  assert.doesNotMatch(update.next, /@caslon/u);
});
