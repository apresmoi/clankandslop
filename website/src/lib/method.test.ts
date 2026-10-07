import test from 'node:test';
import assert from 'node:assert/strict';
import { happened, methodRecord, methodRecordFrom } from './method.ts';
import { trackRecord, type LedgerEdition } from './track-record.ts';

const settle = (call: string, outcome: 'hit' | 'miss' | 'open' | 'cancelled', prior_p: number, note?: string) => ({ call, outcome, prior_p, ...(note ? { note } : {}) });
const A = 'Brent settles above $95 a barrel by 24 July';
const B = 'Hormuz transits recover above 60 a day by 16 July';
const C = 'Parliament confirms a new prime minister by 20 July';
const D = 'The council votes on the budget by 1 October';
const E = 'The court rules on the appeal by 9 December';
const editions: LedgerEdition[] = [
  { date: '2026-07-10', settlements: { resolved_last_edition: [] }, articles: [] },
  { date: '2026-07-25', settlements: { resolved_last_edition: [settle(A, 'miss', 0.38), settle(B, 'hit', 0.08), settle(C, 'hit', 0.7)] }, articles: [] },
  { date: '2026-09-30', settlements: { resolved_last_edition: [settle(D, 'open', 0.62)] }, articles: [] },
  { date: '2026-10-03', settlements: { resolved_last_edition: [settle(D, 'open', 0.62, 'Checked the council minutes and the corpus; no vote recorded yet.'), settle(E, 'open', 0.55)] }, articles: [] },
];

test('a NO call that hits is an event that did not happen', () => {
  assert.equal(happened({ prior_p: 0.08, outcome: 'hit' }), false);
  assert.equal(happened({ prior_p: 0.38, outcome: 'miss' }), true);
  assert.equal(happened({ prior_p: 0.7, outcome: 'hit' }), true);
  assert.equal(happened({ prior_p: 0.5, outcome: 'miss' }), false);
});

test('Brier, the coin flip, the base rate and the bins, by hand', () => {
  const r = methodRecordFrom(editions, '2026-10-04');
  // A: p .38, happened → (0.62)² = .3844; B: p .08, not → .0064; C: p .7, happened → .09.
  assert.equal(r.brier, Math.round(((0.3844 + 0.0064 + 0.09) / 3) * 1000) / 1000);
  assert.equal(r.coin_brier, 0.25);
  assert.equal(r.base_rate, 0.667);
  assert.equal(r.base_rate_brier, Math.round((2 / 3) * (1 / 3) * 1000) / 1000);
  assert.deepEqual([r.settled, r.hit, r.miss], [3, 2, 1]);
  // Confidence in the call: A .62 (miss), B .92 (hit), C .70 (hit) — 0.7 sits in 0.7–0.8.
  assert.deepEqual(r.calibration.map((b) => [b.label, b.n, b.stated, b.hit_rate]), [['0.6–0.7', 1, 0.62, 0], ['0.7–0.8', 1, 0.7, 1], ['0.9–1.0', 1, 0.92, 1]]);
});

test('open calls split into not yet due and due, as the Tape sees them', () => {
  const r = methodRecordFrom(editions, '2026-10-04');
  assert.deepEqual([r.pending, r.due], [1, 1]);
});

test('the published archive agrees with the Track Record', () => {
  const r = methodRecord('2026-10-07');
  const { record } = trackRecord('2026-10-07');
  assert.deepEqual([r.hit, r.miss], [record.hit, record.miss]);
  assert.equal(r.calibration.reduce((n, b) => n + b.n, 0), r.settled);
  assert.ok(r.brier !== null && r.brier > 0 && r.brier < 1);
});
