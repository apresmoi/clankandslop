import test from 'node:test';
import assert from 'node:assert/strict';
import { LayoutError, layEdition } from './lay-page.mjs';
import { collectPublicArticleReferences } from '../agentic-org/scripts/production-newsroom.mjs';
import { article, synthetic } from './lay-page.test-data.mjs';

// The Tape is built by the paper: the numbers from today's articles'
// key_numbers, the deadlines from yesterday's promises, today's next checks
// and the ledger's open calls. The record only writes the Markets File.
const lay = (mutate = (input) => input) => layEdition(mutate(synthetic()));
const tape = (laid) => laid.pages[1].document;
const blocks = (page) => page.head.map((b) => b.block);
const refusal = (mutate) => {
  let error;
  try { lay(mutate); } catch (thrown) { error = thrown; }
  assert.ok(error instanceof LayoutError, `expected a LayoutError, got ${error ?? 'no error at all'}`);
  return error;
};

const QUEBEC = 'Yes if Élections Québec awards the Parti Québécois 64 or more seats by 16:00 UTC on 12 September 2026.';
const full = (i) => {
  i.desk['ledger.worlddesk'].markets = { as_of: '2026-09-08', series: [] };
  i.articles.charlie.key_numbers = [{ label: 'PQ seats', value: '59', dir: 'up' }, { label: 'Majority line', value: '64' }];
  i.articles.alpha.key_numbers = [{ label: 'Slots a day', value: '34', dir: 'down' }, { label: 'Earlier', value: '36' }];
  i.articles.charlie.confidence = { label: QUEBEC, value: 0.28 };
  i.articles.bravo.next_update_utc = '17:00';
  i.ledger = [{ date: '2026-09-08', settlements: { resolved_last_edition: [] }, articles: [article('s-owed', { edition_date: '2026-09-08', headline: 'The Medical Flight Did Not Arrive', next_update_utc: '15:00', byline: { desk: 'The Hearth', agents: ['Vesta'] } })] }];
  return i;
};

test('the tape head runs Markets File, board, numbers, deadlines, ledger, track record — no Grid', () => {
  const page = tape(lay(full));
  assert.deepEqual(blocks(page), ['Briefly', 'MarketsBoard', 'KeyFigures', 'Deadlines', 'ForecastLedger', 'TrackRecord']);
  const figures = page.head[2].props;
  assert.deepEqual(figures.groups.map((g) => [g.kicker, g.href, g.figures.length]), [['K', '/editions/2026-09-09/articles/alpha/', 2], ['K', '/editions/2026-09-09/articles/charlie/', 2]], 'in the record\'s order, lead first');
  const deadlines = page.head[3].props;
  assert.deepEqual(deadlines.owed, [{ time: '15:00', headline: 'The Medical Flight Did Not Arrive', href: '/editions/2026-09-08/articles/s-owed/', who: 'Vesta' }]);
  assert.equal(deadlines.owed_from, '2026-09-08');
  assert.deepEqual(deadlines.dated, [
    { date: '2026-09-09', time: '17:00', what: 'Next check on “H”', who: 'Cogsworth' },
    { date: '2026-09-12', time: '16:00', what: 'H', who: 'Foreman' },
  ]);
  assert.deepEqual(collectPublicArticleReferences(page), [], 'links to stories are hrefs, never featured slugs');
});

test('a thin day prints a shorter tape: no numbers, no deadlines, no ledger', () => {
  assert.deepEqual(blocks(tape(lay())), ['Briefly', 'TrackRecord']);
});

test('a decision record carrying tape.markets or tape.watch is refused with the fix', () => {
  const markets = { kicker: '9 Sep', rows: [{ sym: 'ACP', value: '34', spark: 'slots', pct: 'from 4 Sep', dir: 'down' }] };
  const watch = [{ when: '10 Sep', what: 'The rule either enters force or it slips.', who: 'Tinkerton' }];
  for (const [extra, named] of [[{ markets }, 'tape.markets'], [{ watch }, 'tape.watch'], [{ watch: [] }, 'tape.watch'], [{ markets, watch }, 'tape.markets and tape.watch']]) {
    const error = refusal((i) => { Object.assign(i.decisions.tape, extra); return i; });
    assert.match(error.message, /^tape shape — /u);
    assert.ok(error.message.includes(`carries ${named},`), error.message);
    assert.match(error.message, /the Tape's numbers and deadlines are built by the paper from articles; remove tape\.markets \/ tape\.watch/u);
  }
  assert.match(refusal((i) => { delete i.decisions.tape; return i; }).message, /tape shape — the decision record must carry a "tape" object/u);
});

test('tape.forecast_meta still adds its clause to the ledger count', () => {
  const page = tape(lay((i) => { full(i); i.decisions.tape.forecast_meta = 'Quebec count due 12 Sep'; return i; }));
  assert.equal(page.head.find((b) => b.block === 'ForecastLedger').props.meta, '1 open call · Quebec count due 12 Sep');
});

test('the assembler never emits MarketsRail or WhatToWatch again', () => {
  for (const laid of [lay(), lay(full)]) {
    const text = JSON.stringify(tape(laid));
    assert.doesNotMatch(text, /"block":"(?:MarketsRail|WhatToWatch|Grid)"/u);
  }
});

test('the tape derives its open calls from the settlement document, and omits the block when there are none', () => {
  assert.equal(tape(lay()).head.some((b) => b.block === 'ForecastLedger'), false);
  const page = tape(lay((i) => {
    i.desk['ledger.settlements'].resolved_last_edition = [{ call: 'A thing happens by Friday', outcome: 'open', prior_p: 0.62 }, { call: 'Settled', outcome: 'miss', prior_p: 0.1 }];
    return i;
  }));
  const ledger = page.head.find((b) => b.block === 'ForecastLedger');
  assert.equal(ledger.props.meta, '1 open call');
  assert.deepEqual(ledger.props.open_calls, [{ horizon: 'no date', question: 'A thing happens by Friday', call: 'YES', direction: 'bull', p: 0.62, state: 'pending', state_label: 'not yet due', detail: 'new in the 9 Sep edition' }]);
});
