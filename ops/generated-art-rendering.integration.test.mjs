import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDate = '2099-01-02';
const leadSlug = 'generated-lead';
const glyphSlug = 'generated-glyph';

const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const read = (root, file) => readFileSync(resolve(root, file), 'utf8');
const copyRepo = () => {
  const root = mkdtempSync(resolve(tmpdir(), 'cns-main-art-render-'));
  const filter = (source) => !source.split('/').some((part) => ['node_modules', 'dist', '.astro', '.git'].includes(part));
  for (const name of ['content', 'ops', 'website']) {
    cpSync(resolve(repo, name), resolve(root, name), { recursive: true, dereference: true, filter });
  }
  const modules = resolve(repo, 'website/node_modules');
  if (existsSync(modules)) symlinkSync(modules, resolve(root, 'website/node_modules'), 'dir');
  return root;
};
const addEdition = (root, { heroArt = true, articleArt = false, glyphArt = true } = {}) => {
  const base = resolve(root, 'content/editions', fixtureDate);
  for (const dir of ['articles', 'desk', 'maps', 'pages', 'glyphs']) mkdirSync(resolve(base, dir), { recursive: true });
  writeJson(resolve(base, 'desk/caslon.chrome.json'), { date: fixtureDate, edition_no: '9001', volume: 'X', issued_at: '2099-01-02T12:00:00Z', revision: 1, tagline: 'fixture', next_bell: '18:00 UTC', compiled_by: ['Cogsworth'], lead_story_id: leadSlug });
  writeJson(resolve(base, 'desk/caslon.weather.json'), { weather: { city: 'Fixture', temp_c: 20, summary: 'clear', humidity_pct: 50, wind: 'calm' } });
  writeJson(resolve(base, 'desk/ledger.settlements.json'), { resolved_last_edition: [] });
  writeJson(resolve(base, 'desk/ledger.worlddesk.json'), { world_desk: { escalation_index: 0.1, delta: 'steady', open_conflicts: 1, watch: 1 } });
  writeJson(resolve(base, 'maps/fixture-region.json'), { name: 'fixture-region', west: 30, east: 40, south: 30, north: 38, cols: 84, rows: 32, bands: Array.from({ length: 32 }, (_, r) => '0'.repeat(10) + '12345678'.repeat(8) + String(r % 9).repeat(10)) });
  writeJson(resolve(base, 'glyphs/generated-glyph.json'), { name: glyphSlug, cols: 5, rows: 3, art: '  #  \n ### \n#####', caption: 'Generated glyph fixture.' });
  const article = { id: leadSlug, edition_date: fixtureDate, section: 'world', kicker: 'Fixture', headline: 'Generated Art Lead', deck: 'A synthetic article for renderer compatibility.', epistemic: 'fact', byline: { desk: 'Fixture Desk', agents: ['Cogsworth'] }, timestamp: '12:00 UTC', revision: 1, body: ['Paragraph one.', 'Paragraph two.'], refs: [], evidence_box: [] };
  if (articleArt) article.art = { kind: 'map', map: 'fixture-region', caption: 'Reporter map caption.', spots: [{ name: 'REPORTER', lat: 34, lon: 35 }] };
  writeJson(resolve(base, `articles/${leadSlug}.json`), article);
  const art = heroArt ? { block: 'MapGlyph', props: { map: 'fixture-region', title: 'Fixture Region', caption: 'Hero map caption.', spots: [{ name: 'PLACE', lat: 34, lon: 35, label_side: 'right' }], routes: [{ name: 'Route One', color: 'accent', points: [[33, 34], [35, 37]] }], overlays: [{ name: 'Zone One', color: 'red', ring: [[32, 33], [36, 33], [36, 38], [32, 38]] }], tone: 'soft', locator_context: 'regional', interactive: false } } : undefined;
  writeJson(resolve(base, 'pages/front.json'), { edition: fixtureDate, page: 'front', title: 'Fixture Front', active: '/', tagline: 'fixture', head: [{ block: 'Hero', props: { variant: 'lead-only', withArt: true, lead: leadSlug, ...(art ? { art } : {}) } }, ...(glyphArt ? [{ block: 'GlyphArt', props: { glyph: glyphSlug, caption: 'Generated glyph caption.' } }] : [])], flow: [] });
  writeJson(resolve(base, 'pages/tape.json'), { edition: fixtureDate, page: 'tape', title: 'Fixture Tape', active: '/tape', head: [], flow: [] });
};
const build = (root) => execFileSync('npm', ['run', 'build'], { cwd: resolve(root, 'website'), encoding: 'utf8', stdio: 'pipe' });
const assertRendered = (root) => {
  const front = read(root, `website/dist/editions/${fixtureDate}/index.html`);
  assert.match(front, /hero-art-map/);
  assert.match(front, /mapglyph-print/);
  assert.match(front, /mapglyph-locator/);
  assert.match(front, /locator-footprint/);
  assert.match(front, /PLACE/);
  assert.match(front, /Hero map caption\./);
  assert.match(front, /Route One/);
  assert.match(front, /Zone One/);
  assert.match(front, /glyphart-generated/);
  assert.match(front, /Generated glyph caption\./);
  assert.match(front, /#####/);
  const article = read(root, `website/dist/editions/${fixtureDate}/articles/${leadSlug}/index.html`);
  assert.match(article, /article-map/);
  assert.match(article, /mapglyph-print/);
  assert.match(article, /mapglyph-locator/);
  assert.match(article, /PLACE/);
  assert.match(article, /Hero map caption\./);
};

test('content-only publication renders explicit Hero MapGlyph and generated GlyphArt', () => {
  const root = copyRepo();
  try {
    addEdition(root);
    build(root);
    assertRendered(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy reporter article map keeps its hero caption and article presentation', () => {
  const root = copyRepo();
  try {
    addEdition(root, { heroArt: false, articleArt: true, glyphArt: false });
    build(root);
    const front = read(root, `website/dist/editions/${fixtureDate}/index.html`);
    assert.match(front, /hero-art-map/);
    assert.match(front, /mapglyph-print/);
    assert.match(front, /REPORTER/);
    assert.match(front, /▲ Reporter map caption\./);
    const article = read(root, `website/dist/editions/${fixtureDate}/articles/${leadSlug}/index.html`);
    assert.match(article, /article-map/);
    assert.match(article, /mapglyph-print/);
    assert.match(article, /REPORTER/);
    assert.match(article, /Reporter map caption\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('explicit Hero GlyphArt overrides a legacy reporter map while article rendering keeps the reporter map', () => {
  const root = copyRepo();
  try {
    addEdition(root, { heroArt: false, articleArt: true, glyphArt: false });
    const pageFile = resolve(root, 'content/editions', fixtureDate, 'pages/front.json');
    const page = JSON.parse(readFileSync(pageFile, 'utf8'));
    page.head[0].props.art = { block: 'GlyphArt', props: { glyph: glyphSlug, caption: 'Generated glyph override.' } };
    writeJson(pageFile, page);
    build(root);
    const front = read(root, `website/dist/editions/${fixtureDate}/index.html`);
    assert.match(front, /hero-art-glyph/);
    assert.match(front, /glyphart-generated/);
    assert.match(front, /#####/);
    assert.match(front, /Generated glyph override\./);
    assert.doesNotMatch(front, /hero-art-map/);
    assert.doesNotMatch(front, /▲ Reporter map caption\./);
    const article = read(root, `website/dist/editions/${fixtureDate}/articles/${leadSlug}/index.html`);
    assert.match(article, /article-map/);
    assert.match(article, /REPORTER/);
    assert.match(article, /Reporter map caption\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

