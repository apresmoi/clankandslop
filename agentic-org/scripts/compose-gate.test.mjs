import assert from 'node:assert/strict';
import test from 'node:test';
import { PASSED_ARTICLES_MINIMUM, composeGateLine, composeGateStatus, hasNamedDissent, isDatedForecast } from './compose-gate.mjs';

// The expectations below interpolate the floors rather than hardcoding them.
// Hardcoded numbers made this test fail on a deliberate floor change while
// proving nothing about the gate's behaviour -- the assertion should pin the
// SHAPE of the line and the ready/blocked decision, not the current size.
const F = PASSED_ARTICLES_MINIMUM;

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
  assert.equal(line(composeGateStatus({ edition: EDITION, coverage, passed: 6, desks: 4, forecasts: 0, dissents: 0 })), `# compose: passed=6/${F} desks=4/4 sections=3/3 owners=5/${F} sources=3/3 domains=3/3 forecast=0 dissent=0  → ready`);
  assert.equal(line(composeGateStatus({ edition: EDITION, coverage, passed: 6, desks: 4, forecasts: 1, dissents: 1 })), `# compose: passed=6/${F} desks=4/4 sections=3/3 owners=5/${F} sources=3/3 domains=3/3 forecast=1 dissent=1  → ready`);
  // Article, desk and coverage floors are untouched by forecast/dissent counts.
  // One short of the floor blocks, whatever the floor currently is.
  assert.equal(line(composeGateStatus({ edition: EDITION, coverage, passed: F - 1, desks: 4, forecasts: 1, dissents: 1 })), `# compose: passed=${F - 1}/${F} desks=4/4 sections=3/3 owners=5/${F} sources=3/3 domains=3/3 forecast=1 dissent=1  → blocked`);
  // Exactly at the floor is ready -- 2026-09-26 closed at four passed with every
  // other prerequisite met and could not publish, which is why the floor moved.
  assert.equal(composeGateStatus({ edition: EDITION, coverage, passed: F, desks: 4, forecasts: 1, dissents: 1 }).state, 'ready');
  assert.equal(line(composeGateStatus({ edition: EDITION, coverage, passed: 6, desks: 3, forecasts: 1, dissents: 1 })), `# compose: passed=6/${F} desks=3/4 sections=3/3 owners=5/${F} sources=3/3 domains=3/3 forecast=1 dissent=1  → blocked`);
  assert.equal(line(composeGateStatus({ edition: EDITION, coverage, passed: 6, desks: 5, forecasts: 1, dissents: 1 })), `# compose: passed=6/${F} desks=5/4 sections=3/3 owners=5/${F} sources=3/3 domains=3/3 forecast=1 dissent=1  → blocked`);
  // Unknown forecast/dissent counts cannot override measured prerequisites.
  assert.equal(line(composeGateStatus({ edition: EDITION, coverage, passed: 6, desks: 4 })), `# compose: passed=6/${F} desks=4/4 sections=3/3 owners=5/${F} sources=3/3 domains=3/3 forecast=? dissent=?  → ready`);
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
