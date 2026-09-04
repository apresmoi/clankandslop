import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HARD_LINT_NAMES, armedHardLintNames, buildEditionIndex, describeLintFlag, hardLintFlags, lintFiling, renderEditionIndex, writeEditionIndex } from './edition-index.mjs';
import { composeEdition, fileArticle, fileDesk, recordAssignment, reviewArticle } from './production-newsroom.mjs';

const EDITION = '2026-09-04';
const OWNERS = ['cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton'];
// Real slugs from content/topics.json: the index and file_article both read
// the live glossary, so a placeholder slug would flag every fixture.
const TOPICS = new Set(['oil', 'rates']);
const capitalize = (value) => value[0].toUpperCase() + value.slice(1);

const article = (id, agent, index) => ({
  id, edition_date: EDITION, section: ['world', 'markets', 'technology'][index % 3], kicker: 'Test',
  headline: `Headline ${id}`, deck: 'A complete sourced test deck.', epistemic: index === 1 ? 'forecast' : 'fact',
  byline: { desk: 'Test Desk', agents: [agent] }, timestamp: '12:00 UTC', revision: 1, next_update_utc: '14:30',
  topics: ['oil'],
  body: [`Alpha reports the mechanism [E1].`, `Beta confirms the second reading [E2].`, `Gamma disputes the timing [E1].`, `Delta closes on the operating fact [E2].`],
  key_numbers: [],
  evidence_box: [
    { source: `Official ${index}`, fragment: 'fact', as_of: EDITION, source_note: { source_id: 'E1', source_kind: 'public_url', used_by_agent: agent, source_url: `https://source${index}.example/evidence`, retrieved_at: `${EDITION}T10:00:00Z` } },
    { source: `Second ${index}`, fragment: 'fact', as_of: EDITION, source_note: { source_id: 'E2', source_kind: 'public_url', used_by_agent: agent, source_url: `https://second${index}.example/evidence`, retrieved_at: `${EDITION}T10:00:00Z` } }
  ],
  refs: ['E1', 'E2'],
  ...(index === 1 ? { dissent: { agent: 'Vesta', p: 0.4, argument: 'The named dissenter identifies a plausible countercase.' } } : {}),
  ...(index === 0 ? { art: { hero_map: 'world-map' } } : {})
});
const page = (name, ids, map) => name === 'front'
  ? { edition: EDITION, page: name, paper: 'broadsheet', lead: ids[0], splitWith: ids[1], rail: [ids[2]], flow: [{ block: 'MapGlyph', props: { map } }, { block: 'GlyphArt', props: { glyph: 'signal' } }] }
  : { edition: EDITION, page: name, paper: 'ticker', articles: [ids[0]], article: ids[1], flow: [] };

const indexPath = (state) => path.join(state, 'editions', EDITION, 'INDEX');
const readIndex = (state) => readFile(indexPath(state), 'utf8');
const rows = (text, kind) => text.split('\n').filter((line) => line.startsWith(`${kind} `));

