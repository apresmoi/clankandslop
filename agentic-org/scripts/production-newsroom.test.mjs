import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectPublicArticleReferences, composeEdition, fileArticle, fileDesk, hasDatedForecastWithDissent, qualifySignal, recordAssignment, reviewArticle, stageRelease } from './production-newsroom.mjs';

const owners = ['cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton'];
const assignmentEvent = 'schedule:assignment-20260825';
const article = (id, agent, edition, index) => ({ id, edition_date: edition, section: ['world', 'markets', 'technology'][index % 3], kicker: 'Test', headline: `Headline ${id}`, deck: 'A complete sourced test deck.', epistemic: index === 1 ? 'forecast' : 'fact', byline: { desk: 'Test Desk', agents: [agent] }, timestamp: '12:00 UTC', revision: 1, next_update_utc: '14:30', topics: ['geopolitics'], body: ['One [E1].', 'Two [E1].', 'Three [E1].', 'Four [E1].'], key_numbers: [], evidence_box: [{ source: `Official ${index}`, fragment: 'fact', as_of: edition, source_note: { source_id: 'E1', source_kind: 'public_url', used_by_agent: agent, source_url: `https://source${index}.example/evidence`, retrieved_at: `${edition}T10:00:00Z` } }], refs: ['E1'], ...(index === 1 ? { dissent: { agent: 'Vesta', p: 0.4, argument: 'The named dissenter identifies a plausible countercase.' } } : {}), ...(index === 0 ? { art: { hero_map: 'world-map' } } : {}) });
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
  const assignments = owners.map((owner, index) => ({ id: `story-${index}`, owner, brief: `Report the verified mechanism and countercase for story number ${index}.`, evidence_refs: [`https://source${index}.example/evidence`] })); await recordAssignment({ edition, event_key: assignmentEvent, assignments });
  process.env.CLANK_NEWSROOM_AGENT = 'cogsworth';
  await assert.rejects(fileArticle({ edition, event_key: 'hostile-bad-id', assignment_event_key: assignmentEvent, article: article('unassigned', 'Cogsworth', edition, 0) }), /assignment/u);
  await assert.rejects(fileArticle({ edition, event_key: 'hostile-bad-owner', assignment_event_key: assignmentEvent, article: article('story-1', 'Cogsworth', edition, 1) }), /owner/u);
  const badEvidence = article('story-0', 'Cogsworth', edition, 0); badEvidence.evidence_box[0].source_note.source_url = 'https://wrong.example'; await assert.rejects(fileArticle({ edition, event_key: 'hostile-bad-evidence', assignment_event_key: assignmentEvent, article: badEvidence }), /evidence/u);
  for (let index = 0; index < owners.length; index++) { const owner = owners[index]; process.env.CLANK_NEWSROOM_AGENT = owner; await fileArticle({ edition, event_key: `filing-${index}`, assignment_event_key: assignmentEvent, article: article(`story-${index}`, owner[0].toUpperCase() + owner.slice(1), edition, index) }); }
  process.env.CLANK_NEWSROOM_AGENT = 'spike'; await reviewArticle({ edition, event_key: 'request-0', article_id: 'story-0', revision: 1, verdict: 'REVISION_REQUEST', notes: 'Resolve the countercase.' });
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
