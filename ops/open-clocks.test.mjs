import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { carriedCalls, followUps, ledgerHistory, missingLedgerRows } from './open-clocks.mjs';
import { archiveLedger, assertCarriedRows } from './ledger-archive.mjs';
import { LayoutError, layEdition } from './lay-page.mjs';
import { agents } from './lay-page.test-data.mjs';

// Two editions, the 4 -> 5 October shape: 4 October carries the IEA call open
// (published 3 October) and promises a 17:00 UTC Nantucket check; 5 October's
// prepared settlement document is empty and its record never mentions either.
const IEA = 'YES if the IEA or a G7 energy ministry posts a 100 million barrel schedule by 16:00 UTC on 6 October 2026; otherwise NO.';
const story = (id, over = {}) => ({ id, edition_date: '2026-10-05', section: 'world', kicker: 'K', headline: `Headline ${id}`, deck: 'D', epistemic: 'fact', byline: { desk: 'Desk', agents: ['Tinkerton'] }, timestamp: 'T', revision: 1, body: ['a', 'b'], refs: [], evidence_box: [], ...over });
const archive = [
  { date: '2026-10-03', settlements: { resolved_last_edition: [] }, articles: [story('s-iea', { edition_date: '2026-10-03', byline: { desk: 'Macro Desk', agents: ['Foreman'] }, confidence: { label: IEA, value: 0.62 } })] },
  { date: '2026-10-04', settlements: { resolved_last_edition: [{ call: IEA, outcome: 'open', prior_p: 0.62 }] }, articles: [story('s-nantucket', { edition_date: '2026-10-04', headline: 'The Medical Flight Did Not Arrive', next_update_utc: '17:00', byline: { desk: 'The Hearth', agents: ['Vesta'] } })] },
];

const input = (over = {}) => ({
  edition: '2026-10-05',
  articles: Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((id) => [id, story(id)])),
  desk: {
    'caslon.chrome': { date: '2026-10-05', edition_no: '0094', volume: 'I', issued_at: 'x', revision: 1, tagline: 't', next_bell: '16:00 UTC', compiled_by: ['Tinkerton'], lead_story_id: 'a' },
    'caslon.weather': { weather: null },
    'ledger.settlements': { resolved_last_edition: [] },
    'ledger.worlddesk': { world_desk: { escalation_index: 0.5, delta: 'steady', open_conflicts: 1, watch: 1 } },
  },
  decisions: {
    order: ['a', 'b', 'c', 'd', 'e'],
    art: { a: { shape: 'satellite', caption: 'Lead.' }, b: { shape: 'chip', caption: 'One.' }, c: { shape: 'drone', caption: 'Two.' } },
    briefly: [1, 2, 3].map((n) => ({ label: `Desk ${n}`, lead: { kicker: `K${n}`, agent: 'Tinkerton', what: `W${n}` }, rest: [] })),
    tape: { briefly: ['Closed Clocks', 'Open Clocks', 'Ballots'].map((label) => ({ label, lead: { kicker: 'Runoff Set', agent: 'Tinkerton', what: 'The runoff is the next print.' }, rest: [] })), watch: [{ when: '25 Oct', what: 'The runoff either lands or it slips.', who: 'Tinkerton' }] },
  },
  agents,
  archive: () => undefined,
  ledger: archive,
  ...over,
});
const tapeOf = (laid) => laid.pages.find((p) => p.name === 'tape').document;
const block = (page, name) => page.head.flatMap((b) => (b.block === 'Grid' ? b.props.columns.flat() : [b])).find((b) => b.block === name);

test('an open call from an earlier edition is carried onto the next tape until it settles', () => {
  const tape = tapeOf(layEdition(input()));
  assert.deepEqual(block(tape, 'ForecastLedger').props.open_calls.map((c) => [c.question, c.p]), [[IEA, 0.62]]);
  const open = block(tape, 'Briefly').props.desks.find((d) => d.label === 'Open Clocks');
  assert.deepEqual(open.rest, [{ kicker: 'Open Since 3 Oct', agent: 'Foreman', what: `${IEA.slice(0, -1)}. Prior 0.62, still open.` }]);
});

