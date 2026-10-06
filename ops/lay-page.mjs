import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import { layoutArtifacts } from './layout-artifacts.mjs';
import { mapPresentationProps } from './map-presentation.mjs';
import { GLYPH_ROLLS, GLYPH_SHAPES, glyphSelectionFindings } from './glyph-format.mjs';
import { PASSED_ARTICLES_MINIMUM } from './edition-floor.mjs';
import { publicContentRoot } from '../agentic-org/scripts/public-content.mjs';
import { decisionSummaryFindings } from './summary-fidelity.mjs';
import { LEDGER_EPOCH, carriedCalls, carryTape, followUps, forecastRows, ledgerHistory } from './open-clocks.mjs';
import { archiveLedger } from './ledger-archive.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export class LayoutError extends Error {
  constructor(gate, message) { super(`${gate} — ${message}`); this.gate = gate; }
}
const fail = (gate, message) => { throw new LayoutError(gate, message); };

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const RAIL_DIRS = new Set(['up', 'down', 'flat']);
const CHROME = {
  front: { title: 'Clank & Slop - The Front Page', active: '/' },
  tape: { title: 'Clank & Slop - The Tape', active: '/tape' },
};
const SECTION_HEADER = 'The Flashpoint Index';


const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const jsonDir = (dir) => {
  if (!existsSync(dir)) return {};
  const out = {};
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) out[name.slice(0, -5)] = readJson(resolve(dir, name));
  return out;
};

export function personaNames(agentsDir = resolve(root, 'content', 'agents')) {
  const names = new Set();
  for (const [slug, agent] of Object.entries(jsonDir(agentsDir))) { names.add(slug); if (isStr(agent.name)) names.add(agent.name); if (isStr(agent.id)) names.add(agent.id); }
  return names;
}

export function readEditionInputs(stateRoot, edition) {
  const dir = resolve(stateRoot, 'editions', edition);
  if (!existsSync(dir)) fail('edition tree incomplete', `no edition directory at ${dir}`);
  return { articles: jsonDir(resolve(dir, 'articles')), desk: jsonDir(resolve(dir, 'desk')), maps: jsonDir(resolve(dir, 'maps')) };
}

// Published editions come from the content volume in the container (and from
// content/ in a checkout); publicContentRoot refuses a volume the host has not
// landed rather than letting this come back silently empty.
export function archiveIndex(contentRoot = publicContentRoot()) {
  const dir = resolve(contentRoot, 'editions');
  const index = new Map();
  if (!existsSync(dir)) return index;
  for (const edition of readdirSync(dir).sort()) {
    const maps = resolve(dir, edition, 'maps');
    if (!existsSync(maps)) continue;
    for (const file of readdirSync(maps)) if (file.endsWith('.json')) index.set(file.slice(0, -5), resolve(maps, file));
  }
  return index;
}

export function archiveResolver(contentRoot) {
  let index;
  const cache = new Map();
  return (name) => {
    if (cache.has(name)) return cache.get(name);
    index ??= archiveIndex(contentRoot);
    const file = index.get(name);
    const document = file === undefined ? undefined : readJson(file);
    cache.set(name, document);
    return document;
  };
}


const item = (where, value) => {
  if (!isObj(value)) fail('briefly shape', `${where} must be an object {kicker, agent, what}`);
  for (const key of ['kicker', 'agent', 'what']) if (!isStr(value[key])) fail('briefly shape', `${where}.${key} must be a non-empty string`);
  return { kicker: value.kicker, agent: value.agent, what: value.what };
};

