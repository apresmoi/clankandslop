import assert from 'node:assert/strict';
import test from 'node:test';
import { amendRecord, assertAmendment, assertLineup } from './assignment-lineup.mjs';

const owners = ['cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton'];
const lineup = (forecastAt = [1]) => owners.map((owner, index) => ({
  id: `story-${index}`, owner, brief: `BRIEF: the verified mechanism for story number ${index}.`, evidence_refs: [`https://source${index}.example/evidence`],
  ...(forecastAt.includes(index) ? { slot: 'forecast', dissenter: 'vesta' } : {})
}));

test('a lineup may run without a forecast, and never with two', () => {
  assert.equal(assertLineup(lineup([])), undefined);
  assert.equal(assertLineup(lineup([1])).id, 'story-1');
  assert.throws(() => assertLineup(lineup([1, 2])), /at most one assignment may carry slot "forecast", got 2/u);
  assert.throws(() => assertLineup(lineup([1]).map(({ dissenter, ...item }) => item)), /dissenter is required for the forecast slot/u);
  assert.throws(() => assertLineup(lineup([]).slice(0, 4)), /at least 5 items/u);
});

test('recasting the forecast replaces its brief and drops the slot, leaving the day valid without one', () => {
  const record = { version: 'clank.assignments.v1', edition: '2026-11-01', event_key: 'schedule:conference', assignments: lineup([1]), corpus: { commit: 'c' } };
  const brief = 'BRIEF: the Quad communique and who signed it, no probability.';
  const next = amendRecord(record, { article_id: 'story-1', change: 'recast', brief, event_key: 'wake-recast' });
  const recast = next.assignments.find(item => item.id === 'story-1');
  assert.deepEqual(recast, { id: 'story-1', owner: 'sprockett', brief, evidence_refs: ['https://source1.example/evidence'] });
  assert.equal(assertLineup(next.assignments), undefined);
  assert.deepEqual(next.corpus, record.corpus);
  assert.deepEqual(next.amendments, [{ article_id: 'story-1', change: 'recast', event_key: 'wake-recast', prior: record.assignments[1] }]);
  assert.equal(record.assignments[1].slot, 'forecast', 'the stored record is not mutated in place');
});

test('withdrawing drops exactly one piece, and an unknown id changes nothing', () => {
  const record = { assignments: lineup([1]) };
  const next = amendRecord(record, { article_id: 'story-3', change: 'withdraw', event_key: 'wake-withdraw' });
  assert.deepEqual(next.assignments.map(item => item.id), ['story-0', 'story-1', 'story-2', 'story-4']);
  assert.equal(amendRecord(record, { article_id: 'story-9', change: 'withdraw', event_key: 'wake-withdraw' }), undefined);
});

test('an amendment names one recorded piece and one change', () => {
  const base = { edition: '2026-11-01', event_key: 'wake-amend', article_id: 'story-1' };
  assert.doesNotThrow(() => assertAmendment({ ...base, change: 'recast', brief: 'BRIEF: what happened, sourced.' }));
  assert.doesNotThrow(() => assertAmendment({ ...base, change: 'withdraw' }));
  assert.throws(() => assertAmendment({ ...base, change: 'recast' }), /brief must be a string of at least 20/u);
  assert.throws(() => assertAmendment({ ...base, change: 'withdraw', brief: 'BRIEF: a brief nobody needs.' }), /withdraw carries no brief/u);
  assert.throws(() => assertAmendment({ ...base, change: 'promote' }), /change must be "recast"/u);
  assert.throws(() => assertAmendment({ ...base, change: 'withdraw', slot: 'forecast' }), /unexpected: \[slot\]/u);
});
