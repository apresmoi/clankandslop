import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { LayoutError, alternationRuns, archiveIndex, archiveResolver, layEdition, personaNames, readEditionInputs } from './lay-page.mjs';
import { collectPublicArticleReferences } from '../agentic-org/scripts/production-newsroom.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const agents = personaNames();
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const sha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

// The editions with a real front and tape on the branch. 2026-09-05 is the
// hand-rescued edition the composition study measured; the four August ones are
// the orchestrator's own and are the quality target.
const EDITIONS = ['2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22', '2026-09-05'];

// Glyphs for the two illustrated slots on a day whose articles carry no `art`
// at all. That page shipped a MapGlyph naming a map no article declares as
// `art.hero_map`, which the maps gate refuses — so the assembler cannot
// reproduce it and the record supplies a fitting glyph instead. 2026-09-05 was
// the same shape until its two illustrated stories were given the archived
// regions their own geography sits inside, which is why it is no longer here.
const SUBSTITUTE_GLYPHS = {
  '2026-08-22': {
    'panama-canal-cuts-daily-slots-to-thirty-four': { shape: 'pumpjack', caption: 'Gatún Lake feeds the locks. A-29-2026 cuts bookable slots from 4 September.' },
    'lima-transportistas-hold-the-twenty-fifth': { shape: 'colosseum', caption: 'Lima and Callao. The convocantes were not in the Saturday Mininter room.' },
  },
};

/**
 * The decision record a shipped edition implies, read back off its own pages:
 * the placement order, the flashpoint list, the two Brieflys and the tape's
 * numbers. Everything the assembler derives is deliberately not read.
 */
function decisionsFromShipped(date) {
  const dir = resolve(repo, 'content/editions', date);
  const front = readJson(resolve(dir, 'pages/front.json'));
  const tape = readJson(resolve(dir, 'pages/tape.json'));
  const articles = readEditionInputs(resolve(repo, 'content'), date).articles;
  const order = [];
  const artFor = {};
  const walk = (blocks) => {
    for (const block of blocks) {
      if (block.block === 'Hero') order.push(block.props.lead);
      else if (block.block === 'Teaser') order.push(block.props.article);
      else if (block.block === 'Grid') {
        const flat = block.props.columns.flat();
        const art = flat.find((b) => b.block === 'MapGlyph' || b.block === 'GlyphArt');
        const story = flat.find((b) => b.block === 'Teaser');
        if (art && story) artFor[story.props.article] = art;
        for (const column of block.props.columns) walk(column);
      }
    }
  };
  walk(front.head);
  const art = {};
  for (const [slug, block] of Object.entries(artFor)) {
    if (SUBSTITUTE_GLYPHS[date]?.[slug]) art[slug] = SUBSTITUTE_GLYPHS[date][slug];
    else if (block.block === 'GlyphArt') art[slug] = { ...block.props };
    else if (articles[slug]?.art) art[slug] = { caption: block.props.caption };
  }
  const worldRow = front.head.find((b) => b.block === 'Grid' && b.props.columns?.[0]?.[0]?.block === 'WorldGlyph');
  const items = worldRow?.props.columns[1][0].props.items ?? [];
  const spots = Object.fromEntries((worldRow?.props.columns[0][0].props.hotspots ?? []).map((h) => [h.name, h]));
  const findBlock = (name) => {
    let hit = null;
    const walkTape = (blocks) => { for (const b of blocks) { if (b.block === name) hit = b; if (b.block === 'Grid') for (const c of b.props.columns) walkTape(c); } };
    walkTape(tape.head);
    return hit;
  };
  const rail = findBlock('MarketsRail');
  const watch = findBlock('WhatToWatch');
  return {
    edition: date,
    order,
    ...(Object.keys(art).length > 0 ? { art } : {}),
    flashpoints: items.map((it) => ({ place: it.place, lat: spots[it.place]?.lat ?? 0, lon: spots[it.place]?.lon ?? 0, note: it.note, ...(it.article ? { article: it.article } : { agent: it.agent }) })),
    briefly: front.flow.find((b) => b.block === 'Briefly').props.desks,
    tape: {
      briefly: tape.head.find((b) => b.block === 'Briefly').props.desks,
      ...(rail ? { markets: { kicker: rail.props.kicker, rows: rail.props.rows } } : {}),
      ...(watch ? { watch: watch.props.items } : {}),
    },
  };
}

