import assert from 'node:assert/strict';
import test from 'node:test';
import { citedExcerpts, droppedVerifiedFacts } from './revision-facts.mjs';
import { DESK_SECTIONS, withDeskSection } from './desk-sections.mjs';

const row = (n, excerpt) => ({ source: 's', fragment: excerpt ?? 'x', source_note: { source_id: `E${n}`, ...(excerpt ? { raw_excerpt: excerpt } : {}) } });
const A = 'Southern Command said four people were killed in the strike.';
const B = 'The vessel was operated by a designated narco-terrorist organization.';
const C = 'Saul said there are reasonable grounds to believe';
const prev = { evidence_box: [row(1, A), row(2, B), row(3, C), row(4)], body: ['One [E1] two [E2].', 'Three [E3] four [E4].'] };

test('citedExcerpts keeps only verified rows the body cites', () => {
  assert.deepEqual([...citedExcerpts(prev).values()], ['E1', 'E2', 'E3']);
  assert.deepEqual([...citedExcerpts({ ...prev, body: ['Only [E2].'] }).values()], ['E2']);
});

test('a revision that drops an unnamed verified fact is caught', () => {
  const next = { evidence_box: [row(1, A), row(2, C)], body: ['One [E1].', 'Two [E2].'] };
  assert.deepEqual(droppedVerifiedFacts(prev, next, 'Paragraph 6 needs work.'), [{ label: 'E2', excerpt: B }]);
});

test('a fact the editor named by row or by quotation may go', () => {
  const next = { evidence_box: [row(1, A), row(2, B)], body: ['One [E1] two [E2].'] };
  assert.deepEqual(droppedVerifiedFacts(prev, next, '[E3] is a truncated fragment; drop it.'), []);
  assert.deepEqual(droppedVerifiedFacts(prev, next, `The clause "${C}" is truncated.`), []);
  assert.equal(droppedVerifiedFacts(prev, next, 'Drop E30.').length, 1, 'E30 is not E3');
});

test('reordering or renumbering verified rows is not a drop', () => {
  const next = { evidence_box: [row(1, C), row(2, B), row(3, A)], body: ['[E3] [E2] [E1].'] };
  assert.deepEqual(droppedVerifiedFacts(prev, next, ''), []);
});

test('the section follows the desk, whatever the filing typed', () => {
  assert.equal(new Set(Object.values(DESK_SECTIONS)).size, 6, 'six desks, six sections');
  const { article, changed, to } = withDeskSection({ section: 'World', headline: 'h' }, 'tinkerton');
  assert.equal(article.section, 'Policy'); assert.equal(changed, true); assert.equal(to, 'Policy');
  assert.equal(withDeskSection({ section: 'Policy' }, 'tinkerton').changed, false);
  assert.equal(withDeskSection({ section: 'World' }, 'spike').article.section, 'World', 'non-reporters pass through');
});

test('file_article refusal names every dropped fact and passes a clean revision', async () => {
  const { assertKeepsVerifiedFacts } = await import('./revision-facts.mjs');
  const next = { evidence_box: [row(1, A)], body: ['One [E1].'] };
  assert.throws(() => assertKeepsVerifiedFacts(prev, next, '', 2), /revision 2 drops 2 verified facts.*E2 of revision 1.*E3 of revision 1/su);
  assert.doesNotThrow(() => assertKeepsVerifiedFacts(prev, prev, '', 2));
  assert.doesNotThrow(() => assertKeepsVerifiedFacts(undefined, next, '', 2), 'no previous filing, nothing to compare');
});
