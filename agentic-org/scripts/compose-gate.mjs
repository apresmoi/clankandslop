// The compose gates, in one place, so they can be read before they are hit.
//
// The INDEX and composition share the existing article, desk and coverage
// floors. `ready` means a full paper: the early handoff to Caslon. `partial`
// means at least one piece passed: the edition composes at the compose
// deadline with what it has, and a piece that passes later joins it. `blocked`
// means nothing passed, and a day with nothing passed stays unpublished.
// Composition still checks authentic reviews, unchanged filings, layout and
// artifacts.
//
// The forecast and the dissent are counted here, never refused: the forecast
// shape is enforced at `file_article` for the assignment Brass marked
// `slot: "forecast"`, and the dissent is recorded by the dissenter through
// `record_dissent`. A day nobody dissents ships, and the INDEX, the receipt and
// the audit say so. (A refusal here once fired at a time only Brass and a
// reporter could act on, and was waived every night.) Coverage is now counted
// the same way: a short paper cannot span three sections, and it still ships.

// Declared once in ops/edition-floor.mjs and re-exported here so every existing
// caller of this module keeps working. Do not restate the numbers.
export { PASSED_ARTICLES_MINIMUM, FULL_EDITION_ARTICLES, DESK_DOCUMENTS_REQUIRED } from '../../ops/edition-floor.mjs';
import { PASSED_ARTICLES_MINIMUM, FULL_EDITION_ARTICLES, DESK_DOCUMENTS_REQUIRED } from '../../ops/edition-floor.mjs';
const COVERAGE_RULES = Object.freeze({
  sections: { required: 3, label: 'distinct sections', names: true },
  // Moves with a full paper: the point is enough desks to be a paper, not the
  // full roster filing. Four passed articles cannot come from fewer than four
  // bylines without one desk filing twice, which keeps a paper from `ready`.
  owners: { required: FULL_EDITION_ARTICLES, label: 'distinct byline agents', names: true },
  sources: { required: 3, label: 'distinct evidence sources' },
  domains: { required: 3, label: 'distinct source_url domains' }
});

export function compositionCoverage(articles) {
  return {
    sections: [...new Set(articles.map(article => article.section))],
    owners: [...new Set(articles.map(article => article.byline?.agents?.[0]))],
    sources: [...new Set(articles.flatMap(article => article.evidence_box.map(item => item.source)))],
    domains: [...new Set(articles.flatMap(article => article.evidence_box.map(item => {
      try { return new URL(item.source_note?.source_url).hostname; } catch { return ''; }
    })).filter(Boolean))]
  };
}

const coverageGates = coverage => Object.fromEntries(Object.entries(COVERAGE_RULES).map(([key, rule]) => {
  const found = Array.isArray(coverage?.[key]) ? coverage[key].length : undefined;
  return [key, { found, required: rule.required, ok: Number.isInteger(found) && found >= rule.required }];
}));

// One article's own claim to being the day's forecast: `epistemic` says so and
// `next_update_utc` names the clock the call will be looked at again on. This
// is reported, never enforced — `file_article` is where the shape binds, and
// it additionally requires `confidence.value`, which it can demand because the
// reporter is still awake to supply it.
export const isDatedForecast = (value) => value?.epistemic === 'forecast' && /^\d{2}:\d{2}$/u.test(value?.next_update_utc ?? '');

// One article carrying a colleague's recorded dissent. `agent` is the persona
// display name `record_dissent` stamped from the dissenter's own MCP process;
// an article can never have written it itself, because `file_article` refuses
// an author-typed `dissent` outright.
export const hasNamedDissent = (value) => Boolean(value?.dissent?.agent);

/**
 * The state of the compose gates for one edition.
 *
 * `forecasts` and `dissents` are counts over the PASSed article set, or
 * `undefined` when that set could not be read — reported as "?" rather than
 * guessed at. Neither can block. Unmeasured coverage is unknown and cannot
 * advertise a full paper.
 */
export function composeGateStatus({ edition, passed, desks, forecasts, dissents, coverage }) {
  const passedGate = { found: passed, required: FULL_EDITION_ARTICLES, ok: passed >= FULL_EDITION_ARTICLES };
  const deskGate = { found: desks, required: DESK_DOCUMENTS_REQUIRED, ok: desks === DESK_DOCUMENTS_REQUIRED };
  const measured = coverageGates(coverage);
  const full = passedGate.ok && deskGate.ok && Object.values(measured).every(gate => gate.ok);
  return { edition, passed: passedGate, desks: deskGate, coverage: measured, forecasts, dissents, state: full ? 'ready' : passed >= PASSED_ARTICLES_MINIMUM ? 'partial' : 'blocked' };
}

// The Berlin clock every newsroom schedule runs on. Caslon's compose wake is
// the deadline a partial edition waits for; the late-addition window is how
// long a published edition still takes a piece that passes after it, and is
// the end of the evening recovery commissions (clankandslop-private
// automation/host/recover-edition.mjs DEFAULT_CUTOFF), so the two agree.
export const COMPOSE_DEADLINE = '16:00';
export const LATE_ADDITION_CUTOFF = '23:00';
const berlin = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function berlinClock(now = new Date()) {
  const parts = Object.fromEntries(berlin.formatToParts(now).map(({ type, value }) => [type, value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
export const isPastEdition = (edition, now = new Date()) => edition < berlinClock(now).date;
export const composeDue = (edition, now = new Date()) => { const clock = berlinClock(now); return edition < clock.date || (edition === clock.date && clock.time >= COMPOSE_DEADLINE); };
export const lateAdditionOpen = (edition, now = new Date()) => { const clock = berlinClock(now); return edition === clock.date && clock.time < LATE_ADDITION_CUTOFF; };

/**
 * What a newly passed piece means for composition, given the gate status, whether
 * the edition is already composed, and whether the host proved it is on main.
 *
 * - `blocked`: nothing has passed.
 * - `closed`: published, and its late-addition window has ended. Nothing more
 *   joins it and nobody is asked to compose it again.
 * - `recompose`: already composed; the piece joins the same day's edition.
 * - `compose`: a full paper, or the compose deadline has come.
 * - `wait`: a partial paper before the deadline; Caslon's own wake composes it.
 */
export function composeMoment(status, { composed = false, published = false, now = new Date() } = {}) {
  if (status.state === 'blocked') return 'blocked';
  if (published && !lateAdditionOpen(status.edition, now)) return 'closed';
  if (composed || published) return 'recompose';
  return status.state === 'ready' || composeDue(status.edition, now) ? 'compose' : 'wait';
}

// One line, always. It is a comment row in the edition INDEX header and the
// `compose_gates` field of the composed artifact, so both read identically.
const count = (value) => (Number.isInteger(value) ? String(value) : '?');
export const composeGateLine = (status) => `# compose: passed=${status.passed.found}/${status.passed.required} desks=${status.desks.found}/${status.desks.required} ${Object.entries(status.coverage).map(([key, gate]) => `${key}=${count(gate.found)}/${gate.required}`).join(' ')} forecast=${count(status.forecasts)} dissent=${count(status.dissents)}  → ${status.state}`;
