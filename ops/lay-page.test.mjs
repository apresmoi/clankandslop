import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { LayoutError, alternationRuns, archiveIndex, archiveResolver, layEdition, readEditionInputs } from './lay-page.mjs';
import { collectPublicArticleReferences } from '../agentic-org/scripts/production-newsroom.mjs';

import { repo, agents, readJson, EDITIONS, decisionsFromShipped, layShipped } from './lay-page.test-data.mjs';

const article = (id, over = {}) => ({ id, edition_date: '2026-09-09', section: 'world', kicker: 'K', headline: 'H', deck: 'D', epistemic: 'fact', byline: { desk: 'Policy Desk', agents: ['Tinkerton'] }, timestamp: 'T', revision: 1, body: ['a', 'b', 'c', 'd'], refs: [], evidence_box: [], ...over });
const synthetic = () => ({
  edition: '2026-09-09',
  articles: {
    alpha: article('alpha', { byline: { desk: 'Escalation Desk', agents: ['Sprockett'] } }),
    bravo: article('bravo', { byline: { desk: 'Hardware Desk', agents: ['Cogsworth'] } }),
    charlie: article('charlie', { byline: { desk: 'Macro Desk', agents: ['Foreman'] } }),
    delta: article('delta', { byline: { desk: 'Commodities Desk', agents: ['Graves'] } }),
    echo: article('echo'),
  },
  desk: {
    'caslon.chrome': { date: '2026-09-09', edition_no: '0075', volume: 'I', issued_at: 'x', revision: 1, tagline: 't', next_bell: '14:00 UTC', compiled_by: ['Tinkerton'], lead_story_id: 'alpha' },
    'caslon.weather': { weather: null },
    'ledger.settlements': { resolved_last_edition: [] },
    'ledger.worlddesk': { world_desk: { escalation_index: 0.5, delta: 'steady', open_conflicts: 1, watch: 1 } },
  },
  maps: {},
  decisions: {
    edition: '2026-09-09',
    order: ['alpha', 'bravo', 'charlie', 'delta', 'echo'],
    art: { alpha: { shape: 'satellite', caption: 'Lead.' }, bravo: { shape: 'chip', caption: 'One.' }, charlie: { shape: 'drone', caption: 'Two.' } },
    flashpoints: [{ place: 'KYIV', lat: 50.45, lon: 30.52, note: 'A note.', article: 'alpha' }],
    briefly: [1, 2, 3].map((n) => ({ label: `Desk ${n}`, lead: { kicker: `K${n}`, agent: 'Graves', what: `W${n}` }, rest: [] })),
    tape: {
      briefly: [1, 2, 3].map((n) => ({ label: `Tape ${n}`, lead: { kicker: `TK${n}`, agent: 'Foreman', what: `TW${n}` }, rest: [] })),
      markets: { kicker: '9 Sep · one thing', rows: [{ sym: 'ACP', value: '34', spark: 'slots', pct: 'from 4 Sep', dir: 'down' }] },
      watch: [{ when: '10 Sep', what: 'The rule either enters force or it slips.', who: 'Tinkerton' }],
    },
  },
  agents,
  archive: () => undefined,
});
const lay = (mutate = (input) => input) => layEdition(mutate(synthetic()));
const refuses = (mutate, gate) => {
  let error;
  try { lay(mutate); } catch (thrown) { error = thrown; }
  assert.ok(error instanceof LayoutError, `expected a LayoutError naming ${gate}, got ${error ?? 'no error at all'}`);
  assert.match(error.message, gate, `expected a refusal naming ${gate}, got: ${error.message}`);
  return error;
};

test('the two pages carry different top-level paper values', () => {
  const { pages } = lay();
  assert.equal(pages[0].document.paper, 'front');
  assert.equal(pages[1].document.paper, 'tape');
  assert.equal(new Set(pages.map((p) => p.document.paper)).size, 2);
});

test('the front carries exactly three visual blocks including Caslon-owned lead art', () => {
  const { pages } = lay();
  const visuals = JSON.stringify(pages[0].document).match(/"block":"(?:MapGlyph|GlyphArt|Illustration|Image)"/gu) ?? [];
  assert.equal(visuals.length, 3);
  assert.equal(pages[0].document.head[0].props.art.block, 'GlyphArt');
});

