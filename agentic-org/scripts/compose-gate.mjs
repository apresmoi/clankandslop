// The compose gates, in one place, so they can be read before they are hit.
//
// The INDEX and composition share the existing article, desk and coverage
// floors. Ready means those prerequisites are met; composition still checks
// authentic reviews, unchanged filings, layout and artifacts.
//
// The forecast and the dissent are counted here, never refused: the forecast
// shape is enforced at `file_article` for the assignment Brass marked
// `slot: "forecast"`, and the dissent is recorded by the dissenter through
// `record_dissent`. A day nobody dissents ships, and the INDEX, the receipt and
// the audit say so. (A refusal here once fired at a time only Brass and a
// reporter could act on, and was waived every night.)

// The passed-article floor is a size, not a standard. Four reviewed stories
// from four desks is a paper: on 2026-09-26 an edition with four passed pieces
// across three sections, a forecast and a dissent did not publish for want of
// a fifth body. Every story still clears the same review bar.
// Declared once in ops/edition-floor.mjs and re-exported here so every existing
// caller of this module keeps working. Do not restate the numbers.
export { PASSED_ARTICLES_MINIMUM, DESK_DOCUMENTS_REQUIRED } from '../../ops/edition-floor.mjs';
import { PASSED_ARTICLES_MINIMUM, DESK_DOCUMENTS_REQUIRED } from '../../ops/edition-floor.mjs';
const COVERAGE_RULES = Object.freeze({
  sections: { required: 3, label: 'distinct sections', names: true },
  // Moves with the article floor: the point is enough desks to be a paper, not
  // the full roster filing. Four passed articles cannot come from fewer than
  // four bylines without one desk filing twice, which this still refuses.
  owners: { required: 4, label: 'distinct byline agents', names: true },
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

export function assertCompositionCoverage(coverage) {
  for (const [key, gate] of Object.entries(coverageGates(coverage))) {
    const rule = COVERAGE_RULES[key];
    if (!gate.ok) throw new Error(`edition diversity floor missing — at least ${rule.required} ${rule.label} required, found ${gate.found ?? '?'}${rule.names && Array.isArray(coverage?.[key]) ? `: ${coverage[key].join(', ')}` : ''}`);
  }
}

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
 * advertise readiness.
 */
export function composeGateStatus({ edition, passed, desks, forecasts, dissents, coverage }) {
  const passedGate = { found: passed, required: PASSED_ARTICLES_MINIMUM, ok: passed >= PASSED_ARTICLES_MINIMUM };
  const deskGate = { found: desks, required: DESK_DOCUMENTS_REQUIRED, ok: desks === DESK_DOCUMENTS_REQUIRED };
  const measured = coverageGates(coverage);
  return { edition, passed: passedGate, desks: deskGate, coverage: measured, forecasts, dissents, state: passedGate.ok && deskGate.ok && Object.values(measured).every(gate => gate.ok) ? 'ready' : 'blocked' };
}

// One line, always. It is a comment row in the edition INDEX header and the
// `compose_gates` field of the composed artifact, so both read identically.
const count = (value) => (Number.isInteger(value) ? String(value) : '?');
export const composeGateLine = (status) => `# compose: passed=${status.passed.found}/${status.passed.required} desks=${status.desks.found}/${status.desks.required} ${Object.entries(status.coverage).map(([key, gate]) => `${key}=${count(gate.found)}/${gate.required}`).join(' ')} forecast=${count(status.forecasts)} dissent=${count(status.dissents)}  → ${status.state}`;
