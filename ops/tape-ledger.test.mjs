// A two-edition fixture for the forecast ledger on the Tape: 6 October as it
// shipped (an overdue call printed "open" with no word, a new call missing
// from the table) and 7 October with Ledger's settlements and notes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { dueCallFindings, forecastRows, ledgerHistory } from './open-clocks.mjs';
import { assertCarriedRows } from './ledger-archive.mjs';
import { layEdition } from './lay-page.mjs';
import { agents } from './lay-page.test-data.mjs';

const IRAN = 'U.S. and Iranian negotiators hold at least one announced session in the week ending 4 October 2026, UTC';
const IEA = 'YES if the IEA posts a 100 million barrel schedule by 16:00 UTC on 6 October 2026; otherwise NO.';
const QUEBEC = 'Yes if Élections Québec posts a complete official seat table awarding the Parti Québécois 64 or more seats by 16:00 UTC on 12 October 2026.';
const NOTE = 'Checked the day\'s corpus and asked Brass for the IEA release page; no schedule was posted by 16:00 UTC.';
const story = (id, date, over = {}) => ({ id, edition_date: date, section: 'world', kicker: 'K', headline: `Headline ${id}`, deck: 'D', epistemic: 'fact', byline: { desk: 'Desk', agents: ['Tinkerton'] }, timestamp: 'T', revision: 1, body: ['a', 'b'], refs: [], evidence_box: [], ...over });
const call = (id, date, label, value, over = {}) => story(id, date, { epistemic: 'forecast', byline: { desk: 'Macro Desk', agents: ['Foreman'] }, confidence: { label, value, ...over.confidence }, ...(over.dissent ? { dissent: over.dissent } : {}) });

const OCT3 = { date: '2026-10-03', settlements: { resolved_last_edition: [] }, articles: [call('s-iea', '2026-10-03', IEA, 0.62), call('s-iran', '2026-10-03', IRAN, 0.52, { confidence: { interval: 0.1 }, dissent: { agent: 'Tinkerton', p: 0.4, argument: 'No session is scheduled.' } })] };
const OCT4 = { date: '2026-10-04', settlements: { resolved_last_edition: [{ call: IEA, outcome: 'open', prior_p: 0.62 }, { call: IRAN, outcome: 'open', prior_p: 0.52 }] }, articles: [] };
const OCT6_ROWS = { resolved_last_edition: [{ call: IRAN, outcome: 'open', prior_p: 0.52 }, { call: IEA, outcome: 'open', prior_p: 0.62 }] };
const OCT6_ARTICLES = { a: call('a', '2026-10-06', QUEBEC, 0.28), ...Object.fromEntries(['b', 'c', 'd', 'e'].map((id) => [id, story(id, '2026-10-06')])) };
const OCT6 = { date: '2026-10-06', settlements: OCT6_ROWS, articles: Object.values(OCT6_ARTICLES) };
const OCT7_ROWS = { resolved_last_edition: [{ call: IRAN, outcome: 'miss', prior_p: 0.52, note: 'State Department readout of 5 October says no session was held.' }, { call: IEA, outcome: 'open', prior_p: 0.62, note: NOTE }, { call: QUEBEC, outcome: 'open', prior_p: 0.28 }] };

const input = (edition, ledger, rows, articles) => ({
  edition, articles, ledger, agents, archive: () => undefined,
  desk: {
    'caslon.chrome': { date: edition, edition_no: '0095', volume: 'I', issued_at: 'x', revision: 1, tagline: 't', next_bell: '16:00 UTC', compiled_by: ['Tinkerton'], lead_story_id: 'a' },
    'caslon.weather': { weather: null },
    'ledger.settlements': rows,
    'ledger.worlddesk': { world_desk: { escalation_index: 0.5, delta: 'steady', open_conflicts: 1, watch: 1 } },
  },
  decisions: {
    order: ['a', 'b', 'c', 'd', 'e'],
    art: { a: { shape: 'satellite', caption: 'Lead.' }, b: { shape: 'chip', caption: 'One.' }, c: { shape: 'drone', caption: 'Two.' } },
    briefly: [1, 2, 3].map((n) => ({ label: `Desk ${n}`, lead: { kicker: `K${n}`, agent: 'Tinkerton', what: `W${n}` }, rest: [] })),
    tape: { briefly: ['Closed Clocks', 'Open Clocks', 'Ballots'].map((label) => ({ label, lead: { kicker: 'Runoff Set', agent: 'Tinkerton', what: 'The runoff is the next print.' }, rest: [] })) },
  },
});
const table = (laid) => laid.pages.find((p) => p.name === 'tape').document.head.find((b) => b.block === 'ForecastLedger').props;

