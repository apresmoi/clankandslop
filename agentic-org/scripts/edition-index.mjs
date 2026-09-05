// The edition INDEX: one small file per edition that tells every agent what
// exists today and which single file to open next.
//
// It exists because reading, not writing, is where a wake's tokens go. A
// reporter used to read a 475-847 line desk file to pick one story; Spike
// re-read all six filings on every review pass (1.29M tokens in one wake).
// The rows below carry exactly the mechanical facts those reads were
// re-deriving — citation closure, reference order, source-domain spread,
// topic validity — computed once, at the moment the filing is born.
//
// Every row is one line, and every line names the one path that answers it.
// Nothing here replaces judgement; it replaces the reading that preceded it.
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { composeGateLine, composeGateStatus, editionDiversityWaiver, hasDatedForecastWithDissent } from './compose-gate.mjs';

const INDEX_VERSION = 'clank.edition-index.v1';
const EDITION_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const AGENT_IDS = ['klaxon', 'cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton', 'vesta', 'brass', 'spike', 'ledger', 'caslon', 'pressman'];
// Only personas whose name is not also an ordinary English word. "brass",
// "spike", "foreman", "graves", "ledger" and "pressman" all appear in honest
// copy ("a spike in freight rates", "the ledger the ministry publishes"), so
// matching them would flag correct filings. This check under-reports on
// purpose: Spike still reads the body, and a false flag on a clean piece
// costs a revision round, which is the exact thing this file is here to save.
const NAMED_PERSONAS = ['Klaxon', 'Cogsworth', 'Sprockett', 'Tinkerton', 'Vesta', 'Caslon'];
const PERSONA_PATTERN = new RegExp(`\\b(?:${NAMED_PERSONAS.join('|')})\\b|@(?:${AGENT_IDS.join('|')})\\b|Clank\\s*(?:&|and)\\s*Slop`, 'u');
const CITATION_PATTERN = /\[(E\d+)\]/gu;
const OPENER_STOPWORDS = new Set(['the', 'a', 'an', 'that', 'this', 'those', 'these', 'it', 'in', 'on', 'at', 'by', 'for', 'but', 'and', 'if', 'as', 'no', 'not', 'both', 'there', 'what', 'when', 'to', 'of', 'from', 'with', 'its', 'their']);

// The flags that mean a filing cannot be right, only wrong: a citation with no
// source, a reference the evidence box does not carry, a topic slug the site
// glossary will reject at build time, a persona named in the body, a single
// source domain standing in for corroboration. `rejectHardLint` in
// production-newsroom.mjs turns these into a filing-time error; it is off by
// default. Everything else is advisory and rides the F row for Spike to weigh.
export const HARD_LINT_NAMES = ['refs_subset', 'cite_missing', 'topic_unknown', 'persona_in_body', 'domains<2'];
const named = (flag, name) => flag === name || flag.startsWith(`${name}:`);
export const isHardLintFlag = (flag, names = HARD_LINT_NAMES) => names.some((name) => named(flag, name));
export const hardLintFlags = (flags, names = HARD_LINT_NAMES) => flags.filter((flag) => isHardLintFlag(flag, names));

/**
 * Reads the arming switch. Absent or "0" means off, which is the default and
 * the shipped state. "1" arms all five hard flags; a comma-separated list arms
 * exactly those, which is how this gets turned on one flag at a time.
 *
 * Four of the five (refs_subset, cite_missing, topic_unknown, persona_in_body)
 * fire on zero of the 362 published articles. `domains<2` fires on 25 of them,
 * so the archive says Spike knowingly passes single-domain pieces — arm that
 * one only after someone decides whether he should.
 */
export function armedHardLintNames(value = process.env.CLANK_FILE_ARTICLE_HARD_LINT) {
  if (value === undefined || value === '' || value === '0') return [];
  if (value === '1') return HARD_LINT_NAMES;
  const requested = value.split(',').map((name) => name.trim()).filter(Boolean);
  const unknown = requested.filter((name) => !HARD_LINT_NAMES.includes(name));
  if (unknown.length > 0) throw new Error(`CLANK_FILE_ARTICLE_HARD_LINT names no such hard lint flag: ${unknown.join(', ')} — valid names are ${HARD_LINT_NAMES.join(', ')}`);
  return requested;
}