// Drives the newsroom to a complete edition through the real tool functions,
// asserting after each one that its own write refreshed the INDEX. This is the
// "every converge path" test: assignment, filing, verdict, PASS promotion,
// desk document and page each get their own before/after check.
async function driveEdition(state) {
  process.env.CLANK_EDITION_STATE_ROOT = state;
  const seen = [];
  const step = async (label, run) => {
    await rm(indexPath(state), { force: true });
    await run();
    const text = await readIndex(state).catch(() => undefined);
    assert.ok(text !== undefined, `${label} did not regenerate the edition INDEX`);
    seen.push([label, text]);
    return text;
  };

  const assignments = OWNERS.map((owner, index) => ({ id: `story-${index}`, owner, brief: `Report the verified mechanism and countercase for story number ${index}.`, evidence_refs: [`https://source${index}.example/evidence`] }));
  const afterAssignment = await step('record_assignment', () => recordAssignment({ edition: EDITION, event_key: 'schedule:conference-1', assignments }));
  assert.equal(rows(afterAssignment, 'A').length, 5);
  assert.match(afterAssignment, /^A cogsworth story-0 refs=1 +\| Report the verified mechanism/mu);

  const afterFiling = await step('file_article', async () => {
    for (const [index, owner] of OWNERS.entries()) { process.env.CLANK_NEWSROOM_AGENT = owner; await fileArticle({ edition: EDITION, event_key: `filing-${index}`, article: article(`story-${index}`, capitalize(owner), index) }); }
  });
  assert.equal(rows(afterFiling, 'F').length, 5);
  assert.match(afterFiling, /^F story-0 rev=1 owner=cogsworth epi=fact words=\d+ refs=2 domains=2 topics=ok lint=ok$/mu);

  process.env.CLANK_NEWSROOM_AGENT = 'spike';
  const afterRevision = await step('review_article REVISION_REQUEST', () => reviewArticle({ edition: EDITION, event_key: 'verdict-request', article_id: 'story-0', revision: 1, verdict: 'REVISION_REQUEST', notes: 'Resolve the countercase.' }));
  assert.match(afterRevision, /^V story-0 rev=1 REVISION_REQUEST by=spike$/mu);
  assert.equal(rows(afterRevision, 'P').length, 0, 'a REVISION_REQUEST must not promote a P row');

  process.env.CLANK_NEWSROOM_AGENT = 'cogsworth';
  await fileArticle({ edition: EDITION, event_key: 'refile-0', article: { ...article('story-0', 'Cogsworth', 0), revision: 2, deck: 'A revised sourced deck.' } });
  process.env.CLANK_NEWSROOM_AGENT = 'spike';
  const afterPass = await step('review_article PASS promotion', async () => {
    for (const [index] of OWNERS.entries()) await reviewArticle({ edition: EDITION, event_key: `verdict-pass-${index}`, article_id: `story-${index}`, revision: index === 0 ? 2 : 1, verdict: 'PASS', notes: 'Sources and voice pass.' });
  });
  assert.equal(rows(afterPass, 'P').length, 5);
  assert.match(afterPass, /^P story-0 rev=2 section=world epi=fact key_numbers=0 +\| Headline story-0 \| A revised sourced deck\.$/mu);

  const afterDesk = await step('file_desk', async () => {
    process.env.CLANK_NEWSROOM_AGENT = 'ledger'; for (const name of ['ledger.settlements', 'ledger.worlddesk']) await fileDesk({ edition: EDITION, event_key: name, name, document: { version: 'test' } });
    process.env.CLANK_NEWSROOM_AGENT = 'caslon'; for (const name of ['caslon.chrome', 'caslon.weather']) await fileDesk({ edition: EDITION, event_key: name, name, document: { version: 'test' } });
  });
  assert.equal(rows(afterDesk, 'D').length, 4);
  assert.match(afterDesk, /^D caslon\.chrome keys=1$/mu);

  const ids = OWNERS.map((_, index) => `story-${index}`);
  const afterCompose = await step('compose_edition', () => composeEdition({
    edition: EDITION, event_key: 'compose-1',
    pages: [{ name: 'front', document: page('front', ids.slice(0, 3), 'world-map') }, { name: 'tape', document: page('tape', ids.slice(3)) }],
    maps: [{ name: 'world-map', document: { version: 'test' } }]
  }));
  assert.equal(rows(afterCompose, 'G').length, 2);
  assert.match(afterCompose, /^G front articles=3 visuals=2 papers=broadsheet lead=story-0$/mu);

  assert.equal(seen.length, 6, 'six converge paths must each regenerate the index');
  return afterCompose;
}

