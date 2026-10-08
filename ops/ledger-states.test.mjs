import test from 'node:test';
import assert from 'node:assert/strict';
import { CALL_STATES, callDeadline, callState, hasNote } from './ledger-states.mjs';

test('the deadline is read off the call wording: latest date, missing year, hours and days', () => {
  assert.equal(callDeadline('U.S. and Iranian negotiators hold at least one announced session in the week ending 4 October 2026, UTC', '2026-10-02'), '2026-10-04');
  assert.equal(callDeadline('Alito remains off the bench for Suncor when argument begins on 5 October 2026', '2026-09-29'), '2026-10-05');
  assert.equal(callDeadline('YES if the IEA posts a schedule by 16:00 UTC on 6 October 2026; otherwise NO.', '2026-10-03'), '2026-10-06');
  assert.equal(callDeadline('Talks resume between 3 October and 10 October', '2026-10-01'), '2026-10-10');
  assert.equal(callDeadline('BRENT < 80 BY 30 SEP', '2026-12-01'), '2027-09-30');
  assert.equal(callDeadline('Fed cuts by March 18, 2027', '2026-10-01'), '2027-03-18');
  assert.equal(callDeadline('48-hour expulsion met', '2026-10-02'), '2026-10-04');
  assert.equal(callDeadline('Ceasefire holds 7D', '2026-10-02'), '2026-10-09');
  assert.equal(callDeadline('the PQ may 12 seats', '2026-10-01'), null);
  assert.equal(callDeadline('A ceasefire holds at first unlock', '2026-10-01'), null);
  assert.equal(callDeadline('By 31 September', '2026-09-01'), null);
});

test('one state per call: pending, due, hit, miss, cancelled', () => {
  const entry = (over) => ({ outcome: 'open', opened: '2026-10-03', deadline: '2026-10-06', ...over });
  assert.equal(callState(entry(), '2026-10-06'), 'pending', 'due only once the deadline day has passed');
  assert.equal(callState(entry(), '2026-10-07'), 'due');
  assert.equal(callState(entry({ deadline: null }), '2026-10-04'), 'due', 'a call naming no date is checked every edition after it opens');
  assert.equal(callState(entry({ deadline: null, opened: '2026-10-04' }), '2026-10-04'), 'pending', 'never due in the edition that publishes it');
  for (const outcome of ['hit', 'miss', 'cancelled']) assert.equal(callState(entry({ outcome }), '2026-10-09'), outcome);
  assert.deepEqual(Object.keys(CALL_STATES), ['pending', 'due', 'hit', 'miss', 'cancelled']);
  assert.equal(CALL_STATES.due, 'due — awaiting verification');
});

test('a note must say something: eight words at least', () => {
  assert.equal(hasNote({ note: 'checked' }), false);
  assert.equal(hasNote({ note: '   ' }), false);
  assert.equal(hasNote({ note: 'Checked the corpus and the IEA site; nothing posted yet.' }), true);
});

test('mustSettle: two days of grace past a stated deadline, seven past opening when none is stated', async () => {
  const { mustSettle } = await import('./ledger-states.mjs');
  const entry = (over) => ({ outcome: 'open', opened: '2026-10-02', deadline: '2026-10-04', ...over });
  assert.equal(mustSettle(entry(), '2026-10-05'), false);
  assert.equal(mustSettle(entry(), '2026-10-06'), false);
  assert.equal(mustSettle(entry(), '2026-10-07'), true);
  assert.equal(mustSettle(entry({ outcome: 'miss' }), '2026-10-20'), false, 'a settled call is done');
  assert.equal(mustSettle(entry({ deadline: '2026-12-04' }), '2026-10-08'), false, 'a call not yet due is never forced');
  assert.equal(mustSettle(entry({ deadline: null }), '2026-10-09'), false);
  assert.equal(mustSettle(entry({ deadline: null }), '2026-10-10'), true);
});
