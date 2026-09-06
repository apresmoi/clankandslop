// The page assembler. Turns the day's PASSed articles, the four desk documents
// and a small decision record into the two page documents `compose_edition`
// takes, and nothing else.
//
// It exists because every gate that has ever refused a composition is a
// whole-page property — the visual count, the art-side alternation, the
// front/tape disjointness, the `paper` diversity — and none of them is a
// judgement. A compositor rediscovering them one refusal at a time is the
// most expensive way to retype a house style. The judgements that survive
// are in the decision record; everything else below is derived.
//
// It deliberately runs BEFORE `compose_edition` and hands it the same opaque
// `pages` array it has always taken, so one-shot composition and the
// `stage_release` receipt binding are untouched.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every refusal names the gate it is standing in for and the input that is missing. */
export class LayoutError extends Error {
  constructor(gate, message) { super(`${gate} — ${message}`); this.gate = gate; }
}
const fail = (gate, message) => { throw new LayoutError(gate, message); };

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The renderer's own lists, restated here so a page can never carry a shape
// GlyphArt.astro has no model for. `roll` is two names whatever SYSTEMS.md says.
const GLYPH_SHAPES = new Set(['colosseum', 'play', 'notfound', 'satellite', 'pumpjack', 'missile', 'drone', 'chip', 'campfire', 'eclipse']);
const GLYPH_ROLLS = new Set(['chip', 'eclipse']);
const RAIL_DIRS = new Set(['up', 'down', 'flat']);
const CHROME = {
  front: { title: 'Clank & Slop - The Front Page', active: '/' },
  tape: { title: 'Clank & Slop - The Tape', active: '/tape' },
};
const SECTION_HEADER = 'The Flashpoint Index';

// ---- inputs -----------------------------------------------------------------

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const jsonDir = (dir) => {
  if (!existsSync(dir)) return {};
  const out = {};
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) out[name.slice(0, -5)] = readJson(resolve(dir, name));
  return out;
};

/** The persona display names the content validator will accept on an `agent` prop. */
export function personaNames(agentsDir = resolve(root, 'content', 'agents')) {
  const names = new Set();
  for (const [slug, agent] of Object.entries(jsonDir(agentsDir))) { names.add(slug); if (isStr(agent.name)) names.add(agent.name); if (isStr(agent.id)) names.add(agent.id); }
  return names;
}

/**
 * Everything the assembler reads, from one edition directory.
 * `stateRoot` holds `editions/<date>/{articles,desk,maps}` — true of the shared
 * edition state volume and of the repo's own `content/` tree alike.
 */
export function readEditionInputs(stateRoot, edition) {
  const dir = resolve(stateRoot, 'editions', edition);
  if (!existsSync(dir)) fail('edition tree incomplete', `no edition directory at ${dir}`);
  return { articles: jsonDir(resolve(dir, 'articles')), desk: jsonDir(resolve(dir, 'desk')), maps: jsonDir(resolve(dir, 'maps')) };
}

// ---- the decision record ----------------------------------------------------

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

// ---- derivation -------------------------------------------------------------

const teaser = (article, size) => ({ block: 'Teaser', props: { article, size } });
const grid = (cols, columns, extra = {}) => ({ block: 'Grid', props: { cols, ...extra, columns } });

/**
 * The art block for one illustrated slot.
 *
 * Derived from the article whenever the article carries usable art: a baked
 * `hero_map` becomes a MapGlyph whose spots are the article's own, an ascii
 * shape becomes a GlyphArt. The decision record supplies the glyph only where
 * the article has none, which is every ordinary day — no reporter is asked to
 * write `art`, and `bake-map.mjs` cannot run in the compositor's container.
 */