test('6 October: every open call is in the table, the new Quebec call included, each in its state', () => {
  const props = table(layEdition(input('2026-10-06', [OCT3, OCT4], OCT6_ROWS, OCT6_ARTICLES)));
  assert.deepEqual(props.open_calls.map((r) => [r.question, r.state, r.horizon]), [[IRAN, 'due', '4 Oct'], [IEA, 'pending', '6 Oct'], [QUEBEC, 'pending', '12 Oct']]);
  assert.equal(props.meta, '3 open calls · 1 due, awaiting verification');
  const iran = props.open_calls[0];
  assert.equal(iran.state_label, 'due — awaiting verification');
  assert.equal(iran.interval, 0.1, 'the forecaster\'s own band is supplied');
  assert.deepEqual(iran.dissent, { agents: ['Tinkerton'], p: 0.4 }, 'the filed dissent is supplied');
  assert.equal(props.open_calls[2].detail, 'new in the 6 Oct edition');
});

test('the filing gate refuses a due call left open with no note, and names it', () => {
  const history = ledgerHistory([OCT3, OCT4]);
  assert.deepEqual(dueCallFindings(history, '2026-10-06', OCT6_ROWS).map((f) => [f.call, f.deadline]), [[IRAN, '2026-10-04']]);
  const withNote = { resolved_last_edition: OCT6_ROWS.resolved_last_edition.map((r) => (r.call === IRAN ? { ...r, note: 'Checked the corpus; no announced session found for the week ending 4 October.' } : r)) };
  assert.deepEqual(dueCallFindings(history, '2026-10-06', withNote), []);
  const cancelled = { resolved_last_edition: OCT6_ROWS.resolved_last_edition.map((r) => (r.call === IRAN ? { ...r, outcome: 'cancelled', note: 'too short' } : r)) };
  assert.equal(dueCallFindings(history, '2026-10-06', cancelled).length, 1, 'a cancelled due call needs its reason');
  const settled = { resolved_last_edition: OCT6_ROWS.resolved_last_edition.map((r) => (r.call === IRAN ? { ...r, outcome: 'hit' } : r)) };
  assert.deepEqual(dueCallFindings(history, '2026-10-06', settled), []);

  const root = mkdtempSync(resolve(tmpdir(), 'clank-due-'));
  try {
    for (const edition of [OCT3, OCT4]) {
      mkdirSync(resolve(root, 'editions', edition.date, 'desk'), { recursive: true });
      mkdirSync(resolve(root, 'editions', edition.date, 'articles'), { recursive: true });
      writeFileSync(resolve(root, 'editions', edition.date, 'desk', 'ledger.settlements.json'), JSON.stringify(edition.settlements));
      for (const article of edition.articles) writeFileSync(resolve(root, 'editions', edition.date, 'articles', `${article.id}.json`), JSON.stringify(article));
    }
    assert.throws(() => assertCarriedRows('2026-10-06', OCT6_ROWS, root), /leaves 1 due call\(s\) unexplained .*U\.S\. and Iranian negotiators/u);
    assert.doesNotThrow(() => assertCarriedRows('2026-10-06', withNote, root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('7 October: settled calls leave the table, a checked due call shows Ledger\'s note', () => {
  const props = table(layEdition(input('2026-10-07', [OCT3, OCT4, OCT6], OCT7_ROWS, Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((id) => [id, story(id, '2026-10-07')])))));
  assert.deepEqual(props.open_calls.map((r) => [r.question, r.state]), [[IEA, 'due'], [QUEBEC, 'pending']]);
  assert.equal(props.open_calls[0].note, NOTE);
  assert.equal(props.open_calls[0].noted, '7 Oct');
  assert.equal(props.open_calls[1].note, undefined, 'a call not yet due carries no note');
});

test('forecastRows sorts by deadline and never prints a settled or cancelled call', () => {
  const history = ledgerHistory([OCT3, OCT4, OCT6, { date: '2026-10-07', settlements: { resolved_last_edition: [...OCT7_ROWS.resolved_last_edition.slice(0, 2), { call: QUEBEC, outcome: 'cancelled', prior_p: 0.28, note: 'Élections Québec postponed the official count indefinitely after the recount order.' }] }, articles: [] }]);
  assert.deepEqual(forecastRows(history, '2026-10-07').map((r) => r.question), [IEA]);
});

test('the market board is placed under the Markets File only when Ledger filed one', () => {
  const heads = (worlddesk) => {
    const i = input('2026-10-06', [OCT3, OCT4], OCT6_ROWS, OCT6_ARTICLES);
    i.desk['ledger.worlddesk'] = { ...i.desk['ledger.worlddesk'], ...worlddesk };
    return layEdition(i).pages.find((p) => p.name === 'tape').document.head.map((b) => b.block);
  };
  const markets = { source: 'FRED', retrieved_at: '2026-10-06T05:00:00Z', series: [] };
  assert.deepEqual(heads({ markets }).slice(0, 2), ['Briefly', 'MarketsBoard']);
  assert.equal(heads({}).includes('MarketsBoard'), false);
});