// Field-named explanations, so a rejected filing tells the reporter which key
// of its own article object to fix rather than making it guess from a verdict.
const LINT_FIELDS = {
  refs_subset: ['article.refs', 'cites a source id that article.evidence_box does not carry as source_note.source_id'],
  refs_order: ['article.refs', 'is not in article.evidence_box order'],
  cite_missing: ['article.body', 'cites a source id that article.evidence_box does not carry'],
  cite_unused: ['article.refs', 'declares a source id the body never cites'],
  'domains<2': ['article.evidence_box', 'spans fewer than two distinct source_url domains — one domain repeated is not corroboration'],
  persona_in_body: ['article.body', 'names a newsroom persona; the byline is the only place anyone here appears'],
  topic_unknown: ['article.topics', 'is not a slug in the topic glossary'],
  openers: ['article.body', 'opens two paragraphs on the same word'],
  public_url_no_url: ['article.evidence_box', 'declares source_kind "public_url" with no resolvable source_url']
};
export function describeLintFlag(flag) {
  const [name, value] = flag.includes(':') ? [flag.slice(0, flag.indexOf(':')), flag.slice(flag.indexOf(':') + 1)] : [flag, undefined];
  const [field, message] = LINT_FIELDS[name] ?? [`article (${name})`, 'failed a mechanical check'];
  return `${field} ${message}${value === undefined ? '' : ` (${value})`}`;
}

const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
const byCitationNumber = (left, right) => (Number(left.slice(1)) || 0) - (Number(right.slice(1)) || 0) || left.localeCompare(right);
const firstWord = (paragraph) => paragraph.trim().split(/\s+/u)[0]?.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase() ?? '';
const hostnameOf = (value) => { try { return new URL(value).hostname; } catch { return ''; } };

/**
 * Deterministic mechanical checks over one filing. Pure: no clock, no disk,
 * no network. `knownTopics` is a Set of valid slugs; pass undefined to skip
 * the topic check entirely rather than guess.
 */
export function lintFiling(filing, knownTopics) {
  const flags = [];
  const notes = Array.isArray(filing?.evidence_box) ? filing.evidence_box : [];
  const noteIds = notes.map((item) => item?.source_note?.source_id).filter((value) => typeof value === 'string');
  const noteIdSet = new Set(noteIds);
  const refs = strings(filing?.refs);
  const body = strings(filing?.body);
  const text = body.join('\n');

  if (refs.some((ref) => !noteIdSet.has(ref))) flags.push('refs_subset');

  // Reference order follows the evidence box, so [E1] [E2] [E3] in the box is
  // [E1] [E2] [E3] in refs. Only refs the box actually carries are ordered —
  // an unknown ref is refs_subset's finding, not this one's.
  const known = refs.filter((ref) => noteIdSet.has(ref)).map((ref) => noteIds.indexOf(ref));
  if (known.some((position, index) => index > 0 && position < known[index - 1])) flags.push('refs_order');

  // Two citation conventions run in the archive and both are legitimate. The
  // current one gives each source note source_id "E1".."En" and cites [E1];
  // the older one keeps long source ids ("press:reuters:brent-open-interest")
  // and cites the evidence box positionally, so [E3] means the third note.
  // A slot is therefore reachable by its position label or by its own id, and
  // a citation resolves if either form lands. Reading only one convention
  // would flag several hundred correctly-sourced published articles.
  const slots = notes.map((item, index) => ({ label: `E${index + 1}`, id: item?.source_note?.source_id }));
  const cited = new Set([...text.matchAll(CITATION_PATTERN)].map((match) => match[1]));
  const reachable = new Set([...slots.map((slot) => slot.label), ...slots.map((slot) => slot.id).filter(Boolean)]);
  for (const id of [...cited].filter((id) => !reachable.has(id)).sort(byCitationNumber)) flags.push(`cite_missing:${id}`);
  const unused = slots.filter((slot) => !cited.has(slot.label) && !(slot.id && (cited.has(slot.id) || text.includes(slot.id))));
  for (const slot of unused.sort((left, right) => byCitationNumber(left.label, right.label))) flags.push(`cite_unused:${slot.label}`);

  const domains = new Set(notes.map((item) => hostnameOf(item?.source_note?.source_url)).filter(Boolean));
  if (domains.size < 2) flags.push('domains<2');

  if (PERSONA_PATTERN.test(text)) flags.push('persona_in_body');

  if (knownTopics instanceof Set) for (const slug of [...new Set(strings(filing?.topics))].filter((slug) => !knownTopics.has(slug)).sort()) flags.push(`topic_unknown:${slug}`);

  // "Varied openings" is a craft rule about rhetoric, not about the literal
  // first token: two paragraphs opening on "The" is ordinary English and
  // flagging it puts a permanent flag on six filings in ten, which is the same
  // as having no flag at all. What actually reads as a stuck rhythm is the
  // same *content* word twice, or any word three times.
  const openers = body.map(firstWord).filter(Boolean);
  const repeats = new Map();
  for (const word of openers) repeats.set(word, (repeats.get(word) ?? 0) + 1);
  if ([...repeats].some(([word, count]) => count >= 3 || (count >= 2 && !OPENER_STOPWORDS.has(word)))) flags.push('openers');

  if (notes.some((item) => item?.source_note?.source_kind === 'public_url' && !hostnameOf(item?.source_note?.source_url))) flags.push('public_url_no_url');

  return flags;
}

