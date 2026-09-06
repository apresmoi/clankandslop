import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { layEdition, readEditionInputs } from '../../ops/lay-page.mjs';
import { writeEditionIndex } from './edition-index.mjs';
import { collectPublicArticleReferences, composeEdition, fileArticle, fileDesk, isDatedForecast, qualifySignal, recordAssignment, recordDissent, reviewArticle, stagePublicSource, stageRelease } from './production-newsroom.mjs';

const owners = ['cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton'];
const assignmentEvent = 'schedule:assignment-20260825';
const article = (id, agent, edition, index) => ({ id, edition_date: edition, section: ['world', 'markets', 'technology'][index % 3], kicker: 'Test', headline: `Headline ${id}`, deck: 'A complete sourced test deck.', epistemic: index === 1 ? 'forecast' : 'fact', byline: { desk: 'Test Desk', agents: [agent] }, timestamp: '12:00 UTC', revision: 1, next_update_utc: '14:30', topics: ['geopolitics'], body: ['One [E1].', 'Two [E1].', 'Three [E1].', 'Four [E1].'], key_numbers: [], evidence_box: [{ source: `Official ${index}`, fragment: 'fact', as_of: edition, source_note: { source_id: 'E1', source_kind: 'public_url', used_by_agent: agent, source_url: `https://source${index}.example/evidence`, retrieved_at: `${edition}T10:00:00Z` } }], refs: ['E1'], ...(index === 1 ? { confidence: { value: 0.42 } } : {}), ...(index === 0 ? { art: { kind: 'map', map: 'hormuz', hero_map: 'hormuz-hero', caption: 'The strait.', spots: [] } } : {}) });
// The four desk documents in the shape ops/desk-contract.mjs requires — the
// same shape the site assembles an Edition from. file_desk refuses anything
// else, so a test fixture cannot be a placeholder object any more.
const deskDocument = (name, edition, lead = 'story-0') => ({
  'caslon.chrome': { date: edition, edition_no: '0099', volume: 'I', issued_at: `${edition}T14:00:00Z`, revision: 1, tagline: "All the slop that's fit to print.", next_bell: '14:00 UTC', compiled_by: ['Cogsworth'], lead_story_id: lead },
  'caslon.weather': { weather: { city: 'Berlin', temp_c: 20, summary: 'partly cloudy', humidity_pct: 58, wind: 'W 11km/h' } },
  'ledger.settlements': { resolved_last_edition: [{ call: 'A dated call that came in.', outcome: 'hit', prior_p: 0.62 }] },
  'ledger.worlddesk': { world_desk: { escalation_index: 0.68, delta: 'steady', open_conflicts: 8, watch: 5 } },
}[name]);
const page = (name, ids, map) => name === 'front' ? { edition: '2026-08-25', page: name, paper: 'broadsheet', lead: ids[0], splitWith: ids[1], rail: [ids[2]], flow: [{ block: 'MapGlyph', props: { map } }, { block: 'GlyphArt', props: { glyph: 'signal' } }] } : { edition: '2026-08-25', page: name, paper: 'ticker', articles: [ids[0]], article: ids[1], flow: [] };

