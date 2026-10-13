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

import { forecastEvent, orientedProbability, directionalOutcome, eventHappened, wordingKey } from './forecast-events.mjs';
import { CALL_STATES, TERMINAL, callDeadline, callState, hasNote, mustSettle, NOTE_MIN_WORDS, SETTLE_GRACE_DAYS, shortDay } from './ledger-states.mjs';

// Calls published before this date predate the carry-forward contract. Their
// labels were never written to settle ("medium", "High", "Likely") and none of
// them was ever going to be scored; carrying them now would bury the tape in
// June. Every call from this edition on is carried until it settles.
export const LEDGER_EPOCH = '2026-09-29';

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isP = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

// A label that names no event ("high", "medium", "medium-low") is a
// confidence word, not a call: nothing could ever settle it, so it is not
// carried. Three words is the shortest real call in the archive ("48-hour
// expulsion met").
export const isCallLabel = (label) => isStr(label) && label.trim().split(/\s+/u).length >= 3;

/** The identity of a call: its published wording, whitespace and case folded. */
export const callKey = wordingKey;

const rowsOf = (settlements) => (Array.isArray(settlements?.resolved_last_edition) ? settlements.resolved_last_edition : Array.isArray(settlements) ? settlements : []);
const articlesOf = (articles) => (Array.isArray(articles) ? articles : Object.values(articles ?? {}));
const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
// The opening article's own uncertainty band and named dissent, when filed.
const pool = (article, negated) => ({
  ...(isP(article?.confidence?.interval) ? { interval: article.confidence.interval } : {}),
  ...(isStr(article?.dissent?.agent) && isP(article?.dissent?.p) ? { dissent: { agents: [article.dissent.agent], p: orientedProbability(article.dissent.p, negated) } } : {}),
});

/**
 * Every call the paper has published since `epoch`, with where it stands.
 *
 * `editions` is `[{date, settlements, articles}]`: `settlements` is that
 * edition's `ledger.settlements` document (or its rows) and `articles` its
 * article documents. A call enters the ledger from an article's `confidence`
 * block or from a settlement row, whichever comes first, and leaves `open` the
 * first time a row marks it `hit`, `miss` or `cancelled`. Each entry carries
 * the deadline its wording states, the opening article's owner and headline,
 * the forecaster's own band and dissent when that article filed them, and
 * Ledger's latest row note with its date.
 */
export function ledgerHistory(editions, { epoch = LEDGER_EPOCH } = {}) {
  const calls = new Map(), sources = new Map(), aliases = new Map();
  const ordered = [...(editions ?? [])].filter((e) => isStr(e?.date)).sort(byDate);
  const links = new Map(ordered.flatMap(e => e.settlements?.event_links ?? []).map(link => [callKey(link.call), link]));
  const identity = (call, date, metadata = {}) => {
    const known = aliases.get(callKey(call));
    if (known && (!metadata.event_id || metadata.event_id === known.event_id) && (metadata.negated === undefined || metadata.negated === known.negated)) return known;
    const event = forecastEvent(call, date, { ...links.get(callKey(call)), ...metadata });
    aliases.set(callKey(call), event);
    aliases.set(callKey(event.call), { ...event, negated: false });
    return event;
  };
  // A settlement row does not name who made the call; the article that
  // published it does, in whatever edition that was.
  for (const edition of ordered)
    for (const article of articlesOf(edition.articles))
      if (isStr(article?.confidence?.label) && isStr(article?.byline?.agents?.[0]) && !sources.has(callKey(article.confidence.label))) sources.set(callKey(article.confidence.label), { owner: article.byline.agents[0], ...(isStr(article.headline) ? { headline: article.headline.trim() } : {}) });
  for (const edition of ordered) {
    if (edition.date < epoch) continue;
    for (const article of articlesOf(edition.articles)) {
      const confidence = article?.confidence;
      if (!isCallLabel(confidence?.label) || !isP(confidence?.value)) continue;
      const event = identity(confidence.label, edition.date, confidence);
      const key = event.event_id, p = orientedProbability(confidence.value, event.negated);
      if (!calls.has(key)) calls.set(key, { event_id: key, call: event.call, prior_p: p, latest_p: p, updates: [], first_publication: { date: edition.date, call: confidence.label, p: confidence.value, negated: event.negated }, opened: edition.date, deadline: callDeadline(confidence.label, edition.date), owner: article?.byline?.agents?.[0], article: article?.id, ...(isStr(article?.headline) ? { headline: article.headline.trim() } : {}), ...pool(article, event.negated), outcome: 'open' });
      const entry = calls.get(key);
      if (event.deadline && entry.deadline && event.deadline !== entry.deadline) throw new Error('A forecast event cannot change its deadline; publish a distinct event id');
      entry.aliases = [...new Set([...(entry.aliases ?? []), callKey(confidence.label), callKey(event.call)])];
      if (entry.outcome === 'open' && (entry.opened !== edition.date || entry.article !== article.id)) {
        entry.latest_p = p;
        entry.updates.push({ date: edition.date, p, article: article.id, published_p: confidence.value, negated: event.negated });
      }
    }
    for (const row of rowsOf(edition.settlements)) {
      if (!isCallLabel(row?.call) || !isP(row?.prior_p)) continue;
      const event = identity(row.call, edition.date, row);
      const key = event.event_id, p = orientedProbability(row.prior_p, event.negated);
      if (!calls.has(key)) calls.set(key, { event_id: key, call: event.call, prior_p: p, latest_p: p, updates: [], first_publication: { date: edition.date, call: row.call, p: row.prior_p, negated: event.negated }, opened: edition.date, deadline: event.deadline, ...sources.get(callKey(row.call)), outcome: 'open' });
      const entry = calls.get(key);
      if (event.deadline && entry.deadline && event.deadline !== entry.deadline) throw new Error('A forecast event cannot change its deadline; publish a distinct event id');
      entry.aliases = [...new Set([...(entry.aliases ?? []), callKey(row.call), callKey(event.call)])];
      if (entry.outcome !== 'open') continue;
      if (isStr(row.note)) Object.assign(entry, { note: row.note.trim(), noted_on: edition.date });
      if (TERMINAL.has(row.outcome)) {
        const observed = eventHappened(row);
        const event_outcome = event.negated ? !observed : observed;
        // Complementing 50% preserves the number but reverses its YES direction.
        // Score in the first publication's wording; keep canonical inputs for Brier.
        const first = entry.first_publication;
        const publishedOutcome = first.negated ? !event_outcome : event_outcome;
        Object.assign(entry, { outcome: row.outcome === 'cancelled' ? 'cancelled' : directionalOutcome(first.p, publishedOutcome), event_outcome, settled_on: edition.date });
      }
    }
  }
  return [...calls.values()];
}

