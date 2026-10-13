import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerHistory, ledgerSnapshot, missingLedgerRows } from './open-clocks.mjs';
import { deskDocumentFindings } from './desk-contract.mjs';

const call = 'The council does not pass the budget by 30 November 2026.';
const first = { date: '2026-10-14', articles: [{ id: 'budget', confidence: { label: call, value: 0.67, event_id: 'budget', negated: true } }] };

test('carry-forward preserves identity and affirmative orientation through settlement', () => {
  const history = ledgerHistory([first]);
  const [row] = missingLedgerRows(history, '2026-10-15', []);
  assert.equal(row.event_id, 'budget');
  assert.equal(row.negated, false);
  assert.equal(row.prior_p, 0.33);
  const carried = { date: '2026-10-15', settlements: [row] };
  const terminal = { ...row, outcome: 'hit', event_outcome: false };
  assert.deepEqual(deskDocumentFindings('ledger.settlements', { resolved_last_edition: [terminal] }, { profile: 'filing' }), []);
  const editions = [first, carried, { date: '2026-10-16', settlements: [terminal] }];
  assert.equal(ledgerSnapshot(editions, '2026-10-15').open, 1);
  assert.equal(ledgerSnapshot(editions, '2026-10-16').open, 0);
  const folded = ledgerHistory(editions);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].outcome, 'hit');
  assert.equal(folded[0].event_outcome, false);
  assert.deepEqual(folded[0].first_publication, { date: first.date, call, p: 0.67, negated: true });
});

test('canonical aliases settle the original explicit event even without row metadata', () => {
  const [entry] = ledgerHistory([first]);
  assert.ok(entry.aliases.includes(entry.call.toLowerCase()));
  const editions = [first, { date: '2026-10-16', settlements: [{ call: entry.call, prior_p: 0.33, outcome: 'hit', event_outcome: false }] }];
  const folded = ledgerHistory(editions);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].event_id, 'budget');
  assert.equal(folded[0].event_outcome, false);
  assert.equal(folded[0].outcome, 'hit');
});

test('explicit carried identities retain the opening relative deadline', () => {
  for (const label of ['The council passes the budget within 2D.', 'The council does not pass the budget within 2D.']) {
    const opened = { date: first.date, articles: [{ id: 'relative', confidence: { label, value: 0.67, event_id: 'relative' } }] };
    const history = ledgerHistory([opened]);
    const rows = missingLedgerRows(history, '2026-10-15', []);
    const [entry] = ledgerHistory([opened, { date: '2026-10-15', settlements: rows }]);
    assert.equal(entry.deadline, '2026-10-16');
    assert.equal(entry.event_id, 'relative');
    assert.equal(entry.prior_p, history[0].prior_p);
    assert.equal(entry.latest_p, history[0].latest_p);
  }
});
