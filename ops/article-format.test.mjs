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

test('a two-paragraph brief files, because ARTICLE_FORMAT.md says it is a whole article', () => {
  // ARTICLE_FORMAT.md: the body is an "Array of at least TWO purposeful prose
  // paragraphs", "A BRIEF — exactly two such paragraphs — is a complete,
  // publishable article, not a stub and not a teaser", and the minimum is "a
  // floor for shape, never a quota to fill".
  //
  // The filing schema used to demand four, so file_article answered a brief with
  // `/article/body must NOT have fewer than 4 items`. On 2026-09-27 Cogsworth and
  // Foreman each wrote two sourced paragraphs on two captured sentences, could not
  // file them, and Spike reported the rows dead as "filing refused under four body
  // items" — two stories lost to a schema that contradicted the format it enforced.
  // The reporters were right, the document was right, and the tool was wrong.
  const lengthErrors = (article) => articleFormatFindings(article, context).errors
    .filter((error) => error.path === 'article.body' && error.code === 'length');
  assert.equal(articleFilingSchema.properties.body.minItems, 2);
  assert.deepEqual(lengthErrors({ ...fact, body: fact.body.slice(0, 2) }), [],
    'a two-paragraph brief is the shape the format blesses and must file');
  assert.deepEqual(lengthErrors({ ...fact, body: fact.body.slice(0, 3) }), []);
  assert.deepEqual(lengthErrors(fact), []);
  // Two is a floor, not an invitation: one paragraph is still a stub.
  assert.equal(lengthErrors({ ...fact, body: fact.body.slice(0, 1) }).length, 1,
    'a single paragraph must still be refused');
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


test('September 12 process leaks fail new filing without changing the frozen archive', () => {
  for (const [id, owner, path] of [
    ['s-879a23cb', 'graves', 'article.body[1]'],
    ['s-ab60303c', 'tinkerton', 'article.body[0]'],
    ['s-ab60303c', 'tinkerton', 'article.body[2]'],
    ['s-b70d24bb', 'sprockett', 'article.body[3]'],
    ['s-4bd5de6c', 'cogsworth', 'article.body[3]'],
  ]) {
    const article = read(`editions/2026-09-12/articles/${id}.json`);
    const before = JSON.stringify(article);
    const filing = articleFormatFindings(article, { ...context, owner });
    assert.ok(filing.errors.some(error => error.path === path && error.code === 'prose_leak'), id);
    assert.deepEqual(articleFormatFindings(article, { ...context, profile: 'archive' }).errors, []);
    assert.equal(JSON.stringify(article), before);
  }
});

test('key number labels and values cannot bypass the public prose gate', () => {
  const article = structuredClone(fact);
  article.key_numbers = [
    { label: 'The supplied Record', value: 'Two rows' },
    { label: 'Source', value: 'The story file does not establish the figure' },
    { label: 'The assigned source row', value: 'No count' }
  ];
  assert.deepEqual(proseLeakFindings(article).map(row => row.path), [
    'article.key_numbers[0].label',
    'article.key_numbers[1].value',
    'article.key_numbers[2].label'
  ]);
  assert.equal(articleFormatFindings(article, context).errors.filter(row => row.code === 'prose_leak').length, 3);
});

test('new leak checks preserve ordinary reporting, source notes and evidenced quotations', () => {
  const article = structuredClone(fact);
  article.body = [
    'The company supplied records to the regulator, which prepared a report [E1].',
    'An attacker-supplied file escaped the filter, while a user-supplied file did not [E1].',
    'The court-prepared record and a specially prepared file supported the appeal [E1].',
    'The court filing does not name a buyer; the public record remains incomplete [E1].',
    'The agency supplied evidence to the committee, whose report does not establish the cause [E1].',
    'The supplied fuel reached the port, while the record shows deliveries fell [E1].',
    'The witness said “the story file does not establish the count” [E1].'
  ];
  article.key_numbers = [{ label: 'Public record', value: 'Two crossings' }];
  article.evidence_box[0].fragment = 'the story file does not establish the count';
  article.evidence_box[0].source_note.provenance_note = 'The supplied Record is a summary from the story file.';
  assert.deepEqual(proseLeakFindings(article), []);
  article.body.push('The article can say the crossing closed [E1].');
  assert.deepEqual(proseLeakFindings(article).map(row => row.path), ['article.body[7]']);
});

// Attributed reporting, 2026-10-06. The quote checker cannot open Reuters (401),
// so those rows arrive as `evidence: "attributed_unchecked"`: usable as
// "Reuters reported that …", never quoted, never the only support.
const REUTERS_NOTE = 'Source page could not be opened by the checker (http_401); use only as attributed reporting ("<outlet> reported that …"), paraphrased, never inside quotation marks and never as a quote or captured excerpt.';
const attributedFiling = (body, { verified = true, marker = true } = {}) => {
  const article = structuredClone(fact);
  article.evidence_box = [
    { ...article.evidence_box[0], source_note: { ...article.evidence_box[0].source_note, ...(verified ? { raw_excerpt: article.evidence_box[0].fragment } : {}) } },
    { source: 'Reuters', fragment: 'DeepSeek priced the vision model at Flash rates, a company spokesperson told Reuters.', as_of: '2026-08-21',
      source_note: { source_id: 'E2', source_kind: 'public_url', used_by_agent: 'Cogsworth', source_url: 'https://www.reuters.com/technology/deepseek-vision-2026-08-21/', retrieved_at: '2026-08-21T18:47:00Z', ...(marker ? { evidence: 'attributed_unchecked' } : {}), provenance_note: REUTERS_NOTE } },
  ];
  article.refs = ['E1', 'E2'];
  article.body = body;
  return article;
};
const attributedCodes = (article) => articleFormatFindings(article, context).errors.filter((error) => error.code.startsWith('attributed_')).map((error) => `${error.path}:${error.code}`);
const LEAD = 'DeepSeek’s API docs dated 21 August say DeepSeek-V4-Flash-Vision-Exp is live on the DeepSeek API Platform [E1].';

test('attributed reporting files as a paraphrase beside a verified excerpt', () => {
  const article = attributedFiling([LEAD, 'Reuters reported that the company priced the vision model at Flash rates [E2].']);
  assert.deepEqual(articleFormatFindings(article, context).errors, []);
});

test('a quotation-marked sentence citing attributed reporting is refused', () => {
  const quoted = attributedFiling([LEAD, 'Reuters reported the model was priced “at Flash rates, a company spokesperson” said [E2].']);
  assert.deepEqual(attributedCodes(quoted), ['article.body[1]:attributed_quote']);
  const straight = attributedFiling([LEAD, '"DeepSeek priced the vision model at Flash rates," a spokesperson told Reuters [E2].']);
  assert.deepEqual(attributedCodes(straight), ['article.body[1]:attributed_quote']);
  // The provenance note alone still marks the row, so dropping the marker is no way round it.
  const unmarked = attributedFiling([LEAD, '"DeepSeek priced the vision model at Flash rates," a spokesperson told Reuters [E2].'], { marker: false });
  assert.deepEqual(attributedCodes(unmarked), ['article.body[1]:attributed_quote']);
  // A verified excerpt may still be quoted in the same paragraph.
  const verifiedQuote = attributedFiling(['The docs say “DeepSeek-V4-Flash-Vision-Exp is now live on the DeepSeek API Platform” [E1]. Reuters reported that it costs Flash rates [E2].', LEAD]);
  assert.deepEqual(attributedCodes(verifiedQuote), []);
});

test('attributed reporting never carries a raw_excerpt', () => {
  const article = attributedFiling([LEAD, 'Reuters reported that the company priced the vision model at Flash rates [E2].']);
  article.evidence_box[1].source_note.raw_excerpt = article.evidence_box[1].fragment;
  assert.deepEqual(attributedCodes(article), ['article.evidence_box[1].source_note.raw_excerpt:attributed_quote']);
});

test('attributed reporting cannot be a filing’s only support', () => {
  const article = attributedFiling([LEAD, 'Reuters reported that the company priced the vision model at Flash rates [E2].'], { verified: false });
  assert.deepEqual(attributedCodes(article), ['article.body:attributed_only']);
});
