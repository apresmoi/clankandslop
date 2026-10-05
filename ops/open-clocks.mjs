// The persistent forecast ledger and the open clocks it implies.
//
// 2026-10-04 carried an open call (the IEA 100-million-barrel schedule, prior
// 0.62, deadline 16:00 UTC on 6 October) and a "next check 17:00 UTC" promise.
// 2026-10-05 carried neither, and its Track Record said the ledger opens today.
// The cause: each edition's settlement rows were lifted from the PREVIOUS
// edition's articles only, so a call lived exactly one edition past its article
// and then vanished unsettled. A ledger that forgets its open calls is not a
// ledger.
//
// The rule here: a call, once published, stays open in every later edition
// until a settlement row marks it `hit` or `miss`. The history is a pure fold
// over the published editions, so the tape, the Track Record and Ledger's own
// filing gate all read the same answer.
//
// Pure: callers read the archive (ops/ledger-archive.mjs) and pass it in.

// Calls published before this date predate the carry-forward contract. Their
// labels were never written to settle ("medium", "High", "Likely") and none of
// them was ever going to be scored; carrying them now would bury the tape in
// June. Every call from this edition on is carried until it settles.
export const LEDGER_EPOCH = '2026-09-29';

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isP = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const SETTLED = new Set(['hit', 'miss']);

// A label that names no event ("high", "medium", "medium-low") is a
// confidence word, not a call: nothing could ever settle it, so it is not
// carried. Three words is the shortest real call in the archive ("48-hour
// expulsion met").
export const isCallLabel = (label) => isStr(label) && label.trim().split(/\s+/u).length >= 3;

/** The identity of a call: its published wording, whitespace and case folded. */
export const callKey = (call) => String(call ?? '').toLowerCase().replace(/\s+/gu, ' ').trim();

const rowsOf = (settlements) => (Array.isArray(settlements?.resolved_last_edition) ? settlements.resolved_last_edition : Array.isArray(settlements) ? settlements : []);
const articlesOf = (articles) => (Array.isArray(articles) ? articles : Object.values(articles ?? {}));
const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

/**
 * Every call the paper has published since `epoch`, with where it stands.
 *
 * `editions` is `[{date, settlements, articles}]`: `settlements` is that
 * edition's `ledger.settlements` document (or its rows) and `articles` its
 * article documents. A call enters the ledger from an article's `confidence`
 * block or from a settlement row, whichever comes first, and leaves `open` the
 * first time a row marks it `hit` or `miss`.
 */
export function ledgerHistory(editions, { epoch = LEDGER_EPOCH } = {}) {
  const calls = new Map(), owners = new Map();
  const ordered = [...(editions ?? [])].filter((e) => isStr(e?.date)).sort(byDate);
  // A settlement row does not name who made the call; the article that
  // published it does, in whatever edition that was.
  for (const edition of ordered)
    for (const article of articlesOf(edition.articles))
      if (isStr(article?.confidence?.label) && isStr(article?.byline?.agents?.[0]) && !owners.has(callKey(article.confidence.label))) owners.set(callKey(article.confidence.label), article.byline.agents[0]);
  for (const edition of ordered) {
    if (edition.date < epoch) continue;
    for (const article of articlesOf(edition.articles)) {
      const confidence = article?.confidence;
      if (!isCallLabel(confidence?.label) || !isP(confidence?.value)) continue;
      const key = callKey(confidence.label);
      if (!calls.has(key)) calls.set(key, { call: confidence.label.trim(), prior_p: confidence.value, opened: edition.date, owner: article?.byline?.agents?.[0], article: article?.id, outcome: 'open' });
    }
    for (const row of rowsOf(edition.settlements)) {
      if (!isCallLabel(row?.call) || !isP(row?.prior_p)) continue;
      const key = callKey(row.call);
      if (!calls.has(key)) calls.set(key, { call: row.call.trim(), prior_p: row.prior_p, opened: edition.date, ...(owners.has(key) ? { owner: owners.get(key) } : {}), outcome: 'open' });
      const entry = calls.get(key);
      if (entry.outcome === 'open' && SETTLED.has(row.outcome)) Object.assign(entry, { outcome: row.outcome, settled_on: edition.date });
    }
  }
  return [...calls.values()];
}

/**
 * The calls still open going into `edition`: everything published in an
 * earlier edition and not yet settled, less what today's rows settle.
 * `today` is today's `ledger.settlements` document (or rows).
 */
export function carriedCalls(history, edition, today = []) {
  const settledToday = new Set(rowsOf(today).filter((row) => SETTLED.has(row?.outcome)).map((row) => callKey(row.call)));
  return history
    .filter((entry) => entry.outcome === 'open' && entry.opened < edition && !settledToday.has(callKey(entry.call)))
    .sort((a, b) => (a.opened < b.opened ? -1 : a.opened > b.opened ? 1 : 0));
}

/**
 * The calls a `ledger.settlements` filing for `edition` leaves out: every call
 * still open going into the edition must appear as a row, `open` if nothing on
 * the record settles it. Returns the rows to add, ready to paste.
 */