const layShipped = (date) => layEdition({ edition: date, ...readEditionInputs(resolve(repo, 'content'), date), decisions: decisionsFromShipped(date), agents });

// ---- a hermetic edition, for the gates that need one input wrong -------------

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
    art: { bravo: { shape: 'chip', caption: 'One.' }, charlie: { shape: 'drone', caption: 'Two.' } },
    flashpoints: [{ place: 'KYIV', lat: 50.45, lon: 30.52, note: 'A note.', article: 'alpha' }],
    briefly: [1, 2, 3].map((n) => ({ label: `Desk ${n}`, lead: { kicker: `K${n}`, agent: 'Graves', what: `W${n}` }, rest: [] })),
    tape: {
      briefly: [1, 2, 3].map((n) => ({ label: `Tape ${n}`, lead: { kicker: `TK${n}`, agent: 'Foreman', what: `TW${n}` }, rest: [] })),
      markets: { kicker: '9 Sep · one thing', rows: [{ sym: 'ACP', value: '34', spark: 'slots', pct: 'from 4 Sep', dir: 'down' }] },
      watch: [{ when: '10 Sep', what: 'The rule either enters force or it slips.', who: 'Tinkerton' }],
    },
  },
  agents,
  // Hermetic: the synthetic edition never reaches the repository's own atlas,
  // so a test that wants an archived region has to say which one it means.
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

// ---- the gates the assembler owns -------------------------------------------

test('the two pages carry different top-level paper values', () => {
  const { pages } = lay();
  assert.equal(pages[0].document.paper, 'front');
  assert.equal(pages[1].document.paper, 'tape');
  assert.equal(new Set(pages.map((p) => p.document.paper)).size, 2);
});

test('the front carries exactly two visual blocks', () => {
  const { pages } = lay();
  const visuals = JSON.stringify(pages[0].document).match(/"block":"(?:MapGlyph|GlyphArt|Illustration|Image)"/gu) ?? [];
  assert.equal(visuals.length, 2);
});

test('every PASSed article is placed exactly once, and the tape features none', () => {
  const { pages } = lay();
  const front = collectPublicArticleReferences(pages[0].document);
  const tape = collectPublicArticleReferences(pages[1].document);
  assert.deepEqual(front, ['alpha', 'bravo', 'charlie', 'delta', 'echo']);
  assert.deepEqual(tape, []);
  assert.deepEqual(front.filter((slug) => tape.includes(slug)), []);
});

