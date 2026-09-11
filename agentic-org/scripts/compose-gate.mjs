// The compose gates, in one place, so they can be read before they are hit.
//
// The INDEX and composition share the existing article, desk and coverage
// floors. Ready means those prerequisites are met; composition still checks
// authentic reviews, unchanged filings, layout and artifacts.
//
// The forecast/dissent diversity floor used to be a third refusal here, with a
// dated waiver to excuse it. Both are gone, and the removal is the point:
//
//   * 16 of the 79 editions on `main` ever carried a dated forecast, 11 of
//     those a named dissent, the last on 2026-08-09. None of the six quality-
//     target editions (08-19 … 08-24) had either. The gate refused the paper
//     it was modelled on.
//   * It was structurally unclearable where it stood. A 21:00 refusal on a
//     property only Brass at 18:30 and a reporter at 19:00 can supply is a
//     refusal Caslon cannot act on, so the only reachable outcome was a waiver
//     re-dated every night — a quality bar that has quietly disappeared while
//     still looking like one.
//
// So the two halves moved to where an agent can still act on them. The
// forecast *shape* is enforced at `file_article`, in the reporter's own wake,
// for the assignment Brass marked `slot: "forecast"`. The dissent is written
// by the dissenter through `record_dissent`, under the identity the MCP server
// already authenticates. Here both are counted and neither refuses: a day
// nobody dissents ships, and says so in the INDEX, the receipt and the audit.
//
// Re-arming the floor as a gate is a decision for after five consecutive
// editions carry it without anyone waiving anything. Not before.

export const PASSED_ARTICLES_MINIMUM = 5;
export const DESK_DOCUMENTS_REQUIRED = 4;
const COVERAGE_RULES = Object.freeze({
  sections: { required: 3, label: 'distinct sections', names: true },
  owners: { required: 5, label: 'distinct byline agents', names: true },
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