test('public references and the dated-forecast predicate use the exact contract', () => {
  assert.deepEqual(collectPublicArticleReferences({ article: 'a', lead: 'b', splitWith: 'c', rail: ['d'], articles: ['e'], ignored: 'f' }), ['a', 'b', 'c', 'd', 'e']);
  // Counted, not gated, and no longer conflated with the dissent: a forecast
  // with nobody arguing the other side is still a forecast.
  assert.equal(isDatedForecast({ epistemic: 'forecast', next_update_utc: '14:30' }), true);
  assert.equal(isDatedForecast({ epistemic: 'forecast', next_update_utc: 'tomorrow' }), false);
  assert.equal(isDatedForecast({ epistemic: 'fact', next_update_utc: '14:30' }), false);
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
  process.env.CLANK_NEWSROOM_AGENT = 'ledger'; for (const name of ['ledger.settlements', 'ledger.worlddesk']) await fileDesk({ edition, event_key: name, name, document: deskDocument(name, edition) });
  process.env.CLANK_NEWSROOM_AGENT = 'caslon'; for (const name of ['caslon.chrome', 'caslon.weather']) await fileDesk({ edition, event_key: name, name, document: deskDocument(name, edition) });
  const ids = owners.map((_, index) => `story-${index}`), pages = [{ name: 'front', document: page('front', ids.slice(0, 3), 'hormuz-hero') }, { name: 'tape', document: page('tape', ids.slice(3)) }], maps = [{ name: 'hormuz', document: { version: 'test' } }, { name: 'hormuz-hero', document: { version: 'test' } }];
  await assert.rejects(composeEdition({ edition, event_key: 'compose-incomplete', pages: [pages[0], { name: 'tape', document: page('tape', [ids[3]]) }], maps }), /page completeness/u);
  await assert.rejects(composeEdition({ edition, event_key: 'compose-extra-map', pages, maps: [...maps, { name: 'unused-map', document: {} }] }), /maps must exactly/u); await composeEdition({ edition, event_key: 'compose-valid', pages, maps });
  process.env.CLANK_NEWSROOM_AGENT = 'pressman'; process.env.CLANK_PUBLIC_SOURCE_ROOT = source; process.env.CLANK_RELEASE_STAGING_ROOT = staging;
  const secrets = ['OPENAI_API_KEY', 'MOLTNET_TOKEN', 'CLANK_RUNTIME_SECRET']; for (const secret of secrets) process.env[secret] = 'must-not-propagate';
  for (const [kind, name] of [['desk', 'ledger.worlddesk'], ['pages', 'front'], ['maps', 'hormuz-hero']]) { const file = path.join(state, 'editions', edition, kind, `${name}.json`), bytes = await readFile(file, 'utf8'), changed = JSON.parse(bytes); changed.tampered = true; await writeFile(file, `${JSON.stringify(changed)}\n`); await assert.rejects(stageRelease({ edition, event_key: 'mutation' }), /digest changed/u); await writeFile(file, bytes); }
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
// The forecast slot, the recorded dissent, and the waiver that no longer exists.
//
// The old shape was one refusal at 21:00 for a property only Brass at 18:30 and
// a reporter at 19:00 could supply, plus a dated environment variable to excuse
// it — which meant the bar was met by re-typing a date every night. Both halves
// moved to where an agent can act on them, and the counts that replaced the
// refusal report a paper that shipped without either rather than refusing it.
// ---------------------------------------------------------------------------
// The same fixture with nothing carrying a dated forecast: the real shape of
// every edition since 2026-08-09.
const withoutForecast = (id, agent, edition, index) => { const { confidence: _, ...value } = article(id, agent, edition, index); return { ...value, epistemic: index % 2 === 0 ? 'fact' : 'inference' }; };

// `count` is how many stories the day carries. Five is compose_edition's floor,
// not the only length a day comes in: 2026-09-05 PASSed six. `beforeReview`
// runs after every filing and before Spike rules, which is where a dissent
// lands on a real day.
async function driveToCompose(state, edition, make, count = owners.length, beforeReview) {
  process.env.CLANK_EDITION_STATE_ROOT = state;
  const day = [...owners, 'vesta'].slice(0, count);
  assert.equal(day.length, count, 'the fixture has no owner for that many stories');
  const assignments = day.map((owner, index) => ({ id: `story-${index}`, owner, brief: `Report the verified mechanism and the falsifying fact for story number ${index}.`, evidence_refs: [`https://source${index}.example/evidence`] }));
  process.env.CLANK_NEWSROOM_AGENT = 'brass';
  await recordAssignment({ edition, event_key: `schedule:assignment-${edition}`, assignments });
  for (const [index, owner] of day.entries()) { process.env.CLANK_NEWSROOM_AGENT = owner; await fileArticle({ edition, event_key: `filing-${edition}-${index}`, article: make(`story-${index}`, owner[0].toUpperCase() + owner.slice(1), edition, index) }); }
  if (beforeReview) await beforeReview();
  process.env.CLANK_NEWSROOM_AGENT = 'spike';
  for (const index of day.keys()) await reviewArticle({ edition, event_key: `review-${edition}-${index}`, article_id: `story-${index}`, revision: 1, verdict: 'PASS', notes: 'Sources and voice pass.' });
  process.env.CLANK_NEWSROOM_AGENT = 'ledger'; for (const name of ['ledger.settlements', 'ledger.worlddesk']) await fileDesk({ edition, event_key: `desk-${edition}-${name}`, name, document: deskDocument(name, edition) });
  process.env.CLANK_NEWSROOM_AGENT = 'caslon'; for (const name of ['caslon.chrome', 'caslon.weather']) await fileDesk({ edition, event_key: `desk-${edition}-${name}`, name, document: deskDocument(name, edition) });
  const ids = day.map((_, index) => `story-${index}`);
  return { edition, pages: [{ name: 'front', document: page('front', ids.slice(0, 3), 'hormuz-hero') }, { name: 'tape', document: page('tape', ids.slice(3)) }], maps: [{ name: 'hormuz', document: { version: 'test' } }, { name: 'hormuz-hero', document: { version: 'test' } }] };
}

const readIndexFile = (state, edition) => readFile(path.join(state, 'editions', edition, 'INDEX'), 'utf8');
async function readComposedReceipt(state, edition) {
  const receiptRoot = path.join(state, 'editions', edition, 'receipts');
  const name = (await readdir(receiptRoot)).find((entry) => entry.startsWith('composed-'));
  assert.ok(name, 'a composed receipt must exist');
  return JSON.parse(await readFile(path.join(receiptRoot, name), 'utf8'));
}

const stateOf = (result) => result.compose_gates;

test('a day with no forecast and no dissent composes, and the paper says so', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-no-floor-'));
  const state = path.join(temporary, 'state'), edition = '2026-09-05';
  try {
    const composeArgs = await driveToCompose(state, edition, withoutForecast);
    process.env.CLANK_NEWSROOM_AGENT = 'caslon';
    // The exact composition the old gate refused, and the reason it had to go:
    // none of the six quality-target editions carried a forecast either.
    assert.match(await readIndexFile(state, edition), /^# compose: passed=5\/5 desks=4\/4 forecast=0 dissent=0 {2}→ ready$/mu);
    const composed = await composeEdition({ ...composeArgs, event_key: 'compose-no-forecast' });
    assert.equal(stateOf(composed), '# compose: passed=5/5 desks=4/4 forecast=0 dissent=0  → ready');
    assert.equal(composed.forecasts, 0);
    assert.equal(composed.dissents, 0);
    assert.equal(composed.waiver, undefined, 'nothing was waived, because there is nothing left to waive');
    const receipt = await readComposedReceipt(state, edition);
    assert.equal(receipt.composition.compose_gates, composed.compose_gates);
    assert.equal(receipt.composition.dissents, 0);
    assert.equal(receipt.composition.waiver, undefined);
  } finally {
    delete process.env.CLANK_NEWSROOM_AGENT;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('the waiver environment variable is inert — no value of it changes anything', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-waiver-gone-'));
  const state = path.join(temporary, 'state'), edition = '2026-09-05';
  const saved = process.env.CLANK_EDITION_DIVERSITY_WAIVER;
  try {
    const composeArgs = await driveToCompose(state, edition, withoutForecast);
    process.env.CLANK_NEWSROOM_AGENT = 'caslon';
    // "1" used to be refused outright and a date used to compose under a
    // recorded waiver. Now the variable is read by nothing at all, and the one
    // composition this edition is allowed carries no trace of it.
    for (const value of ['1', 'true', edition, '2026-01-01']) {
      process.env.CLANK_EDITION_DIVERSITY_WAIVER = value;
      const status = await readIndexFile(state, edition);
      assert.match(status, /forecast=0 dissent=0 {2}→ ready$/mu, `${value} must not reach the gate line`);
    }
    const composed = await composeEdition({ ...composeArgs, event_key: 'compose-with-junk-env' });
    assert.equal(composed.waiver, undefined);
    assert.equal(stateOf(composed), '# compose: passed=5/5 desks=4/4 forecast=0 dissent=0  → ready');
  } finally {
    if (saved === undefined) delete process.env.CLANK_EDITION_DIVERSITY_WAIVER; else process.env.CLANK_EDITION_DIVERSITY_WAIVER = saved;
    delete process.env.CLANK_NEWSROOM_AGENT;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('no other compose gate went with it', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-gates-stand-'));
  const state = path.join(temporary, 'state'), edition = '2026-09-05';
  try {
    const composeArgs = await driveToCompose(state, edition, withoutForecast);
    process.env.CLANK_NEWSROOM_AGENT = 'caslon';
    await rm(path.join(state, 'editions', edition, 'desk', 'caslon.weather.json'));
    await assert.rejects(composeEdition({ ...composeArgs, event_key: 'compose-short-desk' }), /exactly 4 desk documents required.*found 3/su);
    await rm(path.join(state, 'editions', edition, 'articles', 'story-4.json'));
    await rm(path.join(state, 'editions', edition, 'reviews', 'story-4.json'));
    await assert.rejects(composeEdition({ ...composeArgs, event_key: 'compose-short-passed' }), /at least 5 PASSed articles required, found 4/u);
  } finally {
    delete process.env.CLANK_NEWSROOM_AGENT;
    await rm(temporary, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// record_dissent.
// ---------------------------------------------------------------------------

// One assignment marked as the day's forecast, its dissenter named, and the
// owner filing the shape that slot obliges.
const FORECAST_ARGUMENT = 'The call rests on a single quarter of shipment data and reads a pause as a turn; the same series moved this far twice last year without one, and the clock the piece sets falls inside the revision window that would settle it.';
async function driveToForecastFiling(state, edition = '2026-09-07', over = {}) {
  process.env.CLANK_EDITION_STATE_ROOT = state;
  process.env.CLANK_NEWSROOM_AGENT = 'brass';
  const assignments = owners.map((owner, index) => ({
    id: `story-${index}`, owner, brief: `Report the verified mechanism and the falsifying fact for story number ${index}.`, evidence_refs: [`https://source${index}.example/evidence`],
    ...(index === 1 ? { slot: 'forecast', dissenter: 'vesta' } : {})
  }));
  const recorded = await recordAssignment({ edition, event_key: `schedule:assignment-${edition}`, assignments });
  for (const [index, owner] of owners.entries()) {
    process.env.CLANK_NEWSROOM_AGENT = owner;
    const value = article(`story-${index}`, owner[0].toUpperCase() + owner.slice(1), edition, index);
    await fileArticle({ edition, event_key: `filing-${edition}-${index}`, article: index === 1 ? { ...value, ...over } : value });
  }
  return recorded;
}

test('an author cannot type a dissent into their own filing', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-authored-dissent-'));
  const state = path.join(temporary, 'state'), edition = '2026-09-07';
  try {
    process.env.CLANK_EDITION_STATE_ROOT = state;
    process.env.CLANK_NEWSROOM_AGENT = 'brass';
    await recordAssignment({ edition, event_key: `schedule:assignment-${edition}`, assignments: owners.map((owner, index) => ({ id: `story-${index}`, owner, brief: `Report the verified mechanism and the falsifying fact for story number ${index}.`, evidence_refs: [] })) });
    process.env.CLANK_NEWSROOM_AGENT = 'cogsworth';
    // The first-law hole. Nobody asked Tinkerton, and until now nothing asked
    // whether anyone had.
    const forged = { ...article('story-0', 'Cogsworth', edition, 0), dissent: { agent: 'Tinkerton', p: 0.3, argument: 'A dissent nobody wrote.' } };
    await assert.rejects(fileArticle({ edition, event_key: 'forged-dissent', article: forged }), /article\.dissent is not yours to write .* record_dissent, under their own name/su);
    // Refused means nothing was recorded: no filing, no receipt, no page.
    await assert.rejects(readFile(path.join(state, 'editions', edition, 'filings', 'story-0', '1.json')));
    // An empty or null dissent is the same assertion and is refused the same way.
    for (const value of [{}, null, undefined]) await assert.rejects(fileArticle({ edition, event_key: 'forged-dissent', article: { ...article('story-0', 'Cogsworth', edition, 0), dissent: value } }), /article\.dissent is not yours to write/u);
  } finally {
    delete process.env.CLANK_NEWSROOM_AGENT;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('the forecast slot binds its owner at filing time, in the wake that can still fix it', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-forecast-slot-'));
  const state = path.join(temporary, 'state'), edition = '2026-09-07';
  try {
    process.env.CLANK_EDITION_STATE_ROOT = state;
    process.env.CLANK_NEWSROOM_AGENT = 'brass';
    const assignments = owners.map((owner, index) => ({ id: `story-${index}`, owner, brief: `Report the verified mechanism and the falsifying fact for story number ${index}.`, evidence_refs: [], ...(index === 1 ? { slot: 'forecast', dissenter: 'vesta' } : {}) }));
    const recorded = await recordAssignment({ edition, event_key: `schedule:assignment-${edition}`, assignments });
    assert.deepEqual(recorded.forecast, { id: 'story-1', owner: 'sprockett', dissenter: 'vesta' });

    // Brass's own shape is checked where Brass can fix it too.
    await assert.rejects(recordAssignment({ edition, event_key: 'bad-slot', assignments: assignments.map((item, index) => (index === 1 ? { ...item, slot: 'analysis' } : item)) }), /slot "analysis" must be "forecast"/u);
    await assert.rejects(recordAssignment({ edition, event_key: 'bad-dissenter', assignments: assignments.map((item, index) => (index === 1 ? { ...item, dissenter: 'sprockett' } : item)) }), /is the owner of the piece — nobody dissents from their own byline/u);
    await assert.rejects(recordAssignment({ edition, event_key: 'lonely-dissenter', assignments: assignments.map((item, index) => (index === 2 ? { ...item, dissenter: 'vesta' } : item)) }), /only meaningful beside slot "forecast"/u);
    await assert.rejects(recordAssignment({ edition, event_key: 'two-slots', assignments: assignments.map((item, index) => (index === 2 ? { ...item, slot: 'forecast' } : item)) }), /at most one assignment may carry slot "forecast", got 2/u);

    process.env.CLANK_NEWSROOM_AGENT = 'sprockett';
    const base = article('story-1', 'Sprockett', edition, 1);
    // All three fields, named in one refusal, before anything is written.
    await assert.rejects(fileArticle({ edition, event_key: 'flat-forecast', article: { ...base, epistemic: 'fact', next_update_utc: 'tomorrow', confidence: undefined } }),
      /is today's forecast, so it files as one: article\.epistemic must be "forecast".*article\.next_update_utc must be a clock time.*article\.confidence\.value must be a number in \[0, 1\]/su);
    await assert.rejects(fileArticle({ edition, event_key: 'no-confidence', article: { ...base, confidence: { value: 1.4 } } }), /article\.confidence\.value must be a number in \[0, 1\]/u);
    await assert.rejects(readFile(path.join(state, 'editions', edition, 'filings', 'story-1', '1.json')));

    // Filed correctly, the tool hands back the one instruction the wake needs.
    const filed = await fileArticle({ edition, event_key: 'good-forecast', article: base });
    assert.deepEqual(filed.forecast, { dissenter: 'vesta' });
    assert.match(filed.next, /mention @vesta in room:filing/u);
    // A story with no slot owes none of it.
    process.env.CLANK_NEWSROOM_AGENT = 'foreman';
    const plain = await fileArticle({ edition, event_key: 'plain-filing', article: article('story-2', 'Foreman', edition, 2) });
    assert.equal(plain.forecast, undefined);
    assert.equal(plain.next, undefined);
  } finally {
    delete process.env.CLANK_NEWSROOM_AGENT;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('a dissent is stamped with the agent the server runs as, and no name in the arguments', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-dissent-identity-'));
  const state = path.join(temporary, 'state'), edition = '2026-09-07';
  try {
    await driveToForecastFiling(state, edition);
    process.env.CLANK_NEWSROOM_AGENT = 'vesta';
    const result = await recordDissent({ edition, event_key: 'vesta-dissents', article_id: 'story-1', revision: 1, stance: 'dissent', p: 0.62, argument: FORECAST_ARGUMENT });
    assert.equal(result.recorded, true);
    assert.equal(result.merged, false, 'the editor has not passed it yet');
    const record = JSON.parse(await readFile(path.join(state, 'editions', edition, 'dissents', 'story-1', '1.json'), 'utf8'));
    assert.equal(record.agent, 'vesta');
    // The display name the archive's own dissents carry, read from the persona
    // file rather than accepted from the caller.
    assert.equal(record.name, 'Vesta');
    assert.equal(record.p, 0.62);
    assert.equal(record.version, 'clank.dissent.v1');
    // No argument names an agent, so there is nothing to forge. Anything extra
    // is refused as an unexpected field rather than silently ignored.
    await assert.rejects(recordDissent({ edition, event_key: 'signed-as-someone-else', article_id: 'story-1', revision: 1, stance: 'dissent', p: 0.5, argument: FORECAST_ARGUMENT, agent: 'tinkerton' }), /unexpected: \[agent\]/u);

    // The tool set is the boundary: nobody outside the six desks holds it, and
    // the function refuses even when reached directly.
    for (const role of ['spike', 'caslon', 'brass', 'ledger', 'pressman', 'klaxon']) {
      process.env.CLANK_NEWSROOM_AGENT = role;
      await assert.rejects(recordDissent({ edition, event_key: `role-${role}`, article_id: 'story-1', revision: 1, stance: 'dissent', p: 0.5, argument: FORECAST_ARGUMENT }), /may only be called by a reporting desk/u);
    }
    // And a reporter cannot dissent from its own byline.
    process.env.CLANK_NEWSROOM_AGENT = 'sprockett';
    await assert.rejects(recordDissent({ edition, event_key: 'self-dissent', article_id: 'story-1', revision: 1, stance: 'dissent', p: 0.5, argument: FORECAST_ARGUMENT }), /carries your own byline — you cannot dissent from your own piece/u);
  } finally {
    delete process.env.CLANK_NEWSROOM_AGENT;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('a dissent reaches the page whether it lands before PASS or after it', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-dissent-merge-'));
  try {
    const articlePath = (state, edition, id) => path.join(state, 'editions', edition, 'articles', `${id}.json`);
    // 1. Before PASS: review_article merges it on promotion.
    const early = path.join(temporary, 'early'), edition = '2026-09-07';
    await driveToForecastFiling(early, edition);
    process.env.CLANK_NEWSROOM_AGENT = 'vesta';
    await recordDissent({ edition, event_key: 'early-dissent', article_id: 'story-1', revision: 1, stance: 'dissent', p: 0.62, argument: FORECAST_ARGUMENT });
    process.env.CLANK_NEWSROOM_AGENT = 'spike';
    const verdict = await reviewArticle({ edition, event_key: 'pass-story-1', article_id: 'story-1', revision: 1, verdict: 'PASS', notes: 'Sources and voice pass.' });
    assert.deepEqual(verdict.dissent, { agent: 'Vesta', p: 0.62, argument: FORECAST_ARGUMENT });
    assert.deepEqual(JSON.parse(await readFile(articlePath(early, edition, 'story-1'), 'utf8')).dissent, { agent: 'Vesta', p: 0.62, argument: FORECAST_ARGUMENT });

    // 2. After PASS, before compose: record_dissent performs the merge itself.
    const late = path.join(temporary, 'late');
    await driveToForecastFiling(late, edition);
    process.env.CLANK_NEWSROOM_AGENT = 'spike';
    await reviewArticle({ edition, event_key: 'pass-first', article_id: 'story-1', revision: 1, verdict: 'PASS', notes: 'Sources and voice pass.' });
    assert.equal(JSON.parse(await readFile(articlePath(late, edition, 'story-1'), 'utf8')).dissent, undefined);
    process.env.CLANK_NEWSROOM_AGENT = 'vesta';
    const merged = await recordDissent({ edition, event_key: 'late-dissent', article_id: 'story-1', revision: 1, stance: 'dissent', p: 0.62, argument: FORECAST_ARGUMENT });
    assert.equal(merged.merged, true);
    assert.deepEqual(JSON.parse(await readFile(articlePath(late, edition, 'story-1'), 'utf8')).dissent, { agent: 'Vesta', p: 0.62, argument: FORECAST_ARGUMENT });

    // 3. A "concur" is on the record and is not a dissent on the page.
    const concur = path.join(temporary, 'concur');
    await driveToForecastFiling(concur, edition);
    process.env.CLANK_NEWSROOM_AGENT = 'vesta';
    const said = await recordDissent({ edition, event_key: 'concurrence', article_id: 'story-1', revision: 1, stance: 'concur', argument: 'I read the call and the counter-series does not cross it.' });
    assert.equal(said.stance, 'concur');
    assert.equal(said.merged, false);
    await assert.rejects(recordDissent({ edition, event_key: 'concur-with-p', article_id: 'story-2', revision: 1, stance: 'concur', p: 0.4, argument: 'I read the call and the counter-series does not cross it.' }), /stance "concur" carries no p/u);
    process.env.CLANK_NEWSROOM_AGENT = 'spike';
    await reviewArticle({ edition, event_key: 'pass-after-concur', article_id: 'story-1', revision: 1, verdict: 'PASS', notes: 'Sources and voice pass.' });
    assert.equal(JSON.parse(await readFile(articlePath(concur, edition, 'story-1'), 'utf8')).dissent, undefined);
  } finally {
    delete process.env.CLANK_NEWSROOM_AGENT;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('a dissent recorded after the edition is composed is refused, loudly', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-dissent-late-'));
  const state = path.join(temporary, 'state'), edition = '2026-09-05';
  try {
    const composeArgs = await driveToCompose(state, edition, article);
    process.env.CLANK_NEWSROOM_AGENT = 'caslon';
    const composed = await composeEdition({ ...composeArgs, event_key: 'compose-before-dissent' });
    assert.equal(composed.dissents, 0);
    process.env.CLANK_NEWSROOM_AGENT = 'vesta';
    await assert.rejects(recordDissent({ edition, event_key: 'too-late', article_id: 'story-1', revision: 1, stance: 'dissent', p: 0.62, argument: FORECAST_ARGUMENT }),
      /is composed; a dissent recorded now cannot reach the page — say it on the floor, it will not be attributed to you in print/u);
    // Nothing was written, so the composition receipt still authenticates.
    await assert.rejects(readFile(path.join(state, 'editions', edition, 'dissents', 'story-1', '1.json')));
  } finally {
    delete process.env.CLANK_NEWSROOM_AGENT;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('a dissent is refused against a revision that does not exist, one that went back, and one somebody else already holds', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-dissent-refusals-'));
  const state = path.join(temporary, 'state'), edition = '2026-09-07';
  try {
    await driveToForecastFiling(state, edition);
    process.env.CLANK_NEWSROOM_AGENT = 'vesta';
    // A revision that was never filed: the refusal names what is filed instead
    // of leaving the dissenter to guess.
    await assert.rejects(recordDissent({ edition, event_key: 'no-such-rev', article_id: 'story-1', revision: 3, stance: 'dissent', p: 0.5, argument: FORECAST_ARGUMENT }), /nothing is filed at revision 3 of "story-1".*what is filed: story-0 rev 1, story-1 rev 1/su);
    await assert.rejects(recordDissent({ edition, event_key: 'no-such-story', article_id: 'story-9', revision: 1, stance: 'dissent', p: 0.5, argument: FORECAST_ARGUMENT }), /nothing is filed at revision 1 of "story-9"/u);
    // A revision the editor sent back is not the one to argue with.
    process.env.CLANK_NEWSROOM_AGENT = 'spike';
    await reviewArticle({ edition, event_key: 'send-back', article_id: 'story-1', revision: 1, verdict: 'REVISION_REQUEST', notes: 'Show the counter-series.' });
    process.env.CLANK_NEWSROOM_AGENT = 'vesta';
    await assert.rejects(recordDissent({ edition, event_key: 'against-returned', article_id: 'story-1', revision: 1, stance: 'dissent', p: 0.5, argument: FORECAST_ARGUMENT }), /was sent back for revision — dissent against the next one/u);
    // One dissent per piece: a second desk cannot overwrite the first.
    process.env.CLANK_NEWSROOM_AGENT = 'vesta';
    await recordDissent({ edition, event_key: 'first-holder', article_id: 'story-0', revision: 1, stance: 'dissent', p: 0.4, argument: FORECAST_ARGUMENT });
    process.env.CLANK_NEWSROOM_AGENT = 'tinkerton';
    await assert.rejects(recordDissent({ edition, event_key: 'second-holder', article_id: 'story-0', revision: 1, stance: 'dissent', p: 0.7, argument: FORECAST_ARGUMENT }), /Vesta already holds the dissent on revision 1 of "story-0" — one dissent per piece/u);
    // The same call twice from the same wake converges rather than conflicting.
    process.env.CLANK_NEWSROOM_AGENT = 'vesta';
    await assert.doesNotReject(recordDissent({ edition, event_key: 'first-holder', article_id: 'story-0', revision: 1, stance: 'dissent', p: 0.4, argument: FORECAST_ARGUMENT }));
    // Shape: a bare "no" is not an argument, and a dissent without a number is
    // not a call.
    await assert.rejects(recordDissent({ edition, event_key: 'thin-argument', article_id: 'story-2', revision: 1, stance: 'dissent', p: 0.4, argument: 'Nope.' }), /between 80 and 2000 characters/u);
    await assert.rejects(recordDissent({ edition, event_key: 'dissent-without-p', article_id: 'story-2', revision: 1, stance: 'dissent', argument: FORECAST_ARGUMENT }), /requires p — your own probability/u);
  } finally {
    delete process.env.CLANK_NEWSROOM_AGENT;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('a dissent carries to a later revision only when the call did not move', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-dissent-carry-'));
  const edition = '2026-09-07';
  const run = async (name, revised) => {
    const state = path.join(temporary, name);
    await driveToForecastFiling(state, edition);
    process.env.CLANK_NEWSROOM_AGENT = 'vesta';
    await recordDissent({ edition, event_key: `carry-${name}`, article_id: 'story-1', revision: 1, stance: 'dissent', p: 0.62, argument: FORECAST_ARGUMENT });
    process.env.CLANK_NEWSROOM_AGENT = 'spike';
    await reviewArticle({ edition, event_key: `send-back-${name}`, article_id: 'story-1', revision: 1, verdict: 'REVISION_REQUEST', notes: 'Tighten the second paragraph.' });
    process.env.CLANK_NEWSROOM_AGENT = 'sprockett';
    await fileArticle({ edition, event_key: `refile-${name}`, article: { ...article('story-1', 'Sprockett', edition, 1), revision: 2, ...revised } });
    process.env.CLANK_NEWSROOM_AGENT = 'spike';
    const verdict = await reviewArticle({ edition, event_key: `pass-${name}`, article_id: 'story-1', revision: 2, verdict: 'PASS', notes: 'Sources and voice pass.' });
    return { state, verdict, article: JSON.parse(await readFile(path.join(state, 'editions', edition, 'articles', 'story-1.json'), 'utf8')) };
  };
  try {
    // Prose changed, the call did not: the dissent is still an argument about
    // this piece, and it carries with the revision it was recorded against.
    const held = await run('held', { deck: 'A revised sourced deck.' });
    assert.deepEqual(held.article.dissent, { agent: 'Vesta', p: 0.62, argument: FORECAST_ARGUMENT });
    assert.equal(held.verdict.dissent_dropped, undefined);
    const carried = JSON.parse(await readFile(path.join(held.state, 'editions', edition, 'dissents', 'story-1', '2.json'), 'utf8'));
    assert.equal(carried.against_revision, 1);

    // The number moved: the argument is against a call that no longer exists,
    // so it is left off the page and the verdict says why.
    const moved = await run('moved', { confidence: { value: 0.71 } });
    assert.equal(moved.article.dissent, undefined);
    assert.equal(moved.verdict.dissent_dropped, 'recorded against revision 1; the call changed');
    // Durable, not just a tool result: the INDEX row carries it too.
    assert.match(await readIndexFile(moved.state, edition), /^V story-1 rev=2 PASS by=spike dissent_dropped=recorded-against-revision-1;-the-call-changed$/mu);

    // And the clock moving counts as the call moving.
    const reclocked = await run('reclocked', { next_update_utc: '18:00' });
    assert.equal(reclocked.article.dissent, undefined);
    assert.equal(reclocked.verdict.dissent_dropped, 'recorded against revision 1; the call changed');
  } finally {
    delete process.env.CLANK_NEWSROOM_AGENT;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('a recorded dissent is counted by compose and reported in the receipt', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-dissent-compose-'));
  const state = path.join(temporary, 'state'), edition = '2026-09-05';
  try {
    const composeArgs = await driveToCompose(state, edition, article, owners.length, async () => {
      process.env.CLANK_NEWSROOM_AGENT = 'vesta';
      await recordDissent({ edition, event_key: 'vesta-on-the-record', article_id: 'story-1', revision: 1, stance: 'dissent', p: 0.62, argument: FORECAST_ARGUMENT });
    });
    process.env.CLANK_NEWSROOM_AGENT = 'caslon';
    const composed = await composeEdition({ ...composeArgs, event_key: 'compose-with-dissent' });
    assert.equal(composed.compose_gates, '# compose: passed=5/5 desks=4/4 forecast=1 dissent=1  → ready');
    assert.equal(composed.forecasts, 1);
    assert.equal(composed.dissents, 1);
    assert.equal((await readComposedReceipt(state, edition)).composition.dissents, 1);
    assert.match(await readIndexFile(state, edition), /^# compose: passed=5\/5 desks=4\/4 forecast=1 dissent=1 {2}→ ready$/mu);
    assert.match(await readIndexFile(state, edition), /^N story-1 rev=1 by=vesta dissent p=0\.62$/mu);
  } finally {
    delete process.env.CLANK_NEWSROOM_AGENT;
    await rm(temporary, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §2 — art.map / art.hero_map, refused at filing time.
// ---------------------------------------------------------------------------

test('a map pair ships both regions, and an unlisted region is refused in the wake that named it', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-art-pair-'));
  const state = path.join(temporary, 'state'), edition = '2026-09-07';
  const withArt = (index, art) => ({ ...article(`story-${index}`, owners[index][0].toUpperCase() + owners[index].slice(1), edition, index), art });
  try {
    process.env.CLANK_EDITION_STATE_ROOT = state;
    process.env.CLANK_NEWSROOM_AGENT = 'brass';
    await recordAssignment({ edition, event_key: `schedule:assignment-${edition}`, assignments: owners.map((owner, index) => ({ id: `story-${index}`, owner, brief: `Report the verified mechanism and the falsifying fact for story number ${index}.`, evidence_refs: [] })) });

    process.env.CLANK_NEWSROOM_AGENT = 'cogsworth';
    const spots = [{ name: 'HORMUZ', lat: 26.6, lon: 56.25 }];
    // The intended pattern, and the one that used to build a page and then die:
    // the wide region for the story page, its -hero re-crop for the front panel.
    await fileArticle({ edition, event_key: 'pair-filing', article: withArt(0, { kind: 'map', map: 'hormuz', hero_map: 'hormuz-hero', caption: 'The strait.', spots }) });
    const filed = JSON.parse(await readFile(path.join(state, 'editions', edition, 'filings', 'story-0', '1.json'), 'utf8'));
    assert.deepEqual([filed.art.map, filed.art.hero_map], ['hormuz', 'hormuz-hero']);

    // A region no edition ever baked, on either key, refused while the reporter
    // is still awake — nothing in this container can bake a new one.
    for (const art of [{ kind: 'map', map: 'kamchatka' }, { kind: 'map', map: 'hormuz', hero_map: 'kamchatka-hero' }]) {
      await assert.rejects(fileArticle({ edition, event_key: 'unlisted-region', article: withArt(0, art) }), /is in neither this edition's maps\/ nor the committed archive.*name a region ops\/ASSETS\.md lists, or file without art/su);
    }
    await assert.rejects(fileArticle({ edition, event_key: 'no-map-key', article: withArt(0, { kind: 'map', hero_map: 'hormuz-hero' }) }), /art\.kind is "map" but art\.map is undefined/u);
    await assert.rejects(fileArticle({ edition, event_key: 'bad-kind', article: withArt(0, { kind: 'Map', map: 'hormuz' }) }), /art\.kind must be "map" .* or "ascii"/su);
    await assert.rejects(fileArticle({ edition, event_key: 'bad-spot', article: withArt(0, { kind: 'map', map: 'hormuz', spots: [{ name: 'HORMUZ', lat: '26.6', lon: 56.25 }] }) }), /art\.spots\[0\]\.lat must be a number/u);

    // Cross-filing: one region, one set of spots. The content validator refuses
    // the page for this at 21:30; here the second reporter can still fix it.
    process.env.CLANK_NEWSROOM_AGENT = 'sprockett';
    await assert.rejects(fileArticle({ edition, event_key: 'clashing-spots', article: withArt(1, { kind: 'map', map: 'hormuz', caption: 'Again.', spots: [{ name: 'BANDAR', lat: 27.2, lon: 56.3 }] }) }), /"story-0" already names map "hormuz" with different art\.spots/u);
    // The same spots are fine — two stories may share a region.
    await assert.doesNotReject(fileArticle({ edition, event_key: 'matching-spots', article: withArt(1, { kind: 'map', map: 'hormuz-hero', caption: 'Again.', spots }) }));
  } finally {
    delete process.env.CLANK_NEWSROOM_AGENT;
    await rm(temporary, { recursive: true, force: true });
  }
});
test('file_desk refuses a desk document the edition cannot be assembled from', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-desk-shape-'));
  const state = path.join(temporary, 'state'), edition = '2026-09-07';
  process.env.CLANK_EDITION_STATE_ROOT = state;
  const deskFile = (name) => path.join(state, 'editions', edition, 'desk', `${name}.json`);
  try {
    // A good document of each of the four shapes lands and is readable back.
    for (const [agent, names] of [['ledger', ['ledger.settlements', 'ledger.worlddesk']], ['caslon', ['caslon.chrome', 'caslon.weather']]]) {
      process.env.CLANK_NEWSROOM_AGENT = agent;
      for (const name of names) {
        const filed = await fileDesk({ edition, event_key: `good-${name}`, name, document: deskDocument(name, edition) });
        assert.equal(filed.name, name);
        assert.deepEqual(JSON.parse(await readFile(deskFile(name), 'utf8')), deskDocument(name, edition));
      }
    }

    // Each required key, dropped one at a time, is refused by name — and the
    // refusal happens before anything is written, so a rejected document
    // leaves no half-filed desk behind.
    const missingEdition = '2026-09-08';
    const cases = [
      ['caslon', 'caslon.chrome', 'date', /date must be a non-empty string/u],
      ['caslon', 'caslon.chrome', 'edition_no', /edition_no must be a non-empty string/u],
      ['caslon', 'caslon.chrome', 'volume', /volume must be a non-empty string/u],
      ['caslon', 'caslon.chrome', 'issued_at', /issued_at must be a non-empty string/u],
      ['caslon', 'caslon.chrome', 'revision', /revision must be a number/u],
      ['caslon', 'caslon.chrome', 'tagline', /tagline must be a non-empty string/u],
      ['caslon', 'caslon.chrome', 'next_bell', /next_bell must be a non-empty string/u],
      ['caslon', 'caslon.chrome', 'compiled_by', /compiled_by must be a non-empty array/u],
      ['caslon', 'caslon.chrome', 'lead_story_id', /lead_story_id must be a non-empty string/u],
      ['caslon', 'caslon.weather', 'weather', /weather must be an object/u],
      ['ledger', 'ledger.settlements', 'resolved_last_edition', /resolved_last_edition must be an array/u],
      ['ledger', 'ledger.worlddesk', 'world_desk', /world_desk must be an object/u],
    ];
    for (const [agent, name, key, pattern] of cases) {
      process.env.CLANK_NEWSROOM_AGENT = agent;
      const { [key]: _dropped, ...document } = deskDocument(name, missingEdition);
      await assert.rejects(fileDesk({ edition: missingEdition, event_key: `missing-${name}-${key}`, name, document }), pattern, `${name} without ${key}`);
    }
    assert.deepEqual(await readdir(path.join(state, 'editions', missingEdition, 'desk')).catch(() => []), []);

    // Nested values are held to the same contract: index.astro reads these
    // unguarded and a wrong type is a build crash, not a thin page.
    process.env.CLANK_NEWSROOM_AGENT = 'ledger';
    await assert.rejects(fileDesk({ edition: missingEdition, event_key: 'worlddesk-index', name: 'ledger.worlddesk', document: { world_desk: { escalation_index: 'high', delta: 'steady', open_conflicts: 8, watch: 5 } } }), /world_desk\.escalation_index must be a number/u);
    await assert.rejects(fileDesk({ edition: missingEdition, event_key: 'worlddesk-delta', name: 'ledger.worlddesk', document: { world_desk: { escalation_index: 0.6, delta: '', open_conflicts: 8, watch: 5 } } }), /world_desk\.delta must be a non-empty string/u);
    await assert.rejects(fileDesk({ edition: missingEdition, event_key: 'settle-outcome', name: 'ledger.settlements', document: { resolved_last_edition: [{ call: 'A call.', outcome: 'partial', prior_p: 0.5 }] } }), /resolved_last_edition\[0\]\.outcome must be hit\|miss\|open/u);
    await assert.rejects(fileDesk({ edition: missingEdition, event_key: 'settle-prior', name: 'ledger.settlements', document: { resolved_last_edition: [{ call: 'A call.', outcome: 'hit', prior_p: 1.4 }] } }), /resolved_last_edition\[0\]\.prior_p must be a number in \[0,1\]/u);
    // Nothing settled is the empty array, which is a complete document.
    await fileDesk({ edition: missingEdition, event_key: 'settle-empty', name: 'ledger.settlements', document: { resolved_last_edition: [] } });

    // No observation retrieved is `null`, which is also a complete document.
    // The contract has to accept it, or the only way to file a valid weather
    // document on a day with no reading is to invent one.
    process.env.CLANK_NEWSROOM_AGENT = 'caslon';
    await fileDesk({ edition: missingEdition, event_key: 'weather-unavailable', name: 'caslon.weather', document: { weather: null } });
    // A partial reading is still refused: null is the whole document or the
    // five retrieved fields are, and there is nothing in between.
    await assert.rejects(fileDesk({ edition: missingEdition, event_key: 'weather-partial', name: 'caslon.weather', document: { weather: { city: 'Berlin', summary: 'clear' } } }), /weather\.temp_c must be a number/u);
    await assert.rejects(fileDesk({ edition: missingEdition, event_key: 'weather-absent', name: 'caslon.weather', document: {} }), /weather must be an object .*or null/u);

    // A field filed into the wrong document is caught here rather than
    // assembling silently over its owner's.
    process.env.CLANK_NEWSROOM_AGENT = 'caslon';
    await assert.rejects(fileDesk({ edition: missingEdition, event_key: 'weather-carries-worlddesk', name: 'caslon.weather', document: { ...deskDocument('caslon.weather', missingEdition), world_desk: { escalation_index: 0.6, delta: 'steady', open_conflicts: 8, watch: 5 } } }), /unexpected key\(s\) \[world_desk\]/u);
    await assert.rejects(fileDesk({ edition: missingEdition, event_key: 'chrome-not-an-object', name: 'caslon.chrome', document: [] }), /object required/u);
  } finally {
    delete process.env.CLANK_NEWSROOM_AGENT;
    await rm(temporary, { recursive: true, force: true });
  }
});

// The page shape is READ OUT OF THE ASSEMBLER THAT SHIPS IT, never copied
// here. A test that hand-copies the document it is meant to be checking proves
// only that two files once agreed; this one fails the moment ops/lay-page.mjs
// stops producing a composable page. (It used to parse the skeletons out of
// caslon's brief, and went red the moment they moved to PAGES.md — a shape
// pinned to prose is a shape pinned to nothing.)
const decisions = (edition, ids) => ({
  edition,
  order: ids,
  art: { [ids[1]]: { shape: 'chip', caption: 'One glyph.' }, [ids[2]]: { shape: 'drone', caption: 'The other.' } },
  flashpoints: [{ place: 'KYIV', lat: 50.45, lon: 30.52, note: 'A place worth a marker.', article: ids[0] }],
  briefly: [1, 2, 3].map((n) => ({ label: `Desk ${n}`, lead: { kicker: `Kicker ${n}`, agent: 'Graves', what: `What ${n}.` }, rest: [] })),
  tape: {
    briefly: [1, 2, 3].map((n) => ({ label: `Tape ${n}`, lead: { kicker: `Tape kicker ${n}`, agent: 'Foreman', what: `Tape what ${n}.` }, rest: [] })),
    markets: { kicker: 'A day in eight words', rows: [{ sym: 'ACP', value: '34', spark: 'slots', pct: 'from 4 Sep', dir: 'down' }] },
    watch: [{ when: '8 Sep', what: 'The measure either enters force or the date slips.', who: 'Foreman' }],
  },
});

const layAt = (state, edition, count) => {
  const ids = Array.from({ length: count }, (_, index) => `story-${index}`);
  return layEdition({ edition, ...readEditionInputs(state, edition), decisions: decisions(edition, ids) });
};

test('the pages ops/lay-page.mjs assembles compose, at five stories and at six', async () => {
  // Seven and eight are covered structurally in ops/lay-page.test.mjs; the
  // fixture here has one owner per story and the roster is six.
  for (const count of [5, 6]) {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-lay-page-'));
    const state = path.join(temporary, 'state');
    const edition = ['2026-09-09', '2026-09-10'][count - 5];
    try {
      // No article carries art.hero_map, which is the ordinary day the paper
      // runs: the permitted map set is empty and the front runs on glyphs.
      const noMap = (id, agent, date, index) => { const { art: _, ...value } = article(id, agent, date, index); return value; };
      await driveToCompose(state, edition, noMap, count);
      process.env.CLANK_NEWSROOM_AGENT = 'caslon';
      const { pages, maps } = layAt(state, edition, count);
      const composed = await composeEdition({ edition, event_key: `compose-laid-${count}`, pages, maps });
      assert.deepEqual(composed.tree.pages, ['front', 'tape']);
      assert.deepEqual(composed.tree.maps, []);
      // The two GlyphArt blocks alone clear the 2-3 illustration gate, whatever
      // the day's length, and every PASSed piece is placed exactly once.
      const index = await readIndexFile(state, edition);
      assert.match(index, new RegExp(`^G front articles=${count} visuals=2 papers=front lead=story-0$`, 'mu'));
      assert.match(index, /^G tape articles=0 visuals=0 papers=tape lead=-$/mu);

      // The same pages with one glyph removed are one visual short and refused.
      const thin = layAt(state, edition, count).pages;
      thin[0].document.head[1].props.columns[0] = [];
      await assert.rejects(composeEdition({ edition, event_key: `compose-laid-thin-${count}`, pages: thin, maps: [] }), /illustration rhythm invalid.*found 1/su);

      // Both pages on the same stock is refused: the paper values must differ.
      const sameStock = layAt(state, edition, count).pages;
      sameStock[1].document.paper = 'front';
      await assert.rejects(composeEdition({ edition, event_key: `compose-laid-stock-${count}`, pages: sameStock, maps: [] }), /paper diversity invalid/u);
    } finally {
      delete process.env.CLANK_NEWSROOM_AGENT;
      await rm(temporary, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// The two read-only bundles that merge into one directory.
//
// The first real stage_release ever attempted died here:
//
//   EACCES: permission denied, unlink
//     '.../website/node_modules/.package-lock.json'
//
// deps-a and deps-b are copied into the SAME website/node_modules and assets-a
// and assets-b into the SAME website/public/og. Both bundles are mode 555/444;
// `fs.cp` preserves those modes; `force:true` unlinks before overwriting and
// unlink needs write on the parent directory. So the second bundle of each pair
// could never land on a path the first one already held — and they overlap on
// `.package-lock.json`, `@astrojs`, `@img`, `@shikijs`, and every shared date
// directory under og/.
//
// The fixture below is the shape of the bug rather than a copy of the message:
// two roots that overlap. Disjoint roots pass with or without the fix.
// ---------------------------------------------------------------------------
const writeReadOnly = async (file, bytes) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); };
async function sealTree(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const paths = [...entries.map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))].reverse();
  for (const file of [...paths, root]) { const stats = await lstat(file); await chmod(file, stats.isDirectory() ? 0o555 : 0o444); }
}
async function unsealTree(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const file of [root, ...entries.map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))]) {
    const stats = await lstat(file); await chmod(file, stats.isDirectory() ? 0o755 : 0o644);
  }
}

test('two read-only bundles merging into one directory: the second one lands', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clank-bundle-merge-'));
  const state = path.join(temporary, 'state'), source = path.join(temporary, 'source'), staging = path.join(temporary, 'staging');
  const depsA = path.join(temporary, 'deps-a'), depsB = path.join(temporary, 'deps-b');
  const assetsA = path.join(temporary, 'assets-a'), assetsB = path.join(temporary, 'assets-b');
  const edition = '2026-09-05';
  const saved = { deps: process.env.CLANK_WEBSITE_DEPS_ROOTS, assets: process.env.CLANK_PUBLIC_ASSET_ROOTS };
  try {
    const composeArgs = await driveToCompose(state, edition, article);
    process.env.CLANK_NEWSROOM_AGENT = 'caslon';
    await composeEdition({ ...composeArgs, event_key: 'compose-for-bundle-merge' });

    // The public source root carries the validator; the astro binary arrives in
    // the dependency bundle, exactly as it does in the container.
    await writeReadOnly(path.join(source, 'ops', 'validate-content.mjs'), 'process.stdout.write("content OK\\n");\n');
    await writeReadOnly(path.join(source, 'website', 'package.json'), '{"name":"site"}\n');

    // The overlap. `.package-lock.json` exists in both halves with different
    // bytes, which is the file the real failure named.
    await writeReadOnly(path.join(depsA, 'website', 'node_modules', '.package-lock.json'), '{"half":"a"}\n');
    await writeReadOnly(path.join(depsA, 'website', 'node_modules', '@astrojs', 'marker.js'), '// a\n');
    await writeReadOnly(path.join(depsA, 'website', 'node_modules', 'astro', 'bin', 'astro.mjs'), 'process.stdout.write("built\\n");\n');
    await writeReadOnly(path.join(depsB, 'website', 'node_modules', '.package-lock.json'), '{"half":"b"}\n');
    await writeReadOnly(path.join(depsB, 'website', 'node_modules', '@shikijs', 'marker.js'), '// b\n');
    // Same shape for the asset halves: one shared date directory, one file each.
    await writeReadOnly(path.join(assetsA, 'website', 'public', 'og', edition, 'story-0.png'), 'a');
    await writeReadOnly(path.join(assetsA, 'website', 'public', 'og', edition, 'shared.png'), 'a');
    await writeReadOnly(path.join(assetsB, 'website', 'public', 'og', edition, 'story-1.png'), 'b');
    await writeReadOnly(path.join(assetsB, 'website', 'public', 'og', edition, 'shared.png'), 'b');
    for (const root of [source, depsA, depsB, assetsA, assetsB]) await sealTree(root);

    process.env.CLANK_NEWSROOM_AGENT = 'pressman';
    process.env.CLANK_PUBLIC_SOURCE_ROOT = source;
    process.env.CLANK_RELEASE_STAGING_ROOT = staging;
    process.env.CLANK_WEBSITE_DEPS_ROOTS = `${depsA}:${depsB}`;
    process.env.CLANK_PUBLIC_ASSET_ROOTS = `${assetsA}:${assetsB}`;

    const staged = await stageRelease({ edition, event_key: 'stage-bundle-merge' });
    assert.equal(staged.validated, true);
    assert.equal(staged.built, true);

    // Both halves of each pair reached the artifact, and the later root won the
    // paths they share — which is the ordering the roots are listed in.
    const modules = path.join(staged.staging_root, 'website', 'node_modules');
    assert.equal(await readFile(path.join(modules, '.package-lock.json'), 'utf8'), '{"half":"b"}\n');
    assert.ok((await readdir(modules)).includes('@astrojs'), 'deps-a survived deps-b');
    assert.ok((await readdir(modules)).includes('@shikijs'), 'deps-b landed at all');
    const og = path.join(staged.staging_root, 'website', 'public', 'og', edition);
    assert.deepEqual((await readdir(og)).sort(), ['shared.png', 'story-0.png', 'story-1.png']);
    assert.equal(await readFile(path.join(og, 'shared.png'), 'utf8'), 'b');
  } finally {
    for (const root of [source, depsA, depsB, assetsA, assetsB]) await unsealTree(root).catch(() => {});
    for (const [key, value] of [['CLANK_WEBSITE_DEPS_ROOTS', saved.deps], ['CLANK_PUBLIC_ASSET_ROOTS', saved.assets]])
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    delete process.env.CLANK_NEWSROOM_AGENT;
    await rm(temporary, { recursive: true, force: true });
  }
});
