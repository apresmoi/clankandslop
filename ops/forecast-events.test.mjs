import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastEvent } from './forecast-events.mjs';
import { ledgerHistory, ledgerSnapshot } from './open-clocks.mjs';
import { deskDocumentFindings } from './desk-contract.mjs';

const YES = 'Yes if a named outlet reports 300,000 tonnes loaded by 16:00 UTC on 16 October 2026; no if no such report is posted.';
const NO = 'Yes if no named outlet reports 300,000 tonnes loaded by 16:00 UTC on 16 October 2026; no if such a report is posted.';
const article = (id, label, value, extra = {}) => ({ id, confidence: { label, value, ...extra } });

test('complementary calls share identity, preserve the first publication and score it', () => {
  const editions = [
    { date: '2026-10-11', articles: [article('first', YES, 0.42)] },
    { date: '2026-10-13', articles: [article('update', NO, 0.67)] },
    { date: '2026-10-17', settlements: [{ call: NO, prior_p: 0.67, outcome: 'miss', event_outcome: true }] },
  ];
  const open = ledgerSnapshot(editions, '2026-10-13');
  assert.equal(open.open, 1);
  assert.equal(open.rows[0].update, '42% → 33%');
  const [entry] = ledgerHistory(editions);
  assert.equal(entry.prior_p, 0.42);
  assert.equal(entry.latest_p, 0.33);
  assert.equal(entry.first_publication.p, 0.42);
  assert.equal(entry.event_outcome, false);
  assert.equal(entry.outcome, 'hit');
  assert.equal(forecastEvent(YES, '2026-10-11').event_id, forecastEvent(NO, '2026-10-13').event_id);
  assert.notEqual(forecastEvent(YES.replace('300,000', '400,000'), '2026-10-11').event_id, entry.event_id);
  assert.notEqual(forecastEvent(YES.replace('16 October', '17 October'), '2026-10-11').event_id, entry.event_id);
});

test('explicit identity links paraphrases; repeats of relative horizons retain the opening deadline', () => {
  const editions = [{ date: '2026-10-11', articles: [article('first', YES, 0.42, { event_id: 'event-a' })] }, { date: '2026-10-13', articles: [article('update', 'No loading report before the stated deadline', 0.67, { event_id: 'event-a', negated: true })] }];
  assert.equal(ledgerHistory(editions).length, 1);
  const relative = [{ date: '2026-10-11', articles: [article('r', 'Council passes the budget within two days', 0.4)] }, { date: '2026-10-12', settlements: [{ call: 'Council passes the budget within two days', prior_p: 0.4, outcome: 'open' }] }];
  assert.equal(ledgerHistory(relative).length, 1);
});

test('new settlement filings must supply the observed event, independent of authored hit/miss', () => {
  assert.ok(deskDocumentFindings('ledger.settlements', { resolved_last_edition: [{ call: YES, prior_p: 0.28, outcome: 'miss' }] }, { profile: 'filing' }).some(f => f.includes('event_outcome')));
  assert.deepEqual(deskDocumentFindings('ledger.settlements', { resolved_last_edition: [{ call: YES, prior_p: 0.28, outcome: 'miss', event_outcome: false }] }, { profile: 'filing' }), []);
});

const POSITIVE = 'The council passes the budget by 30 November 2026.';
const NEGATIVE = 'The council does not pass the budget by 30 November 2026.';

test('first-publication dissent follows the same event orientation as the main probability', () => {
  for (const label of [NO, NEGATIVE]) for (const extra of [{}, { negated: true }]) {
    const first = { ...article('first', label, 0.67, extra), dissent: { agent: 'Tinkerton', p: 0.2 } };
    const editions = [{ date: '2026-10-14', articles: [first] }];
    const [row] = ledgerSnapshot(editions, '2026-10-14').rows;
    assert.equal(row.p, 0.33);
    assert.deepEqual(row.dissent, { agents: ['Tinkerton'], p: 0.8 });
    assert.equal(ledgerHistory(editions)[0].first_publication.p, 0.67);
    assert.equal(first.dissent.p, 0.2, 'The published source remains immutable');
    for (const p of [0, 1]) {
      first.dissent.p = p;
      assert.equal(ledgerSnapshot(editions, '2026-10-14').rows[0].dissent.p, 1 - p);
    }
  }
  const first = { ...article('first', YES, 0.67), dissent: { agent: 'Tinkerton', p: 0.2 } };
  const [row] = ledgerSnapshot([{ date: '2026-10-14', articles: [first] }], '2026-10-14').rows;
  assert.equal(row.p, 0.67);
  assert.equal(row.dissent.p, 0.2);
});

test('verbal negation shares the affirmative event and always displays its orientation', () => {
  for (const negative of [NEGATIVE, NEGATIVE.replace('does not', "doesn't")]) {
    assert.equal(forecastEvent(POSITIVE, '2026-10-14').event_id, forecastEvent(negative, '2026-10-16').event_id);
    for (const extra of [{}, { negated: true }]) {
      const editions = [{ date: '2026-10-14', articles: [article('first', POSITIVE, 0.42)] }, { date: '2026-10-16', articles: [article('update', negative, 0.67, extra)] }];
      const snapshot = ledgerSnapshot(editions, '2026-10-16');
      assert.equal(snapshot.open, 1);
      assert.equal(snapshot.rows[0].update, '42% → 33%');
      const [firstNegative] = ledgerSnapshot([{ date: '2026-10-14', articles: [article('first', negative, 0.67, extra)] }], '2026-10-14').rows;
      assert.match(firstNegative.question, /The council passes the budget/);
      assert.doesNotMatch(firstNegative.question, /does not pass|doesn't pass/);
      assert.equal(firstNegative.call, 'NO');
      assert.equal(firstNegative.p, 0.33);
    }
  }
});

test('subordinate negative conditions do not complement an affirmative report event', () => {
  const call = 'Yes if a named outlet reports that the council does not pass the budget by 30 November 2026; no otherwise.';
  assert.equal(forecastEvent(call, '2026-10-14').negated, false);
  const [row] = ledgerSnapshot([{ date: '2026-10-14', articles: [article('a', call, 0.67)] }], '2026-10-14').rows;
  assert.equal(row.question, call);
  assert.equal(row.p, 0.67);
});

test('explicit polarity for unknown grammar complements the whole displayed condition', () => {
  const event = forecastEvent('No loading report before the stated deadline', '2026-10-14', { negated: true });
  assert.match(event.call, /Yes if loading report/);
  assert.throws(() => forecastEvent(NEGATIVE, '2026-10-14', { negated: false }), /conflicts/);
  assert.match(forecastEvent('Without a loading report', '2026-10-14', { negated: true }).call, /condition is false: “Without a loading report”/);
});