export const countDomains = (filing) => new Set((Array.isArray(filing?.evidence_box) ? filing.evidence_box : []).map((item) => hostnameOf(item?.source_note?.source_url)).filter(Boolean)).size;
export const countWords = (filing) => strings(filing?.body).join(' ').split(/\s+/u).filter(Boolean).length;

// ---------------------------------------------------------------------------
// Topic glossary. The research half is replacing content/topics.json reads
// with a flat content/topics.txt (`slug<TAB>name`); read whichever is present
// so this keeps working on both sides of that landing.
// ---------------------------------------------------------------------------
const contentRoot = path.resolve(import.meta.dirname, '..', '..', 'content');
let topicCache;
export async function knownTopicSlugs(root = contentRoot) {
  if (topicCache) return topicCache;
  const flat = await readFile(path.join(root, 'topics.txt'), 'utf8').catch(() => undefined);
  if (flat !== undefined) return (topicCache = new Set(flat.split('\n').map((line) => line.split('\t')[0].trim()).filter(Boolean)));
  // topics.json is `{version, note, topics: {slug: {name, blurb, aliases}}}` —
  // the same shape ops/validate-content.mjs validates articles against, so a
  // topic_unknown flag here predicts exactly the site build error later.
  const registry = await readFile(path.join(root, 'topics.json'), 'utf8').catch(() => undefined);
  if (registry !== undefined) { const parsed = JSON.parse(registry); if (parsed?.topics && typeof parsed.topics === 'object') return (topicCache = new Set(Object.keys(parsed.topics))); }
  return undefined;
}

// ---------------------------------------------------------------------------
// Reading the edition state tree.
// ---------------------------------------------------------------------------
const editionRoot = (root, edition) => {
  if (!EDITION_DATE.test(edition)) throw new Error(`edition must be an ISO date "YYYY-MM-DD", got ${JSON.stringify(edition)}`);
  return path.join(path.resolve(root), 'editions', edition);
};
const listing = async (directory) => readdir(directory).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

async function readKind(base, kind) {
  const names = (await listing(path.join(base, kind))).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(names.map(async (name) => ({ name: name.slice(0, -5), value: await readJson(path.join(base, kind, name)) })));
}

