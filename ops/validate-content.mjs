// Content gate for the autonomous newsroom: every edition, article, page and
// agent persona must pass before `astro build` runs (locally and in CI).
// Reference integrity rules mirror PageRenderer.astro's hydrate() — keep the
// BLOCKS set and REF KEYS in sync with the registry there.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contentRoot = resolve(root, 'content');

const BLOCKS = new Set([
  'Hero', 'Teaser', 'DeskNote', 'Briefly', 'WhatToWatch',
  'SplitVote', 'ForecastLedger', 'TrackRecord', 'MarketsRail',
  'AgentRoster', 'AgentCard', 'Divider', 'WorldGlyph', 'MapGlyph', 'WorldIndex', 'RankBars', 'SectionHeader', 'Grid',
]);

const EPISTEMIC = new Set(['fact', 'inference', 'forecast']);
const OUTCOMES = new Set(['hit', 'miss', 'open']);
const KEYNUM_DIRS = new Set(['up', 'down', 'flat']);

const errors = [];
const err = (file, msg) => errors.push(`${file}: ${msg}`);

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
  if (isStr(a.name)) agentNames.add(a.name);
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

for (const { date, dir: edDir, desk } of scopes) {
  const articleDir = resolve(edDir, 'articles');
  const articleSlugs = new Set(
    ls(articleDir).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')),
  );

  // edition chrome — per-owner part files under desk/. Filename = owner +
  // artifact; the set must be complete and assemble into the Edition view.
  if (desk) {
  const EDITION_PARTS = [
    'caslon.chrome.json',
    'caslon.weather.json',
    'ledger.settlements.json',
    'ledger.worlddesk.json',
  ];
  const deskDir = resolve(edDir, 'desk');
  const edFile = rel(deskDir);
  let ed = {};
  for (const part of EDITION_PARTS) {
    const p = readJson(resolve(deskDir, part));
    if (p === null) { err(`${edFile}/${part}`, 'missing edition part'); ed = null; break; }
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

  // articles
  for (const slug of articleSlugs) {
    const file = rel(resolve(articleDir, `${slug}.json`));
    const a = readJson(resolve(articleDir, `${slug}.json`));
    if (!a) continue;
    if (a.id !== slug) err(file, `id "${a.id}" does not match filename`);
    if (a.edition_date !== date) err(file, `edition_date "${a.edition_date}" does not match edition ${date}`);
    for (const k of ['section', 'kicker', 'headline', 'timestamp'])
      if (!isStr(a[k])) err(file, `missing ${k}`);
    if (a.epistemic !== undefined && !EPISTEMIC.has(a.epistemic))
      err(file, 'epistemic must be fact|inference|forecast');
    if (!a.byline || !isStr(a.byline.desk)) err(file, 'missing byline.desk');
    if (!Array.isArray(a.byline?.agents) || a.byline.agents.length === 0)
      err(file, 'byline.agents must be a non-empty array');
    for (const name of a.byline?.agents ?? []) checkAgentName(file, 'byline.agents', name);
    if (!isNum(a.revision)) err(file, 'revision must be a number');
    if (!Array.isArray(a.body) || a.body.length === 0 || !a.body.every(isStr))
      err(file, 'body must be a non-empty array of strings');
    if (!Array.isArray(a.refs)) err(file, 'missing refs array');
    if (a.confidence && !isP(a.confidence.value)) err(file, 'confidence.value must be in [0,1]');
    if (a.dissent) {
      checkAgentName(file, 'dissent.agent', a.dissent.agent);
      if (!isP(a.dissent.p)) err(file, 'dissent.p must be in [0,1]');
      if (!isStr(a.dissent.argument)) err(file, 'dissent.argument must be a non-empty string (the component renders this field)');
    }
    for (const [i, k] of (a.key_numbers ?? []).entries()) {
      if (!isStr(k.label) || !isStr(k.value)) err(file, `key_numbers[${i}] missing label/value`);
      if (k.dir !== undefined && !KEYNUM_DIRS.has(k.dir)) err(file, `key_numbers[${i}].dir must be up|down|flat`);
    }
    if (a.art) {
      if (a.art.kind === 'ascii') {
        if (!isStr(a.art.ascii)) err(file, 'art.ascii must be a string');
      } else if (a.art.kind === 'map') {
        if (!mapSlugs.has(a.art.map)) err(file, `art.map references missing map "${a.art.map}"`);
        if (a.art.hero_map !== undefined && !mapSlugs.has(a.art.hero_map))
          err(file, `art.hero_map references missing map "${a.art.hero_map}"`);
      } else {
        err(file, 'art.kind must be ascii|map');
      }
      if (!isStr(a.art.caption)) err(file, 'art.caption is required');
    }
    const box = a.evidence_box ?? [];
    for (const [i, e] of box.entries())
      if (!isStr(e.source) || !isStr(e.fragment)) err(file, `evidence_box[${i}] missing source/fragment`);
    // References must reference: every ref resolves to a Record row.
    const recordIds = new Set(box.map((e) => e.source_note?.source_id).filter(Boolean));
    for (const r of a.refs ?? [])
      if (!recordIds.has(r)) err(file, `ref "${r}" has no Record row — references must reference`);
    // every [En] marker in body must land on an evidence_box row
    for (const para of Array.isArray(a.body) ? a.body : [])
      for (const m of String(para).matchAll(/\[E(\d+)\]/g)) {
        const n = Number(m[1]);
        if (n < 1 || n > box.length)
          err(file, `body cites [E${n}] but evidence_box has ${box.length} entries`);
      }
    // topics (optional) must resolve to the glossary
    if (a.topics !== undefined) {
      if (!Array.isArray(a.topics)) err(file, 'topics must be an array of slugs');
      else for (const t of a.topics)
        if (!validTopics.has(t)) err(file, `topic "${t}" not in content/topics.json glossary`);
    }
  }

  // pages
  const pagesDir = resolve(edDir, 'pages');
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
      p[slot].forEach((b, i) => checkBlock(file, `${slot}[${i}]`, b, { articleSlugs, mapSlugs }));
    }
  }
}


function checkBlock(file, path, b, refs) {
  if (!b || !isStr(b.block)) { err(file, `${path} missing block name`); return; }
  if (!BLOCKS.has(b.block))
    err(file, `${path} unknown block "${b.block}" — known: ${[...BLOCKS].join(', ')}`);
  if (b.block === 'Grid') {
    for (const [c, col] of (b.props?.columns ?? []).entries())
      for (const [i, nested] of (Array.isArray(col) ? col : []).entries())
        checkBlock(file, `${path}.columns[${c}][${i}]`, nested, refs);
    return;
  }
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

if (errors.length > 0) {
  console.error(`content validation failed — ${errors.length} error(s):\n`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log(`content OK — ${agentFiles.length} agents, ${ls(editionsDir).length} edition(s) validated.`);
