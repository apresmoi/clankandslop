// Content gate for the autonomous newsroom: every edition, article, page and
// agent persona must pass before `astro build` runs (locally and in CI).
// Reference integrity rules mirror PageRenderer.astro's hydrate() — keep the
// BLOCKS set and REF KEYS in sync with the registry there.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import { articleFormatFindings } from './article-format.mjs';
import { glyphFormatFindings, glyphSelectionFindings } from './glyph-format.mjs';
import { EDITION_PART_FILES, OUTCOMES as DESK_OUTCOMES, deskDocumentFindings } from './desk-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contentRoot = resolve(root, 'content');

const BLOCKS = new Set([
  'Hero', 'Teaser', 'DeskNote', 'Briefly', 'WhatToWatch',
  'SplitVote', 'ForecastLedger', 'TrackRecord', 'MarketsRail',
  'AgentRoster', 'AgentCard', 'Divider', 'WorldGlyph', 'MapGlyph', 'WorldIndex', 'RankBars', 'GlyphArt', 'SectionHeader', 'Grid',
]);

const OUTCOMES = DESK_OUTCOMES;

const errors = [];
const err = (file, msg) => errors.push(`${file}: ${msg}`);
const warnings = [];
const warn = (file, msg) => warnings.push(`${file}: ${msg}`);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    err(rel(path), `unreadable JSON — ${e.message}`);
    return null;
  }
}

const rel = (p) => p.slice(root.length + 1);
const ls = (dir) => { try { return readdirSync(dir); } catch { return []; } };
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isP = (v) => isNum(v) && v >= 0 && v <= 1;

// ---- agents ----------------------------------------------------------------

const agentsDir = resolve(contentRoot, 'agents');
const agentFiles = ls(agentsDir).filter((f) => f.endsWith('.json'));
const agentSlugs = new Set(agentFiles.map((f) => f.replace('.json', '')));
const agentNames = new Set();
const personaNames = new Set();  // display names only — feeds the no-self-reference body gate

for (const f of agentFiles) {
  const file = rel(resolve(agentsDir, f));
  const a = readJson(resolve(agentsDir, f));
  if (!a) continue;
  if (!isStr(a.id)) err(file, 'missing id');
  if (!isStr(a.name)) err(file, 'missing name');
  if (isStr(a.id) && a.id.toLowerCase() !== basename(f, '.json'))
    err(file, `filename must be lowercase of id — expected ${a.id.toLowerCase()}.json`);
  if (!isStr(a.beat_primary)) err(file, 'missing beat_primary');
  if (!isP(a.reputation_90d)) err(file, 'reputation_90d must be a number in [0,1]');
  for (const k of ['calls_last_n', 'hits', 'misses'])
    if (!isNum(a[k])) err(file, `${k} must be a number`);
  if (!Array.isArray(a.last_5_calls)) err(file, 'missing last_5_calls');
  for (const [i, c] of (a.last_5_calls ?? []).entries()) {
    if (!isStr(c.claim)) err(file, `last_5_calls[${i}] missing claim`);
    if (!isP(c.p)) err(file, `last_5_calls[${i}].p must be in [0,1]`);
    if (!OUTCOMES.has(c.outcome)) err(file, `last_5_calls[${i}].outcome must be hit|miss|open`);
  }
  if (isStr(a.name)) { agentNames.add(a.name); personaNames.add(a.name); }
  if (isStr(a.id)) agentNames.add(a.id);
}

const checkAgentName = (file, where, name) => {
  if (!agentNames.has(name)) err(file, `${where} names unknown agent "${name}"`);
};

// ---- topic glossary ---------------------------------------------------------
// content/topics.json maps canonical slugs → {name, blurb, aliases}. Articles
// tag themselves with canonical slugs; the archive browses by topic.
const topicReg = readJson(resolve(contentRoot, 'topics.json'));
const validTopics = new Set();
if (!topicReg || typeof topicReg.topics !== 'object') {
  err('content/topics.json', 'missing or malformed topic registry');
} else {
  for (const [slug, t] of Object.entries(topicReg.topics)) {
    validTopics.add(slug);
    if (!isStr(t.name)) err('content/topics.json', `topic "${slug}" missing name`);
    if (!isStr(t.blurb)) err('content/topics.json', `topic "${slug}" missing blurb`);
  }
}

// ---- editions + fixtures -----------------------------------------------------
// Fixtures (content/fixtures) follow the same content rules as an edition
// but carry no desk chrome — they exist only for the /layouts gallery.