/**
 * The calls still open going into `edition`: everything published in an
 * earlier edition and not yet settled, less what today's rows settle.
 * `today` is today's `ledger.settlements` document (or rows).
 */
export function matchesEvent(entry, row) {
  return entry.aliases?.includes(callKey(row.call)) || callKey(entry.call) === callKey(row.call) || entry.event_id === forecastEvent(row.call, entry.opened, row).event_id;
}

export function carriedCalls(history, edition, today = []) {
  const settledToday = rowsOf(today).filter(row => TERMINAL.has(row?.outcome));
  return history
    .filter((entry) => entry.outcome === 'open' && entry.opened < edition && !settledToday.some(row => matchesEvent(entry, row)))
    .sort((a, b) => (a.opened < b.opened ? -1 : a.opened > b.opened ? 1 : 0));
}

/**
 * The calls a `ledger.settlements` filing for `edition` leaves out: every call
 * still open going into the edition must appear as a row, `open` if nothing on
 * the record settles it. Returns the rows to add, ready to paste.
 */
export function missingLedgerRows(history, edition, filed) {
  const present = rowsOf(filed);
  return carriedCalls(history, edition).filter((entry) => !present.some(row => matchesEvent(entry, row))).map(({ call, prior_p, event_id }) => ({ call, outcome: 'open', prior_p, event_id, negated: false }));
}

/**
 * The due calls a `ledger.settlements` filing for `edition` leaves
 * unexplained. A call whose deadline has passed is settled `hit`/`miss`/
 * `cancelled`, or stays `open` with a `note` saying what Ledger checked and
 * why it is still unresolved; an `open` row with no such note is what printed
 * three overdue calls as plain "open" on 6 October.
 */
export function dueCallFindings(history, edition, filed) {
  const rows = rowsOf(filed);
  const out = [];
  for (const entry of carriedCalls(history, edition)) {
    if (callState(entry, edition) !== 'due') continue;
    const row = rows.find(row => matchesEvent(entry, row));
    if (row === undefined || row.outcome === 'hit' || row.outcome === 'miss') continue;
    // Past its grace a note no longer holds a call open (ledger-states.mjs).
    if (row.outcome !== 'cancelled' && mustSettle(entry, edition)) { out.push({ call: entry.call, prior_p: entry.prior_p, deadline: entry.deadline ?? 'no date stated', outcome: row.outcome, must_settle: true }); continue; }
    if (hasNote(row)) continue;
    out.push({ call: entry.call, prior_p: entry.prior_p, deadline: entry.deadline ?? 'no date stated', outcome: row.outcome });
  }
  return out;
}