// filings/ and verdicts/ are two levels deep: <id>/<revision>.json.
async function readRevisions(base, kind) {
  const ids = (await listing(path.join(base, kind))).sort();
  const rows = [];
  for (const id of ids) {
    const names = (await listing(path.join(base, kind, id))).filter((name) => name.endsWith('.json'));
    for (const name of names.sort((left, right) => Number(left.slice(0, -5)) - Number(right.slice(0, -5)))) {
      rows.push({ id, revision: Number(name.slice(0, -5)), value: await readJson(path.join(base, kind, id, name)) });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------
const COLUMN = 68;
// One row is one line, always. 78 of the 362 published headlines carry an
// embedded newline and several decks run past a screen, so every value that
// reaches a row is flattened and bounded here rather than trusted. `|` is the
// column separator, so it cannot survive inside a cell either.
const clean = (value, limit) => {
  const text = String(value ?? '').replace(/\s+/gu, ' ').replaceAll('|', '/').trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
};
// Inline `key=value` fields: no whitespace at all, so a malformed section or
// epistemic value shifts nothing downstream of it.
const token = (value, fallback = '?') => String(value ?? '').replace(/\s+/gu, '-').replaceAll('|', '/').slice(0, 64) || fallback;
const pad = (value) => (value.length >= COLUMN ? `${value} ` : value.padEnd(COLUMN + 1));
const row = (left, ...cells) => (cells.length === 0 ? left : `${pad(left)}| ${cells.join(' | ')}`);

export function renderEditionIndex({ edition, generated, assignments, filings, verdicts, articles, desks, pages, compose }) {
  const lines = [];
  lines.push(`# ${INDEX_VERSION} edition=${edition} generated=${generated} assignments=${assignments.length} filings=${filings.length} verdicts=${verdicts.length} passed=${articles.length}`);
  // The three compose gates, before anyone spends a wake discovering them one
  // refusal at a time. A caller that did not evaluate the forecast floor gets
  // "unknown" rather than a guess.
  lines.push(composeGateLine(compose ?? composeGateStatus({ edition, passed: articles.length, desks: desks.length, forecast: undefined, waiver: undefined })));
  lines.push('# rows: A assignment · F filing · V verdict · P passed article · D desk doc · G page');
  lines.push('# read one: cat filings/<id>/<rev>.json | cat articles/<id>.json | cat verdicts/<id>/<rev>.json');
  for (const item of assignments) lines.push(row(`A ${token(item.owner)} ${token(item.id)} refs=${item.evidence_refs.length}`, clean(item.brief, 120)));
  for (const item of filings) {
    const unknown = item.flags.filter((flag) => flag.startsWith('topic_unknown:')).map((flag) => flag.slice('topic_unknown:'.length));
    const rest = item.flags.filter((flag) => !flag.startsWith('topic_unknown:'));
    lines.push(`F ${token(item.id)} rev=${item.revision} owner=${token(item.owner)} epi=${token(item.epistemic)} words=${item.words} refs=${item.refs} domains=${item.domains} topics=${unknown.length === 0 ? 'ok' : `unknown:${unknown.map((slug) => token(slug)).join(',')}`} lint=${rest.length === 0 ? 'ok' : rest.join(',')}`);
  }
  for (const item of verdicts) lines.push(`V ${token(item.id)} rev=${item.revision} ${token(item.verdict)} by=spike`);
  for (const item of articles) lines.push(row(`P ${token(item.id)} rev=${item.revision} section=${token(item.section)} epi=${token(item.epistemic)} key_numbers=${item.key_numbers}`, clean(item.headline, 120), clean(item.deck, 120)));
  for (const item of desks) lines.push(`D ${token(item.name)} keys=${item.keys}`);
  for (const item of pages) lines.push(`G ${token(item.name)} articles=${item.articles} visuals=${item.visuals} papers=${token(item.papers)} lead=${token(item.lead)}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Read the whole edition state tree and return the INDEX text. Throws if any
 * record on disk is unreadable or malformed — a half-true index is worse than
 * a failed tool call, because nobody re-reads an index they were handed.
 */
export async function buildEditionIndex(root, edition, { now = new Date(), knownTopics } = {}) {
  const base = editionRoot(root, edition);
  const topics = knownTopics === undefined ? await knownTopicSlugs() : knownTopics;
  const assignmentRecords = await readKind(base, 'assignments');
  const seen = new Map();
  for (const record of assignmentRecords) for (const item of record.value.assignments ?? []) if (!seen.has(item.id)) seen.set(item.id, item);
  const assignments = [...seen.values()].map((item) => ({ id: item.id, owner: item.owner, brief: item.brief, evidence_refs: item.evidence_refs ?? [] })).sort((left, right) => left.id.localeCompare(right.id));

  const filings = (await readRevisions(base, 'filings')).map(({ id, revision, value }) => ({
    id, revision, owner: (value.byline?.agents ?? [])[0]?.toLowerCase() ?? '?', epistemic: value.epistemic ?? '?',
    words: countWords(value), refs: strings(value.refs).length, domains: countDomains(value), flags: lintFiling(value, topics)
  }));
  const verdicts = (await readRevisions(base, 'verdicts')).map(({ id, revision, value }) => ({ id, revision, verdict: value.verdict ?? '?' }));
  const articleRecords = await readKind(base, 'articles');
  const articles = articleRecords.map(({ name, value }) => ({
    id: name, revision: value.revision ?? '?', section: value.section ?? '?', epistemic: value.epistemic ?? '?',
    key_numbers: (Array.isArray(value.key_numbers) ? value.key_numbers : []).length, headline: value.headline ?? '', deck: value.deck ?? ''
  }));
  const desks = (await readKind(base, 'desk')).map(({ name, value }) => ({ name, keys: Object.keys(value ?? {}).length }));
  const pages = (await readKind(base, 'pages')).map(({ name, value }) => ({
    name, articles: collectPageArticles(value).length, visuals: countVisuals(value),
    papers: [...new Set(walkStrings(value, 'paper'))].sort().join(',') || '-',
    lead: walkStrings(value, 'lead')[0] ?? '-'
  }));
  const compose = composeGateStatus({
    edition, passed: articles.length, desks: desks.length,
    forecast: hasDatedForecastWithDissent(articleRecords.map((item) => item.value)),
    waiver: await composeWaiverFor(base, edition)
  });
  return renderEditionIndex({ edition, generated: now.toISOString(), assignments, filings, verdicts, articles, desks, pages, compose });
}

/**
 * Which waiver, if any, applies to this edition's forecast floor.
 *
 * Prefers the one already recorded in the composed artifact — that is a durable
 * fact about the paper that shipped, readable by every agent regardless of
 * which process holds the environment variable. Before composition there is no
 * artifact, so the environment answers instead.
 *
 * A malformed environment value throws in `compose_edition`, where it is the
 * caller's problem to fix. Here it is swallowed: the index is a report, and
 * reporting the floor as unmet is both the truthful and the conservative
 * reading of an unusable waiver. Every write path regenerates this file, so a
 * throw would take down filings and verdicts that have nothing to do with it.
 */
async function composeWaiverFor(base, edition) {
  // Only the composition receipts are opened: the receipt directory collects
  // one file per tool call all day, and this runs on every one of them.
  const names = (await listing(path.join(base, 'receipts'))).filter((name) => name.startsWith('composed-') && name.endsWith('.json')).sort();
  for (const name of names) {
    const value = await readJson(path.join(base, 'receipts', name));
    const recorded = value?.kind === 'composed' && value?.edition === edition ? value.composition?.waiver : undefined;
    if (recorded?.edition === edition) return recorded;
  }
  try { return editionDiversityWaiver(edition); } catch { return undefined; }
}

// Same shapes production-newsroom.mjs already walks when it checks page
// completeness, illustration rhythm and paper diversity — mirrored here so the
// G row reports what the composer was actually held to.
const walkStrings = (value, key, out = []) => {
  if (Array.isArray(value)) { for (const item of value) walkStrings(item, key, out); return out; }
  if (!value || typeof value !== 'object') return out;
  for (const [name, item] of Object.entries(value)) { if (name === key && typeof item === 'string') out.push(item); walkStrings(item, key, out); }
  return out;
};
const countVisuals = (value) => JSON.stringify(value).match(/"block":"(?:MapGlyph|GlyphArt|Illustration|Image)"/gu)?.length ?? 0;

const collectPageArticles = (value, out = new Set()) => {
  if (Array.isArray(value)) { for (const item of value) collectPageArticles(item, out); return [...out]; }
  if (!value || typeof value !== 'object') return [...out];
  for (const [key, item] of Object.entries(value)) {
    if (['article', 'lead', 'splitWith'].includes(key) && typeof item === 'string') out.add(item);
    else if (['rail', 'articles'].includes(key)) { if (typeof item === 'string') out.add(item); if (Array.isArray(item)) for (const id of item) if (typeof id === 'string') out.add(id); }
    collectPageArticles(item, out);
  }
  return [...out];
};

/**
 * Regenerate editions/<edition>/INDEX in place. Atomic (temp file + rename)
 * and deliberately NOT idempotence-checked the way `converge` is: the index is
 * derived state that is expected to change on every write.
 *
 * This throws on any failure and its callers do not catch. That is the point:
 * an agent handed a stale index reads the wrong thing confidently, which is
 * more expensive than a tool call that failed and said so.
 */
export async function writeEditionIndex(root, edition, options = {}) {
  const base = editionRoot(root, edition);
  const text = await buildEditionIndex(root, edition, options);
  await mkdir(base, { recursive: true });
  const temporary = path.join(base, `.INDEX.tmp-${randomUUID()}`);
  await writeFile(temporary, text, { mode: 0o600 });
  try { await rename(temporary, path.join(base, 'INDEX')); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  return text;
}
