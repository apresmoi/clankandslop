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
  assert.deepEqual(view.items, [{ call: IEA, outcome: 'open', prior_p: 0.62 }]);
});

test('a call leaves the open list the bell it settles, and joins the record', () => {
  const settled = [...editions, { date: '2026-10-06', settlements: { resolved_last_edition: [{ call: IEA, outcome: 'hit' as const, prior_p: 0.62 }] }, articles: [] }];
  assert.deepEqual(trackRecordFrom(settled, '2026-10-06'), { items: [{ call: IEA, outcome: 'hit', prior_p: 0.62 }], record: { hit: 1, miss: 0 } });
  assert.deepEqual(trackRecordFrom(settled, '2026-10-07').items, []);
  assert.deepEqual(trackRecordFrom(settled, '2026-10-07').record, { hit: 1, miss: 0 });
});

test('the published 5 October tape no longer says the ledger opens today', () => {
  const view = trackRecord('2026-10-05');
  assert.ok(view.items.some((row) => row.outcome === 'open' && row.call.startsWith('YES if the IEA')), 'the IEA call must still be open on 5 October');
  assert.ok(view.record.hit + view.record.miss > 0, 'the paper has settled calls before; the record is not empty');
});
