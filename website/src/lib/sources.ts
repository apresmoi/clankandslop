// How many sources a story's Record really rests on.
//
// The 2026-10-07 review: an article with E1–E10 from three publishers, several
// of them relaying the same government announcement, read as ten sources. The
// Record proves attribution, not independent corroboration. So the box now
// prints three counts, each no larger than the data can prove:
//
//   references   Record rows, E1…En
//   outlets      distinct publishers among them (one per registrable domain,
//                one per account on a social network; the paper's own
//                computations and desk records are not outlets)
//   independent  outlets left after relays are folded together. Only outlets
//                with a captured excerpt the checker found on the page count;
//                attributed reporting from a page the checker could not open
//                never does. Two outlets fold into one when an excerpt of one
//                credits the other ("RBI Governor Sanjay Malhotra said" folds
//                the Indian Express into the RBI), when excerpts from both
//                credit the same named speaker ("Rumen Radev said"), or when
//                they share a ten-word run of identical text.
//
// One relayed excerpt folds the whole outlet, so the count leans low. It is
// still a pattern match, not proof: a relay worded in a way these patterns do
// not recognise, or an unnamed briefing, is not folded. /method#sources says
// so to readers.

export interface RecordRow {
  source?: string;
  fragment?: string;
  source_note?: {
    raw_excerpt?: string;
    source_url?: string;
    source_kind?: string;
    evidence?: string;
    provenance_note?: string;
  };
}

export interface SourceCounts { references: number; outlets: number; independent: number }

// The paper's own computations and research records: Record rows, not outlets.
const IN_HOUSE = new Set(['desk', 'desk_cache', 'computed', 'record', 'Record', 'desk record', 'research record', 'desk-research', 'provided_research']);
const SOCIAL = new Set(['x.com', 'twitter.com', 't.me', 'facebook.com', 'instagram.com', 'threads.net', 'truthsocial.com', 'weibo.com', 'youtube.com', 'tiktok.com', 'bsky.app']);
// Second-level labels under a country code: bbc.co.uk is "bbc", rbi.org.in is "rbi".
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'gob', 'go', 'ne', 'or', 'nic', 'mil']);
// Domain stems too generic to name a publisher in prose.
const GENERIC = new Set(['government', 'gov', 'news', 'press', 'official', 'ministry', 'state', 'city', 'info', 'online', 'media', 'the']);

const isAttributed = (row: RecordRow) =>
  row.source_note?.evidence === 'attributed_unchecked' || /use only as attributed reporting/iu.test(String(row.source_note?.provenance_note ?? ''));
const excerptOf = (row: RecordRow) => (isAttributed(row) ? '' : String(row.source_note?.raw_excerpt ?? '').trim());

/** The publisher a Record row belongs to, or null for the paper's own records. */
export function outletKey(row: RecordRow): string | null {
  const url = row.source_note?.source_url;
  if (typeof url === 'string' && url.trim()) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    const host = parsed.hostname.toLowerCase().replace(/^(?:www\d?|m|amp|mobile)\./u, '');
    const labels = host.split('.');
    // One network under two names: twitter.com/Reuters is x.com/Reuters.
    if (labels.slice(-2).join('.') === 'twitter.com') labels.splice(-2, 2, 'x', 'com');
    if (SOCIAL.has(labels.slice(-2).join('.'))) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      const handle = (labels.slice(-2).join('.') === 'bsky.app' && parts[0] === 'profile' ? parts[1] : parts[0]) ?? '';
      return `${labels.slice(-2).join('.')}/${handle.toLowerCase().replace(/^@/u, '')}`;
    }
    const n = labels.length >= 3 && labels.at(-1)!.length === 2 && SECOND_LEVEL.has(labels.at(-2)!) ? 3 : 2;
    return labels.slice(-n)[0];
  }
  if (IN_HOUSE.has(String(row.source_note?.source_kind ?? ''))) return null;
  const label = String(row.source ?? '').trim().toLowerCase();
  return label || null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** Names a publisher goes by in prose: its labels, their initials, its domain stem. */
function aliasesOf(key: string, rows: RecordRow[]): RegExp[] {
  const out = new Set<string>();
  const acronyms = new Set<string>();
  if (!key.includes('/') && !GENERIC.has(key) && key.length >= 3) out.add(key);
  for (const row of rows) {
    const label = String(row.source ?? '').trim();
    if (!label || /\.[a-z]{2,}$/iu.test(label)) continue;
    out.add(label.replace(/^the\s+/iu, ''));
    const initials = label.split(/\s+/u).filter((w) => /^\p{Lu}/u.test(w) && !/^the$/iu.test(w)).map((w) => w[0]).join('');
    if (initials.length >= 2) acronyms.add(initials);
  }
  return [
    ...[...out].filter((a) => a.length >= 3).map((a) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(a)}(?![\\p{L}\\p{N}])`, 'iu')),
    ...[...acronyms].map((a) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(a)}(?![\\p{L}\\p{N}])`, 'u')),
  ];
}