function brieflyDesks(where, desks, agents) {
  if (!Array.isArray(desks) || desks.length !== 3)
    fail('briefly shape', `${where} must carry exactly 3 desks — .briefly-desks is a fixed repeat(3, 1fr) grid, so two leaves a blank column and four wraps (got ${Array.isArray(desks) ? desks.length : typeof desks})`);
  return desks.map((desk, i) => {
    if (!isObj(desk) || !isStr(desk.label)) fail('briefly shape', `${where}[${i}].label must be a non-empty string`);
    const rest = Array.isArray(desk.rest) ? desk.rest : [];
    const out = { label: desk.label, lead: item(`${where}[${i}].lead`, desk.lead), rest: rest.map((r, j) => item(`${where}[${i}].rest[${j}]`, r)) };
    for (const entry of [out.lead, ...out.rest])
      if (!agents.has(entry.agent)) fail('agent reference', `${where}[${i}] names agent "${entry.agent}", which has no persona file — the content validator refuses an unknown agent name`);
    return out;
  });
}


const teaser = (article, size) => ({ block: 'Teaser', props: { article, size } });
const grid = (cols, columns, extra = {}) => ({ block: 'Grid', props: { cols, ...extra, columns } });

const mapArt = (article) => (isObj(article?.art) && article.art.kind === 'map' ? article.art : null);

// Static shapes render at full size unless the decision record asks for less.
// A 0.6 default shrank every Colosseum to under half its July size from
// 2026-09-21 on; rolls keep their animated-strip default.
const defaultScale = (roll) => (isStr(roll) ? 0.6 : 1);

function artBlock(slug, article, choice, maps) {
  const errors = glyphSelectionFindings({ scale: choice?.scale });
  if (errors.length) fail('art selection', errors.join('; '));
  const art = article.art;
  if (choice?.artifact) {
    if (mapArt(article)) fail('art selection', `"${slug}" already owns map art; retain its approved geography`);
    if (!isStr(choice.caption)) fail('art caption', `generated art for "${slug}" needs a caption`);
    const ref = choice.artifact;
    if (ref.kind === 'map') return { block: 'MapGlyph', props: { map: ref.name, tone: 'soft', ...mapPresentationProps(choice), rule: false, interactive: false } };
    return { block: 'GlyphArt', props: { glyph: ref.name, scale: isNum(choice.scale) ? choice.scale : 0.9, caption: choice.caption } };
  }
  if (mapArt(article)) {
    if (['shape', 'roll', 'scale'].some(key => choice?.[key] !== undefined)) fail('art selection', `reporter map for ${slug} permits only a caption choice`);
    const name = isStr(art.hero_map) ? art.hero_map : art.map;
    if (!isStr(name) || !maps[name]) fail('maps must match article art', `"${slug}" carries art.kind "map" whose map did not resolve — this is an assembler bug, resolveArticleMaps should have refused it first`);
    return { block: 'MapGlyph', props: { map: name, cols: art.cols, rows: art.rows, rotX: art.rotX, rotY: art.rotY, zoom: art.zoom, overlays: art.overlays, routes: art.routes, spots: (art.spots ?? []).map((s) => ({ ...s })), tone: art.tone ?? 'soft', locator_context: choice?.locator_context ?? art.locator_context ?? 'regional', rule: false, interactive: false, caption: choice?.caption ?? art.caption ?? '' } };
  }
  const shape = choice?.shape ?? art?.shape, roll = choice?.roll ?? art?.roll;
  if (art?.kind === 'ascii' && (isStr(shape) || isStr(roll))) {
    return glyph(slug, { ...(isStr(shape) ? { shape } : {}), ...(isStr(roll) ? { roll } : {}), scale: isNum(choice?.scale) ? choice.scale : defaultScale(roll), caption: choice?.caption ?? art.caption ?? '' });
  }
  if (!isObj(choice))
    fail('illustration rhythm invalid', `"${slug}" sits in an illustrated slot but carries no art, and the decision record has no art entry for it — add art["${slug}"] = {shape, caption} (shapes: ${[...GLYPH_SHAPES].join(', ')})`);
  if (!isStr(choice.caption)) fail('illustration rhythm invalid', `art["${slug}"].caption must be a non-empty string — one line about this story's own picture`);
  return glyph(slug, { ...(isStr(choice.shape) ? { shape: choice.shape } : {}), ...(isStr(choice.roll) ? { roll: choice.roll } : {}), scale: isNum(choice.scale) ? choice.scale : defaultScale(choice.roll), caption: choice.caption });
}

