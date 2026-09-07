import { ARTICLE_FORMAT_VERSION, ARTICLE_REPORTER_NAMES, articleFilingSchema, articleArchiveSchema, schemaFindings } from './article-format-schema.mjs';
import { proseLintFindings } from './prose-lint.mjs';
export { ARTICLE_FORMAT_VERSION, ARTICLE_REPORTER_NAMES, articleFilingSchema };

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const rows = (value) => Array.isArray(value) ? value : [];
const set = (value) => value instanceof Set ? value : Array.isArray(value) ? new Set(value) : undefined;
const strings = (value) => rows(value).filter((item) => typeof item === 'string');
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const date = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const httpUrl = (value) => { try { const url = new URL(value); return typeof value === 'string' && /^https?:\/\//u.test(value) && ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password && !/\s/u.test(value); } catch { return false; } };
const ARCHIVE_SCHEMA = articleArchiveSchema();
const NON_PUBLIC_KINDS = new Set(['provided_research', 'desk', 'desk_cache', 'record', 'Record', 'desk record', 'research record', 'desk-research', 'computed']);
const DESK_PHRASES = ['Hardware Desk', 'Escalation Desk', 'Macro Desk', 'Commodities Desk', 'Policy Desk'];

/** Pure format preflight. It does not authenticate evidence or check assignment/revision lineage. */
export function articleFormatFindings(article, context = {}) {
  const profile = context.profile ?? 'filing';
  const strict = profile === 'filing';
  const errors = schemaFindings(article, strict ? articleFilingSchema : ARCHIVE_SCHEMA);
  const warnings = [];
  const add = (path, code, message) => errors.push({ path: `article.${path}`, code, message });
  if (!['filing', 'archive'].includes(profile)) errors.push({ path: 'context.profile', code: 'context', message: 'must be filing or archive' });
  if (!isObject(article)) return { errors, warnings };
  const a = article;
  if (context.editionDate !== undefined && a.edition_date !== context.editionDate) add('edition_date', 'edition', `must equal ${context.editionDate}`);
  if (context.articleId !== undefined && a.id !== context.articleId) add('id', 'id', `must equal ${context.articleId}`);
  if (strict && !date(a.edition_date)) add('edition_date', 'date', 'must be a real calendar date YYYY-MM-DD');
  if (strict && Object.hasOwn(a, 'dissent')) add('dissent', 'authority', 'is not yours to write; the colleague records it with record_dissent');
  const agentNames = set(context.agentNames) ?? new Set(Object.values(ARTICLE_REPORTER_NAMES));
  for (const [i, name] of rows(a.byline?.agents).entries()) if (!agentNames.has(name)) add(`byline.agents[${i}]`, 'byline', `must name a canonical agent, got ${JSON.stringify(name)}`);
  if (strict && context.owner !== undefined && (rows(a.byline?.agents).length !== 1 || a.byline.agents[0] !== ARTICLE_REPORTER_NAMES[context.owner])) add('byline.agents', 'authority', `must contain only the filing agent ${JSON.stringify(ARTICLE_REPORTER_NAMES[context.owner] ?? context.owner)}`);
  if (strict && context.forecastRequired && a.epistemic !== 'forecast') add('epistemic', 'forecast', 'must be "forecast" for the forecast assignment');
  if (strict && (a.epistemic === 'forecast' || context.forecastRequired) && !isObject(a.confidence)) add('confidence', 'forecast', 'must contain label and numeric value in [0, 1] for a forecast');
  const topicSlugs = set(context.topicSlugs);
  if (strict && !topicSlugs) errors.push({ path: 'context.topicSlugs', code: 'context', message: 'the trusted topic registry is required' });
  for (const [i, topic] of rows(a.topics).entries()) if (topicSlugs && !topicSlugs.has(topic)) add(`topics[${i}]`, 'topic_unknown', `topic ${JSON.stringify(topic)} is not in the glossary`);
  const priorArticles = set(context.previousArticles);
  for (const [i, prior] of rows(a.previous_coverage).entries()) {
    if (!isObject(prior)) continue;
    if (!date(prior.date)) add(`previous_coverage[${i}].date`, 'date', 'must be a real calendar date');
    if (typeof prior.date === 'string' && prior.date >= a.edition_date) add(`previous_coverage[${i}].date`, 'previous_coverage', 'must reference an earlier edition');
    if (priorArticles && !priorArticles.has(`${prior.date}/${prior.slug}`)) add(`previous_coverage[${i}]`, 'previous_coverage', `references missing article ${prior.date}/${prior.slug}`);
  }
  const box = rows(a.evidence_box);
  const recordIds = new Set(box.map((row) => row?.source_note?.source_id).filter(isText));
  for (const [i, ref] of rows(a.refs).entries()) if (!recordIds.has(ref)) add(`refs[${i}]`, 'refs_subset', `ref ${JSON.stringify(ref)} has no Record row`);
  const cited = new Set();
  const personaNames = set(context.personaNames) ?? new Set([...Object.values(ARTICLE_REPORTER_NAMES), 'Spike', 'Brass', 'Ledger', 'Morgue', 'Caslon', 'Klaxon', 'Pressman']);
  for (const [i, para] of rows(a.body).entries()) {
    if (typeof para !== 'string') continue;
    if (strict && /[<>]/u.test(para)) add(`body[${i}]`, 'raw_markup', 'must not contain raw < or >; the renderer supports prose, **bold** and positional [En] citations');
    if (strict) for (const match of para.matchAll(/\bs-[0-9a-f]{8}\b/gu)) add(`body[${i}]`, 'private_id_in_body', `prints private research id ${match[0]}; keep it in source_note.source_id and cite the row by position`);
    for (const match of para.matchAll(/\[E(\d+)\]/gu)) {
      const n = Number(match[1]);
      if (n < 1 || n > box.length || (strict && match[1] !== String(n))) add(`body[${i}]`, 'cite_missing', `cites [E${match[1]}] but evidence_box has ${box.length} positional rows`);
      else cited.add(n);
    }
    for (const name of personaNames) if (typeof name === 'string' && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'u').test(para)) add(`body[${i}]`, 'persona_in_body', `self-references newsroom persona ${name}`);
    for (const phrase of DESK_PHRASES) if (para.includes(phrase)) add(`body[${i}]`, 'persona_in_body', `self-references newsroom desk ${phrase}`);
  }
  if (strict) {
    const seen = new Set();
    for (const [i, row] of box.entries()) {
      const note = row?.source_note;
      if (!isObject(note)) continue;
      const p = `evidence_box[${i}].source_note`;
      if (context.owner !== undefined && note.used_by_agent !== ARTICLE_REPORTER_NAMES[context.owner]) add(`${p}.used_by_agent`, 'attribution', `must name the consuming filing agent ${JSON.stringify(ARTICLE_REPORTER_NAMES[context.owner] ?? context.owner)}; this field does not identify who fetched the source`);
      if (seen.has(note.source_id)) add(`${p}.source_id`, 'duplicate', 'must identify one Record row only');
      seen.add(note.source_id);
      if (typeof note.source_id === 'string' && /^E\d+$/u.test(note.source_id) && note.source_id !== `E${i + 1}`) add(`${p}.source_id`, 'citation_position', `citation-shaped id must be E${i + 1} for this row; preserve corpus provenance IDs without using them as body citation aliases`);
      if (note.source_url !== undefined && !httpUrl(note.source_url)) add(`${p}.source_url`, 'source_url', 'must be an absolute HTTP(S) URL without credentials or whitespace');
      if (note.source_url === undefined && (!NON_PUBLIC_KINDS.has(note.source_kind) || !isText(note.provenance_note))) add(`${p}.source_url`, 'source_url', 'is required for public evidence; an internal research record instead needs an honest internal source_kind and provenance_note');
      if (typeof note.retrieved_at === 'string' && !date(note.retrieved_at) && !(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(note.retrieved_at) && Number.isFinite(Date.parse(note.retrieved_at)))) add(`${p}.retrieved_at`, 'date', 'must be a retrieval date or ISO timestamp with timezone');
      if (!cited.has(i + 1)) warnings.push({ path: `article.evidence_box[${i}]`, code: 'cite_unused', message: `row E${i + 1} has no citation/backlink in body` });
    }
  }
  if (a.dissent && isObject(a.dissent) && !agentNames.has(a.dissent.agent)) add('dissent.agent', 'byline', 'must name a canonical agent');
  checkAssets(a, context, add);
  for (const finding of proseLintFindings({ ...a, body: strings(a.body), headline: typeof a.headline === 'string' ? a.headline : '', deck: typeof a.deck === 'string' ? a.deck : '' })) warnings.push({ path: 'article', code: finding.flag ?? 'prose', message: finding.message });
  return { errors, warnings };
}

function checkAssets(a, context, add) {
  const maps = set(context.mapSlugs), glyphs = set(context.glyphSlugs);
  for (const [i, item] of rows(a.body).entries()) if (isObject(item) && glyphs && !glyphs.has(item.glyph)) add(`body[${i}].glyph`, 'asset', `references missing glyph ${JSON.stringify(item.glyph)}`);
  const art = a.art;
  if (!isObject(art)) return;
  if (art.kind === 'ascii') {
    if (!isText(art.ascii) && !isText(art.shape)) add('art', 'asset', 'requires ascii text or a committed shape');
    if (art.roll === 'eclipse' && art.shape !== 'eclipse') add('art.roll', 'asset', 'eclipse roll requires shape eclipse');
  }
  if (art.kind === 'map') {
    if (!isText(art.map)) add('art.map', 'asset', 'is required for map art');
    for (const key of ['map', 'hero_map']) if ((key === 'map' || art[key] !== undefined) && maps && !maps.has(art[key])) add(`art.${key}`, 'asset', `references missing map ${JSON.stringify(art[key])}`);
  }
}