export function missingLedgerRows(history, edition, filed) {
  const present = new Set(rowsOf(filed).map((row) => callKey(row?.call)));
  return carriedCalls(history, edition).filter((entry) => !present.has(callKey(entry.call))).map(({ call, prior_p }) => ({ call, outcome: 'open', prior_p }));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

/**
 * The prior edition's follow-up promises: every article that printed a
 * `next_update_utc`, unless one of today's articles names it in
 * `previous_coverage` (the follow-up was filed). Each is a deadline row for
 * the tape: `{when, what, who}`.
 */
export function followUps(previous, todayArticles = {}) {
  if (!isStr(previous?.date)) return [];
  const covered = new Set(articlesOf(todayArticles).flatMap((a) => (Array.isArray(a?.previous_coverage) ? a.previous_coverage : []).map((ref) => `${ref?.date}/${ref?.slug}`)));
  return articlesOf(previous.articles)
    .filter((a) => isStr(a?.next_update_utc) && isStr(a?.headline) && !covered.has(`${previous.date}/${a.id}`))
    .sort((a, b) => String(a.next_update_utc).localeCompare(String(b.next_update_utc)) || String(a.id).localeCompare(String(b.id)))
    .map((a) => {
      const time = a.next_update_utc.trim();
      const when = /^\d{1,2}:\d{2}$/u.test(time) ? `${shortDate(previous.date)} ${time} UTC` : time;
      return { when, what: `Update owed on “${a.headline.trim()}”, promised in the ${shortDate(previous.date)} edition.`, ...(isStr(a.byline?.agents?.[0]) ? { who: a.byline.agents[0] } : {}), article: a.id };
    });
}

const tokens = (text) => new Set((String(text ?? '').toLowerCase().match(/[\p{L}\d][\p{L}\d.-]*/gu) ?? []).filter((t) => t.length >= 3 || /\d/u.test(t)));

/**
 * Whether a desk item already carries `call`: it repeats at least 60% of the
 * call's words. Caslon often restates the call in its own kicker; a carried
 * call that is already on the desk is not added twice.
 */
export function itemCarries(item, call) {
  const want = tokens(call);
  if (want.size === 0) return false;
  const have = tokens(`${item?.kicker ?? ''} ${item?.what ?? ''}`);
  let hits = 0;
  for (const token of want) if (have.has(token)) hits += 1;
  return hits / want.size >= 0.6;
}

/** A desk item for a carried call the decision record left off the desk. */
export function carriedDeskItem(entry) {
  const call = entry.call.replace(/\s*[.;]?\s*$/u, '');
  return { kicker: `Open Since ${shortDate(entry.opened)}`, agent: entry.owner, what: `${call}. Prior ${entry.prior_p.toFixed(2)}, still open.` };
}

/**
 * What the tape carries forward, given the decision record's own desks and
 * deadlines: carried calls the tape's Open Clocks desk does not already hold
 * are appended to it, the prior edition's follow-up promises lead the
 * deadlines, and the forecast ledger lists today's open rows plus every
 * carried call. Returns `{desks, watch, calls}`, or a refusal reason in
 * `error` when there are calls to carry and no Open Clocks desk to put them in.
 */
export function carryTape({ desks, watch, todayRows = [], carried = [], follow = [], agents = new Set() }) {
  const open = rowsOf(todayRows).filter((row) => row?.outcome === 'open' && isStr(row?.call) && isP(row?.prior_p));
  const calls = [...open.map((row) => ({ call: row.call, prior_p: row.prior_p }))];
  const seen = new Set(calls.map((c) => callKey(c.call)));
  for (const entry of carried) if (!seen.has(callKey(entry.call))) { seen.add(callKey(entry.call)); calls.push({ call: entry.call, prior_p: entry.prior_p, opened: entry.opened }); }

  const owned = carried.filter((entry) => isStr(entry.owner) && agents.has(entry.owner));
  const index = desks.findIndex((desk) => /^\s*open clocks\s*$/iu.test(desk.label));
  if (owned.length > 0 && index < 0)
    return { error: `${owned.length} call(s) are still open from earlier editions (${owned.map((e) => JSON.stringify(e.call.slice(0, 60))).join(', ')}) and no tape desk is labelled "Open Clocks" — label one of the three tape desks exactly "Open Clocks"; the assembler adds any carried call it does not already hold` };
  const items = desks.flatMap((desk) => [desk.lead, ...desk.rest]);
  const missing = owned.filter((entry) => !items.some((item) => itemCarries(item, entry.call)));
  const outDesks = index < 0 || missing.length === 0 ? desks : desks.map((desk, i) => (i === index ? { ...desk, rest: [...desk.rest, ...missing.map(carriedDeskItem)] } : desk));

  // Owed follow-ups fell due before anything the record schedules, so they lead.
  const outWatch = [...follow.map(({ when, what, who }) => ({ when, what, ...(isStr(who) && agents.has(who) ? { who } : {}) })), ...watch];
  return { desks: outDesks, watch: outWatch, calls };
}