test('every converge path regenerates the edition INDEX', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-index-'));
  try {
    const text = await driveEdition(path.join(temporary, 'state'));
    assert.match(text, /^# clank\.edition-index\.v1 edition=2026-09-04 generated=\S+ assignments=5 filings=6 verdicts=6 passed=5$/mu);
    assert.match(text, /^# rows: A assignment · F filing · V verdict · P passed article · D desk doc · G page$/mu);
    assert.match(text, /^# read one: cat filings\/<id>\/<rev>\.json \| cat articles\/<id>\.json \| cat verdicts\/<id>\/<rev>\.json$/mu);
    // The whole point of the file: it stays small enough to read every wake.
    assert.ok(Buffer.byteLength(text) < 6000, `edition INDEX grew to ${Buffer.byteLength(text)} bytes`);
  } finally {
    delete process.env.CLANK_NEWSROOM_AGENT;
    await rm(temporary, { recursive: true, force: true });
  }
});

// Mutation guard for the fail-closed contract. If writeEditionIndex ever
// swallows its errors (or a caller wraps it in try/catch), the tool call below
// starts succeeding and this test goes red.
test('a failed index write fails the tool call', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-index-fail-'));
  const state = path.join(temporary, 'state');
  process.env.CLANK_EDITION_STATE_ROOT = state;
  try {
    // A non-empty directory where the INDEX file belongs: the rename that
    // publishes the index fails with EISDIR, exactly as a full disk or a
    // read-only mount would.
    await mkdir(path.join(state, 'editions', EDITION, 'INDEX'), { recursive: true });
    await writeFile(path.join(state, 'editions', EDITION, 'INDEX', 'occupied'), 'x');
    const assignments = OWNERS.map((owner, index) => ({ id: `story-${index}`, owner, brief: `Report the verified mechanism and countercase for story number ${index}.`, evidence_refs: [] }));
    await assert.rejects(recordAssignment({ edition: EDITION, event_key: 'schedule:blocked-index', assignments }), (error) => error.code === 'EISDIR' || /EISDIR|ENOTDIR|EPERM|EACCES/u.test(error.message));

    process.env.CLANK_NEWSROOM_AGENT = 'cogsworth';
    await assert.rejects(fileArticle({ edition: EDITION, event_key: 'blocked-filing', article: article('story-0', 'Cogsworth', 0) }), /EISDIR|ENOTDIR|EPERM|EACCES/u);
  } finally {
    delete process.env.CLANK_NEWSROOM_AGENT;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('lint flags are computed from the filing, not re-derived by the editor', () => {
  const clean = article('story-0', 'Cogsworth', 0);
  assert.deepEqual(lintFiling(clean, TOPICS), []);

  // A citation with no source note behind it.
  const missing = structuredClone(clean);
  missing.body = [...clean.body.slice(0, 3), 'Epsilon leans on a note nobody filed [E4].'];
  assert.deepEqual(lintFiling(missing, TOPICS), ['cite_missing:E4']);

  // References listed out of evidence_box order.
  const disordered = structuredClone(clean);
  disordered.refs = ['E2', 'E1'];
  assert.deepEqual(lintFiling(disordered, TOPICS), ['refs_order']);

  // A reference the evidence box does not carry at all.
  const stray = structuredClone(clean);
  stray.refs = ['E1', 'E2', 'E9'];
  assert.deepEqual(lintFiling(stray, TOPICS), ['refs_subset']);

  // A source note the body never reaches, by label or by id.
  const unused = structuredClone(clean);
  unused.body = clean.body.map((paragraph) => paragraph.replaceAll('[E2]', '[E1]'));
  assert.deepEqual(lintFiling(unused, TOPICS), ['cite_unused:E2']);

  const oneDomain = structuredClone(clean);
  oneDomain.evidence_box[1].source_note.source_url = 'https://source0.example/other';
  assert.deepEqual(lintFiling(oneDomain, TOPICS), ['domains<2']);

  const named = structuredClone(clean);
  named.body = [...clean.body.slice(0, 3), 'Cogsworth walked the line himself [E2].'];
  assert.deepEqual(lintFiling(named, TOPICS), ['persona_in_body']);

  const offGlossary = structuredClone(clean);
  offGlossary.topics = ['oil', 'not-a-real-slug'];
  assert.deepEqual(lintFiling(offGlossary, TOPICS), ['topic_unknown:not-a-real-slug']);

  const stuck = structuredClone(clean);
  stuck.body = ['Beijing opened [E1].', 'Beijing closed [E2].', 'Gamma disputes [E1].', 'Delta closes [E2].'];
  assert.deepEqual(lintFiling(stuck, TOPICS), ['openers']);

  // Two paragraphs opening on "The" is ordinary English, not a stuck rhythm.
  const ordinary = structuredClone(clean);
  ordinary.body = ['The ministry opened [E1].', 'The ministry closed [E2].', 'Gamma disputes [E1].', 'Delta closes [E2].'];
  assert.deepEqual(lintFiling(ordinary, TOPICS), []);

  const noUrl = structuredClone(clean);
  delete noUrl.evidence_box[1].source_note.source_url;
  assert.deepEqual(lintFiling(noUrl, TOPICS), ['domains<2', 'public_url_no_url']);

  // The older archive convention: long source ids, cited positionally.
  const positional = structuredClone(clean);
  positional.evidence_box[0].source_note.source_id = 'press:reuters:one';
  positional.evidence_box[1].source_note.source_id = 'gov:ministry:two';
  positional.refs = ['press:reuters:one', 'gov:ministry:two'];
  assert.deepEqual(lintFiling(positional, TOPICS), []);

  assert.deepEqual(hardLintFlags(['refs_order', 'openers', 'cite_unused:E2', 'domains<2', 'topic_unknown:x', 'cite_missing:E4', 'persona_in_body', 'refs_subset']), ['domains<2', 'topic_unknown:x', 'cite_missing:E4', 'persona_in_body', 'refs_subset']);
  assert.match(describeLintFlag('cite_missing:E4'), /^article\.body cites a source id .*\(E4\)$/u);
});

test('hard lint rejection is off by default and names the field when armed', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-hardlint-'));
  const state = path.join(temporary, 'state');
  process.env.CLANK_EDITION_STATE_ROOT = state;
  try {
    const assignments = OWNERS.map((owner, index) => ({ id: `story-${index}`, owner, brief: `Report the verified mechanism and countercase for story number ${index}.`, evidence_refs: [] }));
    await recordAssignment({ edition: EDITION, event_key: 'schedule:hardlint', assignments });
    process.env.CLANK_NEWSROOM_AGENT = 'cogsworth';
    const broken = article('story-0', 'Cogsworth', 0);
    broken.body = [...broken.body.slice(0, 3), 'Epsilon leans on a note nobody filed [E4].'];

    delete process.env.CLANK_FILE_ARTICLE_HARD_LINT;
    const filed = await fileArticle({ edition: EDITION, event_key: 'hardlint-off', article: broken });
    assert.equal(filed.article_id, 'story-0', 'the flag is off by default and a hard-lint filing still lands');
    const text = await readIndex(state);
    assert.match(text, /^F story-0 rev=1 .* lint=cite_missing:E4$/mu, 'the flag rides the F row whether or not rejection is armed');

    process.env.CLANK_FILE_ARTICLE_HARD_LINT = '1';
    await assert.rejects(
      fileArticle({ edition: EDITION, event_key: 'hardlint-on', article: { ...broken, revision: 1, deck: 'Another deck.' } }),
      /filing rejected on 1 mechanical check .*cite_missing:E4 — article\.body cites a source id/u
    );
    // An advisory-only defect still files with the flag armed.
    const advisory = structuredClone(article('story-1', 'Sprockett', 1));
    advisory.refs = ['E2', 'E1'];
    process.env.CLANK_NEWSROOM_AGENT = 'sprockett';
    await assert.doesNotReject(fileArticle({ edition: EDITION, event_key: 'hardlint-advisory', article: advisory }));
  } finally {
    delete process.env.CLANK_FILE_ARTICLE_HARD_LINT;
    delete process.env.CLANK_NEWSROOM_AGENT;
    await rm(temporary, { recursive: true, force: true });
  }
});

// 78 of the 362 published headlines carry an embedded newline, and a deck can
// run past a screen. One row must stay one line whatever the content is.
test('a row is one line no matter what the headline carries', () => {
  const hostile = {
    edition: EDITION, generated: 'now',
    assignments: [{ id: 'x', owner: 'foreman', brief: 'A brief\nsplit across\nlines and | carrying a separator, then padded out well past the hundred and twenty character cut so the truncation itself is exercised too.', evidence_refs: [] }],
    filings: [{ id: 'x', revision: 1, owner: 'fore man', epistemic: 'fa ct', words: 1, refs: 1, domains: 1, flags: ['topic_unknown:od d', 'domains<2'] }],
    verdicts: [{ id: 'x', revision: 1, verdict: 'PA\nSS' }],
    articles: [{ id: 'x', revision: 1, section: 'wo\nrld', epistemic: 'fact', key_numbers: 0, headline: 'A Headline\nBroken Over\nThree Lines', deck: 'A deck | with a separator\nand a newline.' }],
    desks: [{ name: 'ledger.settlements', keys: 1 }],
    pages: [{ name: 'front', articles: 1, visuals: 2, papers: 'broad sheet', lead: 'x' }]
  };
  const lines = renderEditionIndex(hostile).trim().split('\n');
  assert.equal(lines.length, 3 + 6, 'three header lines and exactly one line per record');
  for (const line of lines) assert.doesNotMatch(line, /[\n\r]/u);
  assert.match(lines[3], /^A foreman x refs=0 +\| A brief split across lines and \/ carrying a separator.*…$/u);
  assert.match(lines[4], /^F x rev=1 owner=fore-man epi=fa-ct words=1 refs=1 domains=1 topics=unknown:od-d lint=domains<2$/u);
  assert.match(lines[5], /^V x rev=1 PA-SS by=spike$/u);
  assert.match(lines[6], /^P x rev=1 section=wo-rld epi=fact key_numbers=0 +\| A Headline Broken Over Three Lines \| A deck \/ with a separator and a newline\.$/u);
});

test('an empty edition still renders a readable index', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-index-empty-'));
  try {
    const text = await writeEditionIndex(path.join(temporary, 'state'), EDITION, { knownTopics: TOPICS });
    assert.equal(text.trim().split('\n').length, 3, 'an empty edition is three header lines and nothing else');
    assert.match(text, /assignments=0 filings=0 verdicts=0 passed=0/u);
    assert.equal(await buildEditionIndex(path.join(temporary, 'state'), EDITION, { knownTopics: TOPICS, now: new Date(0) }).then((value) => value.includes('generated=1970-01-01T00:00:00.000Z')), true);
    await assert.rejects(writeEditionIndex(path.join(temporary, 'state'), 'not-a-date'), /must be an ISO date/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('the hard lint switch arms nothing, everything, or a named subset', () => {
  assert.deepEqual(armedHardLintNames(undefined), []);
  assert.deepEqual(armedHardLintNames('0'), []);
  assert.deepEqual(armedHardLintNames('1'), HARD_LINT_NAMES);
  assert.deepEqual(armedHardLintNames('cite_missing,persona_in_body'), ['cite_missing', 'persona_in_body']);
  assert.throws(() => armedHardLintNames('openers'), /no such hard lint flag: openers/u);
  // The staged rollout: the four flags that fire on none of the 362 published
  // articles are armable without arming domains<2, which fires on 25 of them.
  const staged = ['refs_subset', 'cite_missing', 'topic_unknown', 'persona_in_body'];
  assert.deepEqual(hardLintFlags(['domains<2', 'cite_missing:E4'], staged), ['cite_missing:E4']);
});