function glyph(slug, props) {
  if (props.shape !== undefined && !GLYPH_SHAPES.has(props.shape))
    fail('glyph catalogue', `art["${slug}"].shape "${props.shape}" has no model in website/src/models and no entry in GlyphArt.astro — it renders as the colosseum. Known: ${[...GLYPH_SHAPES].join(', ')}`);
  if (props.roll !== undefined && !GLYPH_ROLLS.has(props.roll))
    fail('glyph catalogue', `art["${slug}"].roll "${props.roll}" is not a committed roll — the two that exist are ${[...GLYPH_ROLLS].join(', ')}`);
  if (props.roll === 'eclipse' && props.shape !== 'eclipse') fail('glyph catalogue', `art["${slug}"] uses roll "eclipse", which requires shape "eclipse" beside it`);
  if (props.shape === 'eclipse' && props.roll !== 'eclipse') fail('glyph catalogue', `art["${slug}"] uses shape "eclipse", which requires roll "eclipse" beside it`);
  if (props.shape === undefined && props.roll === undefined) fail('glyph catalogue', `art["${slug}"] must name a shape or a roll`);
  return { block: 'GlyphArt', props };
}

function flashpoints(order, articles, decisions, agents) {
  const declared = Array.isArray(decisions.flashpoints)
    ? decisions.flashpoints
    : order.map((slug) => (isObj(articles[slug].presentation?.flashpoint) ? { ...articles[slug].presentation.flashpoint, article: slug } : null)).filter(Boolean);
  return declared.map((row, i) => {
    if (!isObj(row)) fail('flashpoint shape', `flashpoints[${i}] must be an object {place, lat, lon, note}`);
    for (const key of ['place', 'note']) if (!isStr(row[key])) fail('flashpoint shape', `flashpoints[${i}].${key} must be a non-empty string`);
    for (const key of ['lat', 'lon']) if (!isNum(row[key])) fail('flashpoint shape', `flashpoints[${i}].${key} must be a number — the globe marker and the index row are the same place`);
    if (row.article !== undefined && !articles[row.article]) fail('page completeness invalid', `flashpoints[${i}].article "${row.article}" is not one of today's PASSed articles`);
    const agent = row.agent ?? (row.article ? articles[row.article].byline?.agents?.[0] : undefined);
    if (agent !== undefined && !agents.has(agent)) fail('agent reference', `flashpoints[${i}] names agent "${agent}", which has no persona file`);
    return { place: row.place, lat: row.lat, lon: row.lon, note: row.note, ...(agent ? { agent } : {}), ...(isNum(row.p) ? { p: row.p } : {}), ...(row.article ? { article: row.article } : {}) };
  });
}