const editionsDir = resolve(contentRoot, 'editions');
const scopes = [];
for (const date of ls(editionsDir)) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    err(rel(resolve(editionsDir, date)), 'edition directory must be YYYY-MM-DD');
    continue;
  }
  scopes.push({ date, dir: resolve(editionsDir, date), desk: true });
}
scopes.push({ date: 'fixtures', dir: resolve(contentRoot, 'fixtures'), desk: false });
const previousArticles = new Set(scopes.flatMap(({ date, dir }) => ls(resolve(dir, 'articles')).filter(f => f.endsWith('.json')).map(f => `${date}/${f.slice(0, -5)}`)));

for (const { date, dir: edDir, desk } of scopes) {
  const articleDir = resolve(edDir, 'articles');
  const articleSlugs = new Set(
    ls(articleDir).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')),
  );
  const articleMapArts = new Map();

  // edition chrome — per-owner part files under desk/. Filename = owner +
  // artifact; the set must be complete and assemble into the Edition view.
  if (desk) {
  const deskDir = resolve(edDir, 'desk');
  const edFile = rel(deskDir);
  let ed = {};
  for (const part of EDITION_PART_FILES) {
    const p = readJson(resolve(deskDir, part));
    if (p === null) { err(`${edFile}/${part}`, 'missing edition part'); ed = null; break; }
    // The same contract file_desk applies hours earlier, so a document that
    // reaches here malformed has already been refused once at filing time.
    for (const finding of deskDocumentFindings(part.slice(0, -5), p)) err(`${edFile}/${part}`, finding);
    Object.assign(ed, p);
  }
  if (ed) {
    for (const k of ['date', 'edition_no', 'volume', 'issued_at', 'tagline', 'next_bell'])
      if (!isStr(ed[k])) err(edFile, `missing ${k}`);
    if (ed.date !== date) err(edFile, `date "${ed.date}" does not match directory ${date}`);
    if (!isNum(ed.revision)) err(edFile, 'revision must be a number');
    if (!articleSlugs.has(ed.lead_story_id))
      err(edFile, `lead_story_id "${ed.lead_story_id}" has no article file`);
    for (const name of ed.compiled_by ?? []) checkAgentName(edFile, 'compiled_by', name);
    for (const [i, r] of (ed.resolved_last_edition ?? []).entries()) {
      if (!OUTCOMES.has(r.outcome)) err(edFile, `resolved_last_edition[${i}].outcome must be hit|miss|open`);
      if (!isP(r.prior_p)) err(edFile, `resolved_last_edition[${i}].prior_p must be in [0,1]`);
    }
  }
  }

  // maps (baked by ops/bake-map.mjs) — validated before articles so article
  // art can reference them.
  const mapsDir = resolve(edDir, 'maps');
  const mapSlugs = new Set(
    ls(mapsDir).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')),
  );
  const glyphSlugs = new Set(
    ls(resolve(edDir, 'glyphs')).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')),
  );
  for (const slug of mapSlugs) {
    const file = rel(resolve(mapsDir, `${slug}.json`));
    const m = readJson(resolve(mapsDir, `${slug}.json`));
    if (!m) continue;
    if (m.name !== slug) err(file, `name "${m.name}" does not match filename`);
    if (!(isNum(m.west) && isNum(m.east) && m.west < m.east)) err(file, 'bounds must satisfy west < east');
    if (!(isNum(m.south) && isNum(m.north) && m.south < m.north)) err(file, 'bounds must satisfy south < north');
    if (!isNum(m.cols) || !isNum(m.rows)) err(file, 'missing cols/rows');
    if (!Array.isArray(m.bands) || m.bands.length !== m.rows) err(file, `bands must have ${m.rows} rows`);
    for (const [i, row] of (m.bands ?? []).entries())
      if (typeof row !== 'string' || row.length !== m.cols || !/^[0-8]+$/.test(row))
        err(file, `bands[${i}] must be ${m.cols} chars of 0-8`);
  }

  for (const name of glyphSlugs) {
    const file = resolve(edDir, 'glyphs', `${name}.json`);
    for (const finding of glyphFormatFindings(readJson(file), name)) err(rel(file), finding);
  }

  // articles
  for (const slug of articleSlugs) {
    const file = rel(resolve(articleDir, `${slug}.json`));
    const a = readJson(resolve(articleDir, `${slug}.json`));
    if (!a) continue;
    const findings = articleFormatFindings(a, { profile: 'archive', editionDate: date, articleId: slug, agentNames, personaNames, topicSlugs: validTopics, mapSlugs, glyphSlugs, previousArticles });
    for (const finding of findings.errors) err(file, `${finding.path}: ${finding.message}`);
    for (const finding of findings.warnings) warn(file, finding.message);
    if (a.art?.kind === 'map' && isStr(a.art.map)) articleMapArts.set(a.art.map, { slug, spots: a.art.spots ?? [] });
  }

  // pages
  const pagesDir = resolve(edDir, 'pages');
  const pageFeatureRefs = new Map();
  for (const f of ls(pagesDir).filter((f) => f.endsWith('.json'))) {
    const file = rel(resolve(pagesDir, f));
    const p = readJson(resolve(pagesDir, f));
    if (!p) continue;
    if (p.edition !== date) err(file, `edition "${p.edition}" does not match ${date}`);
    if (p.page !== basename(f, '.json')) err(file, `page "${p.page}" does not match filename`);
    if (!isStr(p.title)) err(file, 'missing title');
    if (!isStr(p.active)) err(file, 'missing active');
    for (const slot of ['head', 'flow']) {
      if (!Array.isArray(p[slot])) { err(file, `missing ${slot} array`); continue; }
      p[slot].forEach((b, i) => checkBlock(file, `${slot}[${i}]`, b, { date, articleSlugs, mapSlugs, glyphSlugs, articleMapArts }));
    }
    pageFeatureRefs.set(p.page, collectFeatureArticleRefs([...(p.head ?? []), ...(p.flow ?? [])]));
    if (date >= '2026-07-30' && p.page === 'front')
      checkIllustratedRuns(file, p.head);
    if (date >= '2026-08-23' && p.page === 'front')
      checkFrontIllustrationMix(file, p.head);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date >= '2026-08-14') {
    const frontRefs = pageFeatureRefs.get('front') ?? new Set();
    const tapeRefs = pageFeatureRefs.get('tape') ?? new Set();
    const repeated = [...frontRefs].filter((slug) => tapeRefs.has(slug));
    if (repeated.length > 0)
      err(rel(resolve(pagesDir, 'tape.json')), `front and tape repeat featured article(s): ${repeated.join(', ')} — assign each story to one page`);
  }
}

