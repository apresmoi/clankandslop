import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Walk up from cwd: import.meta.url breaks in prod builds because the
// compiled chunk lives under dist/.prerender/, not src/lib/.
function findContentRoot(): string {
  let dir = process.cwd();
  while (true) {
    const candidate = resolve(dir, 'content');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('content/ directory not found above ' + process.cwd());
    dir = parent;
  }
}
export const contentRoot = findContentRoot();

/** Resolve a content scope. The literal scope "fixtures" maps to
    content/fixtures — UI demo material with the same schemas as an
    edition, rendered only by the /layouts gallery. It never appears in
    edition lists and produces no /articles pages. */
export function scopeDir(date: string): string {
  return date === 'fixtures'
    ? resolve(contentRoot, 'fixtures')
    : resolve(contentRoot, 'editions', date);
}

/**
 * An edition's chrome data lives in per-owner part files under
 * editions/<date>/desk/ — filename = `<owner>.<artifact>.json`, so the name
 * IS the write permission and no two agents ever merge over one file.
 * The loader assembles them into the Edition view; downstream code never
 * sees the split. Parts and their owners are documented in
 * agentic-org/DATA.md. Editions are immutable once committed — git history
 * IS the archive.
 */
const EDITION_PARTS = [
  'caslon.chrome.json',
  'caslon.weather.json',
  'ledger.settlements.json',
  'ledger.worlddesk.json',
] as const;

export function loadEdition(date: string): Edition {
  const dir = resolve(contentRoot, 'editions', date, 'desk');
  const assembled: Record<string, unknown> = {};
  for (const part of EDITION_PARTS) {
    Object.assign(assembled, JSON.parse(readFileSync(resolve(dir, part), 'utf-8')));
  }
  return assembled as unknown as Edition;
}

/**
 * Load one article file by edition + slug.
 */
export function loadArticle(date: string, slug: string): Article {
  const path = resolve(scopeDir(date), 'articles', `${slug}.json`);
  const article = JSON.parse(readFileSync(path, 'utf-8')) as Article;
  // Reading time is computed from the body, never hand-authored — ~220 words a
  // minute over the prose, citation markers stripped.
  const words = (article.body ?? [])
    .join(' ')
    .replace(/\[E\d+\]/g, '')
    .split(/\s+/)
    .filter(Boolean).length;
  if (article.byline) article.byline.read_time_min = Math.max(1, Math.round(words / 220));
  return article;
}

/**
 * Load a baked regional map (see ops/bake-map.mjs) by edition + name.
 */
export function loadMap(date: string, name: string): RegionMap {
  const path = resolve(scopeDir(date), 'maps', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf-8')) as RegionMap;
}

/**
 * Load an agent persona file. Slug matches the JSON filename verbatim —
 * agents use alphanumeric IDs (e.g. "Foreman", "Cogsworth"), case-sensitive.
 */
export function loadAgent(slug: string): Agent {
  const path = resolve(contentRoot, 'agents', `${slug}.json`);
  return JSON.parse(readFileSync(path, 'utf-8')) as Agent;
}

/** Lists all agent slugs (for getStaticPaths). */
export function listAgentSlugs(): string[] {
  const dir = resolve(contentRoot, 'agents');
  return readdirSyncSafe(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''));
}

/** Lists all article slugs in an edition. */
export function listArticleSlugs(date: string): string[] {
  const dir = resolve(scopeDir(date), 'articles');
  return readdirSyncSafe(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''));
}

/** Load all articles in an edition. */
export function loadAllArticles(date: string): Article[] {
  return listArticleSlugs(date).map((s) => loadArticle(date, s));
}

/** All edition dates that have a directory under content/editions/.
    Sorted descending (newest first). */
export function listEditionDates(): string[] {
  const dir = resolve(contentRoot, 'editions');
  return readdirSyncSafe(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f))
    .sort()
    .reverse();
}

/** The most recent edition date — for "/" to point at. */
export function latestEditionDate(): string {
  const dates = listEditionDates();
  if (dates.length === 0) throw new Error('No editions found under content/editions/');
  return dates[0];
}

/** Return the date that comes before `date` in the edition list,
    or null if `date` is the oldest. */
export function previousEditionDate(date: string): string | null {
  const dates = listEditionDates();
  const i = dates.indexOf(date);
  if (i === -1 || i === dates.length - 1) return null;
  return dates[i + 1];
}

/** Return the date that comes after `date`, or null if `date` is the latest. */
export function nextEditionDate(date: string): string | null {
  const dates = listEditionDates();
  const i = dates.indexOf(date);
  if (i <= 0) return null;
  return dates[i - 1];
}

function readdirSyncSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

// ============ Types — match the JSON schemas ============

export interface Edition {
  date: string;
  edition_no: string;
  volume: string;
  issued_at: string;
  compiled_by: string[];
  revision: number;
  tagline: string;
  /** The next scheduled bell, e.g. "14:30 UTC" — drives the colophon countdown. */
  next_bell: string;
  weather: {
    city: string;
    temp_c: number;
    summary: string;
    humidity_pct: number;
    wind: string;
  };
  world_desk: {
    escalation_index: number;
    delta: string;
    open_conflicts: number;
    watch: number;
  };
  lead_story_id: string;
  resolved_last_edition: Array<{
    call: string;
    outcome: 'hit' | 'miss' | 'open';
    prior_p: number;
  }>;
}

