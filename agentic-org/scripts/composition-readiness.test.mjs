import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertCompositionCoverage, compositionCoverage, composeGateLine, composeGateStatus } from './compose-gate.mjs';
import { buildEditionIndex } from './edition-index.mjs';

const edition = '2026-09-11';
const article = (section, index) => ({
  id: `story-${index}`, section, revision: 1, byline: { agents: [`Reporter${index}`] }, epistemic: 'fact',
  evidence_box: [{ source: `Source ${index}`, source_note: { source_url: `https://source${index}.example/report` } }]
});
const twoSections = () => ['Business', 'World', 'World', 'Business', 'World'].map(article);
const threeSections = () => [...twoSections(), article('Policy', 5)];
const status = articles => composeGateStatus({ edition, passed: articles.length, desks: 4, coverage: compositionCoverage(articles), forecasts: 0, dissents: 0 });

test('today-shaped two-section paper is blocked while an additional genuine third section is ready', () => {
  assert.equal(status(twoSections()).state, 'blocked');
  assert.match(composeGateLine(status(twoSections())), /sections=2\/3 owners=5\/5 sources=5\/3 domains=5\/3.*→ blocked$/);
  assert.throws(() => assertCompositionCoverage(compositionCoverage(twoSections())), /at least 3 distinct sections required, found 2: Business, World/);
  assert.equal(status(threeSections()).state, 'ready');
  assert.doesNotThrow(() => assertCompositionCoverage(compositionCoverage(threeSections())));
});

test('each existing floor blocks both readiness and composition, and unmeasured coverage is unknown', () => {
  for (const [field, length, message] of [['sections', 2, 'distinct sections'], ['owners', 4, 'distinct byline agents'], ['sources', 2, 'distinct evidence sources'], ['domains', 2, 'distinct source_url domains']]) {
    const coverage = compositionCoverage(threeSections()); coverage[field] = coverage[field].slice(0, length);
    const result = composeGateStatus({ edition, passed: 6, desks: 4, coverage });
    assert.equal(result.state, 'blocked', field);
    assert.throws(() => assertCompositionCoverage(coverage), new RegExp(message));
  }
  const unknown = composeGateStatus({ edition, passed: 6, desks: 4 });
  assert.equal(unknown.state, 'blocked');
  assert.match(composeGateLine(unknown), /sections=\?\/3 owners=\?\/5 sources=\?\/3 domains=\?\/3/);
});

test('coverage preserves distinct-name and URL-hostname counting, including invalid URL exclusion', () => {
  const values = threeSections();
  values[1].evidence_box[0].source_note.source_url = 'https://source0.example/another';
  values[2].evidence_box[0].source_note.source_url = 'not a URL';
  values[1].evidence_box[0].source = 'Source 0';
  const coverage = compositionCoverage(values);
  assert.equal(coverage.sources.length, 5);
  assert.equal(coverage.domains.length, 4);
});

test('the filesystem INDEX reports the same two-section blocker before any compose attempt', async () => {
  const state = await mkdtemp(path.join(tmpdir(), 'clank-compose-readiness-'));
  const base = path.join(state, 'editions', edition);
  try {
    for (const kind of ['articles', 'desk']) await mkdir(path.join(base, kind), { recursive: true });
    for (const value of twoSections()) await writeFile(path.join(base, 'articles', `${value.id}.json`), JSON.stringify(value));
    for (const name of ['caslon.chrome', 'caslon.weather', 'ledger.settlements', 'ledger.worlddesk']) await writeFile(path.join(base, 'desk', `${name}.json`), '{}');
    const blocked = await buildEditionIndex(state, edition, { knownTopics: new Set() });
    assert.match(blocked, /^# compose: passed=5\/5 desks=4\/4 sections=2\/3 owners=5\/5 sources=5\/3 domains=5\/3 forecast=0 dissent=0 {2}→ blocked$/mu);
    const extra = article('Policy', 5); await writeFile(path.join(base, 'articles', `${extra.id}.json`), JSON.stringify(extra));
    const ready = await buildEditionIndex(state, edition, { knownTopics: new Set() });
    assert.match(ready, /^# compose: passed=6\/5 desks=4\/4 sections=3\/3 owners=6\/5 sources=6\/3 domains=6\/3 forecast=0 dissent=0 {2}→ ready$/mu);
  } finally { await rm(state, { recursive: true, force: true }); }
});