function collectFeatureArticleRefs(blocks, refs = new Set()) {
  for (const block of blocks ?? []) {
    if (block?.block === 'Grid') {
      for (const column of block.props?.columns ?? []) collectFeatureArticleRefs(column, refs);
      continue;
    }
    if (block?.block === 'Hero' && isStr(block.props?.lead)) refs.add(block.props.lead);
    if (block?.block === 'Teaser' && isStr(block.props?.article)) refs.add(block.props.article);
    if (block?.block === 'SplitVote') {
      for (const key of ['lead', 'splitWith']) if (isStr(block.props?.[key])) refs.add(block.props[key]);
    }
  }
  return refs;
}

function illustratedStorySide(block) {
  if (block?.block === 'Hero' && block.props?.withArt === true) return 'left';
  if (block?.block !== 'Grid' || !Array.isArray(block.props?.columns)) return null;
  const kinds = block.props.columns.map((column) => {
    const blocks = Array.isArray(column) ? column : [];
    return {
      art: blocks.some((nested) => nested?.block === 'MapGlyph' || nested?.block === 'GlyphArt'),
      story: blocks.some((nested) => nested?.block === 'Teaser'),
    };
  });
  const art = kinds.findIndex((kind) => kind.art);
  const story = kinds.findIndex((kind) => kind.story);
  if (art < 0 || story < 0 || art === story) return null;
  return art < story ? 'left' : 'right';
}

function walkBlocks(blocks, visit) {
  for (const block of blocks ?? []) {
    visit(block);
    if (block?.block === 'Grid') {
      for (const column of block.props?.columns ?? []) walkBlocks(column, visit);
    }
  }
}

function checkFrontIllustrationMix(file, blocks) {
  const hero = (blocks ?? []).find((block) => block?.block === 'Hero');
  let glyph = 0;
  walkBlocks(blocks, (block) => {
    if (block?.block === 'GlyphArt') glyph += 1;
  });
  if (hero && hero.props?.withArt !== true)
    warn(file, 'front Hero is lead-only without art — house mix is lead art + globe + one more glyph/map');
  if (glyph === 0)
    warn(file, 'front has no GlyphArt — the glyph is the signature; use a fitting roll/shape rather than a second map under a bare lead');
}

function checkIllustratedRuns(file, blocks) {
  let run = [];
  const flush = () => {
    if (run.length < 2) { run = []; return; }
    run.forEach(({ index, side }, offset) => {
      const expected = offset % 2 === 0 ? 'left' : 'right';
      if (side !== expected)
        err(file, `head[${index}] illustrated story row must place art ${expected}; adjacent runs alternate left → right`);
    });
    run = [];
  };
  for (const [index, block] of (blocks ?? []).entries()) {
    const side = illustratedStorySide(block);
    if (side) run.push({ index, side });
    else flush();
  }
  flush();
}