test('illustrated rows alternate art left then art right', () => {
  const [rowA, rowB] = lay().pages[0].document.head.slice(1, 3);
  assert.deepEqual(rowA.props.cols, [1, 2]);
  assert.equal(rowA.props.columns[0][0].block, 'GlyphArt');
  assert.deepEqual(rowB.props.cols, [2, 1]);
  assert.equal(rowB.props.columns[1][0].block, 'GlyphArt');
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

test('a glyph outside the committed library is refused', () => {
  refuses((i) => { i.decisions.art.bravo.shape = 'biplane'; return i; }, /glyph catalogue/);
  refuses((i) => { i.decisions.art.bravo.roll = 'globe'; return i; }, /glyph catalogue/);
  refuses((i) => { i.decisions.art.bravo.roll = 'eclipse'; return i; }, /glyph catalogue/);
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
  const block = pages[0].document.head[1].props.columns[0][0];
  assert.equal(block.block, 'MapGlyph');
  assert.deepEqual(block.props.spots, spots);
  assert.equal(block.props.caption, 'From the article.');
  assert.equal(block.props.interactive, false);
});

// ---- the archived atlas ------------------------------------------------------

const KYIV_MAP = { name: 'kyiv', west: 20, east: 40, south: 40, north: 60, cols: 2, rows: 1, bands: ['01'] };
const withMap = (i, slug, over = {}) => {
  i.articles[slug].art = { kind: 'map', map: 'kyiv', hero_map: 'kyiv', caption: 'From the article.', spots: [{ name: 'KYIV', lat: 50.45, lon: 30.52 }], ...over };
  i.maps.kyiv = KYIV_MAP;
  delete i.decisions.art[slug];
  return i;
};

test('a region baked for an earlier edition resolves out of the committed archive', () => {
  // The edition state of a fresh day holds no maps at all — compose_edition is
  // what writes that directory — so an archived region is only reachable if the
  // assembler looks past it into content/editions/*/maps/. This is the whole
  // route by which a map reaches the paper.
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
  // Five names were re-cropped under the same name across editions. The index
  // is built in edition order, so the newest crop is the one a story gets.
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
  assert.match(error.message, /Nothing in this newsroom can bake a new one/);
});

test('a map/hero_map pair resolves and ships both, from the 2026-07-05 fixture', () => {
  // The intended authoring pattern, and the one that was inexpressible:
  // `taiwan-east` is the 104x42 story-page region, `taiwan-hero` the 52x30
  // re-crop the front panel takes. Both are in the committed archive; both
  // must reach the edition's maps/, because the story page loads art.map and
  // the hero panel loads art.hero_map.
  const { maps, pages } = lay((i) => {
    i.articles.bravo.art = { kind: 'map', map: 'taiwan-east', hero_map: 'taiwan-hero', caption: 'The pair.', spots: [{ name: 'HUALIEN', lat: 23.98, lon: 121.6 }] };
    delete i.decisions.art.bravo;
    i.archive = archiveResolver();
    return i;
  });
  assert.deepEqual(maps.map((m) => m.name), ['taiwan-east', 'taiwan-hero']);
  assert.deepEqual(maps.map((m) => m.document.name), ['taiwan-east', 'taiwan-hero']);
  // The panel draws the narrow crop; the wide one ships for the story page.
  const block = pages[0].document.head[1].props.columns[0][0];
  assert.equal(block.block, 'MapGlyph');
  assert.equal(block.props.map, 'taiwan-hero');
});

test('equal names ship one map, and a bare art.map ships one', () => {
  // August practice: one name in both keys. It is still legal and still one
  // document — the union of {x} and {x}.
  assert.deepEqual(lay((i) => withMap(i, 'bravo')).maps.map((m) => m.name), ['kyiv']);
  // June practice, and half the archive: hero_map simply absent. The hero
  // panel falls back to art.map rather than the filing being refused.
  const bare = lay((i) => withMap(i, 'bravo', { hero_map: undefined }));
  assert.deepEqual(bare.maps.map((m) => m.name), ['kyiv']);
  assert.equal(bare.pages[0].document.head[1].props.columns[0][0].props.map, 'kyiv');
  // What is still refused is a name nothing ever baked, on either key.
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
  // The same spots on both is the legible case and stays allowed.
  const { maps } = lay((i) => { withMap(i, 'bravo'); withMap(i, 'charlie'); return i; });
  assert.deepEqual(maps.map((m) => m.name), ['kyiv']);
});

test('a lead that declares a map takes the hero panel, and the feature rows flip under it', () => {
  const plain = lay().pages[0].document.head;
  assert.equal(plain[0].props.withArt, false);
  assert.deepEqual([plain[1].props.cols, plain[2].props.cols], [[1, 2], [2, 1]]);

  const head = lay((i) => withMap(i, 'alpha')).pages[0].document.head;
  assert.equal(head[0].props.withArt, true, 'the lead\'s own map renders in the hero panel');
  // Hero art is not a counted block, so the rhythm is still the two feature
  // glyphs — but validate-content reads it as the first art-LEFT row.
  assert.deepEqual([head[1].props.cols, head[2].props.cols], [[2, 1], [1, 2]]);
  assert.equal(head[1].props.columns[1][0].block, 'GlyphArt');
  assert.equal(head[2].props.columns[0][0].block, 'GlyphArt');
  const visuals = JSON.stringify(lay((i) => withMap(i, 'alpha')).pages[0].document).match(/"block":"(?:MapGlyph|GlyphArt|Illustration|Image)"/gu) ?? [];
  assert.equal(visuals.length, 2, 'a hero map does not consume one of the two-to-three visual blocks');
});

test('a page whose illustrated run does not alternate is refused before compose_edition sees it', () => {
  // Mutation check on the flip above: with the hero carrying art, a front that
  // still opens art-left is exactly what ops/validate-content.mjs refuses at
  // the release boundary, so the assembler has to refuse it here.
  const head = [
    { block: 'Hero', props: { variant: 'lead-only', withArt: true, lead: 'alpha' } },
    { block: 'Grid', props: { cols: [1, 2], columns: [[{ block: 'GlyphArt', props: {} }], [{ block: 'Teaser', props: { article: 'bravo' } }]] } },
  ];
  assert.deepEqual(alternationRuns(head), [['left', 'left']]);
  assert.deepEqual(alternationRuns(lay((i) => withMap(i, 'alpha')).pages[0].document.head), [['left', 'right', 'left']]);
  assert.deepEqual(alternationRuns(lay().pages[0].document.head), [['left', 'right']]);
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
  for (const date of EDITIONS) assert.equal(JSON.stringify(layShipped(date)), JSON.stringify(layShipped(date)));
});

// ---- the real editions ------------------------------------------------------

test('every shipped edition re-lays and satisfies each page gate', () => {
  for (const date of EDITIONS) {
    const { pages, maps } = layShipped(date);
    const [front, tape] = pages.map((p) => p.document);
    const passed = Object.keys(readEditionInputs(resolve(repo, 'content'), date).articles).sort();
    assert.deepEqual(collectPublicArticleReferences(front), passed, `${date} page completeness`);
    assert.deepEqual(collectPublicArticleReferences(tape), [], `${date} tape features nothing`);
    assert.equal(new Set([front.paper, tape.paper]).size, 2, `${date} paper diversity`);
    const visuals = (JSON.stringify(front).match(/"block":"(?:MapGlyph|GlyphArt|Illustration|Image)"/gu) ?? []).length;
    assert.ok(visuals >= 2 && visuals <= 3, `${date} illustration rhythm: ${visuals}`);
    const articleMaps = new Set(Object.values(readEditionInputs(resolve(repo, 'content'), date).articles).flatMap((a) => [a.art?.map, a.art?.hero_map]).filter(Boolean));
    assert.deepEqual(maps.map((m) => m.name).sort(), [...articleMaps].sort(), `${date} maps match article art`);
  }
});

test('ops/validate-content.mjs accepts every assembled edition', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'lay-page-'));
  try {
    cpSync(resolve(repo, 'ops'), resolve(dir, 'ops'), { recursive: true });
    cpSync(resolve(repo, 'content'), resolve(dir, 'content'), { recursive: true });
    for (const date of EDITIONS) {
      const pages = resolve(dir, 'content/editions', date, 'pages');
      rmSync(pages, { recursive: true, force: true });
      mkdirSync(pages, { recursive: true });
      for (const page of layShipped(date).pages) writeFileSync(resolve(pages, `${page.name}.json`), `${JSON.stringify(page.document, null, 1)}\n`);
    }
    const out = execFileSync(process.execPath, ['ops/validate-content.mjs'], { cwd: dir, encoding: 'utf8' });
    assert.match(out, /content OK/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the real compose_edition accepts the assembled 2026-09-05, and refuses the pages that shipped', async () => {
  const date = '2026-09-05';
  const dir = mkdtempSync(resolve(tmpdir(), 'lay-page-state-'));
  const before = { root: process.env.CLANK_EDITION_STATE_ROOT, agent: process.env.CLANK_NEWSROOM_AGENT };
  try {
    const seed = (name) => {
      const root = resolve(dir, name);
      const edition = resolve(root, 'editions', date);
      mkdirSync(edition, { recursive: true });
      // No `maps` directory: on a real day compose_edition is what writes one,
      // and seeding the published copies would only test whether they happen to
      // be byte-identical to what `converge` writes (they are not — the
      // committed archive carries no trailing newline).
      for (const kind of ['articles', 'desk'])
        if (existsSync(resolve(repo, 'content/editions', date, kind))) cpSync(resolve(repo, 'content/editions', date, kind), resolve(edition, kind), { recursive: true });
      // The filing and verdict pair composition re-checks: a filing is the PASSed
      // article plus the assignment_ref review_article strips on PASS.
      for (const file of readdirSync(resolve(edition, 'articles'))) {
        const id = file.slice(0, -5);
        const value = readJson(resolve(edition, 'articles', file));
        const filing = { ...value, assignment_ref: { event_key: `t-${id}`, id } };
        mkdirSync(resolve(edition, 'filings', id), { recursive: true });
        writeFileSync(resolve(edition, 'filings', id, `${value.revision}.json`), `${JSON.stringify(filing)}\n`);
        mkdirSync(resolve(edition, 'reviews'), { recursive: true });
        writeFileSync(resolve(edition, 'reviews', file), `${JSON.stringify({ version: 'clank.editorial-verdict.v1', article_id: id, revision: value.revision, article_digest: sha(JSON.stringify(filing)), verdict: 'PASS', notes: '', event_key: `t-${id}` })}\n`);
      }
      return root;
    };
    const { composeEdition } = await import('../agentic-org/scripts/production-newsroom.mjs');
    process.env.CLANK_NEWSROOM_AGENT = 'caslon';

    process.env.CLANK_EDITION_STATE_ROOT = seed('assembled');
    const { pages, maps } = layShipped(date);
    // Two archived regions reach the paper: the front carries a MapGlyph for
    // each, and compose_edition writes both documents into the edition.
    assert.deepEqual(maps.map((m) => m.name), ['moscow-kyiv', 'taiwan-north']);
    const result = await composeEdition({ edition: date, event_key: 'lay-page-test', pages, maps });
    // The paper that could not be composed without a dated waiver: six PASSed
    // pieces, four desk documents, no forecast and no dissent. It composes, and
    // the gate line and the receipt both say which of the two it was.
    assert.equal(result.compose_gates, '# compose: passed=6/5 desks=4/4 forecast=0 dissent=0  → ready');
    assert.equal(result.forecasts, 0);
    assert.equal(result.dissents, 0);
    assert.equal(result.waiver, undefined);
    assert.deepEqual(result.tree.pages, ['front', 'tape']);
    assert.deepEqual(result.tree.maps, ['moscow-kyiv', 'taiwan-north']);

    // Mutation checks. Each deletes one half of the maps contract from output
    // the gate has just accepted, so a green run above cannot be the gate
    // failing to look.
    const clone = (value) => JSON.parse(JSON.stringify(value));

    // 1. A map no article names. The set-equality assertion is what stands
    //    between the archive and a compositor helping himself to it.
    process.env.CLANK_EDITION_STATE_ROOT = seed('extra-map');
    await assert.rejects(
      () => composeEdition({ edition: date, event_key: 'lay-page-test-extra', pages, maps: [...maps, { name: 'hormuz-strait', document: { name: 'hormuz-strait' } }] }),
      /maps must exactly match article art — article art\.map\/art\.hero_map values \[moscow-kyiv, taiwan-north\], supplied maps \[hormuz-strait, moscow-kyiv, taiwan-north\]/,
    );

    // 2. The page drops a MapGlyph while the article keeps its art. Caught two
    //    ways, and both are the mismatch: drop the supplied map with it and the
    //    same set equality reddens from the other side; keep a MapGlyph but
    //    point it somewhere else and the page-reference assertion fires.
    process.env.CLANK_EDITION_STATE_ROOT = seed('dropped-glyph');
    const stripped = clone(pages);
    // Swapped for a glyph rather than deleted, so the front still carries two
    // visual blocks and the illustration gate cannot answer first.
    for (const block of stripped[0].document.head)
      for (const column of block.props?.columns ?? [])
        for (const [index, nested] of column.entries())
          if (nested.block === 'MapGlyph' && nested.props.map === 'moscow-kyiv') column[index] = { block: 'GlyphArt', props: { shape: 'pumpjack', scale: 0.6, caption: 'A glyph in its place.' } };
    await assert.rejects(
      () => composeEdition({ edition: date, event_key: 'lay-page-test-dropped', pages: stripped, maps: maps.filter((m) => m.name !== 'moscow-kyiv') }),
      /maps must exactly match article art — article art\.map\/art\.hero_map values \[moscow-kyiv, taiwan-north\], supplied maps \[taiwan-north\]/,
    );

    process.env.CLANK_EDITION_STATE_ROOT = seed('repointed-glyph');
    const repointed = clone(pages);
    for (const block of repointed[0].document.head)
      for (const column of block.props?.columns ?? [])
        for (const nested of column) if (nested.block === 'MapGlyph' && nested.props.map === 'moscow-kyiv') nested.props.map = 'hormuz-strait';
    await assert.rejects(
      () => composeEdition({ edition: date, event_key: 'lay-page-test-repointed', pages: repointed, maps }),
      /maps must exactly match page references — page\(s\) reference map\(s\) not in article art\.map\/art\.hero_map: hormuz-strait/,
    );

    process.env.CLANK_EDITION_STATE_ROOT = seed('shipped');
    const shipped = ['front', 'tape'].map((name) => ({ name, document: readJson(resolve(repo, 'content/editions', date, 'pages', `${name}.json`)) }));
    await assert.rejects(() => composeEdition({ edition: date, event_key: 'lay-page-test-shipped', pages: shipped, maps: [] }), /paper diversity invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [['CLANK_EDITION_STATE_ROOT', before.root], ['CLANK_NEWSROOM_AGENT', before.agent]])
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('the record may run an article glyph as an animated roll, and only one may turn', () => {
  const withRoll = (i) => {
    i.articles.bravo.art = { kind: 'ascii', shape: 'chip', caption: 'From the article.' };
    i.decisions.art.bravo = { roll: 'chip' };
    return i;
  };
  const block = lay(withRoll).pages[0].document.head[1].props.columns[0][0];
  assert.deepEqual(block.props, { shape: 'chip', roll: 'chip', scale: 0.6, caption: 'From the article.' });
  refuses((i) => { withRoll(i); i.decisions.art.charlie = { shape: 'eclipse', roll: 'eclipse', caption: 'The other.' }; return i; }, /animated roll/);
});

test('the assembled front reproduces the shipped August front, plus the paper key the gate wanted', () => {
  for (const date of ['2026-08-19', '2026-08-20', '2026-08-21']) {
    const assembled = layShipped(date).pages[0].document;
    const shipped = readJson(resolve(repo, 'content/editions', date, 'pages/front.json'));
    assert.equal(assembled.paper, 'front');
    const { paper: _, ...withoutPaper } = assembled;
    assert.deepEqual(withoutPaper, shipped, `${date} front must re-lay byte-for-byte apart from "paper"`);
  }
});

test('a map/hero_map pair on the real 2026-09-05 composes, ships both, and validates', async () => {
  // §2 end to end on real data. The edition's `foxconn-ai-capex-build-chain`
  // shipped `taiwan-north` in both keys. Given the pair it was always allowed
  // to name — `taiwan-east` for the 104x42 story page, `taiwan-hero` for the
  // 52x30 front panel — the old gate shipped only `taiwan-hero` and the story
  // page asked for a `taiwan-east.json` nobody wrote, which is where
  // `astro build` died. Both must now reach content/editions/<date>/maps/.
  const date = '2026-09-05';
  const dir = mkdtempSync(resolve(tmpdir(), 'lay-page-pair-'));
  const before = { root: process.env.CLANK_EDITION_STATE_ROOT, agent: process.env.CLANK_NEWSROOM_AGENT };
  try {
    const inputs = readEditionInputs(resolve(repo, 'content'), date);
    const paired = { ...inputs.articles['foxconn-ai-capex-build-chain'] };
    paired.art = { ...paired.art, map: 'taiwan-east', hero_map: 'taiwan-hero' };
    const articles = { ...inputs.articles, 'foxconn-ai-capex-build-chain': paired };

    const root = resolve(dir, 'state');
    const edition = resolve(root, 'editions', date);
    mkdirSync(resolve(edition, 'articles'), { recursive: true });
    cpSync(resolve(repo, 'content/editions', date, 'desk'), resolve(edition, 'desk'), { recursive: true });
    for (const [id, value] of Object.entries(articles)) {
      writeFileSync(resolve(edition, 'articles', `${id}.json`), `${JSON.stringify(value)}\n`);
      const filing = { ...value, assignment_ref: { event_key: `t-${id}`, id } };
      mkdirSync(resolve(edition, 'filings', id), { recursive: true });
      writeFileSync(resolve(edition, 'filings', id, `${value.revision}.json`), `${JSON.stringify(filing)}\n`);
      mkdirSync(resolve(edition, 'reviews'), { recursive: true });
      writeFileSync(resolve(edition, 'reviews', `${id}.json`), `${JSON.stringify({ version: 'clank.editorial-verdict.v1', article_id: id, revision: value.revision, article_digest: sha(JSON.stringify(filing)), verdict: 'PASS', notes: '', event_key: `t-${id}` })}\n`);
    }

    const { pages, maps } = layEdition({ edition: date, articles, desk: inputs.desk, maps: {}, decisions: decisionsFromShipped(date), agents });
    // The union, in one place: the wide region, its hero re-crop, and the
    // second story's single name.
    assert.deepEqual(maps.map((m) => m.name), ['moscow-kyiv', 'taiwan-east', 'taiwan-hero']);

    const { composeEdition } = await import('../agentic-org/scripts/production-newsroom.mjs');
    process.env.CLANK_NEWSROOM_AGENT = 'caslon';
    process.env.CLANK_EDITION_STATE_ROOT = root;
    const result = await composeEdition({ edition: date, event_key: 'lay-page-pair-test', pages, maps });
    assert.deepEqual(result.tree.maps, ['moscow-kyiv', 'taiwan-east', 'taiwan-hero']);
    // Mutation check for the union: hand compose only the hero half, exactly
    // what it used to ship by itself, and it must refuse rather than write a
    // tree the story page cannot read.
    rmSync(resolve(edition, 'receipts'), { recursive: true, force: true });
    rmSync(resolve(edition, 'maps'), { recursive: true, force: true });
    rmSync(resolve(edition, 'pages'), { recursive: true, force: true });
    await assert.rejects(
      () => composeEdition({ edition: date, event_key: 'lay-page-pair-hero-only', pages, maps: maps.filter((m) => m.name !== 'taiwan-east') }),
      /maps must exactly match article art — article art\.map\/art\.hero_map values \[moscow-kyiv, taiwan-east, taiwan-hero\], supplied maps \[moscow-kyiv, taiwan-hero\]/,
    );

    // And the composed tree is a publishable edition: ops/validate-content.mjs
    // reads art.map and art.hero_map against the edition's own maps/ directory.
    const site = resolve(dir, 'site');
    cpSync(resolve(repo, 'ops'), resolve(site, 'ops'), { recursive: true });
    cpSync(resolve(repo, 'content'), resolve(site, 'content'), { recursive: true });
    process.env.CLANK_EDITION_STATE_ROOT = root;
    await composeEdition({ edition: date, event_key: 'lay-page-pair-recompose', pages, maps });
    for (const kind of ['articles', 'pages', 'maps']) {
      rmSync(resolve(site, 'content/editions', date, kind), { recursive: true, force: true });
      cpSync(resolve(edition, kind), resolve(site, 'content/editions', date, kind), { recursive: true });
    }
    assert.match(execFileSync(process.execPath, ['ops/validate-content.mjs'], { cwd: site, encoding: 'utf8' }), /content OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [['CLANK_EDITION_STATE_ROOT', before.root], ['CLANK_NEWSROOM_AGENT', before.agent]])
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
