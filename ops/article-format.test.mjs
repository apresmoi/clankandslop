import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { articleFormatFindings, articleFilingSchema, ARTICLE_REPORTER_NAMES, proseLeakFindings } from './article-format.mjs';

const read = (file) => JSON.parse(readFileSync(new URL(`../content/${file}`, import.meta.url), 'utf8'));
const fact = read('editions/2026-08-21/articles/deepseek-ships-flash-vision-on-the-api.json');
const publishedForecast = read('editions/2026-08-09/articles/syria-takes-the-airport-russia-keeps-the-question.json');
const hormuzForecast = read('editions/2026-09-11/articles/s-df5507bc.json');
const alstomOrder = read('editions/2026-09-11/articles/s-044c222e.json');
const khasabStrike = read('editions/2026-09-11/articles/s-69b40b89.json');
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

test('eclipse art requires both shape "eclipse" and roll "eclipse"', () => {
  const validEclipse = structuredClone(fact);
  validEclipse.art = { kind: 'ascii', shape: 'eclipse', roll: 'eclipse', caption: 'The Moon crosses the Sun.' };
  assert.deepEqual(articleFormatFindings(validEclipse, context).errors, []);

  const shapeOnly = structuredClone(fact);
  shapeOnly.art = { kind: 'ascii', shape: 'eclipse', caption: 'No roll.' };
  const shapeErrors = articleFormatFindings(shapeOnly, context).errors;
  assert.ok(shapeErrors.some(e => e.path === 'article.art.shape' && e.code === 'asset' && e.message.includes('eclipse shape requires roll eclipse')));

  const rollOnly = structuredClone(fact);
  rollOnly.art = { kind: 'ascii', roll: 'eclipse', caption: 'No shape.' };
  const rollErrors = articleFormatFindings(rollOnly, context).errors;
  assert.ok(rollErrors.some(e => e.path === 'article.art.roll' && e.code === 'asset' && e.message.includes('eclipse roll requires shape eclipse')));

  const mismatchedRoll = structuredClone(fact);
  mismatchedRoll.art = { kind: 'ascii', shape: 'chip', roll: 'eclipse', caption: 'Mismatched.' };
  const mismatchedRollErrors = articleFormatFindings(mismatchedRoll, context).errors;
  assert.ok(mismatchedRollErrors.some(e => e.path === 'article.art.roll' && e.code === 'asset'));

  const mismatchedShape = structuredClone(fact);
  mismatchedShape.art = { kind: 'ascii', shape: 'eclipse', roll: 'chip', caption: 'Mismatched.' };
  const mismatchedShapeErrors = articleFormatFindings(mismatchedShape, context).errors;
  assert.ok(mismatchedShapeErrors.some(e => e.path === 'article.art.shape' && e.code === 'asset'));
});

test('high-confidence prose leaks report bounded reader-facing paths', () => {
  const article = structuredClone(fact);
  article.headline = 'A Sensor Answer Becomes Policy';
  article.deck = 'The only assigned source row carries the count.';
  article.body = [
    'A sensor answer found the posted order [E1].',
    'This filing does not treat adjacent claims as proof [E1].',
    'The fuller sensor return gives the geography [E1].',
    'The null reading has to be paid in full [E1].'
  ];
  article.art = { kind: 'map', map: 'hormuz', caption: 'A sensor-supplied review fixes the point.' };
  article.presentation = { flashpoint: { place: 'HORMUZ', lat: 26.57, lon: 56.25, note: 'The null case is boring and important.' } };
  const before = JSON.stringify(article);
  const findings = proseLeakFindings(article);
  assert.deepEqual(findings.map((finding) => finding.path), [
    'article.headline',
    'article.deck',
    'article.body[0]',
    'article.body[1]',
    'article.body[2]',
    'article.body[3]',
    'article.art.caption',
    'article.presentation.flashpoint.note'
  ]);
  assert.ok(findings.every((finding) => finding.code === 'prose_leak'));
  assert.equal(JSON.stringify(article), before);
});