function frontPage(edition, order, articles, decisions, maps, agents) {
  const [lead, featureA, featureB, ...rest] = order;
  const heroArt = artBlock(lead, articles[lead], decisions.art?.[lead], maps);
  const artRow = (slug, side) => {
    const art = artBlock(slug, articles[slug], decisions.art?.[slug], maps);
    const story = teaser(slug, 'feature');
    return side === 'left'
      ? grid([1, 2], [[art], [story]], { rule: false, align: 'stretch' })
      : grid([2, 1], [[story], [art]], { rule: false, align: 'stretch' });
  };
  const head = [
    { block: 'Hero', props: { variant: 'lead-only', withArt: true, lead, art: heroArt } },
    artRow(featureA, 'right'),
    artRow(featureB, 'left'),
  ];
  const pairs = [];
  for (let i = 0; i + 1 < rest.length; i += 2) pairs.push(rest.slice(i, i + 2));
  const single = rest.length % 2 === 1 ? rest[rest.length - 1] : undefined;
  for (const [a, b] of pairs) head.push(grid([1, 1], [[teaser(a, 'flow')], [teaser(b, 'flow')]], { rule: true, align: 'start' }));
  if (single) head.push(grid([1], [[teaser(single, 'feature')]], { rule: false, align: 'start' }));

  const points = flashpoints(order, articles, decisions, agents);
  if (points.length > 0) {
    head.push({ block: 'SectionHeader', props: { text: SECTION_HEADER } });
    head.push(grid([1, 1], [
      [{ block: 'WorldGlyph', props: { cols: 84, rows: 40, rotX: 1.2, rotY: 0.9, worldDesk: 'edition', hotspots: points.map(({ place, lat, lon, p }) => ({ name: place, lat, lon, ...(isNum(p) ? { p } : {}) })) } }],
      [{ block: 'WorldIndex', props: { items: points.map(({ place, agent, note, p, article }) => ({ place, ...(agent ? { agent } : {}), note, ...(isNum(p) ? { p } : {}), ...(article ? { article } : {}) })) } }],
    ]));
  }
  return { edition, page: 'front', paper: 'front', title: CHROME.front.title, active: CHROME.front.active, tagline: null, head, flow: [{ block: 'Briefly', props: { title: '', compact: true, desks: brieflyDesks('briefly', decisions.briefly, agents) } }] };
}

function tapePage(edition, decisions, desk, agents, carry) {
  const tape = isObj(decisions.tape) ? decisions.tape : fail('tape shape', 'the decision record must carry a "tape" object {briefly, markets, watch}');
  const authoredDesks = brieflyDesks('tape.briefly', tape.briefly, agents);

  const rows = (tape.markets?.rows ?? []).map((row, i) => {
    for (const key of ['sym', 'value', 'spark', 'pct']) if (!isStr(row?.[key])) fail('markets shape', `tape.markets.rows[${i}].${key} must be a non-empty string`);
    if (!RAIL_DIRS.has(row.dir)) fail('markets shape', `tape.markets.rows[${i}].dir must be up|down|flat — red is only ever down and green only ever up, so "flat" is the honest choice for anything that has not moved`);
    return { sym: row.sym, value: row.value, spark: row.spark, pct: row.pct, dir: row.dir };
  });
  const authoredWatch = (tape.watch ?? []).map((row, i) => {
    for (const key of ['when', 'what']) if (!isStr(row?.[key])) fail('watch shape', `tape.watch[${i}].${key} must be a non-empty string`);
    if (row.who !== undefined && !agents.has(row.who)) fail('agent reference', `tape.watch[${i}].who names agent "${row.who}", which has no persona file`);
    return { when: row.when, what: row.what, ...(row.who ? { who: row.who } : {}) };
  });
  // Open calls and follow-up promises from earlier editions are carried here
  // until they settle (ops/open-clocks.mjs); a decision record cannot drop one.
  const carried = carryTape({ desks: authoredDesks, watch: authoredWatch, todayRows: desk['ledger.settlements'], carried: carry.calls, follow: carry.follow, agents });
  if (carried.error) fail('open clocks', carried.error);
  const watch = carried.watch;
  const head = [{ block: 'Briefly', props: { title: 'The Markets File', compact: true, desks: carried.desks } }];
  // Ledger's copy of the producer's FRED board; the site reads it off the desk
  // document, the way the globe reads the World Desk.
  if (isObj(desk['ledger.worlddesk'].markets)) head.push({ block: 'MarketsBoard', props: { markets: 'edition' } });
  const rail = rows.length > 0 ? { block: 'MarketsRail', props: { title: 'The Tape', ...(isStr(tape.markets?.kicker) ? { kicker: tape.markets.kicker } : {}), rows } } : null;
  const deadlines = watch.length > 0 ? { block: 'WhatToWatch', props: { title: `The Deadlines · ${watch[0].when}${watch.length > 1 ? ` – ${watch[watch.length - 1].when}` : ''}`, items: watch } } : null;
  if (rail && deadlines) head.push(grid([1, 1], [[rail], [deadlines]]));
  else if (rail || deadlines) head.push(rail ?? deadlines);

  // Every call not yet settled, today's new ones included, each in its state.
  const open = carry.table;
  if (open.length > 0) {
    const due = open.filter((row) => row.state === 'due').length;
    const meta = `${open.length} open call${open.length === 1 ? '' : 's'}${due > 0 ? ` · ${due} due, awaiting verification` : ''}${isStr(tape.forecast_meta) ? ` · ${tape.forecast_meta}` : ''}`;
    head.push({ block: 'ForecastLedger', props: { meta, open_calls: open } });
  }
  head.push({ block: 'TrackRecord', props: { label: 'Track Record · Settlement', resolved: 'edition' } });
  return { edition, page: 'tape', paper: 'tape', title: CHROME.tape.title, active: CHROME.tape.active, tagline: null, head, flow: [] };
}