export { NOTE_MIN_WORDS, SETTLE_GRACE_DAYS };

/**
 * The tape's forecast table going into `edition`: every call not yet settled,
 * including the ones today's articles open, each with its state, deadline,
 * Ledger's latest note and the forecaster's own band and dissent. `history`
 * is the fold over the prior editions AND today ({date: edition, settlements:
 * today's document, articles: today's articles}).
 */
export function ledgerSnapshot(editions, edition, options) {
  const history = ledgerHistory(editions.filter(e => e.date <= edition), options);
  const rows = forecastRows(history, edition);
  const due = rows.filter(row => row.state === 'due').length;
  return { history, rows, open: rows.length, pending: rows.length - due, due, meta: `${rows.length} open call${rows.length === 1 ? '' : 's'}${due ? ` · ${due} due, awaiting verification` : ''}` };
}

export function forecastRows(history, edition) {
  return history
    .filter((entry) => entry.outcome === 'open')
    .sort((a, b) => String(a.deadline ?? '9999').localeCompare(String(b.deadline ?? '9999')) || a.opened.localeCompare(b.opened))
    .map((entry) => {
      const state = callState(entry, edition);
      const published = entry.updates?.at(-1) ?? entry.first_publication;
      // At 50%, canonical probability alone cannot retain a negated YES call.
      const yes = published ? ((published.published_p ?? published.p) >= 0.5) !== published.negated : (entry.latest_p ?? entry.prior_p) >= 0.5;
      return {
        horizon: entry.deadline ? shortDay(entry.deadline) : 'no date',
        question: entry.call,
        event_id: entry.event_id,
        call: yes ? 'YES' : 'NO',
        direction: yes ? 'bull' : 'bear',
        p: entry.latest_p ?? entry.prior_p,
        ...(entry.updates?.length ? { update: `${Math.round(entry.prior_p * 100)}% → ${Math.round(entry.latest_p * 100)}%`, updated: shortDay(entry.updates.at(-1).date) } : {}),
        state,
        state_label: CALL_STATES[state],
        detail: entry.opened < edition ? `open since ${shortDay(entry.opened)}` : `new in the ${shortDay(edition)} edition`,
        ...(state === 'due' && isStr(entry.note) ? { note: entry.note, noted: shortDay(entry.noted_on) } : {}),
        ...(isP(entry.interval) ? { interval: entry.interval } : {}),
        ...(entry.dissent ? { dissent: entry.dissent } : {}),
      };
    });
}

const shortDate = shortDay;

/**
 * The prior edition's follow-up promises: every article that printed a
 * `next_update_utc`, unless one of today's articles names it in
 * `previous_coverage` (the follow-up was filed). Each is an owed row for the
 * tape's Deadlines: `{edition, time, headline, article, who}`, where
 * `edition` is the prior edition's date, `time` the promised clock as filed
 * and `article` that story's id.
 */
export function followUps(previous, todayArticles = {}) {
  if (!isStr(previous?.date)) return [];
  const covered = new Set(articlesOf(todayArticles).flatMap((a) => (Array.isArray(a?.previous_coverage) ? a.previous_coverage : []).map((ref) => `${ref?.date}/${ref?.slug}`)));
  return articlesOf(previous.articles)
    // A forecast's next_update_utc is its same-day facts check; what it owes
    // later is its settlement, which the Deadlines already date.
    .filter((a) => a?.epistemic !== 'forecast' && isStr(a?.next_update_utc) && isStr(a?.headline) && isStr(a?.id) && !covered.has(`${previous.date}/${a.id}`))
    .sort((a, b) => String(a.next_update_utc).localeCompare(String(b.next_update_utc)) || String(a.id).localeCompare(String(b.id)))
    .map((a) => ({ edition: previous.date, time: a.next_update_utc.trim(), headline: a.headline.trim(), article: a.id, ...(isStr(a.byline?.agents?.[0]) ? { who: a.byline.agents[0] } : {}) }));
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
 * What the tape carries forward, given the decision record's own desks:
 * carried calls the tape's Open Clocks desk does not already hold are
 * appended to it. Returns `{desks, calls}`, or a refusal reason in `error`
 * when there are calls to carry and no Open Clocks desk to put them in.
 */
export function carryTape({ desks, todayRows = [], carried = [], agents = new Set() }) {
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
  return { desks: outDesks, calls };
}