test('every PASSed article is placed exactly once, and the tape features none', () => {
  const { pages } = lay();
  const front = collectPublicArticleReferences(pages[0].document);
  const tape = collectPublicArticleReferences(pages[1].document);
  assert.deepEqual(front, ['alpha', 'bravo', 'charlie', 'delta', 'echo']);
  assert.deepEqual(tape, []);
  assert.deepEqual(front.filter((slug) => tape.includes(slug)), []);
});

test('illustrated rows alternate after the lead art row', () => {
  const [hero, rowA, rowB] = lay().pages[0].document.head.slice(0, 3);
  assert.equal(hero.props.withArt, true);
  assert.deepEqual(rowA.props.cols, [2, 1]);
  assert.equal(rowA.props.columns[1][0].block, 'GlyphArt');
  assert.deepEqual(rowB.props.cols, [1, 2]);
  assert.equal(rowB.props.columns[0][0].block, 'GlyphArt');
});

test('the globe hotspots and the flashpoint index are the same places in the same order', () => {
  const row = lay().pages[0].document.head.find((b) => b.block === 'Grid' && b.props.columns[0][0]?.block === 'WorldGlyph');
  const hotspots = row.props.columns[0][0].props.hotspots.map((h) => h.name);
  const places = row.props.columns[1][0].props.items.map((i) => i.place);
  assert.deepEqual(hotspots, places);
});

test('the flashpoint agent is derived from the article byline, never supplied', () => {
  const row = lay().pages[0].document.head.find((b) => b.block === 'Grid' && b.props.columns[0][0]?.block === 'WorldGlyph');
  assert.equal(row.props.columns[1][0].props.items[0].agent, 'Sprockett');
});

test('a sixth story becomes a full-width feature row before the section header', () => {
  const { pages } = lay((input) => {
    input.articles.foxtrot = article('foxtrot', { byline: { desk: 'The Hearth', agents: ['Vesta'] } });
    input.decisions.order.push('foxtrot');
    return input;
  });
  const head = pages[0].document.head;
  const wide = head.findIndex((b) => b.block === 'Grid' && b.props.cols.length === 1);
  assert.equal(head[wide].props.columns[0][0].props.article, 'foxtrot');
  assert.ok(wide < head.findIndex((b) => b.block === 'SectionHeader'));
});

test('a seventh story becomes a second two-up row rather than a dropped piece', () => {
  const { pages } = lay((input) => {
    for (const id of ['foxtrot', 'golf']) { input.articles[id] = article(id); input.decisions.order.push(id); }
    return input;
  });
  const twoUp = pages[0].document.head.filter((b) => b.block === 'Grid' && b.props.cols.join() === '1,1' && b.props.columns[0][0].block === 'Teaser');
  assert.equal(twoUp.length, 2);
});

test('an order that is not exactly the PASSed set is refused, naming the gate', () => {
  refuses((i) => { i.decisions.order = ['alpha', 'bravo', 'charlie', 'delta']; return i; }, /page completeness invalid/);
  refuses((i) => { i.decisions.order = ['alpha', 'alpha', 'bravo', 'charlie', 'delta']; return i; }, /page completeness invalid/);
});

test('a lead that disagrees with caslon.chrome is refused', () => {
  refuses((i) => { i.decisions.order = ['bravo', 'alpha', 'charlie', 'delta', 'echo']; return i; }, /lead story/);
});

test('a missing desk document is refused before any page is built', () => {
  refuses((i) => { delete i.desk['ledger.worlddesk']; return i; }, /edition tree incomplete/);
});

test('an illustrated slot with neither article art nor a record entry is refused', () => {
  const error = refuses((i) => { delete i.decisions.art.bravo; return i; }, /illustration rhythm invalid/);
  assert.match(error.message, /art\["bravo"\]/);
});

test('a new layout without lead art is refused before page bytes are produced', () => {
  const error = refuses((i) => { delete i.decisions.art.alpha; return i; }, /illustration rhythm invalid/);
  assert.match(error.message, /art\["alpha"\]/);
});