const visualCount = (value) => JSON.stringify(value).match(/"block":"(?:MapGlyph|GlyphArt|Illustration|Image)"/gu)?.length ?? 0;

function resolveArticleMaps(articles, maps, archive) {
  const resolved = {}, spotsFor = new Map();
  for (const slug of Object.keys(articles).sort()) {
    const art = mapArt(articles[slug]);
    if (art === null) continue;
    if (!isStr(art.map))
      fail('maps must match article art', `"${slug}" carries art.kind "map" but no "map" — art.map is the wide region the story page and the OG card load, and it is the one key a map story cannot leave out`);
    if (art.hero_map !== undefined && !isStr(art.hero_map))
      fail('maps must match article art', `"${slug}" carries art.hero_map ${JSON.stringify(art.hero_map)} — it names the front panel's narrower re-crop, usually "${art.map}-hero", or it is left out entirely`);
    const spots = JSON.stringify((art.spots ?? []).map(({ name: place, lat, lon }) => ({ place, lat, lon })).sort((a, b) => a.place.localeCompare(b.place)));
    for (const name of [art.map, ...(isStr(art.hero_map) ? [art.hero_map] : [])]) {
      const document = maps[name] ?? archive(name);
      if (!isObj(document))
        fail('maps must match article art', `"${slug}" names map "${name}", which is neither in this edition's maps/ nor in the committed archive under content/editions/*/maps/ — name an archived region; Caslon can add fresh page art separately`);
      const seen = spotsFor.get(name);
      if (seen !== undefined && seen.slug !== slug && seen.spots !== spots)
        fail('maps must match article art', `"${slug}" and "${seen.slug}" both name map "${name}" with different art.spots — ops/validate-content.mjs matches a page MapGlyph's spots against the article art for that map name, and one region cannot carry two sets. Give them the same spots, or one of them a different region`);
      spotsFor.set(name, { slug, spots });
      resolved[name] = document;
    }
  }
  return resolved;
}