function artBlock(slug, article, choice, maps) {
  const art = article.art;
  if (art?.kind === 'map') {
    const name = art.hero_map ?? art.map;
    if (!isStr(name)) fail('maps must match article art', `"${slug}" carries art.kind "map" with neither hero_map nor map`);
    if (!maps[name]) fail('maps must match article art', `"${slug}" names map "${name}" but no baked maps/${name}.json exists in this edition — bake it or drop art from the article`);
    return { block: 'MapGlyph', props: { map: name, spots: (art.spots ?? []).map((s) => ({ ...s })), tone: 'soft', locator_context: 'regional', rule: false, interactive: false, caption: choice?.caption ?? art.caption ?? '' } };
  }
  // The reporter says what the story is about; the shape, whether it turns,
  // and the line under it are the compositor's, so a record entry overrides
  // the article's own art rather than being ignored beside it.
  const shape = choice?.shape ?? art?.shape, roll = choice?.roll ?? art?.roll;
  if (art?.kind === 'ascii' && (isStr(shape) || isStr(roll))) {
    return glyph(slug, { ...(isStr(shape) ? { shape } : {}), ...(isStr(roll) ? { roll } : {}), scale: isNum(choice?.scale) ? choice.scale : 0.6, caption: choice?.caption ?? art.caption ?? '' });
  }
  if (!isObj(choice))
    fail('illustration rhythm invalid', `"${slug}" sits in an illustrated slot but carries no art, and the decision record has no art entry for it — add art["${slug}"] = {shape, caption} (shapes: ${[...GLYPH_SHAPES].join(', ')})`);
  if (!isStr(choice.caption)) fail('illustration rhythm invalid', `art["${slug}"].caption must be a non-empty string — one line about this story's own picture`);
  return glyph(slug, { ...(isStr(choice.shape) ? { shape: choice.shape } : {}), ...(isStr(choice.roll) ? { roll: choice.roll } : {}), scale: isNum(choice.scale) ? choice.scale : 0.6, caption: choice.caption });
}

function glyph(slug, props) {
  if (props.shape !== undefined && !GLYPH_SHAPES.has(props.shape))
    fail('glyph catalogue', `art["${slug}"].shape "${props.shape}" has no model in website/src/models and no entry in GlyphArt.astro — it renders as the colosseum. Known: ${[...GLYPH_SHAPES].join(', ')}`);
  if (props.roll !== undefined && !GLYPH_ROLLS.has(props.roll))
    fail('glyph catalogue', `art["${slug}"].roll "${props.roll}" is not a committed roll — the two that exist are ${[...GLYPH_ROLLS].join(', ')}`);
  if (props.roll === 'eclipse' && props.shape !== 'eclipse') fail('glyph catalogue', `art["${slug}"] uses roll "eclipse", which requires shape "eclipse" beside it`);
  if (props.shape === undefined && props.roll === undefined) fail('glyph catalogue', `art["${slug}"] must name a shape or a roll`);
  return { block: 'GlyphArt', props };
}

/** Flashpoint rows: the record's own list, else each ordered article's shipped `presentation.flashpoint`. */
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

// ---- the two pages ----------------------------------------------------------

function frontPage(edition, order, articles, decisions, maps, agents) {
  const [lead, featureA, featureB, ...rest] = order;
  const head = [
    { block: 'Hero', props: { variant: 'lead-only', withArt: false, lead } },
    grid([1, 2], [[artBlock(featureA, articles[featureA], decisions.art?.[featureA], maps)], [teaser(featureA, 'feature')]], { rule: false, align: 'stretch' }),
    grid([2, 1], [[teaser(featureB, 'feature')], [artBlock(featureB, articles[featureB], decisions.art?.[featureB], maps)]], { rule: false, align: 'stretch' }),
  ];
  // Pairs become two-up rows, a leftover single becomes the full-width feature
  // row — which is where a Hearth piece lands. Neither carries art, so the
  // visual count stays at two whatever the day's length.
  const pairs = [];
  for (let i = 0; i + 1 < rest.length; i += 2) pairs.push(rest.slice(i, i + 2));
  const single = rest.length % 2 === 1 ? rest[rest.length - 1] : undefined;
  for (const [a, b] of pairs) head.push(grid([1, 1], [[teaser(a, 'flow')], [teaser(b, 'flow')]], { rule: true, align: 'start' }));
  if (single) head.push(grid([1], [[teaser(single, 'feature')]], { rule: false, align: 'start' }));

  const points = flashpoints(order, articles, decisions, agents);
  if (points.length > 0) {
    head.push({ block: 'SectionHeader', props: { text: SECTION_HEADER } });
    // One list, two consumers: the circled markers on the globe and the numbered
    // rows beside it are the same places in the same order, by construction.
    head.push(grid([1, 1], [
      [{ block: 'WorldGlyph', props: { cols: 84, rows: 40, rotX: 1.2, rotY: 0.9, worldDesk: 'edition', hotspots: points.map(({ place, lat, lon, p }) => ({ name: place, lat, lon, ...(isNum(p) ? { p } : {}) })) } }],
      [{ block: 'WorldIndex', props: { items: points.map(({ place, agent, note, p, article }) => ({ place, ...(agent ? { agent } : {}), note, ...(isNum(p) ? { p } : {}), ...(article ? { article } : {}) })) } }],
    ]));
  }
  return { edition, page: 'front', paper: 'front', title: CHROME.front.title, active: CHROME.front.active, tagline: null, head, flow: [{ block: 'Briefly', props: { title: '', compact: true, desks: brieflyDesks('briefly', decisions.briefly, agents) } }] };
}

