import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisiveTestClaim, percentagePointSlip, proseLintFindings, unnamedSpeaker } from './prose-lint.mjs';

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

test('unnamed_speaker: a statement attributed to an unnamed person is flagged', () => {
  assert.deepEqual(flags(['A woman told the German press agency the party would run. [E1]']), ['unnamed_speaker']);
  assert.deepEqual(flags(['"We will not stop," a man said outside the court. [E1]']), ['unnamed_speaker']);
  assert.deepEqual(flags(['An unnamed speaker at the rally called for a boycott. [E1]']), ['unnamed_speaker']);
  assert.deepEqual(flags(['The crowd cheered when a speaker read the list. [E1]']), ['unnamed_speaker']);
  assert.deepEqual(flags(['Polls opened on time. [E1]'], 'Another woman says the vote was rigged.'), ['unnamed_speaker']);
  assert.match(proseLintFindings({ body: ['A man said the dam broke. [E1]'] })[0].message, /name the speaker and their role/u);
});

test('unnamed_speaker: named speakers, the Speaker of a parliament and ordinary nouns pass', () => {
  assert.deepEqual(flags(['Sahra Wagenknecht, founder of the BSW, told the German press agency the party would run. [E1]']), []);
  assert.deepEqual(flags(['The Speaker of the House adjourned the session. [E1]']), []);
  assert.deepEqual(flags(['A woman was among the 25 dead, the Air Force said. [E1]']), []);
  assert.deepEqual(flags(['Loudspeakers carried the speech across the square. [E1]']), []);
  assert.equal(unnamedSpeaker(['The spokesman for the ministry said talks would resume. [E1]']), undefined);
});

test('decisive_test: a closing "would settle which reading" claim is flagged for Spike', () => {
  const hearth = 'A laboratory result that names a pathogen in her samples, or a second confirmed illness among those under observation, would settle which reading is true. [E4]';
  assert.deepEqual(flags(['The worker died last week. [E1]', hearth]), ['decisive_test']);
  assert.deepEqual(flags(['Exports rose in August. [E1]', 'A shipment table would show whether August was a turn. [E2]']), ['decisive_test']);
  assert.deepEqual(flags(['Two readings remain. [E1]', 'Nothing yet settles which reading holds. [E2]']), ['decisive_test']);
  assert.match(proseLintFindings({ body: ['One. [E1]', hearth] })[0].message, /differ under each reading/u);
});

test('decisive_test: only the final paragraph counts, and plain endings pass', () => {
  assert.deepEqual(flags(['A recount would settle whether the seat flips. [E1]', 'The count resumes on Monday. [E2]']), []);
  assert.deepEqual(flags(['The worker died last week. [E1]', 'The people around her are still being watched. [E2]']), []);
  assert.equal(decisiveTestClaim([]), undefined);
});
