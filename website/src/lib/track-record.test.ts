import test from 'node:test';
import assert from 'node:assert/strict';
import { trackRecord, trackRecordFrom, type LedgerEdition } from './track-record.ts';

const IEA = 'YES if the IEA posts a 100 million barrel schedule by 16:00 UTC on 6 October 2026; otherwise NO.';
const article = (id: string, label: string, value: number) => ({ id, byline: { agents: ['Foreman'] }, confidence: { label, value } });
// Two editions: the call is published on 3 October, carried open by Ledger on
// 4 October, and 5 October's settlement file is empty.
const editions: LedgerEdition[] = [
  { date: '2026-10-03', settlements: { resolved_last_edition: [] }, articles: [article('s-1', IEA, 0.62)] },
  { date: '2026-10-04', settlements: { resolved_last_edition: [{ call: IEA, outcome: 'open', prior_p: 0.62 }] }, articles: [] },
  { date: '2026-10-05', settlements: { resolved_last_edition: [] }, articles: [] },
];

test('an open call stays on the Track Record after the edition that carried it', () => {
  const view = trackRecordFrom(editions, '2026-10-05');
  assert.deepEqual(view.items, [{ call: IEA, outcome: 'open', prior_p: 0.62, state: 'pending', state_label: 'not yet due', deadline: '6 Oct' }]);
});

test('a call leaves the open list the bell it settles, and joins the record', () => {
  const settled = [...editions, { date: '2026-10-06', settlements: { resolved_last_edition: [{ call: IEA, outcome: 'hit' as const, prior_p: 0.62 }] }, articles: [] }];
  assert.deepEqual(trackRecordFrom(settled, '2026-10-06'), { items: [{ call: IEA, outcome: 'hit', prior_p: 0.62, state: 'hit', state_label: 'settled hit', deadline: '6 Oct' }], record: { hit: 1, miss: 0 } });
  assert.deepEqual(trackRecordFrom(settled, '2026-10-07').items, []);
  assert.deepEqual(trackRecordFrom(settled, '2026-10-07').record, { hit: 1, miss: 0 });
});

test('the published 5 October tape no longer says the ledger opens today', () => {
  const view = trackRecord('2026-10-05');
  assert.ok(view.items.some((row) => row.outcome === 'open' && row.call.startsWith('YES if the IEA')), 'the IEA call must still be open on 5 October');
  assert.ok(view.record.hit + view.record.miss > 0, 'the paper has settled calls before; the record is not empty');
});

test('a due call shows Ledger\'s note; a cancelled call shows its reason and scores neither way', () => {
  const NOTE = 'Checked the corpus and asked Brass for the IEA page; no schedule posted by 16:00 UTC.';
  const due = [...editions, { date: '2026-10-07', settlements: { resolved_last_edition: [{ call: IEA, outcome: 'open' as const, prior_p: 0.62, note: NOTE }] }, articles: [] }];
  assert.deepEqual(trackRecordFrom(due, '2026-10-07').items, [{ call: IEA, outcome: 'open', prior_p: 0.62, state: 'due', state_label: 'due — awaiting verification', deadline: '6 Oct', note: NOTE, noted: '7 Oct' }]);
  const cancelled = [...due, { date: '2026-10-08', settlements: { resolved_last_edition: [{ call: IEA, outcome: 'cancelled' as const, prior_p: 0.62, note: 'The IEA withdrew the coordinated release before the deadline.' }] }, articles: [] }];
  const view = trackRecordFrom(cancelled, '2026-10-08');
  assert.deepEqual(view.items.map((i) => [i.state, i.note]), [['cancelled', 'The IEA withdrew the coordinated release before the deadline.']]);
  assert.deepEqual(view.record, { hit: 0, miss: 0 });
});