function tapePage(edition, decisions, desk, agents) {
  const tape = isObj(decisions.tape) ? decisions.tape : fail('tape shape', 'the decision record must carry a "tape" object {briefly, markets, watch}');
  const head = [{ block: 'Briefly', props: { title: 'The Markets File', compact: true, desks: brieflyDesks('tape.briefly', tape.briefly, agents) } }];

  const rows = (tape.markets?.rows ?? []).map((row, i) => {
    for (const key of ['sym', 'value', 'spark', 'pct']) if (!isStr(row?.[key])) fail('markets shape', `tape.markets.rows[${i}].${key} must be a non-empty string`);
    if (!RAIL_DIRS.has(row.dir)) fail('markets shape', `tape.markets.rows[${i}].dir must be up|down|flat — red is only ever down and green only ever up, so "flat" is the honest choice for anything that has not moved`);
    return { sym: row.sym, value: row.value, spark: row.spark, pct: row.pct, dir: row.dir };
  });
  const watch = (tape.watch ?? []).map((row, i) => {
    for (const key of ['when', 'what']) if (!isStr(row?.[key])) fail('watch shape', `tape.watch[${i}].${key} must be a non-empty string`);
    if (row.who !== undefined && !agents.has(row.who)) fail('agent reference', `tape.watch[${i}].who names agent "${row.who}", which has no persona file`);
    return { when: row.when, what: row.what, ...(row.who ? { who: row.who } : {}) };
  });
  // A rail padded to length is a fabricated tape, so a day with no numbers
  // simply prints a shorter page rather than a block full of invented rows.
  const rail = rows.length > 0 ? { block: 'MarketsRail', props: { title: 'The Tape', ...(isStr(tape.markets?.kicker) ? { kicker: tape.markets.kicker } : {}), rows } } : null;
  const deadlines = watch.length > 0 ? { block: 'WhatToWatch', props: { title: `The Deadlines · ${watch[0].when}${watch.length > 1 ? ` – ${watch[watch.length - 1].when}` : ''}`, items: watch } } : null;
  if (rail && deadlines) head.push(grid([1, 1], [[rail], [deadlines]]));
  else if (rail || deadlines) head.push(rail ?? deadlines);

  // The open calls are Ledger's, read off the settlement document rather than
  // retyped: question is the row's own call, p its own prior, and the direction
  // follows from p. `interval` and `quorum` are pool statistics no input here
  // supplies, so they are omitted rather than estimated.
  const open = (desk['ledger.settlements']?.resolved_last_edition ?? []).filter((row) => row?.outcome === 'open');
  if (open.length > 0) {
    const meta = `${open.length} open call${open.length === 1 ? '' : 's'}${isStr(tape.forecast_meta) ? ` · ${tape.forecast_meta}` : ''}`;
    head.push({ block: 'ForecastLedger', props: { meta, open_calls: open.map((row) => ({ question: row.call, call: row.prior_p >= 0.5 ? 'YES' : 'NO', direction: row.prior_p >= 0.5 ? 'bull' : 'bear', p: row.prior_p })) } });
  }
  head.push({ block: 'TrackRecord', props: { label: 'Track Record · Settlement', resolved: 'edition' } });
  return { edition, page: 'tape', paper: 'tape', title: CHROME.tape.title, active: CHROME.tape.active, tagline: null, head, flow: [] };
}

// ---- the whole edition ------------------------------------------------------

/** Counts what `compose_edition`'s illustration gate counts, the same way. */
const visualCount = (value) => JSON.stringify(value).match(/"block":"(?:MapGlyph|GlyphArt|Illustration|Image)"/gu)?.length ?? 0;

