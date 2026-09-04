import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Reporters used to recall their own past work with
// `rg -l <Name> ./repos/newsroom/content/editions/*/articles/*.json` and then
// `cat` every match -- dozens of full article JSON files (body prose,
// evidence boxes, art overlays, key_numbers) pulled into the most expensive
// context of a wake just to see what they'd already covered. This script
// renders the same recall as one flat TSV per agent: date, slug, section,
// epistemic, topics, headline -- a few KB of grep-able lines instead of
// megabytes of JSON. Note: the article schema's slug field is actually
// named `id`, not `slug`; `topics` is an array joined here with commas; the
// byline lives at `byline.agents` (an array, one name per agent credited).

const COLUMNS = ['date', 'slug', 'section', 'epistemic', 'topics', 'headline'];

export function sanitizeField(value) {
  if (value === undefined || value === null || value === '') return '-';
  return String(value).replace(/[\t\r\n]+/g, ' ');
}

function isAbsent(value) {
  return value === undefined || value === null || value === '';
}

// Reads one parsed article and returns its TSV field values, the list of
// byline agents it credits, and which of the six columns were absent in the
// source (so the caller can tally and report them, rather than silently
// inventing data).
export function rowForArticle(article) {
  const rawTopics = Array.isArray(article.topics) ? article.topics : [];
  const missing = [];
  if (isAbsent(article.edition_date)) missing.push('date');
  if (isAbsent(article.id)) missing.push('slug');
  if (isAbsent(article.section)) missing.push('section');
  if (isAbsent(article.epistemic)) missing.push('epistemic');
  if (rawTopics.length === 0) missing.push('topics');
  if (isAbsent(article.headline)) missing.push('headline');

  const fields = {
    date: sanitizeField(article.edition_date),
    slug: sanitizeField(article.id),
    section: sanitizeField(article.section),
    epistemic: sanitizeField(article.epistemic),
    topics: rawTopics.length > 0 ? rawTopics.map(sanitizeField).join(',') : '-',
    headline: sanitizeField(article.headline)
  };

  const agents = Array.isArray(article.byline?.agents) ? article.byline.agents : [];
  return { fields, agents, missing };
}

export function renderAgentTsv(rows) {
  return rows.map((row) => COLUMNS.map((column) => row[column]).join('\t')).join('\n') + '\n';
}

// Newest date first; equal dates break by slug ascending. Rows with a
// missing ('-') date sort last, since they carry no real chronology.
export function compareRows(a, b) {
  if (a.date !== b.date) {
    if (a.date === '-') return 1;
    if (b.date === '-') return -1;
    return a.date < b.date ? 1 : -1;
  }
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

function findArticleFiles(repoRoot) {
  const editionsDir = resolve(repoRoot, 'content', 'editions');
  let editionEntries;
  try {
    editionEntries = readdirSync(editionsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const files = [];
  for (const edition of editionEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    const articlesDir = resolve(editionsDir, edition, 'articles');
    let articleEntries;
    try {
      articleEntries = readdirSync(articlesDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of articleEntries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name).sort()) {
      files.push(resolve(articlesDir, entry));
    }
  }
  return files;
}

// Scans every content/editions/*/articles/*.json and groups TSV rows by
// lowercased agent name. Returns per-agent rows plus a missing-field tally
// across the whole corpus, so callers can report both.
export function collectBylineRows(repoRoot) {
  const files = findArticleFiles(repoRoot);
  const byAgent = new Map();
  const missingCounts = new Map();

  for (const file of files) {
    const article = JSON.parse(readFileSync(file, 'utf8'));
    const { fields, agents, missing } = rowForArticle(article);
    for (const field of missing) missingCounts.set(field, (missingCounts.get(field) ?? 0) + 1);
    for (const agent of agents) {
      const key = agent.toLowerCase();
      if (!byAgent.has(key)) byAgent.set(key, []);
      byAgent.get(key).push(fields);
    }
  }

  for (const rows of byAgent.values()) rows.sort(compareRows);
  return { byAgent, missingCounts, articleCount: files.length };
}

export function buildBylinesTsv(repoRoot) {
  const { byAgent, missingCounts, articleCount } = collectBylineRows(repoRoot);
  const outDir = resolve(repoRoot, 'content', 'bylines');
  mkdirSync(outDir, { recursive: true });

  const written = [];
  for (const agent of [...byAgent.keys()].sort()) {
    const rows = byAgent.get(agent);
    const text = renderAgentTsv(rows);
    const path = resolve(outDir, `${agent}.tsv`);
    writeFileSync(path, text);
    written.push({ agent, path, lines: rows.length, bytes: Buffer.byteLength(text) });
  }

  return { written, missingCounts, articleCount };
}

function main() {
  const repoRoot = process.argv[2] ?? process.env.CLANK_NEWSROOM_REPO ?? resolve(import.meta.dirname, '..', '..');
  const { written, missingCounts, articleCount } = buildBylinesTsv(repoRoot);
  for (const { agent, lines, bytes } of written) {
    console.log(`content/bylines/${agent}.tsv: ${lines} lines, ${bytes} bytes`);
  }
  for (const [field, count] of missingCounts) {
    console.log(`missing ${field}: ${count} article(s)`);
  }
  console.log(`${articleCount} article file(s) scanned, ${written.length} agent file(s) written`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) main();
