import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { LayoutError, layEdition, personaNames, readEditionInputs } from './lay-page.mjs';
import { collectPublicArticleReferences } from '../agentic-org/scripts/production-newsroom.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const agents = personaNames();
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const sha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

// The editions with a real front and tape on the branch. 2026-09-05 is the
// hand-rescued edition the composition study measured; the four August ones are
// the orchestrator's own and are the quality target.
const EDITIONS = ['2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22', '2026-09-05'];

// Glyphs for the two illustrated slots on the days whose articles carry no
// `art` at all. Those pages shipped a MapGlyph naming a map no article declares
// as `art.hero_map`, which the maps gate refuses — so the assembler cannot
// reproduce them and the record supplies a fitting glyph instead.
const SUBSTITUTE_GLYPHS = {
  '2026-08-22': {
    'panama-canal-cuts-daily-slots-to-thirty-four': { shape: 'pumpjack', caption: 'Gatún Lake feeds the locks. A-29-2026 cuts bookable slots from 4 September.' },
    'lima-transportistas-hold-the-twenty-fifth': { shape: 'colosseum', caption: 'Lima and Callao. The convocantes were not in the Saturday Mininter room.' },
  },
  '2026-09-05': {
    'kametstal-furnace-outage': { shape: 'pumpjack', caption: 'Kamianske. Two blast furnaces are down and no restart date is published.' },
    'foxconn-ai-capex-build-chain': { shape: 'chip', caption: 'NT$921.8bn in August. The build chain sits on this coast.' },
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
    const articleMaps = new Set(Object.values(readEditionInputs(resolve(repo, 'content'), date).articles).map((a) => a.art?.hero_map).filter(Boolean));
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
  const before = { root: process.env.CLANK_EDITION_STATE_ROOT, agent: process.env.CLANK_NEWSROOM_AGENT, waiver: process.env.CLANK_EDITION_DIVERSITY_WAIVER };
  try {
    const seed = (name) => {
      const root = resolve(dir, name);
      const edition = resolve(root, 'editions', date);
      mkdirSync(edition, { recursive: true });
      for (const kind of ['articles', 'desk', 'maps'])
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
    // 2026-09-05 carries no "forecast" article, which is Brass's lineup rather
    // than a layout problem; the publisher's dated waiver is what shipped it.
    process.env.CLANK_EDITION_DIVERSITY_WAIVER = date;

    process.env.CLANK_EDITION_STATE_ROOT = seed('assembled');
    const { pages, maps } = layShipped(date);
    const result = await composeEdition({ edition: date, event_key: 'lay-page-test', pages, maps });
    assert.match(result.compose_gates, /passed=6\/5 desks=4\/4/);
    assert.deepEqual(result.tree.pages, ['front', 'tape']);

    process.env.CLANK_EDITION_STATE_ROOT = seed('shipped');
    const shipped = ['front', 'tape'].map((name) => ({ name, document: readJson(resolve(repo, 'content/editions', date, 'pages', `${name}.json`)) }));
    await assert.rejects(() => composeEdition({ edition: date, event_key: 'lay-page-test-shipped', pages: shipped, maps: [] }), /paper diversity invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [['CLANK_EDITION_STATE_ROOT', before.root], ['CLANK_NEWSROOM_AGENT', before.agent], ['CLANK_EDITION_DIVERSITY_WAIVER', before.waiver]])
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
