import assert from 'node:assert/strict';
import test from 'node:test';
import { composeGateLine, composeGateStatus, hasNamedDissent, isDatedForecast } from './compose-gate.mjs';

const EDITION = '2026-09-05';
const coverage = { sections: ['World', 'Business', 'Policy'], owners: ['A', 'B', 'C', 'D', 'E'], sources: ['a', 'b', 'c'], domains: ['a.example', 'b.example', 'c.example'] };
const line = (status) => composeGateLine(status);

test('a dated forecast is epistemic plus a clock, and nothing about dissent', () => {
  assert.equal(isDatedForecast({ epistemic: 'forecast', next_update_utc: '14:30' }), true);
  assert.equal(isDatedForecast({ epistemic: 'inference', next_update_utc: '14:30' }), false);
  assert.equal(isDatedForecast({ epistemic: 'forecast', next_update_utc: 'tomorrow' }), false);
  assert.equal(isDatedForecast({ epistemic: 'forecast' }), false);
  assert.equal(isDatedForecast(undefined), false);
  // The two halves are counted separately now, so a forecast with no dissent
  // is still a forecast — which is what 16 of the 79 archived editions are.
  assert.equal(hasNamedDissent({ epistemic: 'forecast', next_update_utc: '14:30' }), false);
  assert.equal(hasNamedDissent({ dissent: { agent: 'Tinkerton', p: 0.4, argument: 'No.' } }), true);
  assert.equal(hasNamedDissent({ dissent: { p: 0.4, argument: 'No.' } }), false);
});

test('the gate line reports the forecast and dissent counts and refuses on neither', () => {
  // Today's real state on 2026-09-05: six PASSed pieces, four desk documents,
  // no forecast and no dissent. It composes.
  assert.equal(line(composeGateStatus({ edition: EDITION, coverage, passed: 6, desks: 4, forecasts: 0, dissents: 0 })), '# compose: passed=6/5 desks=4/4 sections=3/3 owners=5/5 sources=3/3 domains=3/3 forecast=0 dissent=0  → ready');
  assert.equal(line(composeGateStatus({ edition: EDITION, coverage, passed: 6, desks: 4, forecasts: 1, dissents: 1 })), '# compose: passed=6/5 desks=4/4 sections=3/3 owners=5/5 sources=3/3 domains=3/3 forecast=1 dissent=1  → ready');
  // Article, desk and coverage floors are untouched by forecast/dissent counts.
  assert.equal(line(composeGateStatus({ edition: EDITION, coverage, passed: 4, desks: 4, forecasts: 1, dissents: 1 })), '# compose: passed=4/5 desks=4/4 sections=3/3 owners=5/5 sources=3/3 domains=3/3 forecast=1 dissent=1  → blocked');
  assert.equal(line(composeGateStatus({ edition: EDITION, coverage, passed: 6, desks: 3, forecasts: 1, dissents: 1 })), '# compose: passed=6/5 desks=3/4 sections=3/3 owners=5/5 sources=3/3 domains=3/3 forecast=1 dissent=1  → blocked');
  assert.equal(line(composeGateStatus({ edition: EDITION, coverage, passed: 6, desks: 5, forecasts: 1, dissents: 1 })), '# compose: passed=6/5 desks=5/4 sections=3/3 owners=5/5 sources=3/3 domains=3/3 forecast=1 dissent=1  → blocked');
  // Unknown forecast/dissent counts cannot override measured prerequisites.
  assert.equal(line(composeGateStatus({ edition: EDITION, coverage, passed: 6, desks: 4 })), '# compose: passed=6/5 desks=4/4 sections=3/3 owners=5/5 sources=3/3 domains=3/3 forecast=? dissent=?  → ready');
  // One line, always.
  for (const status of [composeGateStatus({ edition: EDITION, coverage, passed: 0, desks: 0, forecasts: 0, dissents: 0 })]) assert.equal(line(status).split('\n').length, 1);
});

test('the waiver mechanism is gone, not merely unused', async () => {
  // The whole point of the change: there is no symbol left to re-date. If any
  // of these comes back, so does a quality bar that disappears by being
  // remembered rather than met.
  const module = await import('./compose-gate.mjs');
  for (const symbol of ['DIVERSITY_WAIVER_ENV', 'FORECAST_DISSENT_FLOOR', 'WAIVER_VERSION', 'editionDiversityWaiver', 'hasDatedForecastWithDissent'])
    assert.equal(module[symbol], undefined, `compose-gate.mjs must not export ${symbol}`);
  assert.equal(composeGateStatus({ edition: EDITION, coverage, passed: 6, desks: 4, forecasts: 0, dissents: 0 }).diversity, undefined);
});