test('a glyph outside the committed library is refused', () => {
  refuses((i) => { i.decisions.art.bravo.shape = 'biplane'; return i; }, /glyph catalogue/);
  refuses((i) => { i.decisions.art.bravo.roll = 'globe'; return i; }, /glyph catalogue/);
  refuses((i) => { i.decisions.art.bravo.roll = 'eclipse'; return i; }, /glyph catalogue/);
  refuses((i) => { i.decisions.art.bravo.shape = 'eclipse'; return i; }, /glyph catalogue/);
});

test('eclipse glyph requires both shape "eclipse" and roll "eclipse" in layout', () => {
  const { pages } = lay((i) => {
    i.decisions.art.bravo = { shape: 'eclipse', roll: 'eclipse', caption: 'The total solar eclipse.' };
    return i;
  });
  const block = pages[0].document.head[1].props.columns[1][0];
  assert.deepEqual(block.props, { shape: 'eclipse', roll: 'eclipse', scale: 0.6, caption: 'The total solar eclipse.' });

  const shapeOnlyErr = refuses((i) => { i.decisions.art.bravo = { shape: 'eclipse', caption: 'Shape only.' }; return i; }, /glyph catalogue/);
  assert.match(shapeOnlyErr.message, /uses shape "eclipse", which requires roll "eclipse" beside it/);

  refuses((i) => {
    i.articles.bravo.art = { kind: 'ascii', shape: 'eclipse', caption: 'Article shape only.' };
    delete i.decisions.art.bravo.shape;
    return i;
  }, /glyph catalogue/);

});

test('a Briefly that is not exactly three desks is refused', () => {
  refuses((i) => { i.decisions.briefly = i.decisions.briefly.slice(0, 2); return i; }, /briefly shape/);
  refuses((i) => { i.decisions.tape.briefly = [...i.decisions.tape.briefly, i.decisions.tape.briefly[0]]; return i; }, /briefly shape/);
});

test('an agent name with no persona file is refused', () => {
  refuses((i) => { i.decisions.briefly[0].lead.agent = 'Caslon'; return i; }, /agent reference/);
  refuses((i) => { i.decisions.tape.watch[0].who = 'Brass'; return i; }, /agent reference/);
});

test('an article hero_map with no baked map is refused, naming the maps gate', () => {
  refuses((i) => { i.articles.echo.art = { kind: 'map', map: 'kyiv', hero_map: 'kyiv', caption: 'c' }; return i; }, /maps must match article art/);
});

test('a baked hero_map is supplied to compose_edition even when no page shows it', () => {
  const { maps } = lay((i) => {
    i.articles.echo.art = { kind: 'map', map: 'kyiv', hero_map: 'kyiv', caption: 'c', spots: [] };
    i.maps.kyiv = { name: 'kyiv', west: 20, east: 40, south: 40, north: 60, cols: 2, rows: 1, bands: ['01'] };
    return i;
  });
  assert.deepEqual(maps.map((m) => m.name), ['kyiv']);
});

test('an article carrying map art in an illustrated slot becomes a MapGlyph with its own spots', () => {
  const spots = [{ name: 'KYIV', lat: 50.45, lon: 30.52 }];
  const { pages } = lay((i) => {
    i.articles.bravo.art = { kind: 'map', map: 'kyiv', hero_map: 'kyiv', caption: 'From the article.', spots };
    i.maps.kyiv = { name: 'kyiv', west: 20, east: 40, south: 40, north: 60, cols: 2, rows: 1, bands: ['01'] };
    delete i.decisions.art.bravo;
    return i;
  });
  const block = pages[0].document.head[1].props.columns[1][0];
  assert.equal(block.block, 'MapGlyph');
  assert.deepEqual(block.props.spots, spots);
  assert.equal(block.props.caption, 'From the article.');
  assert.equal(block.props.interactive, false);
});

const KYIV_MAP = { name: 'kyiv', west: 20, east: 40, south: 40, north: 60, cols: 2, rows: 1, bands: ['01'] };
const withMap = (i, slug, over = {}) => {
  i.articles[slug].art = { kind: 'map', map: 'kyiv', hero_map: 'kyiv', caption: 'From the article.', spots: [{ name: 'KYIV', lat: 50.45, lon: 30.52 }], ...over };
  i.maps.kyiv = KYIV_MAP;
  delete i.decisions.art[slug];
  return i;
};

