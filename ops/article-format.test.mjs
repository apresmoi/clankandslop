import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { articleFormatFindings, articleFilingSchema, ARTICLE_REPORTER_NAMES } from './article-format.mjs';

const read = (file) => JSON.parse(readFileSync(new URL(`../content/${file}`, import.meta.url), 'utf8'));
const fact = read('editions/2026-08-21/articles/deepseek-ships-flash-vision-on-the-api.json');
const publishedForecast = read('editions/2026-08-09/articles/syria-takes-the-airport-russia-keeps-the-question.json');
const topicSlugs = Object.keys(read('topics.json').topics);
const context = { owner: 'cogsworth', topicSlugs };

test('the published August 21 fact passes unchanged, including quotes and structured key numbers', () => {
  const before = JSON.stringify(fact);
  assert.deepEqual(articleFormatFindings(fact, context).errors, []);
  assert.equal(JSON.stringify(fact), before);
  assert.deepEqual(articleFilingSchema.properties.byline.properties.agents.items.enum, Object.values(ARTICLE_REPORTER_NAMES));
});

test('an authored forecast passes without a forged dissent; published dissent uses archive context', () => {
  const { dissent, ...authored } = publishedForecast;
  assert.ok(dissent?.agent);
  const before = JSON.stringify(authored);
  assert.deepEqual(articleFormatFindings(authored, { topicSlugs, owner: 'sprockett' }).errors, []);
  assert.equal(JSON.stringify(authored), before);
  assert.ok(articleFormatFindings(publishedForecast, { topicSlugs, owner: 'sprockett' }).errors.some(e => e.code === 'authority'));
  assert.deepEqual(articleFormatFindings(publishedForecast, { profile: 'archive', topicSlugs }).errors, []);
});

test('format mutations report the offending field, without changing source text', () => {
  const mutations = [
    ['headline', a => { delete a.headline; }],
    ['extra', a => { a.extra = 'silently ignored'; }],
    ['byline.agents', a => { a.byline.agents = ['cogsworth']; }],
    ['byline.agents', a => { a.byline.agents.push('Tinkerton'); }],
    ['byline.agents', a => { a.byline.agents = ['Tinkerton']; }],
    ['key_numbers[0]', a => { a.key_numbers[0] = '384 tokens'; }],
    ['key_numbers[0].value', a => { a.key_numbers[0].value = 384; }],
    ['body[0]', a => { a.body[0] = { text: 'Unrenderable paragraph.' }; }],
    ['body[0]', a => { a.body[0] = '<script>run()</script> [E1]'; }],
    ['body[0]', a => { a.body[0] = 'A source claims this [E9].'; }],
    ['body[0]', a => { a.body[0] = 'A noncanonical anchor [E01].'; }],
    ['evidence_box[0].source_note.source_id', a => { a.evidence_box[0].source_note.source_id = 'E9'; a.refs[0] = 'E9'; a.body[0] = 'A source claims this [E9].'; }],
    ['evidence_box[0].source_note.source_id', a => { [a.evidence_box[0], a.evidence_box[1]] = [a.evidence_box[1], a.evidence_box[0]]; }],
    ['evidence_box[0].source_note.source_url', a => { a.evidence_box[0].source_note.source_url = 'javascript:alert(1)'; }],
    ['evidence_box[0].source_note.source_url', a => { delete a.evidence_box[0].source_note.source_url; }],
    ['evidence_box[0].source_note.raw_excerpt', a => { a.evidence_box[0].source_note.raw_excerpt = { quote: 'not text' }; }],
    ['evidence_box[0].source_note.used_by_agent', a => { a.evidence_box[0].source_note.used_by_agent = 'Tinkerton'; }],
    ['evidence_box[0].source_note.used_by_agent', a => { a.evidence_box[0].source_note.used_by_agent = 'cogsworth'; }],
    ['next_update_utc', a => { a.epistemic = 'forecast'; a.confidence = { label: 'CALL', value: 0.5 }; a.next_update_utc = '99:99'; }],
    ['confidence', a => { a.epistemic = 'forecast'; }],
    ['confidence.interval', a => { a.confidence = { label: 'CALL', value: 0.5, interval: '0.2' }; }],
    ['confidence.label', a => { a.confidence = { value: 0.5 }; }],
    ['topics[0]', a => { a.topics[0] = 'invented-topic'; }],
  ];
  for (const [field, mutate] of mutations) {
    const article = structuredClone(fact); mutate(article);
    const before = JSON.stringify(article);
    const result = articleFormatFindings(article, context);
    assert.ok(result.errors.some(error => error.path.startsWith(`article.${field}`)), `${field}: ${JSON.stringify(result.errors)}`);
    assert.equal(JSON.stringify(article), before, field);
  }
});

