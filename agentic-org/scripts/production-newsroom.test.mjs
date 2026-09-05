import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeEditionIndex } from './edition-index.mjs';
import { collectPublicArticleReferences, composeEdition, fileArticle, fileDesk, hasDatedForecastWithDissent, qualifySignal, recordAssignment, reviewArticle, stageRelease } from './production-newsroom.mjs';

const owners = ['cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton'];
const assignmentEvent = 'schedule:assignment-20260825';
const article = (id, agent, edition, index) => ({ id, edition_date: edition, section: ['world', 'markets', 'technology'][index % 3], kicker: 'Test', headline: `Headline ${id}`, deck: 'A complete sourced test deck.', epistemic: index === 1 ? 'forecast' : 'fact', byline: { desk: 'Test Desk', agents: [agent] }, timestamp: '12:00 UTC', revision: 1, next_update_utc: '14:30', topics: ['geopolitics'], body: ['One [E1].', 'Two [E1].', 'Three [E1].', 'Four [E1].'], key_numbers: [], evidence_box: [{ source: `Official ${index}`, fragment: 'fact', as_of: edition, source_note: { source_id: 'E1', source_kind: 'public_url', used_by_agent: agent, source_url: `https://source${index}.example/evidence`, retrieved_at: `${edition}T10:00:00Z` } }], refs: ['E1'], ...(index === 1 ? { dissent: { agent: 'Vesta', p: 0.4, argument: 'The named dissenter identifies a plausible opposing reading.' } } : {}), ...(index === 0 ? { art: { hero_map: 'world-map' } } : {}) });
const page = (name, ids, map) => name === 'front' ? { edition: '2026-08-25', page: name, paper: 'broadsheet', lead: ids[0], splitWith: ids[1], rail: [ids[2]], flow: [{ block: 'MapGlyph', props: { map } }, { block: 'GlyphArt', props: { glyph: 'signal' } }] } : { edition: '2026-08-25', page: name, paper: 'ticker', articles: [ids[0]], article: ids[1], flow: [] };

