import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ledgerKey, marketBoard, marketRow, tapeTagline, type Markets, type MarketSeries } from './tape.ts';

const s = (over: Partial<MarketSeries>): MarketSeries => ({ id: 'DGS10', group: 'rates', label: 'US 10-year Treasury yield', unit: 'percent', decimals: 2, basis: 'close', url: 'https://fred.stlouisfed.org/series/DGS10', value: 4.12, observed: '2026-10-05', previous: 4.09, previous_observed: '2026-10-02', ...over });
const markets = (...series: MarketSeries[]): Markets => ({ source: 'FRED, Federal Reserve Bank of St. Louis', retrieved_at: '2026-10-06T05:00:00Z', series });

test('a market row prints the observed value, its change and the day it was observed', () => {
  assert.deepEqual(marketRow(s({})), { id: 'DGS10', label: 'US 10-year Treasury yield', url: 'https://fred.stlouisfed.org/series/DGS10', value: '4.12%', asOf: 'close 5 Oct', dir: 'up', vs: 'vs 2 Oct', change: '+3 bp' });
  const brent = marketRow(s({ id: 'DCOILBRENTEU', group: 'commodities', unit: 'usd', basis: 'spot', value: 64.1, previous: 65.6, observed: '2026-09-29', previous_observed: '2026-09-26' }));
  assert.equal(brent.value, '$64.10');
  assert.equal(brent.change, '−1.50 (−2.29%)');
  assert.equal(brent.dir, 'down');
  assert.equal(brent.asOf, 'spot 29 Sep', 'a lagged series is labelled with its own date, not the bell');
  const sp = marketRow(s({ id: 'SP500', group: 'equities', unit: 'index', value: 6712.4, previous: 6712.4 }));
  assert.equal(sp.value, '6,712.40');
  assert.equal(sp.dir, 'flat');
  assert.equal(marketRow(s({ previous: undefined, previous_observed: undefined })).change, undefined, 'one observation prints no change');
});

test('a series that did not fetch is unavailable and prints no number', () => {
  const row = marketRow(s({ value: undefined, observed: undefined, previous: undefined, previous_observed: undefined, unavailable: 'FRED fetch failed: HTTP 503' }));
  assert.deepEqual(row, { id: 'DGS10', label: 'US 10-year Treasury yield', url: 'https://fred.stlouisfed.org/series/DGS10', unavailable: 'FRED fetch failed: HTTP 503' });
  assert.equal(marketRow(s({ unavailable: 'stale' })).value, undefined, 'an unavailable mark wins over any number beside it');
});

test('the tagline promises only the asset classes the board prices', () => {
  const down = { value: undefined, observed: undefined, previous: undefined, previous_observed: undefined, unavailable: 'x' };
  assert.equal(tapeTagline(markets(s({}), s({ group: 'fx', id: 'DEXUSEU' }), s({ group: 'commodities', id: 'DHHNGSP' }), s({ group: 'equities', id: 'SP500' }))), 'Rates · FX · commodities · equities — the latest published closes, read at the bell.');
  assert.equal(tapeTagline(markets(s({}), s({ group: 'equities', id: 'SP500', ...down }))), 'Rates — the latest published closes, read at the bell.');
  assert.equal(tapeTagline(undefined), 'Open clocks, deadlines and the forecast ledger, read at the bell.');
  assert.deepEqual(marketBoard(markets(s({ group: 'equities', id: 'SP500' }), s({}))).map((g) => g.label), ['Rates', 'Equities']);
});

test('the ledger key explains only what the rows supply, and never a quorum', () => {
  const bare = ledgerKey([{ state: 'pending' }]).map((k) => `${k.term} ${k.text}`).join(' ');
  assert.doesNotMatch(bare, /quorum|±|band|Dissent/u);
  assert.match(bare, /due — awaiting verification/u);
  const full = ledgerKey([{ interval: 0.1, dissent: { agents: ['Tinkerton'], p: 0.4 } }]).map((k) => `${k.term} ${k.text}`).join(' ');
  assert.match(full, /± the forecaster’s own uncertainty band/u);
  assert.match(full, /Dissent names the agent/u);
});

test('no Tape template hardcodes a claim its data does not back', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const ledger = read('../components/ForecastLedger.astro');
  assert.doesNotMatch(ledger, /quorum|±1σ|five desk agents|at the next bell/u, 'the key is built by ledgerKey from the rows');
  for (const page of ['../pages/tape.astro', '../pages/editions/[date]/tape.astro']) {
    const source = read(page);
    assert.doesNotMatch(source, /priced at the bell|Rates · FX/u, `${page} must build its tagline from the board`);
    assert.match(source, /tapeTagline\(edition\.markets\)/u);
  }
});
