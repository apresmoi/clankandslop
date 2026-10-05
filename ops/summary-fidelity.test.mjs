import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { decisionSummaryFindings, summaryFindings } from './summary-fidelity.mjs';
import { LayoutError, layEdition, readEditionInputs } from './lay-page.mjs';
import { repo, agents, decisionsFromShipped } from './lay-page.test-data.mjs';

// The 2026-10-05 Banja Luka article, as published: the declaration is Sunday,
// the Friday rally is where Dodik said Bosnia "is dead".
const bosnia = {
  id: 's-e11a096f', kicker: 'Bosnia', headline: 'He Called the Sweep Before the Count', byline: { agents: ['Vesta'] },
  deck: "Banned from office, Milorad Dodik declared his party the winner while Bosnia's election commission was still counting.",
  body: [
    "Milorad Dodik declared victory for his party in Bosnia and Herzegovina's general election on Sunday [E1]. The Central Election Commission said the counting was not finished [E10].",
    "With nearly 90% of votes counted, his ally had more than 55% for the Serb seat [E3].",
    'At the party\'s final rally on Friday night in Banja Luka, Republika Srpska\'s administrative capital, Dodik told supporters that Bosnia "is dead" [E8].',
  ],
};
const FUSED = "Dodik declared an SNSD sweep at the Friday rally in Banja Luka while Bosnia's election commission was still counting.";

test('the 5 October Flashpoint note that moved Sunday\'s declaration onto Friday\'s rally is refused', () => {
  const findings = summaryFindings(FUSED, { articles: [bosnia], edition: '2026-10-05' });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /ties "declar…" to Friday, but the article puts that on Sunday/u);
});

test('the same facts with each event on its own day pass', () => {
  for (const note of [
    "Dodik declared an SNSD sweep on Sunday while Bosnia's election commission was still counting.",
    'Dodik told the Friday rally in Banja Luka that Bosnia "is dead".',
    'With nearly 90% counted, his ally had more than 55% for the Serb seat.',
  ]) assert.deepEqual(summaryFindings(note, { articles: [bosnia], edition: '2026-10-05' }), [], note);
});

test('a weekday, date, relative day or number the article never printed is refused', () => {
  const at = (note) => summaryFindings(note, { articles: [bosnia], edition: '2026-10-05' });
  assert.match(at('Dodik declared victory on Saturday.')[0], /says "Saturday" but the article never does/u);
  assert.match(at('Dodik declared victory on 3 October.')[0], /gives the date "3 october"/u);
  assert.match(at('Dodik declared victory with 62% counted.')[0], /carries the number 62/u);
  // 5 October 2026 is a Monday; "yesterday" is Sunday, which the article names.
  assert.deepEqual(at('Dodik declared victory yesterday.'), []);
  assert.match(at('Dodik declared victory today.')[0], /says "today" but the article never puts the event on Monday, 5 october/u);
});

test('a probability may be printed as a percent or a decimal', () => {
  const call = { ...bosnia, confidence: { label: 'Cvijanović is certified the winner of the Serb seat', value: 0.58 } };
  assert.deepEqual(summaryFindings('The desk puts certification at 58%.', { articles: [call] }), []);
  assert.deepEqual(summaryFindings('The desk puts certification at 0.58.', { articles: [call] }), []);
});

test('an agent-only desk item may carry a running thread, but may not move today\'s event to another day', () => {
  const decisions = { briefly: [{ label: 'Open Clocks', lead: { kicker: 'K', agent: 'Vesta', what: 'The 3 October call stays open at 0.71.' }, rest: [{ kicker: 'K', agent: 'Vesta', what: FUSED }] }] };
  const findings = decisionSummaryFindings(decisions, { [bosnia.id]: bosnia }, { edition: '2026-10-05' });
  assert.equal(findings.length, 1, findings.join('\n'));
  assert.match(findings[0], /^briefly\[0\]\.rest\[0\]\.what/u);
});

test('the assembler refuses the 5 October decision record, and names what to rewrite', () => {
  const date = '2026-10-05';
  const decisions = decisionsFromShipped(date);
  decisions.art = { ...decisions.art, [decisions.order[0]]: { shape: 'satellite', caption: 'Every US bomber at RAF Fairford flew to home stations on Sunday.' } };
  const inputs = { edition: date, ...readEditionInputs(resolve(repo, 'content'), date), decisions, agents, ledger: [] };
  assert.throws(() => layEdition(inputs), (error) => error instanceof LayoutError && /summary fidelity/u.test(error.message) && /flashpoints\[3\]\.note/u.test(error.message) && /never merge two events/u.test(error.message));
  decisions.flashpoints[3].note = "Dodik declared an SNSD sweep on Sunday while Bosnia's election commission was still counting.";
  assert.ok(layEdition(inputs).pages.length === 2);
});

test('no shipped edition since the ledger epoch trips the check except the 5 October fusion', () => {
  for (const date of ['2026-09-29', '2026-09-30', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']) {
    const { articles, desk } = readEditionInputs(resolve(repo, 'content'), date);
    const rows = desk['ledger.settlements'].resolved_last_edition.map((row) => `${row.call} ${row.prior_p}`);
    const findings = decisionSummaryFindings(decisionsFromShipped(date), articles, { edition: date, extra: [...rows, JSON.stringify(desk['ledger.worlddesk'])] });
    assert.deepEqual(findings.map((f) => f.slice(0, 40)), date === '2026-10-05' ? [`flashpoints[3].note ${JSON.stringify(FUSED).slice(0, 20)}`] : [], date);
  }
});