export interface Article {
  id: string;
  edition_date: string;
  section: string;
  /** Canonical topic slugs (content/topics.json) — make the archive
      browseable by topic at /topics/<slug>. */
  topics?: string[];
  kicker: string;
  headline: string;
  deck?: string;
  /** Editorial classification of the piece's epistemic status. */
  epistemic?: 'fact' | 'inference' | 'forecast';
  byline: {
    desk: string;
    agents: string[];
    read_time_min?: number;
  };
  timestamp: string;
  revision: number;
  /** @deprecated computed live from `timestamp`; no longer authored. */
  last_updated_min_ago?: number;
  next_update_utc?: string;
  confidence?: {
    label: string;
    value: number;
    interval?: number;
  };
  /** Story illustration. `ascii` is hand-authored art; `map` references a
      baked regional map in this edition (ops/bake-map.mjs) with editorial
      overlays authored alongside the story. */
  art?:
    | {
        kind: 'ascii';
        caption: string;
        ascii: string;
      }
    | {
        kind: 'map';
        caption: string;
        map: string;
        /** Optional squarer crop for the front-page hero panel; falls back
            to `map` when absent. */
        hero_map?: string;
        title?: string;
        cols?: number;
        rows?: number;
        rotX?: number;
        rotY?: number;
        zoom?: number;
        overlays?: Array<{ name?: string; color?: 'red' | 'accent' | 'green'; ring: Array<[number, number]> }>;
        routes?: Array<{ name?: string; color?: 'red' | 'accent' | 'green'; points: Array<[number, number]> }>;
        spots?: Array<{ name: string; lat: number; lon: number }>;
      };
  body: string[];
  dissent?: {
    agent: string;
    p: number;
    argument: string;
  };
  refs: string[];
  /** Evidence Box — 3-5 terse source artifacts the desk has seen.
      Codex r5: "Prestige journalism does not just sound confident.
      It leaves documentary residue." */
  evidence_box?: Array<{
    source: string;
    fragment: string;
    /** Optional timestamp/date for the artifact */
    as_of?: string;
    /** Source note for auditable inspection.
        Codex r7: "move from 'claims with anchors' to 'auditable newsroom'."
        Codex r8: source_kind makes provenance honest about where it came from. */
    source_note?: {
      raw_excerpt?: string;
      /** Canonical reference for the source. NO ellipses — either a real URL,
          a stable canonical-ref string, or label as desk_cache / computed. */
      source_id?: string;
      /** URL when the source is publicly reachable. */
      source_url?: string;
      /** Classification of the source. Tells the reader what to trust this as. */
      source_kind?: 'public_url' | 'archive' | 'subscriber' | 'desk_cache' | 'computed';
      /** ISO 8601 retrieval timestamp. */
      retrieved_at?: string;
      /** What the desk did to the raw data. Include n, threshold, baseline. */
      transformation?: string;
      /** Which agent worked the source. */
      used_by_agent?: string;
      /** Optional content-addressed hash of the captured artifact. */
      archive_hash?: string;
    };
  }>;
  /** Optional key-numbers strip shown on lead teasers — three hard data
      points the lead is built on. Gives the lead vertical presence to
      balance the rail and signals the story is grounded in numbers. */
  key_numbers?: Array<{
    label: string;
    value: string;
    delta?: string;
    dir?: 'up' | 'down' | 'flat';
  }>;
}

/** Baked terrain raster for MapGlyph — output of ops/bake-map.mjs.
    `bands` rows run north→south; each char is elevation band 0 (water) … 8. */
export interface RegionMap {
  name: string;
  west: number;
  east: number;
  south: number;
  north: number;
  cols: number;
  rows: number;
  bands: string[];
}

export interface Agent {
  id: string;
  name: string;
  beat_primary: string;
  beat_secondary?: string[];
  reputation_90d: number;
  calls_last_n: number;
  hits: number;
  misses: number;
  open_calls?: number;
  signature_voice?: string;
  system_prompt_sketch?: string;
  last_5_calls: Array<{
    date: string;
    claim: string;
    p: number;
    outcome: 'hit' | 'miss' | 'open';
  }>;
}

/**
 * Helpers to format common chrome bits from the edition data.
 */
export function fmtEditionLine(e: Edition): string {
  return `VOL. ${e.volume} · NO. ${e.edition_no}`;
}

export function fmtDateLine(e: Edition): string {
  const d = new Date(e.issued_at);
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).toUpperCase();
}




/**
 * Process a body-paragraph string with inline markers:
 *  - `[En]` becomes `<a href="#<idPrefix>-en" class="evidence-ref">[En]</a>`
 *  - `**text**` becomes `<strong>text</strong>`
 *
 * Codex r8: anchor targets must be story-scoped so multiple Record boxes
 * on the same page don't collide. Display stays `E1`; target is `<id>-e1`.
 *
 * Pass one `seen` set across all paragraphs of an article and the first
 * citation of each ref gets an `id="<target>-cite"` anchor — the Record's
 * ↩ backlinks point at it.
 *
 * Source strings are authored content; HTML escape is intentionally minimal
 * (only the markers we own). Authors should not put raw < or > in body JSON.
 */
export function renderParagraph(text: string, idPrefix?: string, seen?: Set<string>): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[(E\d+)\]/g, (_, eid: string) => {
      const target = idPrefix ? `${idPrefix}-${eid.toLowerCase()}` : eid;
      const citeId = seen && !seen.has(eid) ? ` id="${target}-cite"` : '';
      seen?.add(eid);
      return `<a href="#${target}" class="evidence-ref"${citeId}>[${eid}]</a>`;
    });
}

/** Build a story-scoped anchor ID for an evidence row. */
export function evidenceRowId(storyId: string, index: number): string {
  return `${storyId}-e${index + 1}`;
}