test('a call the record already carries on the Open Clocks desk is not added twice', () => {
  const laid = layEdition(input({ decisions: { ...input().decisions, tape: { ...input().decisions.tape, briefly: input().decisions.tape.briefly.map((d) => (d.label === 'Open Clocks' ? { ...d, lead: { kicker: 'IEA Schedule By 6 Oct', agent: 'Foreman', what: IEA } } : d)) } } }));
  assert.deepEqual(block(tapeOf(laid), 'Briefly').props.desks.find((d) => d.label === 'Open Clocks').rest, []);
});

test('a call settled today leaves the ledger and the desk', () => {
  const desk = { ...input().desk, 'ledger.settlements': { resolved_last_edition: [{ call: IEA, outcome: 'hit', prior_p: 0.62 }] } };
  const tape = tapeOf(layEdition(input({ desk })));
  assert.equal(block(tape, 'ForecastLedger'), undefined);
  assert.deepEqual(block(tape, 'Briefly').props.desks.find((d) => d.label === 'Open Clocks').rest, []);
});

test('the prior edition\'s next_update_utc promise is surfaced as an open deadline', () => {
  const watch = block(tapeOf(layEdition(input())), 'WhatToWatch').props.items;
  assert.deepEqual(watch[0], { when: '4 Oct 17:00 UTC', what: 'Update owed on “The Medical Flight Did Not Arrive”, promised in the 4 Oct edition.', who: 'Vesta' });
  assert.equal(watch.length, 2);
  // A follow-up that names it in previous_coverage has kept the promise.
  const articles = { ...input().articles, e: story('e', { previous_coverage: [{ date: '2026-10-04', slug: 's-nantucket' }] }) };
  assert.equal(block(tapeOf(layEdition(input({ articles }))), 'WhatToWatch').props.items.length, 1);
});

test('a tape with calls to carry and no Open Clocks desk is refused with the fix', () => {
  const decisions = { ...input().decisions, tape: { ...input().decisions.tape, briefly: input().decisions.tape.briefly.map((d, i) => ({ ...d, label: `Desk ${i}` })) } };
  assert.throws(() => layEdition(input({ decisions })), (e) => e instanceof LayoutError && /open clocks/u.test(e.message) && /label one of the three tape desks exactly "Open Clocks"/u.test(e.message));
});

test('the fold: open until a row settles it, junk labels never carried, calls before the epoch ignored', () => {
  const history = ledgerHistory([...archive, { date: '2026-09-01', settlements: { resolved_last_edition: [{ call: 'An old call before the epoch', outcome: 'open', prior_p: 0.5 }] }, articles: [] }, { date: '2026-10-04', settlements: { resolved_last_edition: [{ call: 'medium', outcome: 'open', prior_p: 0.64 }] }, articles: [] }]);
  assert.deepEqual(carriedCalls(history, '2026-10-05').map((c) => c.call), [IEA]);
  assert.deepEqual(carriedCalls(history, '2026-10-05', { resolved_last_edition: [{ call: IEA.toUpperCase(), outcome: 'miss', prior_p: 0.62 }] }), []);
  assert.deepEqual(missingLedgerRows(history, '2026-10-05', { resolved_last_edition: [] }), [{ call: IEA, outcome: 'open', prior_p: 0.62 }]);
  assert.deepEqual(followUps(undefined), []);
});

test('Ledger cannot file a settlement document that drops an open call', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'clank-ledger-'));
  try {
    for (const edition of archive) {
      mkdirSync(resolve(root, 'editions', edition.date, 'desk'), { recursive: true });
      mkdirSync(resolve(root, 'editions', edition.date, 'articles'), { recursive: true });
      writeFileSync(resolve(root, 'editions', edition.date, 'desk', 'ledger.settlements.json'), JSON.stringify(edition.settlements));
      for (const article of edition.articles) writeFileSync(resolve(root, 'editions', edition.date, 'articles', `${article.id}.json`), JSON.stringify(article));
    }
    assert.equal(archiveLedger(root, { before: '2026-10-04' }).length, 1);
    assert.throws(() => assertCarriedRows('2026-10-05', { resolved_last_edition: [] }, root), /drops 1 call\(s\) still open .*"outcome":"open","prior_p":0.62/u);
    assert.doesNotThrow(() => assertCarriedRows('2026-10-05', { resolved_last_edition: [{ call: IEA, outcome: 'open', prior_p: 0.62 }] }, root));
    assert.doesNotThrow(() => assertCarriedRows('2026-10-05', { resolved_last_edition: [{ call: IEA, outcome: 'hit', prior_p: 0.62 }] }, root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
