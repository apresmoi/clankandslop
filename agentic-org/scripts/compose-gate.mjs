// The three compose gates, in one place, so they can be read before they are hit.
//
// `compose_edition` refuses on three independent conditions — enough PASSed
// articles, exactly four desk documents, and the forecast/dissent diversity
// floor — and until now each one was invisible until it failed. A newsroom
// discovered them one per failed compose run, three runs and roughly 2.4M
// tokens to learn a fact the state tree already knew. `composeGateLine` renders
// all three as one line in the edition INDEX header, which every agent already
// reads, and the same line is recorded in the composed artifact.
//
// The forecast floor is the only gate a publisher can waive, and the waiver
// names the exact edition it excuses. It is deliberately not a boolean: a
// waiver that cannot be dated is a quality bar that quietly disappears, which
// is the failure this shape exists to prevent. `CLANK_EDITION_DIVERSITY_WAIVER`
// left set after its edition ships has no effect on any later paper.

export const PASSED_ARTICLES_MINIMUM = 5;
export const DESK_DOCUMENTS_REQUIRED = 4;
export const DIVERSITY_WAIVER_ENV = 'CLANK_EDITION_DIVERSITY_WAIVER';
export const FORECAST_DISSENT_FLOOR = 'forecast-dissent';
export const WAIVER_VERSION = 'clank.edition-diversity-waiver.v1';

const EDITION_DATE = /^\d{4}-\d{2}-\d{2}$/u;

// The one floor a dated waiver can excuse: at least one article whose epistemic
// is "forecast", carrying a dated next_update_utc and a named dissent.
export const hasDatedForecastWithDissent = (values) => values.some((value) => value.epistemic === 'forecast' && /^\d{2}:\d{2}$/u.test(value.next_update_utc) && value.dissent?.agent && value.dissent?.argument);

/**
 * Reads the waiver switch for one specific edition.
 *
 * Returns a waiver record only when the environment names *this* edition;
 * undefined when it names another one, and undefined when it is unset. A
 * value that is not an ISO edition date throws rather than being ignored,
 * because "1"/"true"/"yes" is exactly the shape a permanent, undated waiver
 * would take and silently dropping it would hide a misconfiguration.
 */
export function editionDiversityWaiver(edition, value = process.env[DIVERSITY_WAIVER_ENV]) {
  if (value === undefined || value === null) return undefined;
  const declared = String(value).trim();
  if (declared === '') return undefined;
  if (!EDITION_DATE.test(declared)) throw new Error(`${DIVERSITY_WAIVER_ENV} must name the one edition it waives as an ISO date "YYYY-MM-DD", got ${JSON.stringify(value)} — the ${FORECAST_DISSENT_FLOOR} floor is never waived by a boolean`);
  if (declared !== edition) return undefined;
  return { version: WAIVER_VERSION, floor: FORECAST_DISSENT_FLOOR, edition: declared, source: DIVERSITY_WAIVER_ENV, note: 'composed without a "forecast" article carrying a dated next_update_utc and a named dissent' };
}

/**
 * The state of all three gates for one edition.
 *
 * `forecast` is true/false when the article set could be read, and undefined
 * when it could not — reported as "unknown" rather than guessed at. `waiver`
 * is whatever `editionDiversityWaiver` returned for this same edition, or the
 * waiver already recorded in a composed artifact.
 */
export function composeGateStatus({ edition, passed, desks, forecast, waiver }) {
  const passedGate = { found: passed, required: PASSED_ARTICLES_MINIMUM, ok: passed >= PASSED_ARTICLES_MINIMUM };
  const deskGate = { found: desks, required: DESK_DOCUMENTS_REQUIRED, ok: desks === DESK_DOCUMENTS_REQUIRED };
  // A waiver only ever applies to an edition that is genuinely missing the
  // forecast piece: an edition that has one records no waiver at all.
  const waived = forecast === false && Boolean(waiver);
  const state = forecast === undefined ? 'unknown' : forecast ? 'ok' : waived ? `waived(${waiver.edition})` : 'missing(forecast)';
  const diversity = { floor: FORECAST_DISSENT_FLOOR, state, ok: forecast === true || waived, waived };
  return { edition, passed: passedGate, desks: deskGate, diversity, state: passedGate.ok && deskGate.ok && diversity.ok ? (waived ? 'waived' : 'ready') : 'blocked' };
}

// One line, always. It is a comment row in the edition INDEX header and the
// `compose_gates` field of the composed artifact, so both read identically.
export const composeGateLine = (status) => `# compose: passed=${status.passed.found}/${status.passed.required} desks=${status.desks.found}/${status.desks.required} diversity=${status.diversity.state}  → ${status.state}`;
