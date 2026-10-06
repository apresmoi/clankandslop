// Where a published call stands, in one of five states.
//
// On 6 October the tape still printed three calls as plain "open" whose
// windows had closed on 4, 5 and 6 October: the week of US-Iran talks, Alito
// off Suncor, the IEA schedule. Nothing said they were overdue and nothing
// said whether anyone had looked. A ledger reader cannot tell a clock still
// running from a clock nobody checked, so every call now carries exactly one
// state and the due ones carry what Ledger checked:
//
//   pending    not yet due — the deadline the call states has not arrived
//   due        due — awaiting verification: the deadline passed (or the call
//              names no date), Ledger has not settled it, and its row says
//              what was checked and why it is still unresolved
//   hit/miss   settled, from a record Ledger can name
//   cancelled  withdrawn, with the reason in the row's note
//
// The deadline is read off the call's own published wording, the only place
// the paper ever stated it. Pure: no I/O.

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;

export const CALL_STATES = Object.freeze({
  pending: 'not yet due',
  due: 'due — awaiting verification',
  hit: 'settled hit',
  miss: 'settled miss',
  cancelled: 'cancelled',
});

/** Outcomes that take a call off the open ledger. */
export const TERMINAL = new Set(['hit', 'miss', 'cancelled']);

/** The shortest note that can say what was checked and why it did not settle. */
export const NOTE_MIN_WORDS = 8;
export const hasNote = (row) => isStr(row?.note) && row.note.trim().split(/\s+/u).length >= NOTE_MIN_WORDS;

const MONTH = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const NAME = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})\\s+${NAME}\\b\\.?(?:,?\\s+(\\d{4}))?`, 'giu');
const MONTH_DAY = new RegExp(`\\b${NAME}\\.?\\s+(\\d{1,2})(?!\\d)(?:,?\\s+(\\d{4}))?`, 'giu');
const ISO_IN_TEXT = /\b(\d{4})-(\d{2})-(\d{2})\b/gu;
const HOURS = /\b(\d{1,3})[- ]hours?\b/iu;
const DAYS = /(?<![\w$])(\d{1,3})D(?!\w)/u;

const iso = (date) => date.toISOString().slice(0, 10);
const addDays = (day, n) => iso(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000));

function dated(year, month, day, opened, explicitYear) {
  if (!(day >= 1 && day <= 31) || month === undefined) return null;
  let date = new Date(Date.UTC(year, month, day));
  if (date.getUTCDate() !== day) return null;
  // A deadline the paper published is in that paper's future: "by 16 Jun"
  // printed in December means next June.
  if (!explicitYear && iso(date) < opened) date = new Date(Date.UTC(year + 1, month, day));
  return iso(date);
}

/**
 * The deadline a call's wording states, as an ISO day, or null when it names
 * none. `opened` is the edition that published it: it supplies a missing year
 * and anchors "48-hour" and "7D" horizons. A call that names several dates is
 * due after the latest of them.
 */
export function callDeadline(call, opened) {
  const text = String(call ?? '');
  if (!ISO_DAY.test(String(opened ?? ''))) return null;
  const year = Number(opened.slice(0, 4));
  const found = [];
  for (const m of text.matchAll(DAY_MONTH)) found.push(dated(m[3] ? Number(m[3]) : year, MONTH[m[2].slice(0, 3).toLowerCase()], Number(m[1]), opened, Boolean(m[3])));
  for (const m of text.matchAll(MONTH_DAY)) if (/^[A-Z]/u.test(m[0])) found.push(dated(m[3] ? Number(m[3]) : year, MONTH[m[1].slice(0, 3).toLowerCase()], Number(m[2]), opened, Boolean(m[3])));
  for (const m of text.matchAll(ISO_IN_TEXT)) found.push(dated(Number(m[1]), Number(m[2]) - 1, Number(m[3]), opened, true));
  const days = found.filter(Boolean).sort();
  if (days.length > 0) return days[days.length - 1];
  const hours = HOURS.exec(text);
  if (hours) return addDays(opened, Math.ceil(Number(hours[1]) / 24));
  const relative = DAYS.exec(text);
  if (relative) return addDays(opened, Number(relative[1]));
  return null;
}

/**
 * The state of a ledger entry (`{outcome, opened, deadline}`) going into
 * `edition`. A call is never due in the edition that publishes it; after that
 * it is due once its deadline day has passed, and at once when it names no
 * date, because then only Ledger can say whether it has arrived.
 */
export function callState(entry, edition) {
  if (TERMINAL.has(entry?.outcome)) return entry.outcome;
  if (!(String(entry?.opened ?? '') < edition)) return 'pending';
  if (!isStr(entry?.deadline)) return 'due';
  return entry.deadline < edition ? 'due' : 'pending';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-10-06" → "6 Oct". */
export const shortDay = (day) => (ISO_DAY.test(String(day ?? '')) ? `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}` : '');