function checkBlock(file, path, b, refs) {
  if (!b || !isStr(b.block)) { err(file, `${path} missing block name`); return; }
  if (!BLOCKS.has(b.block))
    err(file, `${path} unknown block "${b.block}" — known: ${[...BLOCKS].join(', ')}`);
  if (b.block === 'Hero' && b.props?.art !== undefined) {
    const art = b.props.art;
    if (!art || !['MapGlyph', 'GlyphArt'].includes(art.block)) err(file, `${path}.props.art must be a MapGlyph or GlyphArt block`);
    else checkBlock(file, `${path}.props.art`, art, refs);
  }
  if (b.block === 'Grid') {
    for (const [c, col] of (b.props?.columns ?? []).entries())
      for (const [i, nested] of (Array.isArray(col) ? col : []).entries())
        checkBlock(file, `${path}.columns[${c}][${i}]`, nested, refs);
    return;
  }
  if (b.block === 'MapGlyph' && /^\d{4}-\d{2}-\d{2}$/.test(refs.date) && refs.date >= '2026-07-25' && isStr(b.props?.map)) {
    const articleArt = refs.articleMapArts.get(b.props.map);
    if (articleArt) {
      const normalized = (spots) => (spots ?? [])
        .map(({ name, lat, lon }) => ({ name, lat, lon }))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (JSON.stringify(normalized(b.props.spots)) !== JSON.stringify(normalized(articleArt.spots)))
        err(file, `${path}.spots must match article "${articleArt.slug}" art.spots for map "${b.props.map}"`);
    }
  }
  if (b.block === 'GlyphArt') for (const finding of glyphSelectionFindings(b.props)) err(file, `${path}: ${finding}`);
  checkRefs(file, path, b.props, refs);
}

// Mirrors hydrate() in PageRenderer.astro: slug-reference keys plus the
// display-name keys (`agent`, `agents[].name`) that must match a persona.
function checkRefs(file, path, props, refs) {
  if (props === null || typeof props !== 'object') return;
  if (Array.isArray(props)) { props.forEach((v, i) => checkRefs(file, `${path}[${i}]`, v, refs)); return; }
  for (const [k, v] of Object.entries(props)) {
    if ((k === 'article' || k === 'lead' || k === 'splitWith') && isStr(v)) {
      if (!refs.articleSlugs.has(v)) err(file, `${path}.${k} references missing article "${v}"`);
    } else if ((k === 'rail' || k === 'articles') && Array.isArray(v) && v.every(isStr)) {
      for (const s of v) if (!refs.articleSlugs.has(s)) err(file, `${path}.${k} references missing article "${s}"`);
    } else if (k === 'map' && isStr(v)) {
      if (!refs.mapSlugs.has(v)) err(file, `${path}.map references missing map "${v}"`);
    } else if (k === 'glyph' && isStr(v)) {
      if (!refs.glyphSlugs.has(v)) err(file, `${path}.glyph references missing glyph \"${v}\"`);
    } else if (k === 'agentSlug' && isStr(v)) {
      if (!agentSlugs.has(v)) err(file, `${path}.agentSlug references missing agent file "${v}"`);
    } else if (k === 'agentSlugs' && Array.isArray(v)) {
      for (const s of v) if (!agentSlugs.has(s)) err(file, `${path}.agentSlugs references missing agent file "${s}"`);
    } else if (k === 'agent' && isStr(v)) {
      checkAgentName(file, `${path}.agent`, v);
    } else if (k === 'agents' && Array.isArray(v)) {
      for (const [i, item] of v.entries()) {
        if (item && typeof item === 'object' && isStr(item.name)) checkAgentName(file, `${path}.agents[${i}].name`, item.name);
        checkRefs(file, `${path}.agents[${i}]`, item, refs);
      }
    } else {
      checkRefs(file, `${path}.${k}`, v, refs);
    }
  }
}

// ---- report ----------------------------------------------------------------

if (warnings.length > 0) {
  console.warn(`editorial warnings — ${warnings.length} (non-blocking):\n`);
  for (const w of warnings) console.warn(`  ⚠ ${w}`);
  console.warn('');
}
if (errors.length > 0) {
  console.error(`content validation failed — ${errors.length} error(s):\n`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log(`content OK — ${agentFiles.length} agents, ${ls(editionsDir).length} edition(s) validated.`);