test('arbitrary JSON shapes produce findings rather than throwing', () => {
  for (const value of [null, [], '', 123, true, {}, { body: {}, byline: 8, evidence_box: [null, []], refs: {} }, { body: [null, []], art: { spots: 'x' }, previous_coverage: [null] }]) {
    assert.doesNotThrow(() => articleFormatFindings(value, context));
    assert.ok(articleFormatFindings(value, context).errors.length);
  }
});

test('source IDs retain original provenance while citations retain physical row positions', () => {
  const article = structuredClone(fact);
  article.evidence_box[0].source_note.source_id = 's-0c0be037';
  article.refs[0] = 's-0c0be037';
  article.body[0] += ' The literal quote was “He said \\"yes\\"” and Arabic: «مرحبا» [E1].';
  article.evidence_box[0].source_note.raw_excerpt = 'He said "yes"; C:\\records\\source.';
  const before = JSON.stringify(article);
  assert.deepEqual(articleFormatFindings(article, context).errors, []);
  assert.equal(JSON.stringify(article), before);
  assert.equal(articleFormatFindings(article, { ...context, forecastRequired: true }).errors.some(e => e.code === 'forecast'), true);
});


test('the reporter owns only the documented flashpoint presentation fields', () => {
  const article = structuredClone(fact);
  article.presentation = { flashpoint: { place: 'PANAMA', lat: 9.08, lon: -79.52, note: 'The booking limit changes. The schedule remains provisional.' } };
  const before = JSON.stringify(article);
  assert.deepEqual(articleFormatFindings(article, context).errors, []);
  assert.equal(JSON.stringify(article), before);
  for (const [field, mutate] of [
    ['article.presentation.teaser', a => { a.presentation.teaser = 'Caslon-owned text'; }],
    ['article.presentation.flashpoint.agent', a => { a.presentation.flashpoint.agent = 'Tinkerton'; }],
    ['article.presentation.flashpoint.article', a => { a.presentation.flashpoint.article = 'another-story'; }],
    ['article.presentation.flashpoint.lat', a => { a.presentation.flashpoint.lat = '9.08'; }],
    ['article.presentation.flashpoint.note', a => { delete a.presentation.flashpoint.note; }],
  ]) {
    const candidate = structuredClone(article); mutate(candidate);
    assert.ok(articleFormatFindings(candidate, context).errors.some(error => error.path === field), field);
  }
});

test('JSON keys inherited from Object.prototype remain unknown fields', () => {
  for (const key of ['__proto__', 'constructor', 'toString']) {
    const article = { ...fact, ...JSON.parse(`{"${key}":{}}`) };
    assert.ok(articleFormatFindings(article, context).errors.some(error => error.path === `article.${key}` && error.code === 'unknown_key'));
  }
});

test('consumer attribution binds strict filings without rewriting historical source metadata', () => {
  const article = structuredClone(fact);
  article.evidence_box[0].source_note.used_by_agent = 'Tinkerton';
  const before = JSON.stringify(article);
  const errors = articleFormatFindings(article, context).errors;
  assert.ok(errors.some(error => error.path === 'article.evidence_box[0].source_note.used_by_agent' && error.code === 'attribution'));
  assert.deepEqual(articleFormatFindings(article, { ...context, profile: 'archive' }).errors, []);
  assert.equal(JSON.stringify(article), before);
});
