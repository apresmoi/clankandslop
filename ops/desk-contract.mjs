// The shape of the four per-owner desk documents an edition is assembled from.
//
// One definition, two enforcement points. `ops/validate-content.mjs` reads it
// at build time, inside `stage_release`, where a malformed document costs the
// whole edition; `file_desk` reads the same functions at 14:00 and 15:00, while
// the agent that wrote the document is still awake and can file it again. The
// constraints below are therefore never restated in either caller.
//
// Every value here is derived from what the site actually consumes:
// `website/src/lib/edition.ts` (the Edition type and the loader that
// Object.assigns the four parts into it), `website/src/pages/index.astro` (the
// masthead ears, which read weather and world_desk unguarded), and
// `website/src/components/{WorldGlyph,TrackRecord}.astro`.

export const OUTCOMES = new Set(['hit', 'miss', 'open', 'cancelled']);
const ROW_KEYS = new Set(['call', 'outcome', 'prior_p', 'note']);
export const MARKET_GROUPS = Object.freeze(['rates', 'fx', 'commodities', 'equities']);
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

/** Part name → owning agent. The filename IS the write permission. */
export const DESK_OWNERS = Object.freeze({
  'caslon.chrome': 'caslon',
  'caslon.weather': 'caslon',
  'ledger.settlements': 'ledger',
  'ledger.worlddesk': 'ledger',
});

/** The complete set, in assembly order. An edition needs all four. */
export const EDITION_PARTS = Object.freeze(Object.keys(DESK_OWNERS));
export const EDITION_PART_FILES = Object.freeze(EDITION_PARTS.map((name) => `${name}.json`));

const LEAD_REASON_MAX = 240;
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isP = (v) => isNum(v) && v >= 0 && v <= 1;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Declared rather than hand-written per document so the required key list a
// brief quotes and the list a gate enforces cannot drift apart.
const SHAPES = {
  'caslon.chrome': {
    keys: ['date', 'edition_no', 'volume', 'issued_at', 'revision', 'tagline', 'next_bell', 'compiled_by', 'lead_story_id'],
    // Why this story leads, in one line, written when the lead is chosen. The
    // lead is picked for the significance its piece explains, not the size of
    // an official claim; a reason nobody wrote down is a reason nobody checked.
    // Required from file_desk on; editions before 2026-10-07 carry none.
    filingKeys: ['date', 'edition_no', 'volume', 'issued_at', 'revision', 'tagline', 'next_bell', 'compiled_by', 'lead_story_id', 'lead_reason'],
    optional: ['lead_reason'],
    check(document, out) {
      if (out.profile === 'filing' || document.lead_reason !== undefined)
        if (!isStr(document.lead_reason) || /\n/u.test(document.lead_reason) || document.lead_reason.length > LEAD_REASON_MAX)
          out.push(`lead_reason must be one line of at most ${LEAD_REASON_MAX} characters saying why lead_story_id leads: the significance its piece explains, not the size of an official claim`);
      if (isStr(document.date) && !/^\d{4}-\d{2}-\d{2}$/.test(document.date)) out.push('date must be an ISO date "YYYY-MM-DD"');
      for (const key of ['date', 'edition_no', 'volume', 'issued_at', 'tagline', 'next_bell', 'lead_story_id'])
        if (!isStr(document[key])) out.push(`${key} must be a non-empty string`);
      if (!isNum(document.revision)) out.push('revision must be a number');
      if (!Array.isArray(document.compiled_by) || document.compiled_by.length === 0 || !document.compiled_by.every(isStr))
        out.push('compiled_by must be a non-empty array of agent names');
    },
  },
  'caslon.weather': {
    keys: ['weather'],
    check(document, out) {
      // The desk owns no weather instrument. A reading reaches it only as a
      // retrieved observation file; on a day there is none, `null` is the
      // complete and honest document, and the masthead ear drops the two
      // weather lines. The contract permits that explicitly so the only way
      // to satisfy it is never to invent a temperature.
      if (document.weather === null) return;
      if (!isObj(document.weather)) { out.push('weather must be an object {city, temp_c, summary, humidity_pct, wind}, or null when no observation was retrieved'); return; }
      for (const key of ['city', 'summary', 'wind']) if (!isStr(document.weather[key])) out.push(`weather.${key} must be a non-empty string`);
      for (const key of ['temp_c', 'humidity_pct']) if (!isNum(document.weather[key])) out.push(`weather.${key} must be a number`);
    },
  },
  'ledger.settlements': {
    keys: ['resolved_last_edition'],
    check(document, out) {
      // An edition where nothing settled files the empty array. Omitting the
      // document instead leaves desk.length !== 4 and there is no edition.
      if (!Array.isArray(document.resolved_last_edition)) { out.push('resolved_last_edition must be an array (file [] when nothing settled)'); return; }
      for (const [i, row] of document.resolved_last_edition.entries()) {
        if (!isObj(row)) { out.push(`resolved_last_edition[${i}] must be an object {call, outcome, prior_p}`); continue; }
        if (!isStr(row.call)) out.push(`resolved_last_edition[${i}].call must be a non-empty string`);
        if (!OUTCOMES.has(row.outcome)) out.push(`resolved_last_edition[${i}].outcome must be hit|miss|open|cancelled`);
        if (!isP(row.prior_p)) out.push(`resolved_last_edition[${i}].prior_p must be a number in [0,1]`);
        const extra = Object.keys(row).filter((key) => !ROW_KEYS.has(key));
        if (extra.length > 0) out.push(`resolved_last_edition[${i}] carries unexpected key(s) [${extra.join(', ')}] — a row is {call, outcome, prior_p, note?}`);
        if (row.note !== undefined && !isStr(row.note)) out.push(`resolved_last_edition[${i}].note must be a non-empty string when present`);
        if (row.outcome === 'cancelled' && !isStr(row.note)) out.push(`resolved_last_edition[${i}] is cancelled with no note — a cancelled call carries its reason in "note"`);
      }
    },
  },
  'ledger.worlddesk': {
    keys: ['world_desk'],
    filingKeys: ['world_desk'],
    optional: ['markets'],
    check(document, out) {
      if (document.markets !== undefined) marketFindings(document.markets, out);
      // index.astro reads .escalation_index.toFixed(2) with no guard, so a
      // missing world_desk is not a thin page — it is a build crash.
      if (!isObj(document.world_desk)) { out.push('world_desk must be an object {escalation_index, delta, open_conflicts, watch}'); return; }
      for (const key of ['escalation_index', 'open_conflicts', 'watch']) if (!isNum(document.world_desk[key])) out.push(`world_desk.${key} must be a number`);
      if (!isStr(document.world_desk.delta)) out.push('world_desk.delta must be a non-empty string');
      if (out.profile === 'filing') {
        if (document.world_desk.derived !== true) out.push('world_desk.derived must be true for a filed World Desk derivation');
        if (!isStr(document.world_desk.from)) out.push('world_desk.from must be a non-empty trace path');
        if (!isStr(document.world_desk.method)) out.push('world_desk.method must be a non-empty string');
      }
    },
  },
};

