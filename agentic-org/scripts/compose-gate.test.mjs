import assert from 'node:assert/strict';
import test from 'node:test';
import { DIVERSITY_WAIVER_ENV, composeGateLine, composeGateStatus, editionDiversityWaiver, hasDatedForecastWithDissent } from './compose-gate.mjs';

const EDITION = '2026-09-05';
const line = (status) => composeGateLine(status);

test('a waiver names one edition and is inert on every other', () => {
  const waiver = editionDiversityWaiver(EDITION, EDITION);
  assert.equal(waiver.floor, 'forecast-dissent');
  assert.equal(waiver.edition, EDITION);
  assert.equal(waiver.source, DIVERSITY_WAIVER_ENV);

  // The property the whole shape exists for: a waiver left set applies to
  // exactly one paper. Every other edition sees nothing.
  for (const other of ['2026-09-04', '2026-09-06', '2027-09-05', '2026-10-05']) assert.equal(editionDiversityWaiver(other, EDITION), undefined);
  assert.equal(editionDiversityWaiver(EDITION, undefined), undefined);
  assert.equal(editionDiversityWaiver(EDITION, ''), undefined);
  assert.equal(editionDiversityWaiver(EDITION, '   '), undefined);
  // Surrounding whitespace from a shell or a compiled env block is not a
  // different date.
  assert.equal(editionDiversityWaiver(EDITION, ` ${EDITION}\n`).edition, EDITION);
});

test('a boolean waiver is refused, not ignored', () => {
  for (const value of ['1', '0', 'true', 'yes', 'always', '2026-9-5', '2026-09-05T00:00:00Z', 'today']) {
    assert.throws(() => editionDiversityWaiver(EDITION, value), /must name the one edition it waives as an ISO date "YYYY-MM-DD".*never waived by a boolean/su, `"${value}" must not be accepted`);
  }
});

test('the forecast floor reads epistemic, a dated next_update_utc and a named dissent', () => {
  const forecast = { epistemic: 'forecast', next_update_utc: '14:30', dissent: { agent: 'Vesta', argument: 'A plausible opposing reading.' } };
  assert.equal(hasDatedForecastWithDissent([forecast]), true);
  assert.equal(hasDatedForecastWithDissent([{ ...forecast, epistemic: 'inference' }]), false);
  assert.equal(hasDatedForecastWithDissent([{ ...forecast, next_update_utc: 'tomorrow' }]), false);
  assert.equal(hasDatedForecastWithDissent([{ ...forecast, dissent: { agent: 'Vesta' } }]), false);
  assert.equal(hasDatedForecastWithDissent([]), false);
});

test('the gate line renders all three gates at once', () => {
  const waiver = editionDiversityWaiver(EDITION, EDITION);
  // Today's real state: six PASSed pieces, four desk documents, no forecast.
  assert.equal(line(composeGateStatus({ edition: EDITION, passed: 6, desks: 4, forecast: false })), '# compose: passed=6/5 desks=4/4 diversity=missing(forecast)  → blocked');
  assert.equal(line(composeGateStatus({ edition: EDITION, passed: 6, desks: 4, forecast: false, waiver })), '# compose: passed=6/5 desks=4/4 diversity=waived(2026-09-05)  → waived');
  assert.equal(line(composeGateStatus({ edition: EDITION, passed: 6, desks: 4, forecast: true })), '# compose: passed=6/5 desks=4/4 diversity=ok  → ready');
  // A waiver never turns a different gate green.
  assert.equal(line(composeGateStatus({ edition: EDITION, passed: 4, desks: 3, forecast: false, waiver })), '# compose: passed=4/5 desks=3/4 diversity=waived(2026-09-05)  → blocked');
  assert.equal(line(composeGateStatus({ edition: EDITION, passed: 6, desks: 5, forecast: true })), '# compose: passed=6/5 desks=5/4 diversity=ok  → blocked');
  // An article set that could not be read reports unknown, and unknown blocks.
  assert.equal(line(composeGateStatus({ edition: EDITION, passed: 6, desks: 4, forecast: undefined, waiver })), '# compose: passed=6/5 desks=4/4 diversity=unknown  → blocked');
  // One line, always.
  for (const status of [composeGateStatus({ edition: EDITION, passed: 0, desks: 0, forecast: false })]) assert.equal(line(status).split('\n').length, 1);
});

test('a waived edition is one that was actually missing the forecast', () => {
  const waiver = editionDiversityWaiver(EDITION, EDITION);
  assert.equal(composeGateStatus({ edition: EDITION, passed: 6, desks: 4, forecast: true, waiver }).diversity.waived, false);
  assert.equal(composeGateStatus({ edition: EDITION, passed: 6, desks: 4, forecast: false, waiver }).diversity.waived, true);
  assert.equal(composeGateStatus({ edition: EDITION, passed: 6, desks: 4, forecast: false }).diversity.ok, false);
});
