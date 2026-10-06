import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { datesIn, forecastSettlementFindings, printedProbabilities } from './forecast-settlement.mjs';
import { articleFormatFindings } from './article-format.mjs';

const editions = new URL('../content/editions/', import.meta.url);
const read = (file) => JSON.parse(readFileSync(new URL(file, editions), 'utf8'));
const quebec = read('2026-10-06/articles/s-18e23011.json');
const codes = (article) => forecastSettlementFindings(article).map((finding) => finding.code);
const forecast = (overrides) => ({ epistemic: 'forecast', headline: 'Lula is a 42% shot at a fourth term', deck: 'Lula trails 45.16% to 47.03% before the 25 October runoff.', confidence: { label: "Yes if Brazil's electoral court names Lula winner of the 25 October runoff for a fourth term; no otherwise.", value: 0.42 }, ...overrides });

test('the 2026-10-06 Quebec forecast is refused: its label settles on a table posted by 12 October the deck never names', () => {
  const findings = forecastSettlementFindings(quebec);
  assert.deepEqual(findings.map((finding) => finding.code), ['forecast_deadline']);
  assert.match(findings[0].message, /12 October.*drop that condition from the label, or name the deadline in the deck/su);
  assert.ok(articleFormatFindings(quebec, { topicSlugs: quebec.topics }).errors.some((error) => error.code === 'forecast_deadline'), 'file_article refuses it through the filing preflight');
  assert.equal(articleFormatFindings(quebec, { profile: 'archive' }).errors.some((error) => error.code === 'forecast_deadline'), false, 'the published archive is not re-judged');
});

test('either repair clears it: the deck names the deadline, or the label drops the publication condition', () => {
  assert.deepEqual(codes({ ...quebec, deck: `${quebec.deck} The call settles on the official seat table posted by 12 October.` }), []);
  assert.deepEqual(codes({ ...quebec, deck: quebec.deck.replace('.', ', by Oct. 12.') }), []);
  assert.deepEqual(codes({ ...quebec, confidence: { ...quebec.confidence, label: 'Yes if Élections Québec posts a complete official seat table awarding the Parti Québécois 64 or more of 127 seats; no if it awards 63 or fewer.' } }), []);
});

test('forecast_probability: a printed probability must equal round(confidence.value * 100)', () => {
  assert.deepEqual(codes({ ...quebec, confidence: { ...quebec.confidence, value: 0.31 } }).filter((code) => code === 'forecast_probability'), ['forecast_probability', 'forecast_probability']);
  assert.deepEqual(codes(forecast({ deck: 'Prediction markets give Lula a 65% chance; the call is 42%.' })), [], 'quoted odds beside the house call pass');
  assert.deepEqual(codes(forecast({ deck: 'Prediction markets give Lula a 65% chance before the runoff.' })), [], 'attributed odds in the deck, house call in the headline');
  assert.deepEqual(codes(forecast({ deck: 'Prediction markets give Lula a 42% chance; the house call is 65%.' })), ['forecast_probability'], 'a matching quote cannot hide a wrong house call');
  assert.deepEqual(codes(forecast({ deck: 'The house call is 42%; a 65% chance is implied by prediction markets.' })), [], 'attribution after the figure counts');
  assert.deepEqual(codes(forecast({ deck: 'Prediction markets give Lula a 42% chance, but the house call is 65%.' })), ['forecast_probability'], 'attribution stays inside its clause');
  assert.deepEqual(codes(forecast({ confidence: { ...forecast().confidence, value: 0.424 } })), []);
  assert.deepEqual(codes(forecast({ deck: 'The call is 0.45 before the 25 October runoff.' })), ['forecast_probability']);
  assert.deepEqual(codes(forecast({ deck: 'The house gives it a 0.42 probability.' })), []);
  assert.deepEqual(codes(forecast({ deck: 'Market odds to 65.7% are a quote, not the call.' })), [], 'a quoted market price is not the house probability');
});

test('forecast_event: the headline event must be one the label settles, or one the deck ties to the label', () => {
  assert.deepEqual(codes(forecast({ headline: 'Lula is a 42% shot at a landslide' })), ['forecast_event']);
  assert.match(forecastSettlementFindings(forecast({ headline: 'Lula is a 42% shot at a landslide' }))[0].message, /"landslide".*never settles on/u);
  assert.deepEqual(codes({ ...quebec, deck: 'The party leads in 59 seats. Probability 28% by 12 October.' }), ['forecast_event'], 'without the deck tying "majority" to 64 seats the headline event floats free');
  assert.deepEqual(codes(forecast({ headline: 'Lula wins 42% of the vote' })), [], 'a vote share is not a probability');
  assert.deepEqual(codes(forecast({ headline: 'Lula is a 42% shot at a fourth term despite weak polling' })), [], 'context after the event is not the event');
  assert.deepEqual(codes(forecast({ headline: 'Lula is a 42% shot at a fourth term with a legislative majority' })), ['forecast_event'], 'an added condition is part of the event');
  assert.deepEqual(codes(forecast({ headline: 'Lula fights for a fourth term' })), [], 'no printed probability, no event phrase to compare');
});

test('non-forecasts and incomplete confidence are out of scope', () => {
  assert.deepEqual(codes({ ...quebec, epistemic: 'fact' }), []);
  assert.deepEqual(codes({ ...quebec, confidence: { label: quebec.confidence.label } }), []);
  assert.deepEqual(codes({ ...quebec, confidence: { value: 0.28 } }), []);
});

test('an ISO deadline in the deck counts, and a hostile label cannot stall the check', () => {
  const label = 'Yes if Lula wins a fourth term; no if no result is posted by 1 November 2026.';
  assert.deepEqual(codes(forecast({ deck: 'Results must be posted by 2026-11-01.', confidence: { value: 0.42, label } })), []);
  assert.deepEqual(codes(forecast({ confidence: { value: 0.42, label } })), ['forecast_deadline']);
  const start = performance.now();
  forecastSettlementFindings(forecast({ confidence: { value: 0.42, label: 'if no posted '.repeat(5000) } }));
  assert.ok(performance.now() - start < 200, 'linear in the label');
});

test('helpers read the common date and probability spellings', () => {
  assert.deepEqual(datesIn('by 16:00 UTC on 12 October 2026, or Oct. 3, or 1st Nov').map((date) => date.key), ['12-oct', '1-nov', '3-oct']);
  assert.deepEqual(printedProbabilities('a 28% shot; Probability 28%; 46 percent chance; a 0.82 probability; the call is 0.62').map((found) => found.value), [28, 46, 28, 82, 62]);
});

test('calibration: of every archived forecast, only the 2026-10-06 Quebec piece trips the check', () => {
  const flagged = [];
  let checked = 0;
  for (const date of readdirSync(editions).sort()) {
    const dir = new URL(`${date}/articles/`, editions);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
      const article = read(`${date}/articles/${file}`);
      if (article.epistemic !== 'forecast') continue;
      checked++;
      if (forecastSettlementFindings(article).length > 0) flagged.push(`${date}/${file}`);
    }
  }
  assert.ok(checked >= 33, `expected the archive's forecasts, read ${checked}`);
  assert.deepEqual(flagged, ['2026-10-06/s-18e23011.json']);
});
