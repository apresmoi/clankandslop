import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentagePointSlip, proseLintFindings } from './prose-lint.mjs';

const flags = (body, deck = 'Turnout fell.') => proseLintFindings({ headline: 'Bosnia votes', deck, body }).map((finding) => finding.flag);

test('pct_points: a change between two percentages written as "%" is flagged', () => {
  assert.deepEqual(flags(['Turnout was 42%, down by about 8% from roughly 50% four years ago. [E1]']), ['pct_points']);
  assert.deepEqual(flags(['Support rose by 3.5% to 41.2%, the poll found. [E1]']), ['pct_points']);
  assert.deepEqual(flags(['Polls opened on time. [E1]'], 'Turnout fell by 8% to 42%.'), ['pct_points']);
  assert.match(proseLintFindings({ body: ['Approval fell by 6% to 38%. [E1]'] })[0].message, /percentage points/u);
});

test('pct_points: percentage points, a lone percentage and split sentences pass', () => {
  assert.deepEqual(flags(['Turnout was about 42%, down about 8 percentage points from about 50%. [E1]']), []);
  assert.deepEqual(flags(['Exports rose by 8% in September. [E1]']), []);
  assert.deepEqual(flags(['Exports rose by 8% in September. Imports were 40% of the total. [E1]']), []);
  assert.equal(percentagePointSlip(['Inflation eased to 2.1% from 2.4%. [E1]']), undefined);
});