test('prose leak gate catches actual September defects in filings only', () => {
  const gravesErrors = articleFormatFindings(hormuzForecast, { ...context, owner: 'graves' }).errors;
  assert.ok(gravesErrors.some((error) => error.path === 'article.body[0]' && error.code === 'prose_leak'));
  assert.ok(gravesErrors.some((error) => error.path === 'article.body[1]' && error.code === 'prose_leak'));

  const cogsworthErrors = articleFormatFindings(alstomOrder, { ...context, owner: 'cogsworth' }).errors;
  assert.ok(cogsworthErrors.some((error) => error.path === 'article.body[6]' && error.code === 'prose_leak'));

  const sprockettErrors = articleFormatFindings(khasabStrike, { ...context, owner: 'sprockett' }).errors;
  assert.ok(sprockettErrors.some((error) => error.path === 'article.body[4]' && error.code === 'prose_leak'));

  assert.deepEqual(articleFormatFindings(hormuzForecast, { ...context, profile: 'archive' }).errors, []);
  assert.deepEqual(articleFormatFindings(alstomOrder, { ...context, profile: 'archive' }).errors, []);
  assert.deepEqual(articleFormatFindings(khasabStrike, { ...context, profile: 'archive' }).errors, []);
});

test('prose leak checks do not ban ordinary source language or provenance notes', () => {
  const article = structuredClone(fact);
  article.body = [
    'A sensor-equipped match ball helped officials mark the contact point [E1].',
    'The null hypothesis survived the first test, while the SEC filing named a risk factor [E1].',
    'The company submitted its response to the SEC. This filing does not name a buyer [E1].',
    'The record describes a sensor model, not a newsroom process [E1].',
    'The sensor readout showed the reactor had cooled [E1].',
    'The robot uses sensor-provided temperature measurements [E1].'
  ];
  article.evidence_box[0].fragment = 'Sensor-supplied finding: this filing does not treat adjacent reports as proof.';
  article.evidence_box[0].source_note.provenance_note = 'A sensor answer supplied this source row to the reporter.';
  article.art = { kind: 'map', map: 'hormuz', caption: 'A sensor buoy reported wave height near the strait.' };
  const before = JSON.stringify(article);
  assert.deepEqual(proseLeakFindings(article), []);
  assert.deepEqual(articleFormatFindings(article, context).errors, []);
  assert.equal(JSON.stringify(article), before);
});

test('known internal wording is rejected in the reader-facing kicker', () => {
  const article = structuredClone(fact);
  article.kicker = 'The assigned source row';
  assert.ok(articleFormatFindings(article, context).errors.some(row => row.path === 'article.kicker' && row.code === 'prose_leak'));
});

test('physical sensor prose does not exempt separate newsroom prose leaks', () => {
  const article = structuredClone(fact);
  article.body = [
    'The sensor readout showed the reactor had cooled [E1].',
    'The robot uses sensor-provided temperature measurements [E1].',
    'The same sensor answer says Reuters did not publish individual crossing times [E1].',
    'A sensor-supplied UKMTO report plotted the count [E1].'
  ];
  const findings = proseLeakFindings(article);
  assert.deepEqual(findings.map((finding) => finding.path), ['article.body[2]', 'article.body[3]']);
  const errors = articleFormatFindings(article, context).errors;
  assert.ok(errors.some((error) => error.path === 'article.body[2]' && error.code === 'prose_leak'));
  assert.ok(errors.some((error) => error.path === 'article.body[3]' && error.code === 'prose_leak'));
});

test('prose leak checks exempt only evidenced quoted spans', () => {
  const article = structuredClone(fact);
  article.body = [
    'The quoted finding says “The null case is boring and important” [E1].',
    'The quoted finding says “The null case is boring and important.”',
    'The quoted finding says “The null case is boring and important” [E1]. The null case is boring and important outside the quote [E1].',
    'The quoted finding says “A sensor answer found the permit” [E1].'
  ];
  article.evidence_box[0].fragment = 'The null case is boring and important';
  const findings = proseLeakFindings(article);
  assert.deepEqual(findings.map((finding) => finding.path), [
    'article.body[1]',
    'article.body[2]',
    'article.body[3]'
  ]);
  assert.ok(articleFormatFindings(article, context).errors.some((error) => error.path === 'article.body[1]' && error.code === 'prose_leak'));
  assert.ok(articleFormatFindings(article, context).errors.some((error) => error.path === 'article.body[2]' && error.code === 'prose_leak'));
  assert.ok(articleFormatFindings(article, context).errors.some((error) => error.path === 'article.body[3]' && error.code === 'prose_leak'));
});
