// The Tape's numbers and deadlines, built by the paper from what the agents
// already file. Nobody lays these out by hand.
//
// Until 7 October Caslon retyped them into the decision record: a MarketsRail
// of invented tickers ("MOKHA 324 targets claimed") and a WhatToWatch list
// whose `when` column held whatever string was typed ("5 Oct 15:00 UTC",
// "12 October", "25 October"). Every figure already sat in an article's
// `key_numbers`, every promised check in its `next_update_utc` and every
// settlement date in a published call, so the page copies them instead:
//
//   KeyFigures  today's PASSed stories in the edition's own order, lead first:
//               up to three stories that filed key_numbers, up to three
//               figures each, copied verbatim in the order the writer filed
//   Deadlines   owed     the prior edition's next_update_utc promises no
//                        story today follows up (open-clocks.mjs followUps)
//               dated    today's own next checks, and every open call whose
//                        deadline is today or later, by date then time
//
// Pure: no I/O. Either block is omitted when it would be empty.

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/u;
const STATED_TIME = /\b([01]?\d|2[0-3]):([0-5]\d)\s*UTC\b/u;
const DIRS = new Set(['up', 'down', 'flat']);

export const TODAYS_NUMBERS = Object.freeze({ title: "Today's Numbers", stories: 3, figures: 3 });
export const DEADLINES_TITLE = 'The Deadlines';

/** An edition-scoped article address, as the site serves it. */
export const articleHref = (edition, id) => `/editions/${edition}/articles/${id}/`;

/** "9:05" → "09:05"; anything that is not a UTC clock → undefined. */
export const clock = (value) => {
  const m = CLOCK.exec(String(value ?? '').trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : undefined;
};

/** The clock time a call's wording states ("by 16:00 UTC on 6 October"), if any. */
export const statedTime = (call) => {
  const m = STATED_TIME.exec(String(call ?? ''));
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : undefined;
};

const figure = (entry) => (isObj(entry) && isStr(entry.value) && isStr(entry.label)
  ? { value: entry.value, label: entry.label, ...(DIRS.has(entry.dir) ? { dir: entry.dir } : {}) }
  : null);

/**
 * Today's Numbers. `order` is the decision record's placement order (lead
 * first) and `articles` today's PASSed articles keyed by slug.
 */
export function keyFiguresBlock({ edition, order, articles }) {
  const groups = [];
  for (const slug of order ?? []) {
    if (groups.length >= TODAYS_NUMBERS.stories) break;
    const article = articles?.[slug];
    const figures = (Array.isArray(article?.key_numbers) ? article.key_numbers : []).map(figure).filter(Boolean).slice(0, TODAYS_NUMBERS.figures);
    if (figures.length === 0 || !isStr(article.headline)) continue;
    groups.push({ kicker: isStr(article.kicker) ? article.kicker : article.section, headline: article.headline, href: articleHref(edition, article.id ?? slug), figures });
  }
  return groups.length > 0 ? { block: 'KeyFigures', props: { title: TODAYS_NUMBERS.title, groups } } : null;
}

const byWhen = (a, b) => a.date.localeCompare(b.date)
  // A row with no time is due by the end of its day, after the timed ones.
  || (a.time === undefined) - (b.time === undefined)
  || String(a.time ?? '').localeCompare(String(b.time ?? ''))
  || a.what.localeCompare(b.what);

/**
 * The Deadlines.
 *
 * `owed` is `followUps(previous, articles)`; `articles` today's PASSed
 * articles; `calls` the ledger history entries (ops/open-clocks.mjs
 * ledgerHistory over the prior editions and today); `agents` the persona
 * names a `who` may carry. Every date is an ISO day and every time HH:MM, so
 * nothing typed can break the columns.
 */
export function deadlinesBlock({ edition, owed = [], articles = {}, calls = [], agents = new Set() }) {
  const who = (name) => (isStr(name) && agents.has(name) ? { who: name } : {});
  const owedRows = owed
    .filter((row) => isStr(row?.headline) && isStr(row?.article) && isStr(row?.edition))
    .map((row) => ({ ...(clock(row.time) ? { time: clock(row.time) } : {}), headline: row.headline, href: articleHref(row.edition, row.article), ...who(row.who) }))
    // Filed clocks are not zero-padded ("9:00" sorts after "18:00" as text).
    .sort((a, b) => (a.time === undefined) - (b.time === undefined) || String(a.time ?? '').localeCompare(String(b.time ?? '')));
  const owedFrom = owed.find((row) => isStr(row?.edition))?.edition;

  const dated = [];
  for (const article of Object.values(articles ?? {})) {
    const time = clock(article?.next_update_utc);
    if (time === undefined || !isStr(article?.headline)) continue;
    dated.push({ date: edition, time, what: `Next check on “${article.headline.trim()}”`, ...who(article.byline?.agents?.[0]) });
  }
  for (const entry of calls) {
    if (entry?.outcome !== 'open' || !isStr(entry.deadline) || entry.deadline < edition) continue;
    const time = statedTime(entry.call);
    dated.push({ date: entry.deadline, ...(time ? { time } : {}), what: isStr(entry.headline) ? entry.headline.trim() : entry.call.trim(), ...who(entry.owner) });
  }
  const seen = new Set();
  const unique = dated.sort(byWhen).filter((row) => {
    const key = `${row.date}|${row.time ?? ''}|${row.what.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (owedRows.length === 0 && unique.length === 0) return null;
  return { block: 'Deadlines', props: { title: DEADLINES_TITLE, ...(owedRows.length > 0 ? { owed_from: owedFrom, owed: owedRows } : {}), ...(unique.length > 0 ? { dated: unique } : {}) } };
}