const NAME_WORD = "(?:\\p{Lu}[\\p{L}\\p{N}.'’-]*)";
const RUN = `${NAME_WORD}(?:\\s+(?:(?:of|for|and|de|del|von|van|al|the)\\s+)?${NAME_WORD})*`;
const WHEN = '(?:\\s+(?:late\\s+|early\\s+)?on\\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(?:\\s+(?:morning|afternoon|evening|night))?)?';
const CUE = '(?:said|says|announced|stated|told|wrote|posted|confirmed|declared|reported)';
const BEFORE_CUE = new RegExp(`(${RUN})${WHEN}\\s*,?\\s+(?:has\\s+|had\\s+|have\\s+)?${CUE}(?![\\p{L}])`, 'gu');
const AFTER_CUE = new RegExp(`(?:[Aa]ccording\\s+to|(?:report|reporting|statement|announcement|interview|briefing|post)s?\\s+(?:by|from|of|with|to)|[Cc]iting|[Cc]ited\\s+by|[Rr]eported\\s+by|[Qq]uoted\\s+by|(?<![\\p{L}])(?:said|says|told))\\s+(?:(?:the|a|an)\\s+)?(${RUN})`, 'gu');
const NOT_SPEAKERS = new Set(['the', 'it', 'he', 'she', 'they', 'we', 'i', 'this', 'that', 'a', 'an', 'but', 'and', 'in', 'on', 'his', 'her', 'their', 'its',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'today', 'yesterday']);
const TITLES = new Set(['minister', 'president', 'spokesperson', 'spokesman', 'spokeswoman', 'governor', 'secretary', 'official', 'officials', 'chief', 'director', 'chairman', 'chair', 'ministry', 'office', 'department', 'agency', 'government']);

/** The named speakers an excerpt credits: "Prime Minister Rumen Radev said" → "Prime Minister Rumen Radev". */
export function creditedSpeakers(excerpt: string): string[] {
  const found: string[] = [];
  for (const pattern of [BEFORE_CUE, AFTER_CUE])
    for (const match of excerpt.matchAll(pattern)) {
      const run = match[1].replace(/^the\s+/iu, '').replace(/[.'’]+$|['’]s$/gu, '').trim();
      if (run && !NOT_SPEAKERS.has(run.toLowerCase())) found.push(run);
    }
  return found;
}

/** One key per speaker: a person's surname, an institution's whole name. */
function speakerKey(run: string): string {
  const words = run.toLowerCase().split(/\s+/u);
  const last = words.at(-1)!;
  return TITLES.has(last) || words.length === 1 ? words.join(' ') : last;
}

const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/u).filter(Boolean);
const SHARED_RUN = 10;
function shingles(text: string): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + SHARED_RUN <= w.length; i += 1) out.add(w.slice(i, i + SHARED_RUN).join(' '));
  return out;
}

/** References, outlets and independent outlets behind one story's Record. */
export function sourceCounts(rows: RecordRow[]): SourceCounts {
  const byOutlet = new Map<string, RecordRow[]>();
  for (const row of rows) {
    const key = outletKey(row);
    if (key === null) continue;
    byOutlet.set(key, [...(byOutlet.get(key) ?? []), row]);
  }
  const parent = new Map<string, string>([...byOutlet.keys()].map((k) => [k, k]));
  const find = (k: string): string => { while (parent.get(k) !== k) k = parent.get(k)!; return k; };
  const join = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  const aliases = new Map([...byOutlet].map(([key, group]) => [key, aliasesOf(key, group)]));
  const speakers = new Map<string, string>();
  const runs = new Map<string, string>();
  for (const [key, group] of byOutlet)
    for (const row of group) {
      const excerpt = excerptOf(row);
      if (!excerpt) continue;
      for (const speaker of creditedSpeakers(excerpt)) {
        const other = [...aliases].find(([k, patterns]) => k !== key && patterns.some((p) => p.test(speaker)));
        if (other) join(key, other[0]);
        // The speaker joins too: "RBI Governor Sanjay Malhotra said" and
        // "Sanjay Malhotra said" are one statement whatever the publisher match.
        const id = speakerKey(speaker);
        if (speakers.has(id)) join(key, speakers.get(id)!); else speakers.set(id, key);
      }
      for (const run of shingles(excerpt)) {
        if (runs.has(run)) join(key, runs.get(run)!); else runs.set(run, key);
      }
    }

  const evidenced = [...byOutlet].filter(([, group]) => group.some((row) => excerptOf(row))).map(([key]) => find(key));
  return { references: rows.length, outlets: byOutlet.size, independent: new Set(evidenced).size };
}

/** "12 references · 4 outlets · 3 independent". */
export function sourceLine({ references, outlets, independent }: SourceCounts): string {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  return `${n(references, 'reference', 'references')} · ${n(outlets, 'outlet', 'outlets')} · ${independent} independent`;
}
