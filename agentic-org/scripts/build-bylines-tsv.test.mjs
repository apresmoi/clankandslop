import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  sanitizeField,
  rowForArticle,
  renderAgentTsv,
  compareRows,
  collectBylineRows,
  buildBylinesTsv
} from './build-bylines-tsv.mjs';

const repoRoot = resolve(import.meta.dirname, '..', '..');

function article(overrides = {}) {
  return {
    id: 'a-slug',
    edition_date: '2026-06-13',
    section: 'geopolitics',
    epistemic: 'inference',
    topics: ['oil', 'strait-of-hormuz'],
    headline: 'A headline',
    byline: { agents: ['Sprockett'] },
    ...overrides
  };
}

function writeArticle(scratch, edition, slug, data) {
  const dir = join(scratch, 'content', 'editions', edition, 'articles');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.json`), JSON.stringify(data));
}

test('sanitizeField replaces tabs/newlines/CR with a space and empty/absent with -', () => {
  assert.equal(sanitizeField('a\tb'), 'a b');
  assert.equal(sanitizeField('a\nb\r\nc'), 'a b c');
  assert.equal(sanitizeField(''), '-');
  assert.equal(sanitizeField(undefined), '-');
  assert.equal(sanitizeField(null), '-');
  assert.equal(sanitizeField('plain'), 'plain');
});

test('rowForArticle sanitizes a headline containing an embedded newline', () => {
  const { fields, missing } = rowForArticle(article({ headline: 'Line one.\nLine two.' }));
  assert.equal(fields.headline, 'Line one. Line two.');
  assert.deepEqual(missing, []);
});

test('rowForArticle reports every missing field and emits - for each', () => {
  const { fields, missing, agents } = rowForArticle({
    byline: { agents: ['Foreman'] }
    // id, edition_date, section, epistemic, topics, headline all absent
  });
  assert.deepEqual(fields, { date: '-', slug: '-', section: '-', epistemic: '-', topics: '-', headline: '-' });
  assert.deepEqual(missing.sort(), ['date', 'epistemic', 'headline', 'section', 'slug', 'topics']);
  assert.deepEqual(agents, ['Foreman']);
});

test('rowForArticle joins topics with commas and no spaces', () => {
  const { fields } = rowForArticle(article({ topics: ['us-iran', 'oil', 'maritime-security'] }));
  assert.equal(fields.topics, 'us-iran,oil,maritime-security');
});

test('rowForArticle treats an empty topics array as missing', () => {
  const { fields, missing } = rowForArticle(article({ topics: [] }));
  assert.equal(fields.topics, '-');
  assert.ok(missing.includes('topics'));
});

test('rowForArticle returns no agents when byline.agents is absent', () => {
  const { agents } = rowForArticle({ id: 'x' });
  assert.deepEqual(agents, []);
});

test('compareRows sorts newest date first, tiebreaking by slug ascending', () => {
  const rows = [
    { date: '2026-06-10', slug: 'zebra' },
    { date: '2026-06-12', slug: 'mid' },
    { date: '2026-06-12', slug: 'alpha' },
    { date: '2026-06-11', slug: 'beta' }
  ];
  const sorted = [...rows].sort(compareRows);
  assert.deepEqual(
    sorted.map((r) => `${r.date}:${r.slug}`),
    ['2026-06-12:alpha', '2026-06-12:mid', '2026-06-11:beta', '2026-06-10:zebra']
  );
});

test('compareRows sorts rows with a missing (-) date to the end', () => {
  const rows = [
    { date: '-', slug: 'undated' },
    { date: '2026-06-10', slug: 'dated' }
  ];
  const sorted = [...rows].sort(compareRows);
  assert.deepEqual(sorted.map((r) => r.slug), ['dated', 'undated']);
});

test('renderAgentTsv emits exactly six tab-separated columns, no header, trailing newline', () => {
  const text = renderAgentTsv([
    { date: '2026-06-13', slug: 'a-slug', section: 'geopolitics', epistemic: 'inference', topics: 'oil,us-iran', headline: 'A headline' }
  ]);
  assert.equal(text, '2026-06-13\ta-slug\tgeopolitics\tinference\toil,us-iran\tA headline\n');
  const fields = text.trimEnd().split('\t');
  assert.equal(fields.length, 6);
});

test('deterministic and byte-stable: same input directory produces identical output across two runs', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'clank-bylines-'));
  try {
    writeArticle(scratch, '2026-06-13', 'first', article({ id: 'first', byline: { agents: ['Sprockett'] } }));
    writeArticle(scratch, '2026-06-14', 'second', article({ id: 'second', edition_date: '2026-06-14', byline: { agents: ['Sprockett', 'Graves'] } }));

    const first = collectBylineRows(scratch);
    const second = collectBylineRows(scratch);
    assert.equal(renderAgentTsv(first.byAgent.get('sprockett')), renderAgentTsv(second.byAgent.get('sprockett')));

    buildBylinesTsv(scratch);
    const runOne = readFileSync(join(scratch, 'content', 'bylines', 'sprockett.tsv'), 'utf8');
    buildBylinesTsv(scratch);
    const runTwo = readFileSync(join(scratch, 'content', 'bylines', 'sprockett.tsv'), 'utf8');
    assert.equal(runOne, runTwo, 'rebuilding from unchanged input must produce byte-identical output');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('buildBylinesTsv writes one file per agent, newest-first with slug tiebreak, no header line', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'clank-bylines-'));
  try {
    writeArticle(scratch, '2026-06-10', 'older', article({ id: 'older', edition_date: '2026-06-10', byline: { agents: ['Sprockett'] } }));
    writeArticle(scratch, '2026-06-12', 'newer-b', article({ id: 'newer-b', edition_date: '2026-06-12', byline: { agents: ['Sprockett'] } }));
    writeArticle(scratch, '2026-06-12', 'newer-a', article({ id: 'newer-a', edition_date: '2026-06-12', byline: { agents: ['Sprockett'] } }));
    writeArticle(scratch, '2026-06-11', 'other-agent', article({ id: 'other-agent', edition_date: '2026-06-11', byline: { agents: ['Graves'] } }));

    const { written } = buildBylinesTsv(scratch);
    assert.deepEqual(written.map((w) => w.agent).sort(), ['graves', 'sprockett']);

    const text = readFileSync(join(scratch, 'content', 'bylines', 'sprockett.tsv'), 'utf8');
    const lines = text.trimEnd().split('\n');
    assert.deepEqual(lines.map((l) => l.split('\t')[1]), ['newer-a', 'newer-b', 'older']);
    assert.equal(text.endsWith('\n'), true);
    assert.ok(!text.includes('date\tslug'), 'no header row');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('an agent credited on zero articles gets no file written', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'clank-bylines-'));
  try {
    writeArticle(scratch, '2026-06-10', 'solo', article({ id: 'solo', edition_date: '2026-06-10', byline: { agents: ['Sprockett'] } }));
    const { written } = buildBylinesTsv(scratch);
    assert.deepEqual(written.map((w) => w.agent), ['sprockett']);
    assert.equal(readdirSync(join(scratch, 'content', 'bylines')).length, 1);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// --- Real corpus checks ---

function loadRealArticles() {
  const editionsDir = join(repoRoot, 'content', 'editions');
  const articles = [];
  for (const edition of readdirSync(editionsDir).sort()) {
    const articlesDir = join(editionsDir, edition, 'articles');
    let names;
    try {
      names = readdirSync(articlesDir);
    } catch {
      continue;
    }
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      articles.push(JSON.parse(readFileSync(join(articlesDir, name), 'utf8')));
    }
  }
  return articles;
}

test('real corpus: every article for a given agent appears exactly once in that agent'+"'"+'s TSV', () => {
  const articles = loadRealArticles();
  const { byAgent } = collectBylineRows(repoRoot);

  const target = articles.find((a) => a.byline?.agents?.includes('Sprockett'));
  assert.ok(target, 'fixture assumes Sprockett has at least one byline in the real corpus');

  const rows = byAgent.get('sprockett');
  const matches = rows.filter((r) => r.slug === target.id && r.date === target.edition_date);
  assert.equal(matches.length, 1, `article ${target.id} must appear exactly once in sprockett.tsv`);
});

test('real corpus: total TSV row count equals the total number of (article, agent) pairs', () => {
  const articles = loadRealArticles();
  const expectedPairs = articles.reduce((sum, a) => sum + (Array.isArray(a.byline?.agents) ? a.byline.agents.length : 0), 0);

  const { byAgent } = collectBylineRows(repoRoot);
  const actualPairs = [...byAgent.values()].reduce((sum, rows) => sum + rows.length, 0);

  assert.equal(actualPairs, expectedPairs);
});