/**
 * The two page documents plus the maps that must accompany them, ready to hand
 * to `compose_edition` unchanged.
 */
export function layEdition({ edition, articles, desk, maps = {}, decisions, agents = personaNames() }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(edition ?? '')) fail('edition identity', `edition must be an ISO date "YYYY-MM-DD", got ${JSON.stringify(edition)}`);
  if (!isObj(decisions)) fail('decision record', 'no decision record supplied — the assembler never guesses an editorial choice');
  if (decisions.edition !== undefined && decisions.edition !== edition) fail('edition identity', `the decision record names edition ${JSON.stringify(decisions.edition)} but the run is for ${edition}`);
  for (const part of ['caslon.chrome', 'caslon.weather', 'ledger.settlements', 'ledger.worlddesk'])
    if (!isObj(desk[part])) fail('edition tree incomplete', `desk document "${part}" is missing — compose_edition requires exactly 4`);

  const passed = Object.keys(articles).sort();
  if (passed.length < 5) fail('edition tree incomplete', `at least 5 PASSed articles required, found ${passed.length} — that is Brass's lineup, not a layout problem`);
  const order = decisions.order;
  if (!Array.isArray(order) || order.some((slug) => !isStr(slug))) fail('page completeness invalid', 'the decision record must carry "order": every PASSed slug, in placement order — order[0] leads');
  const placed = [...order].sort();
  if (new Set(order).size !== order.length || placed.join() !== passed.join())
    fail('page completeness invalid', `"order" must be exactly today's PASSed set, each slug once. Expected [${passed.join(', ')}], got [${[...order].sort().join(', ')}]`);
  const lead = decisions.lead ?? desk['caslon.chrome'].lead_story_id;
  if (isStr(lead) && lead !== order[0])
    fail('lead story', `order[0] is "${order[0]}" but caslon.chrome.lead_story_id is "${lead}" — the page and the desk document must name the same lead`);

  const front = frontPage(edition, order, articles, decisions, maps, agents);
  const tape = tapePage(edition, decisions, desk, agents);

  // Self-checks: every whole-page gate, re-read off the documents that are about
  // to be handed over, so a refusal happens here rather than inside a wake.
  const visuals = visualCount(front);
  if (visuals < 2 || visuals > 3) fail('illustration rhythm invalid', `the front carries ${visuals} MapGlyph/GlyphArt blocks; compose_edition requires 2-3`);
  const rolls = front.head.flatMap((block) => block.props?.columns?.flat() ?? []).filter((nested) => nested?.block === 'GlyphArt' && isStr(nested.props.roll));
  if (rolls.length > 1) fail('animated roll', `the front carries ${rolls.length} animated rolls (${rolls.map((r) => r.props.roll).join(', ')}); at most one runs in an edition — two competing motions read like a carnival, not a newspaper`);
  // compose_edition counts `paper` values found anywhere in either document, so
  // an absent one is not a distinct value — and it is the gate that has refused
  // every composition this paper has ever attempted.
  const papers = [front, tape].map((page) => page.paper).filter(isStr);
  if (new Set(papers).size < 2) fail('paper diversity invalid', `the two pages must each carry a distinct top-level "paper" value, found [${papers.join(', ')}]`);
  const supplied = [...new Set(Object.values(articles).map((a) => a.art?.hero_map).filter(isStr))].sort();
  for (const name of supplied) if (!maps[name]) fail('maps must match article art', `article art names hero_map "${name}" but no baked maps/${name}.json exists in this edition`);
  return {
    pages: [{ name: 'front', document: front }, { name: 'tape', document: tape }],
    maps: supplied.map((name) => ({ name, document: maps[name] })),
    report: { edition, passed: passed.length, placed: order.length, visuals, maps: supplied.length, flashpoints: front.head.find((b) => b.block === 'Grid' && b.props.columns[0][0]?.block === 'WorldGlyph')?.props.columns[1][0].props.items.length ?? 0 },
  };
}

// ---- cli --------------------------------------------------------------------

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
  // stdout is exactly the two arguments compose_edition takes, and nothing else.
  process.stdout.write(`${JSON.stringify({ pages: laid.pages, maps: laid.maps })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(`lay-page: ${error instanceof LayoutError ? error.message : error.stack ?? error.message}`);
    process.exit(1);
  }
}
