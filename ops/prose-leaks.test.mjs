import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proseLeakFindings } from './prose-leaks.mjs';

const article = (body) => ({ headline: 'Yields climb', deck: 'Borrowing costs rose.', kicker: 'Bond markets', body, evidence_box: [{ fragment: 'unrelated' }] });
const codes = (body) => proseLeakFindings(article(body)).map((finding) => finding.message);

test('house style: the word percent after a number is refused, the % sign passes', () => {
  assert.equal(codes(['The 10-year yield rose to 5.243 percent. [E1]']).length, 1);
  assert.deepEqual(codes(['The 10-year yield rose to about 5.2%, CNBC reported. [E1]']), []);
});

test('newsroom evidence vocabulary is refused in reader-facing prose', () => {
  assert.equal(codes(['A captured sentence puts the arrests at 1,949. [E1]']).length, 1);
  assert.equal(codes(['Thursday is the date on that page. [E1]']).length, 1);
  assert.equal(codes(['The Record carries no second source. [E1]']).length, 1);
});

test('ordinary attribution is not a leak', () => {
  assert.deepEqual(codes(['Police made 1,949 arrests on Thursday, the interior ministry said. [E1]', 'That account was echoed by the BBC. [E2]']), []);
});