// The Tape's market board: the producer's FRED observations, copied verbatim
// by Ledger with the World Desk. A series that did not fetch is `unavailable`
// with its reason; there is no third form, so a number can only be one that
// was observed on the date printed beside it.
function marketFindings(markets, out) {
  if (!isObj(markets)) { out.push('markets must be an object {source, retrieved_at, series[]}'); return; }
  for (const key of ['source', 'retrieved_at']) if (!isStr(markets[key])) out.push(`markets.${key} must be a non-empty string`);
  if (!Array.isArray(markets.series) || markets.series.length === 0) { out.push('markets.series must be a non-empty array'); return; }
  for (const [i, row] of markets.series.entries()) {
    const at = `markets.series[${i}]`;
    if (!isObj(row)) { out.push(`${at} must be an object`); continue; }
    for (const key of ['id', 'label', 'unit', 'basis', 'url']) if (!isStr(row[key])) out.push(`${at}.${key} must be a non-empty string`);
    if (!MARKET_GROUPS.includes(row.group)) out.push(`${at}.group must be one of ${MARKET_GROUPS.join('|')}`);
    if (!Number.isInteger(row.decimals) || row.decimals < 0 || row.decimals > 4) out.push(`${at}.decimals must be an integer 0-4`);
    if (isStr(row.unavailable)) {
      if (['value', 'observed', 'previous', 'previous_observed'].some((key) => row[key] !== undefined)) out.push(`${at} is unavailable and must carry no value or date`);
      continue;
    }
    if (!isNum(row.value) || !DAY.test(row.observed ?? '')) out.push(`${at} must carry value and observed (YYYY-MM-DD), or unavailable with its reason`);
    if ((row.previous === undefined) !== (row.previous_observed === undefined)) out.push(`${at}.previous and previous_observed come together`);
    if (row.previous !== undefined && (!isNum(row.previous) || !DAY.test(row.previous_observed ?? '') || !(row.previous_observed < row.observed))) out.push(`${at}.previous must be a number observed on an earlier day`);
  }
}

/** The required top-level keys of one desk document as filed, for briefs and messages. */
export const deskDocumentKeys = (name) => SHAPES[name]?.filingKeys ?? SHAPES[name]?.keys ?? null;
/** Keys a desk document may carry beyond the required ones. */
export const deskOptionalKeys = (name) => SHAPES[name]?.optional ?? [];

/**
 * Every way `document` fails the contract for the desk part `name`, as plain
 * sentences. Empty means it will assemble and render.
 */
export function deskDocumentFindings(name, document, { profile = 'archive' } = {}) {
  const shape = SHAPES[name];
  if (!shape) return [`unknown desk document "${name}" — the edition carries exactly ${EDITION_PARTS.join(', ')}`];
  if (!isObj(document)) return [`${name} must be a JSON object`];
  const out = [];
  out.profile = profile;
  const keys = [...(profile === 'filing' && shape.filingKeys ? shape.filingKeys : shape.keys), ...(shape.optional ?? [])];
  const unexpected = Object.keys(document).filter((key) => !keys.includes(key));
  if (unexpected.length > 0) out.push(`unexpected key(s) [${unexpected.join(', ')}] — ${name} carries exactly [${keys.join(', ')}]`);
  shape.check(document, out);
  delete out.profile;
  return out;
}