test('public references and forecast dissent use the exact contract', () => {
  assert.deepEqual(collectPublicArticleReferences({ article: 'a', lead: 'b', splitWith: 'c', rail: ['d'], articles: ['e'], ignored: 'f' }), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(hasDatedForecastWithDissent([{ epistemic: 'forecast', next_update_utc: '14:30' }, { dissent: { agent: 'Vesta', argument: 'No.' } }]), false);
  assert.equal(hasDatedForecastWithDissent([{ epistemic: 'forecast', next_update_utc: '14:30', dissent: { agent: 'Vesta', argument: 'No.' } }]), true);
});

test('production newsroom binds filings, composition content, and local release', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-production-'));
  const state = path.join(temporary, 'state'), source = path.join(temporary, 'source'), staging = path.join(temporary, 'staging'), edition = '2026-08-25';
  await mkdir(path.join(source, 'ops'), { recursive: true }); await mkdir(path.join(source, 'website', 'node_modules', 'astro', 'bin'), { recursive: true });
  const environmentProbe = "{OPENAI_API_KEY:process.env.OPENAI_API_KEY,MOLTNET_TOKEN:process.env.MOLTNET_TOKEN,CLANK_RUNTIME_SECRET:process.env.CLANK_RUNTIME_SECRET}";
  await writeFile(path.join(source, 'ops', 'validate-content.mjs'), `import{writeFileSync}from'node:fs';writeFileSync('validator-env.json',JSON.stringify(${environmentProbe}));\n`);
  await writeFile(path.join(source, 'website', 'node_modules', 'astro', 'bin', 'astro.mjs'), `import{writeFileSync}from'node:fs';writeFileSync('astro-env.json',JSON.stringify(${environmentProbe}));\n`);
  process.env.CLANK_EDITION_STATE_ROOT = state;
  const qualified = { edition, event_key: 'moltnet:sensor-production-1', summary: 'A sufficiently detailed qualified signal for the daily paper.', selected_desks: ['foreman', 'cogsworth'], evidence_refs: ['https://source0.example/evidence'] };
  await Promise.all([qualifySignal(qualified), qualifySignal(qualified)]);
  const assignments = owners.map((owner, index) => ({ id: `story-${index}`, owner, brief: `Report the verified mechanism and the falsifying fact for story number ${index}.`, evidence_refs: [`https://source${index}.example/evidence`] })); await recordAssignment({ edition, event_key: assignmentEvent, assignments });
  process.env.CLANK_NEWSROOM_AGENT = 'cogsworth';
  // A reporter's wake never carries assignment_event_key or the assigned id — file_article
  // resolves the assignment from (edition, owner) alone and self-corrects a wrong id.
  const wrongIdArticle = article('story-0', 'Cogsworth', edition, 0); wrongIdArticle.id = 'not-my-assigned-id';
  const autoResolved = await fileArticle({ edition, event_key: 'auto-resolved-id', article: wrongIdArticle });
  assert.equal(autoResolved.article_id, 'story-0');
  assert.match(autoResolved.note, /your assignment today is "story-0"/u);
  process.env.CLANK_NEWSROOM_AGENT = 'vesta';
  await assert.rejects(fileArticle({ edition, event_key: 'no-assignment-teaches', article: article('story-0', 'Vesta', edition, 0) }), /you have no assignment for edition/u);
  process.env.CLANK_NEWSROOM_AGENT = 'cogsworth';
  await assert.rejects(fileArticle({ edition, event_key: 'hostile-bad-owner', article: article('story-1', 'Sprockett', edition, 1) }), /filing agent/u);
  const badEvidence = article('story-0', 'Cogsworth', edition, 0); badEvidence.evidence_box[0].source_note.source_url = 'https://wrong.example'; await assert.rejects(fileArticle({ edition, event_key: 'hostile-bad-evidence', article: badEvidence }), /evidence/u);
  for (let index = 0; index < owners.length; index++) { const owner = owners[index]; process.env.CLANK_NEWSROOM_AGENT = owner; await fileArticle({ edition, event_key: `filing-${index}`, assignment_event_key: assignmentEvent, article: article(`story-${index}`, owner[0].toUpperCase() + owner.slice(1), edition, index) }); }
  process.env.CLANK_NEWSROOM_AGENT = 'spike'; await reviewArticle({ edition, event_key: 'request-0', article_id: 'story-0', revision: 1, verdict: 'REVISION_REQUEST', notes: 'Resolve the opposing reading.' });
  process.env.CLANK_NEWSROOM_AGENT = 'cogsworth'; await fileArticle({ edition, event_key: 'refile-0', assignment_event_key: assignmentEvent, article: { ...article('story-0', 'Cogsworth', edition, 0), revision: 2, deck: 'A revised sourced deck.' } });
  process.env.CLANK_NEWSROOM_AGENT = 'spike'; for (let index = 0; index < owners.length; index++) await reviewArticle({ edition, event_key: `review-${index}`, article_id: `story-${index}`, revision: index === 0 ? 2 : 1, verdict: 'PASS', notes: 'Sources and voice pass.' });
  process.env.CLANK_NEWSROOM_AGENT = 'ledger'; for (const name of ['ledger.settlements', 'ledger.worlddesk']) await fileDesk({ edition, event_key: name, name, document: { version: 'test' } });
  process.env.CLANK_NEWSROOM_AGENT = 'caslon'; for (const name of ['caslon.chrome', 'caslon.weather']) await fileDesk({ edition, event_key: name, name, document: { version: 'test' } });
  const ids = owners.map((_, index) => `story-${index}`), pages = [{ name: 'front', document: page('front', ids.slice(0, 3), 'world-map') }, { name: 'tape', document: page('tape', ids.slice(3)) }], maps = [{ name: 'world-map', document: { version: 'test' } }];
  await assert.rejects(composeEdition({ edition, event_key: 'compose-incomplete', pages: [pages[0], { name: 'tape', document: page('tape', [ids[3]]) }], maps }), /page completeness/u);
  await assert.rejects(composeEdition({ edition, event_key: 'compose-extra-map', pages, maps: [...maps, { name: 'unused-map', document: {} }] }), /maps must exactly/u); await composeEdition({ edition, event_key: 'compose-valid', pages, maps });
  process.env.CLANK_NEWSROOM_AGENT = 'pressman'; process.env.CLANK_PUBLIC_SOURCE_ROOT = source; process.env.CLANK_RELEASE_STAGING_ROOT = staging;
  const secrets = ['OPENAI_API_KEY', 'MOLTNET_TOKEN', 'CLANK_RUNTIME_SECRET']; for (const secret of secrets) process.env[secret] = 'must-not-propagate';
  for (const [kind, name] of [['desk', 'ledger.worlddesk'], ['pages', 'front'], ['maps', 'world-map']]) { const file = path.join(state, 'editions', edition, kind, `${name}.json`), bytes = await readFile(file, 'utf8'), changed = JSON.parse(bytes); changed.tampered = true; await writeFile(file, `${JSON.stringify(changed)}\n`); await assert.rejects(stageRelease({ edition, event_key: 'mutation' }), /digest changed/u); await writeFile(file, bytes); }
  const receiptRoot = path.join(state, 'editions', edition, 'receipts'), compositionName = (await readdir(receiptRoot)).find((name) => name.startsWith('composed-')), compositionPath = path.join(receiptRoot, compositionName), compositionBytes = await readFile(compositionPath, 'utf8');
  await writeFile(compositionPath, compositionBytes.replace('"digest":"sha256:', '"digest":"sha256:0')); await assert.rejects(stageRelease({ edition, event_key: 'release-valid' }), /authentication/u); await writeFile(compositionPath, compositionBytes);
  process.env.CLANK_RELEASE_CRASH_BEFORE_SWITCH = '1'; await assert.rejects(stageRelease({ edition, event_key: 'release-valid' }), /injected crash/u); await assert.rejects(readFile(path.join(staging, 'current-edition'))); delete process.env.CLANK_RELEASE_CRASH_BEFORE_SWITCH;
  const first = await stageRelease({ edition, event_key: 'release-valid' }), second = await stageRelease({ edition, event_key: 'release-valid' }); assert.equal(first.artifact_digest, second.artifact_digest); assert.equal(first.composition_digest, second.composition_digest);
  for (const file of [path.join(first.staging_root, 'validator-env.json'), path.join(first.staging_root, 'website', 'astro-env.json')]) { const childEnv = JSON.parse(await readFile(file, 'utf8')); for (const secret of secrets) assert.equal(childEnv[secret], undefined); } for (const secret of secrets) delete process.env[secret];
  assert.ok((await readdir(staging)).includes('current-edition')); await writeFile(path.join(first.staging_root, 'tamper'), 'changed'); await assert.rejects(stageRelease({ edition, event_key: 'release-valid' }), /digest conflict/u);
  const receipts = await readdir(receiptRoot); assert.equal(receipts.filter((name) => name.startsWith('staged-')).length, 1); assert.equal(receipts.filter((name) => name.includes('published')).length, 0); await rm(temporary, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Citation integrity at filing time, and the re-file rule.
//
// The 2026-09-05 edition shipped two citation schemes at once.
// `hard-public-verbs-hearth` cited [E1]..[E5]; `moscow-kyiv-envoy-sequence`
// cited four raw private research ids eleven times and carried zero [En] at
// all, and `usps-mail-ballot-rule` printed one and mixed it into `refs`. A
// private research id is a handle into a store no reader can open, so those
// two pieces published references that resolve to nothing.
//
// Same day, a reporter that could not get a filing accepted started raising
// its own revision number, because a refused filing and a filing awaiting a
// verdict were both answered with a refusal that mentioned revisions.
// ---------------------------------------------------------------------------
const EDITION = '2026-09-04';
const cited = (id, agent, over = {}) => ({
  id, edition_date: EDITION, section: 'world', kicker: 'Test', headline: `Headline ${id}`,
  deck: 'A complete sourced test deck.', epistemic: 'fact', byline: { desk: 'Test Desk', agents: [agent] },
  timestamp: '12:00 UTC', revision: 1, next_update_utc: '14:30', topics: ['unclos'],
  body: ['Alpha reports the mechanism [E1].', 'Beta confirms the second reading [E2].', 'Gamma disputes the timing [E1].', 'Delta closes on the operating fact [E2].'],
  key_numbers: [],
  evidence_box: [
    { source: 'Official', fragment: 'fact', as_of: EDITION, source_note: { source_id: 'E1', source_kind: 'public_url', used_by_agent: agent, source_url: 'https://first.example/evidence', retrieved_at: `${EDITION}T10:00:00Z` } },
    { source: 'Second', fragment: 'fact', as_of: EDITION, source_note: { source_id: 'E2', source_kind: 'public_url', used_by_agent: agent, source_url: 'https://second.example/evidence', retrieved_at: `${EDITION}T10:00:00Z` } }
  ],
  refs: ['E1', 'E2'], ...over
});

async function citationFixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-citation-'));
  process.env.CLANK_EDITION_STATE_ROOT = path.join(temporary, 'state');
  process.env.CLANK_NEWSROOM_AGENT = 'brass';
  await recordAssignment({
    edition: EDITION, event_key: 'schedule:citation-gate',
    assignments: owners.map((owner, index) => ({ id: `story-${index}`, owner, brief: `Report the verified mechanism for story number ${index}.`, evidence_refs: [] }))
  });
  process.env.CLANK_NEWSROOM_AGENT = 'cogsworth';
  return temporary;
}

test('a filing whose citations do not resolve is refused, and the refusal names the token', async () => {
  const temporary = await citationFixture();
  try {
    // 1. The exact defect in moscow-kyiv-envoy-sequence: a private research id
    //    printed in the prose instead of a citation into the evidence box.
    const privateId = cited('story-0', 'Cogsworth');
    privateId.body = [...privateId.body.slice(0, 3), 'Delta closes on the operating fact [s-5adc90c2].'];
    await assert.rejects(
      fileArticle({ edition: EDITION, event_key: 'gate-private-id', article: privateId }),
      /private_id_in_body:s-5adc90c2 — article\.body prints a private research id.*\[E1\] for the first entry through \[En\] for the nth/su
    );

    // 2. An [En] that lands on no evidence_box entry at all.
    const dangling = cited('story-0', 'Cogsworth');
    dangling.body = [...dangling.body.slice(0, 3), 'Delta leans on a note nobody filed [E9].'];
    await assert.rejects(
      fileArticle({ edition: EDITION, event_key: 'gate-cite-missing', article: dangling }),
      /cite_missing:E9 — article\.body cites a source id that article\.evidence_box does not carry/u
    );

    // 3. A ref the evidence box never declared.
    const strayRef = cited('story-0', 'Cogsworth', { refs: ['E1', 'E2', 'E9'] });
    await assert.rejects(
      fileArticle({ edition: EDITION, event_key: 'gate-refs-subset', article: strayRef }),
      /refs_subset:E9 — article\.refs names a source id that article\.evidence_box does not carry/u
    );

    // None of the three is switchable: turning the arming switch fully off
    // leaves them exactly as refused.
    const saved = process.env.CLANK_FILE_ARTICLE_HARD_LINT;
    process.env.CLANK_FILE_ARTICLE_HARD_LINT = '0';
    await assert.rejects(fileArticle({ edition: EDITION, event_key: 'gate-unswitchable', article: privateId }), /private_id_in_body/u);
    if (saved === undefined) delete process.env.CLANK_FILE_ARTICLE_HARD_LINT; else process.env.CLANK_FILE_ARTICLE_HARD_LINT = saved;

    // The legitimate half of the same convention still files: a private id is
    // fine as the evidence box's own source_id, cited from the body by its
    // position. That is hard-public-verbs-hearth's shape, and it must not break.
    const positional = cited('story-0', 'Cogsworth');
    positional.evidence_box[0].source_note.source_id = 's-0c0be037';
    positional.evidence_box[1].source_note.source_id = 's-c597bb83';
    positional.refs = ['s-0c0be037', 's-c597bb83'];
    assert.equal((await fileArticle({ edition: EDITION, event_key: 'gate-positional-ok', article: positional })).article_id, 'story-0');

    // Nothing was written for any of the three refusals — the reporter is
    // told to re-file this revision precisely because there is nothing there.
    const filings = await readdir(path.join(process.env.CLANK_EDITION_STATE_ROOT, 'editions', EDITION, 'filings', 'story-0'));
    assert.deepEqual(filings, ['1.json'], 'only the accepted filing landed');
  } finally {
    delete process.env.CLANK_NEWSROOM_AGENT;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('a reporter may re-file an unreviewed revision, and may never raise its own revision number', async () => {
  const temporary = await citationFixture();
  const state = process.env.CLANK_EDITION_STATE_ROOT;
  const filingOf = async (revision) => JSON.parse(await readFile(path.join(state, 'editions', EDITION, 'filings', 'story-0', `${revision}.json`), 'utf8'));
  try {
    // A refused attempt, then the same revision again with the defect fixed.
    const broken = cited('story-0', 'Cogsworth');
    broken.body = [...broken.body.slice(0, 3), 'Delta closes on the operating fact [s-5adc90c2].'];
    await assert.rejects(fileArticle({ edition: EDITION, event_key: 'refile-rejected-1', article: broken }), /private_id_in_body/u);
    assert.equal((await fileArticle({ edition: EDITION, event_key: 'refile-rejected-2', article: cited('story-0', 'Cogsworth') })).revision, 1);

    // And again over a filing that did land but that the editor has not read:
    // this is the case a file-time warning depends on, because a warning the
    // reporter cannot act on is not a warning.
    const corrected = await fileArticle({ edition: EDITION, event_key: 'refile-unreviewed', article: cited('story-0', 'Cogsworth', { deck: 'A corrected sourced deck.' }) });
    assert.equal(corrected.revision, 1);
    assert.match(corrected.replaced, /replaces your earlier revision 1 of "story-0", which the editor had not yet reviewed/u);
    assert.equal((await filingOf(1)).deck, 'A corrected sourced deck.', 'the replacement is what is on disk');

    // Raising the revision number is still the editor's call, not the
    // reporter's, and the refusal now says which revision to file instead.
    await assert.rejects(
      fileArticle({ edition: EDITION, event_key: 'refile-invented-3', article: cited('story-0', 'Cogsworth', { revision: 3 }) }),
      /you have never filed revision 2 of "story-0".*A refused filing is not a filing/su
    );
    await assert.rejects(
      fileArticle({ edition: EDITION, event_key: 'refile-invented-2', article: cited('story-0', 'Cogsworth', { revision: 2 }) }),
      /revision 1 of "story-0" is filed and still with the editor — you do not raise your own revision number/u
    );

    // A verdict makes that revision immutable: the digest Spike ruled against
    // is the digest composition re-checks.
    process.env.CLANK_NEWSROOM_AGENT = 'spike';
    await reviewArticle({ edition: EDITION, event_key: 'verdict-revise-1', article_id: 'story-0', revision: 1, verdict: 'REVISION_REQUEST', notes: 'Resolve the sourcing.' });
    process.env.CLANK_NEWSROOM_AGENT = 'cogsworth';
    await assert.rejects(
      fileArticle({ edition: EDITION, event_key: 'refile-over-verdict', article: cited('story-0', 'Cogsworth', { deck: 'A third deck.' }) }),
      /revision 1 of "story-0" has already been reviewed .*"REVISION_REQUEST".*File your corrected piece as revision 2/su
    );
    assert.equal((await filingOf(1)).deck, 'A corrected sourced deck.', 'the reviewed revision is unchanged on disk');

    // With the REVISION_REQUEST on file, revision 2 is a genuine revision.
    assert.equal((await fileArticle({ edition: EDITION, event_key: 'refile-genuine-2', article: cited('story-0', 'Cogsworth', { revision: 2, deck: 'A revised sourced deck.' }) })).revision, 2);

    // A HOLD is not a REVISION_REQUEST, and never opens the next revision.
    process.env.CLANK_NEWSROOM_AGENT = 'spike';
    await reviewArticle({ edition: EDITION, event_key: 'verdict-hold-2', article_id: 'story-0', revision: 2, verdict: 'HOLD', notes: 'Waiting on a second confirmation.' });
    process.env.CLANK_NEWSROOM_AGENT = 'cogsworth';
    await assert.rejects(
      fileArticle({ edition: EDITION, event_key: 'refile-after-hold', article: cited('story-0', 'Cogsworth', { revision: 3 }) }),
      /revision 3 requires revision 2 to carry a REVISION_REQUEST verdict, got "HOLD"/u
    );
  } finally {
    delete process.env.CLANK_NEWSROOM_AGENT;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('prose warnings reach the reporter at file time and the editor at review time', async () => {
  const temporary = await citationFixture();
  try {
    const wall = cited('story-0', 'Cogsworth', {
      deck: 'A sourced deck about the permit, not the promise.',
      body: ['The ministry opened [E1].', 'The ministry held [E2].', 'The ministry closed [E1].', 'Delta closes on the operating fact [E2].']
    });
    const filed = await fileArticle({ edition: EDITION, event_key: 'prose-warnings-file', article: wall });
    // Warned, never refused: the filing landed.
    assert.equal(filed.revision, 1);
    assert.deepEqual(filed.warnings, [
      '3 consecutive paragraphs open with "The" (para 1+) — vary the openers',
      'headline/deck leans on the "X, not Y" binary-contrast reflex — state the point directly, vary the form'
    ]);

    process.env.CLANK_NEWSROOM_AGENT = 'spike';
    const reviewed = await reviewArticle({ edition: EDITION, event_key: 'prose-warnings-review', article_id: 'story-0', revision: 1, verdict: 'PASS', notes: 'Sources and voice pass.' });
    assert.deepEqual(reviewed.warnings, filed.warnings, 'the editor is shown exactly what the reporter was shown');

    // A clean filing carries no warnings and no lint key at all, and the
    // advice never reaches the published article.
    const article = JSON.parse(await readFile(path.join(process.env.CLANK_EDITION_STATE_ROOT, 'editions', EDITION, 'articles', 'story-0.json'), 'utf8'));
    assert.equal(article.lint, undefined, 'filing-time advice must not reach content/editions');
    assert.equal(article.assignment_ref, undefined);
    process.env.CLANK_NEWSROOM_AGENT = 'sprockett';
    assert.deepEqual((await fileArticle({ edition: EDITION, event_key: 'prose-warnings-clean', article: cited('story-1', 'Sprockett') })).warnings, []);
  } finally {
    delete process.env.CLANK_NEWSROOM_AGENT;
    await rm(temporary, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The dated diversity waiver.
//
// A newspaper can decide to ship without a forecast piece. It cannot decide to
// stop having the floor. The waiver therefore names one edition and expires by
// being wrong about the date, not by being remembered and unset.
// ---------------------------------------------------------------------------
const FORECAST_FLOOR_REFUSAL = 'edition diversity floor missing — at least one "forecast" article with a dated next_update_utc and a dissent {agent, argument} is required';
const refusesWithFloorMessage = (error) => { assert.equal(error.message, FORECAST_FLOOR_REFUSAL); return true; };
// The same fixture with the forecast piece taken out: today's real shape, six
// stories of fact and inference and nothing carrying a dated forecast.
const withoutForecast = (id, agent, edition, index) => { const { dissent: _, ...value } = article(id, agent, edition, index); return { ...value, epistemic: index % 2 === 0 ? 'fact' : 'inference' }; };

async function driveToCompose(state, edition, make) {
  process.env.CLANK_EDITION_STATE_ROOT = state;
  const assignments = owners.map((owner, index) => ({ id: `story-${index}`, owner, brief: `Report the verified mechanism and the falsifying fact for story number ${index}.`, evidence_refs: [`https://source${index}.example/evidence`] }));
  process.env.CLANK_NEWSROOM_AGENT = 'brass';
  await recordAssignment({ edition, event_key: `schedule:assignment-${edition}`, assignments });
  for (const [index, owner] of owners.entries()) { process.env.CLANK_NEWSROOM_AGENT = owner; await fileArticle({ edition, event_key: `filing-${edition}-${index}`, article: make(`story-${index}`, owner[0].toUpperCase() + owner.slice(1), edition, index) }); }
  process.env.CLANK_NEWSROOM_AGENT = 'spike';
  for (const index of owners.keys()) await reviewArticle({ edition, event_key: `review-${edition}-${index}`, article_id: `story-${index}`, revision: 1, verdict: 'PASS', notes: 'Sources and voice pass.' });
  process.env.CLANK_NEWSROOM_AGENT = 'ledger'; for (const name of ['ledger.settlements', 'ledger.worlddesk']) await fileDesk({ edition, event_key: `desk-${edition}-${name}`, name, document: { version: 'test' } });
  process.env.CLANK_NEWSROOM_AGENT = 'caslon'; for (const name of ['caslon.chrome', 'caslon.weather']) await fileDesk({ edition, event_key: `desk-${edition}-${name}`, name, document: { version: 'test' } });
  const ids = owners.map((_, index) => `story-${index}`);
  return { edition, pages: [{ name: 'front', document: page('front', ids.slice(0, 3), 'world-map') }, { name: 'tape', document: page('tape', ids.slice(3)) }], maps: [{ name: 'world-map', document: { version: 'test' } }] };
}

const readIndexFile = (state, edition) => readFile(path.join(state, 'editions', edition, 'INDEX'), 'utf8');
async function readComposedReceipt(state, edition) {
  const receiptRoot = path.join(state, 'editions', edition, 'receipts');
  const name = (await readdir(receiptRoot)).find((entry) => entry.startsWith('composed-'));
  assert.ok(name, 'a composed receipt must exist');
  return JSON.parse(await readFile(path.join(receiptRoot, name), 'utf8'));
}

test('the diversity floor is waived only for the exact edition the waiver names', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-waiver-'));
  const state = path.join(temporary, 'state'), edition = '2026-09-05', otherEdition = '2026-09-06';
  const savedWaiver = process.env.CLANK_EDITION_DIVERSITY_WAIVER;
  try {
    const composeArgs = await driveToCompose(state, edition, withoutForecast);
    process.env.CLANK_NEWSROOM_AGENT = 'caslon';

    // Unwaived: refuses, word for word as it always has.
    delete process.env.CLANK_EDITION_DIVERSITY_WAIVER;
    await assert.rejects(composeEdition({ ...composeArgs, event_key: 'compose-unwaived' }), refusesWithFloorMessage);
    assert.match(await readIndexFile(state, edition), /^# compose: passed=5\/5 desks=4\/4 diversity=missing\(forecast\) {2}→ blocked$/mu);

    // The one that matters: a waiver dated to a different edition is not a
    // waiver at all. Delete the `declared !== edition` guard in
    // editionDiversityWaiver and this assertion goes red.
    process.env.CLANK_EDITION_DIVERSITY_WAIVER = otherEdition;
    await assert.rejects(composeEdition({ ...composeArgs, event_key: 'compose-wrong-edition' }), refusesWithFloorMessage);

    // Nor is a boolean: it is refused outright rather than quietly ignored,
    // because an undated waiver is the permanent one this shape rules out.
    for (const value of ['1', 'true', 'yes', '2026-9-5']) {
      process.env.CLANK_EDITION_DIVERSITY_WAIVER = value;
      await assert.rejects(composeEdition({ ...composeArgs, event_key: 'compose-boolean' }), /CLANK_EDITION_DIVERSITY_WAIVER must name the one edition it waives as an ISO date "YYYY-MM-DD".*never waived by a boolean/su);
    }

    // Dated to this edition: it composes, and the artifact carries the fact.
    process.env.CLANK_EDITION_DIVERSITY_WAIVER = edition;
    const composed = await composeEdition({ ...composeArgs, event_key: 'compose-waived' });
    assert.equal(composed.compose_gates, '# compose: passed=5/5 desks=4/4 diversity=waived(2026-09-05)  → waived');
    assert.equal(composed.waiver.floor, 'forecast-dissent');
    assert.equal(composed.waiver.edition, edition);
    assert.equal(composed.waiver.source, 'CLANK_EDITION_DIVERSITY_WAIVER');
    const receipt = await readComposedReceipt(state, edition);
    assert.equal(receipt.composition.waiver.edition, edition);
    assert.equal(receipt.composition.compose_gates, composed.compose_gates);

    // And it is legible from the INDEX with the environment variable gone —
    // the record lives in the artifact, not in whoever happens to hold the env.
    delete process.env.CLANK_EDITION_DIVERSITY_WAIVER;
    await writeEditionIndex(state, edition);
    assert.match(await readIndexFile(state, edition), /^# compose: passed=5\/5 desks=4\/4 diversity=waived\(2026-09-05\) {2}→ waived$/mu);

    // The same waiver value cannot carry to tomorrow's paper.
    const nextState = path.join(temporary, 'next-state');
    const nextArgs = await driveToCompose(nextState, otherEdition, withoutForecast);
    process.env.CLANK_NEWSROOM_AGENT = 'caslon';
    process.env.CLANK_EDITION_DIVERSITY_WAIVER = edition;
    await assert.rejects(composeEdition({ ...nextArgs, event_key: 'compose-tomorrow' }), refusesWithFloorMessage);
  } finally {
    if (savedWaiver === undefined) delete process.env.CLANK_EDITION_DIVERSITY_WAIVER; else process.env.CLANK_EDITION_DIVERSITY_WAIVER = savedWaiver;
    delete process.env.CLANK_NEWSROOM_AGENT;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('an edition that carries a real forecast records no waiver, even with one set', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-waiver-unused-'));
  const state = path.join(temporary, 'state'), edition = '2026-09-05';
  const savedWaiver = process.env.CLANK_EDITION_DIVERSITY_WAIVER;
  try {
    const composeArgs = await driveToCompose(state, edition, article);
    process.env.CLANK_NEWSROOM_AGENT = 'caslon';
    process.env.CLANK_EDITION_DIVERSITY_WAIVER = edition;
    const composed = await composeEdition({ ...composeArgs, event_key: 'compose-with-forecast' });
    assert.equal(composed.waiver, undefined, 'a paper with a forecast piece was not composed under a waiver');
    assert.equal(composed.compose_gates, '# compose: passed=5/5 desks=4/4 diversity=ok  → ready');
    assert.equal((await readComposedReceipt(state, edition)).composition.waiver, undefined);
    assert.match(await readIndexFile(state, edition), /^# compose: passed=5\/5 desks=4\/4 diversity=ok {2}→ ready$/mu);
  } finally {
    if (savedWaiver === undefined) delete process.env.CLANK_EDITION_DIVERSITY_WAIVER; else process.env.CLANK_EDITION_DIVERSITY_WAIVER = savedWaiver;
    delete process.env.CLANK_NEWSROOM_AGENT;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('no other compose gate is waivable', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-waiver-scope-'));
  const state = path.join(temporary, 'state'), edition = '2026-09-05';
  const savedWaiver = process.env.CLANK_EDITION_DIVERSITY_WAIVER;
  try {
    const composeArgs = await driveToCompose(state, edition, withoutForecast);
    process.env.CLANK_EDITION_DIVERSITY_WAIVER = edition;
    process.env.CLANK_NEWSROOM_AGENT = 'caslon';

    // A desk document short: the waiver does not reach that gate.
    await rm(path.join(state, 'editions', edition, 'desk', 'caslon.weather.json'));
    await assert.rejects(composeEdition({ ...composeArgs, event_key: 'compose-short-desk' }), /exactly 4 desk documents required.*found 3/su);

    // A PASSed article short: likewise.
    await rm(path.join(state, 'editions', edition, 'articles', 'story-4.json'));
    await rm(path.join(state, 'editions', edition, 'reviews', 'story-4.json'));
    await assert.rejects(composeEdition({ ...composeArgs, event_key: 'compose-short-passed' }), /at least 5 PASSed articles required, found 4/u);
  } finally {
    if (savedWaiver === undefined) delete process.env.CLANK_EDITION_DIVERSITY_WAIVER; else process.env.CLANK_EDITION_DIVERSITY_WAIVER = savedWaiver;
    delete process.env.CLANK_NEWSROOM_AGENT;
    await rm(temporary, { recursive: true, force: true });
  }
});