test('a region baked for an earlier edition resolves out of the committed archive', () => {
  const { maps } = lay((i) => {
    i.articles.bravo.art = { kind: 'map', map: 'hormuz-strait', hero_map: 'hormuz-strait', caption: 'The archive.', spots: [] };
    delete i.decisions.art.bravo;
    i.archive = archiveResolver();
    return i;
  });
  assert.deepEqual(maps.map((m) => m.name), ['hormuz-strait']);
  assert.equal(maps[0].document.name, 'hormuz-strait');
  assert.equal(maps[0].document.bands.length, maps[0].document.rows);
  assert.deepEqual(
    maps[0].document,
    readJson(resolve(repo, 'content/editions/2026-06-26/maps/hormuz-strait.json')),
    'the archive hands back the committed document unchanged',
  );
});

test('the archive index carries every region committed on this branch, newest crop winning', () => {
  const index = archiveIndex();
  assert.equal(index.size, 120, 'the branch carries 120 distinct baked regions');
  assert.match(index.get('hormuz'), /2026-07-16\/maps\/hormuz\.json$/);
  assert.equal(index.has('bhote-koshi'), false, 'regions that exist only on origin/main are not claimable here');
});

test('a story naming a region no edition ever baked is refused, naming the maps gate', () => {
  const error = refuses((i) => {
    i.articles.echo.art = { kind: 'map', map: 'kamchatka', hero_map: 'kamchatka', caption: 'c' };
    i.archive = archiveResolver();
    return i;
  }, /maps must match article art/);
  assert.match(error.message, /neither in this edition's maps\/ nor in the committed archive/);
  assert.match(error.message, /Caslon can add fresh page art separately/);
});

test('a map/hero_map pair resolves and ships both, from the 2026-07-05 fixture', () => {
  const { maps, pages } = lay((i) => {
    i.articles.bravo.art = { kind: 'map', map: 'taiwan-east', hero_map: 'taiwan-hero', caption: 'The pair.', spots: [{ name: 'HUALIEN', lat: 23.98, lon: 121.6 }] };
    delete i.decisions.art.bravo;
    i.archive = archiveResolver();
    return i;
  });
  assert.deepEqual(maps.map((m) => m.name), ['taiwan-east', 'taiwan-hero']);
  assert.deepEqual(maps.map((m) => m.document.name), ['taiwan-east', 'taiwan-hero']);
  const block = pages[0].document.head[1].props.columns[1][0];
  assert.equal(block.block, 'MapGlyph');
  assert.equal(block.props.map, 'taiwan-hero');
});

test('equal names ship one map, and a bare art.map ships one', () => {
  assert.deepEqual(lay((i) => withMap(i, 'bravo')).maps.map((m) => m.name), ['kyiv']);
  const bare = lay((i) => withMap(i, 'bravo', { hero_map: undefined }));
  assert.deepEqual(bare.maps.map((m) => m.name), ['kyiv']);
  assert.equal(bare.pages[0].document.head[1].props.columns[1][0].props.map, 'kyiv');
  refuses((i) => withMap(i, 'bravo', { map: 'kyiv-wide' }), /names map "kyiv-wide", which is neither/);
  refuses((i) => withMap(i, 'bravo', { hero_map: 'kyiv-hero' }), /names map "kyiv-hero", which is neither/);
  refuses((i) => withMap(i, 'bravo', { map: undefined }), /carries art\.kind "map" but no "map"/);
  refuses((i) => withMap(i, 'bravo', { hero_map: 42 }), /carries art\.hero_map 42/);
});

test('two stories may not carry one region with different spots', () => {
  refuses((i) => {
    withMap(i, 'bravo');
    withMap(i, 'charlie', { spots: [{ name: 'LVIV', lat: 49.84, lon: 24.03 }] });
    return i;
  }, /one region cannot carry two sets/);
  const { maps } = lay((i) => { withMap(i, 'bravo'); withMap(i, 'charlie'); return i; });
  assert.deepEqual(maps.map((m) => m.name), ['kyiv']);
});

test('a lead that declares a map takes the hero panel without losing reporter map presentation', () => {
  const plain = lay().pages[0].document.head;
  assert.equal(plain[0].props.withArt, true);
  assert.equal(plain[0].props.art.block, 'GlyphArt');
  assert.deepEqual([plain[1].props.cols, plain[2].props.cols], [[2, 1], [1, 2]]);

  const head = lay((i) => withMap(i, 'alpha', { cols: 52, rows: 30, rotX: 1.1, rotY: 0.2, zoom: 0.7, tone: 'normal', locator_context: 'continental', overlays: [{ ring: [[50, 30], [51, 30], [51, 31]], color: 'red' }], routes: [{ points: [[50, 30], [51, 31]], color: 'accent' }] })).pages[0].document.head;
  assert.equal(head[0].props.withArt, true, 'the lead\'s own map renders in the hero panel');
  assert.deepEqual([head[1].props.cols, head[2].props.cols], [[2, 1], [1, 2]]);
  assert.equal(head[1].props.columns[1][0].block, 'GlyphArt');
  assert.equal(head[2].props.columns[0][0].block, 'GlyphArt');
  const visuals = JSON.stringify(lay((i) => withMap(i, 'alpha')).pages[0].document).match(/"block":"(?:MapGlyph|GlyphArt|Illustration|Image)"/gu) ?? [];
  assert.equal(visuals.length, 3, 'the hero map joins the two feature visuals');
});

test('a page whose illustrated run does not alternate is refused before compose_edition sees it', () => {
  const head = [
    { block: 'Hero', props: { variant: 'lead-only', withArt: true, lead: 'alpha', art: { block: 'GlyphArt', props: { shape: 'satellite', caption: 'Lead.' } } } },
    { block: 'Grid', props: { cols: [1, 2], columns: [[{ block: 'GlyphArt', props: {} }], [{ block: 'Teaser', props: { article: 'bravo' } }]] } },
  ];
  assert.deepEqual(alternationRuns(head), [['left', 'left']]);
  assert.deepEqual(alternationRuns(lay((i) => withMap(i, 'alpha')).pages[0].document.head), [['left', 'right', 'left']]);
  assert.deepEqual(alternationRuns(lay().pages[0].document.head), [['left', 'right', 'left']]);
});

test('a reporter-shipped presentation.flashpoint is used when the record declares none', () => {
  const { pages } = lay((i) => {
    delete i.decisions.flashpoints;
    i.articles.delta.presentation = { flashpoint: { place: 'LUSAKA', lat: -15.42, lon: 28.28, note: 'The clock still runs.' } };
    return i;
  });
  const row = pages[0].document.head.find((b) => b.block === 'Grid' && b.props.columns[0][0]?.block === 'WorldGlyph');
  assert.deepEqual(row.props.columns[1][0].props.items.map((i) => i.place), ['LUSAKA']);
  assert.equal(row.props.columns[1][0].props.items[0].agent, 'Graves');
});

test('the tape derives its open calls from the settlement document, and omits the block when there are none', () => {
  assert.equal(lay().pages[1].document.head.some((b) => b.block === 'ForecastLedger'), false);
  const { pages } = lay((i) => {
    i.desk['ledger.settlements'].resolved_last_edition = [{ call: 'A thing happens by Friday', outcome: 'open', prior_p: 0.62 }, { call: 'Settled', outcome: 'miss', prior_p: 0.1 }];
    return i;
  });
  const ledger = pages[1].document.head.find((b) => b.block === 'ForecastLedger');
  assert.equal(ledger.props.meta, '1 open call');
  assert.deepEqual(ledger.props.open_calls, [{ question: 'A thing happens by Friday', call: 'YES', direction: 'bull', p: 0.62 }]);
});

test('a day with no market numbers prints a shorter tape rather than a padded rail', () => {
  const { pages } = lay((i) => { i.decisions.tape.markets = { rows: [] }; return i; });
  assert.equal(pages[1].document.head.some((b) => b.block === 'MarketsRail'), false);
  assert.equal(pages[1].document.head.some((b) => b.block === 'WhatToWatch'), true);
});

test('the deadline title is derived from the first and last watch item', () => {
  const { pages } = lay((i) => { i.decisions.tape.watch.push({ when: '30 Sep', what: 'It either lands or it does not.', who: 'Foreman' }); return i; });
  const watch = pages[1].document.head.find((b) => b.block === 'Grid').props.columns[1][0];
  assert.equal(watch.props.title, 'The Deadlines · 10 Sep – 30 Sep');
});

test('page chrome is ceremony and is never taken from the record', () => {
  const [front, tape] = lay((i) => { i.decisions.title = 'Front'; i.decisions.active = 'front'; return i; }).pages.map((p) => p.document);
  assert.equal(front.title, 'Clank & Slop - The Front Page');
  assert.equal(front.active, '/');
  assert.equal(tape.title, 'Clank & Slop - The Tape');
  assert.equal(tape.active, '/tape');
  assert.equal(front.tagline, null);
  assert.deepEqual(tape.flow, []);
});

test('the assembler is deterministic — same inputs, byte-identical output', () => {
  const once = JSON.stringify(lay());
  for (let i = 0; i < 3; i += 1) assert.equal(JSON.stringify(lay()), once);
});

test('legacy shipped editions stay renderable as frozen page JSON, but bare-lead relayout is refused', () => {
  for (const date of EDITIONS) {
    const front = readJson(resolve(repo, 'content/editions', date, 'pages/front.json'));
    const tape = readJson(resolve(repo, 'content/editions', date, 'pages/tape.json'));
    const passed = Object.keys(readEditionInputs(resolve(repo, 'content'), date).articles).sort();
    assert.deepEqual(collectPublicArticleReferences(front), passed, `${date} frozen page completeness`);
    assert.deepEqual(collectPublicArticleReferences(tape), [], `${date} frozen tape features nothing`);
    assert.equal(new Set([front.paper ?? 'front', tape.paper ?? 'tape']).size, 2, `${date} frozen paper diversity`);
    assert.throws(() => layShipped(date), /art\[".*?"\]/u, `${date} legacy relayout needs explicit lead art`);
  }
});

test('ops/validate-content.mjs accepts frozen shipped editions', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'lay-page-'));
  try {
    cpSync(resolve(repo, 'ops'), resolve(dir, 'ops'), { recursive: true });
    cpSync(resolve(repo, 'content'), resolve(dir, 'content'), { recursive: true });
    for (const date of EDITIONS) {
    }
    const out = execFileSync(process.execPath, ['ops/validate-content.mjs'], { cwd: dir, encoding: 'utf8' });
    assert.match(out, /content OK/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ops/validate-content.mjs validates explicit Hero art without requiring legacy pages to carry it', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'lay-page-'));
  try {
    cpSync(resolve(repo, 'ops'), resolve(dir, 'ops'), { recursive: true });
    cpSync(resolve(repo, 'content'), resolve(dir, 'content'), { recursive: true });
    const frontPath = resolve(dir, 'content/editions/2026-06-13/pages/front.json');
    const front = readJson(frontPath);
    front.head[0].props.withArt = true;
    front.head[0].props.art = { block: 'GlyphArt', props: { shape: 'satellite', caption: 'Explicit lead art.' } };
    writeFileSync(frontPath, `${JSON.stringify(front, null, 1)}\n`);
    assert.match(execFileSync(process.execPath, ['ops/validate-content.mjs'], { cwd: dir, encoding: 'utf8' }), /content OK/);
    front.head[0].props.art = { block: 'UnknownArt', props: {} };
    writeFileSync(frontPath, `${JSON.stringify(front, null, 1)}\n`);
    assert.throws(() => execFileSync(process.execPath, ['ops/validate-content.mjs'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }), /props\.art must be a MapGlyph or GlyphArt block/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the record may run an article glyph as an animated roll, and only one may turn', () => {
  const withRoll = (i) => {
    i.articles.bravo.art = { kind: 'ascii', shape: 'chip', caption: 'From the article.' };
    i.decisions.art.bravo = { roll: 'chip' };
    return i;
  };
  const block = lay(withRoll).pages[0].document.head[1].props.columns[1][0];
  assert.deepEqual(block.props, { shape: 'chip', roll: 'chip', scale: 0.6, caption: 'From the article.' });
  refuses((i) => { withRoll(i); i.decisions.art.charlie = { shape: 'eclipse', roll: 'eclipse', caption: 'The other.' }; return i; }, /animated roll/);
});