export function alternationRuns(head) {
  const side = (block) => {
    if (block?.block === 'Hero') return block.props?.withArt === true ? 'left' : null;
    if (block?.block !== 'Grid' || !Array.isArray(block.props?.columns)) return null;
    const kinds = block.props.columns.map((column) => ({
      art: column.some((nested) => nested?.block === 'MapGlyph' || nested?.block === 'GlyphArt'),
      story: column.some((nested) => nested?.block === 'Teaser'),
    }));
    const art = kinds.findIndex((kind) => kind.art), story = kinds.findIndex((kind) => kind.story);
    return art < 0 || story < 0 || art === story ? null : art < story ? 'left' : 'right';
  };
  const runs = [];
  let run = [];
  for (const block of head) {
    const value = side(block);
    if (value) run.push(value);
    else { if (run.length > 1) runs.push(run); run = []; }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

// `ledger` is the published editions before this one ([{date, settlements,
// articles}]); read from the archive when the caller does not supply it.
export function layEdition({ edition, articles, desk, maps = {}, decisions, artifacts = [], agents = personaNames(), archive = archiveResolver(), ledger }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(edition ?? '')) fail('edition identity', `edition must be an ISO date "YYYY-MM-DD", got ${JSON.stringify(edition)}`);
  if (!isObj(decisions)) fail('decision record', 'no decision record supplied — the assembler never guesses an editorial choice');
  if (decisions.edition !== undefined && decisions.edition !== edition) fail('edition identity', `the decision record names edition ${JSON.stringify(decisions.edition)} but the run is for ${edition}`);
  for (const part of ['caslon.chrome', 'caslon.weather', 'ledger.settlements', 'ledger.worlddesk'])
    if (!isObj(desk[part])) fail('edition tree incomplete', `desk document "${part}" is missing — compose_edition requires exactly 4`);

  const passed = Object.keys(articles).sort();
  if (passed.length < PASSED_ARTICLES_MINIMUM) fail('edition tree incomplete', `at least ${PASSED_ARTICLES_MINIMUM} PASSed articles required, found ${passed.length} — that is Brass's lineup, not a layout problem`);
  const order = decisions.order;
  if (!Array.isArray(order) || order.some((slug) => !isStr(slug))) fail('page completeness invalid', 'the decision record must carry "order": every PASSed slug, in placement order — order[0] leads');
  const placed = [...order].sort();
  if (new Set(order).size !== order.length || placed.join() !== passed.join())
    fail('page completeness invalid', `"order" must be exactly today's PASSed set, each slug once. Expected [${passed.join(', ')}], got [${[...order].sort().join(', ')}]`);
  for (const [field, lead] of [['decisions.lead', decisions.lead], ['caslon.chrome.lead_story_id', desk['caslon.chrome'].lead_story_id]])
    if (isStr(lead) && lead !== order[0])
      fail('lead story', `order[0] is "${order[0]}" but ${field} is "${lead}" — the decision, page and desk document must name the same lead`);

  const generated = layoutArtifacts(decisions, artifacts, fail);
  const resolved = { ...resolveArticleMaps(articles, maps, archive) };
  for (const [name, document] of Object.entries(generated.maps)) {
    if (resolved[name] && JSON.stringify(resolved[name]) !== JSON.stringify(document)) fail('map identity', `generated map ${name} conflicts with reporter art`);
    resolved[name] = document;
  }
  const rows = desk['ledger.settlements'].resolved_last_edition ?? [];
  // Reporter flashpoints inherited when the record names none are summaries too.
  const inherited = Array.isArray(decisions.flashpoints) ? decisions.flashpoints : order.map((slug) => (isObj(articles[slug].presentation?.flashpoint) ? { ...articles[slug].presentation.flashpoint, article: slug } : null)).filter(Boolean);
  const summaries = decisionSummaryFindings({ ...decisions, flashpoints: inherited }, articles, { edition, extra: [...rows.map((row) => `${row?.call} ${row?.prior_p}`), JSON.stringify(desk['ledger.worlddesk'])] });
  if (summaries.length > 0)
    fail('summary fidelity', `${summaries.length} summary line(s) say what their article does not. A summary may only restate what the article states: keep each event with its own day, date and place, never merge two events into one sentence, and copy figures rather than computing them. Rewrite: ${summaries.join(' | ')}`);
  const prior = (ledger ?? archiveLedger(undefined, { before: edition })).filter((entry) => entry.date < edition);
  const previous = prior.reduce((latest, entry) => (latest === undefined || entry.date > latest.date ? entry : latest), undefined);
  const today = { date: edition, settlements: desk['ledger.settlements'], articles: Object.values(articles) };
  const carry = { calls: carriedCalls(ledgerHistory(prior), edition, desk['ledger.settlements']), follow: followUps(previous, articles), table: forecastRows(ledgerHistory([...prior, today], { epoch: edition < LEDGER_EPOCH ? edition : LEDGER_EPOCH }), edition) };
  const front = frontPage(edition, order, articles, decisions, resolved, agents);
  const tape = tapePage(edition, decisions, desk, agents, carry);

  const visuals = visualCount(front);
  if (visuals < 2 || visuals > 3) fail('illustration rhythm invalid', `the front carries ${visuals} MapGlyph/GlyphArt blocks; compose_edition requires 2-3`);
  const rolls = front.head.flatMap((block) => block.props?.columns?.flat() ?? []).filter((nested) => nested?.block === 'GlyphArt' && isStr(nested.props.roll));
  if (rolls.length > 1) fail('animated roll', `the front carries ${rolls.length} animated rolls (${rolls.map((r) => r.props.roll).join(', ')}); at most one runs in an edition — two competing motions read like a carnival, not a newspaper`);
  const papers = [front, tape].map((page) => page.paper).filter(isStr);
  if (new Set(papers).size < 2) fail('paper diversity invalid', `the two pages must each carry a distinct top-level "paper" value, found [${papers.join(', ')}]`);
  for (const run of alternationRuns(front.head))
    for (const [offset, side] of run.entries()) {
      const expected = offset % 2 === 0 ? 'left' : 'right';
      if (side !== expected) fail('illustration alternation', `an adjacent run of illustrated rows goes [${run.join(', ')}]; ops/validate-content.mjs requires art ${expected} in position ${offset} — adjacent runs alternate left → right, and a hero carrying art is the first left`);
    }
  const supplied = Object.keys(resolved).sort();
  return {
    pages: [{ name: 'front', document: front }, { name: 'tape', document: tape }],
    maps: supplied.map((name) => ({ name, document: resolved[name] })),
    artifacts: generated.references,
    report: { edition, passed: passed.length, placed: order.length, visuals, maps: supplied.length, flashpoints: front.head.find((b) => b.block === 'Grid' && b.props.columns[0][0]?.block === 'WorldGlyph')?.props.columns[1][0].props.items.length ?? 0 },
  };
}


function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function main(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    flags[key] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i += 1] : true;
  }
  const edition = flags.edition;
  if (!isStr(edition)) { console.error('usage: node ops/lay-page.mjs --edition <YYYY-MM-DD> [--state <root>] [--decisions <file|->] [--out <dir>]'); process.exit(2); }
  const stateRoot = resolve(flags.state === undefined || flags.state === true ? (process.env.CLANK_EDITION_STATE_ROOT ?? './state/edition') : flags.state);
  const source = flags.decisions === undefined || flags.decisions === true || flags.decisions === '-' ? readStdin() : readFileSync(resolve(flags.decisions), 'utf8');
  if (source.trim() === '') { console.error('lay-page: no decision record on stdin or at --decisions — the assembler never guesses an editorial choice'); process.exit(2); }
  let decisions;
  try { decisions = JSON.parse(source); } catch (error) { console.error(`lay-page: decision record is not valid JSON — ${error.message}`); process.exit(2); }

  const { articles, desk, maps } = readEditionInputs(stateRoot, edition);
  const laid = layEdition({ edition, articles, desk, maps, decisions });
  const { report } = laid;
  console.error(`lay-page ${report.edition}: ${report.placed}/${report.passed} articles placed · front visuals=${report.visuals} · papers=front,tape · flashpoints=${report.flashpoints} · maps=${report.maps}`);
  if (isStr(flags.out)) {
    const dir = resolve(flags.out);
    mkdirSync(dir, { recursive: true });
    for (const page of laid.pages) writeFileSync(resolve(dir, `${page.name}.json`), `${JSON.stringify(page.document, null, 1)}\n`);
    console.error(`lay-page: wrote ${laid.pages.map((p) => `${basename(dir)}/${p.name}.json`).join(' ')}`);
  }
  process.stdout.write(`${JSON.stringify({ pages: laid.pages, maps: laid.maps, artifacts: laid.artifacts })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(`lay-page: ${error instanceof LayoutError ? error.message : error.stack ?? error.message}`);
    process.exit(1);
  }
}
