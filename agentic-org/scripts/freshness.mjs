// The facts check between Spike's PASS and composition.
//
// Research freezes at 12:00 Berlin and the paper publishes around 17:00. On
// 2026-10-06 three PASSed pieces were stale by then: a crash piece said 32
// aboard with casualties unconfirmed after the Air Force had confirmed 25 dead
// at 07:14, a party vote was printed as pending after it had been held, and a
// projection ran as a seat lead. So after a PASS the owner sends ONE ad hoc
// research request asking what changed since the research time, then records
// the outcome with record_freshness_check:
//
//   unchanged    nothing material moved; the PASSed revision runs, stamped
//                with the answer's time.
//   updated      something material moved; the owner files revision r+1 with
//                the development, Spike reviews it as usual, and the filing
//                carries the stamp.
//   unavailable  the answer was refused or never came; the piece runs stamped
//                with the research corpus time, which is the honest "as of".
//
// compose_edition refuses any article without a check that covers its current
// revision. Pure: the records and the article come in, a verdict goes out.

export const FRESHNESS_VERSION = 'clank.freshness-check.v1';
export const FRESHNESS_OUTCOMES = Object.freeze(['unchanged', 'updated', 'unavailable']);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/u;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
export const clockOf = (iso) => new Date(iso).toISOString().slice(11, 16);

/**
 * The record that governs `article`: the latest check at or below its current
 * revision. An `unchanged`/`unavailable` check covers exactly the revision it
 * was recorded against; an `updated` check covers the revisions filed after it.
 * Returns `{ ok, record, problem }`; `problem` is the sentence Caslon relays.
 */
export function freshnessStatus(article, records = []) {
  const revision = article?.revision, id = article?.id ?? '?';
  const record = records.filter((item) => Number.isSafeInteger(item?.revision) && item.revision <= revision).sort((left, right) => right.revision - left.revision)[0];
  if (!record) return { ok: false, problem: `"${id}" revision ${revision} has no facts check recorded after its PASS — its owner sends one research request asking what changed since the research time, then calls record_freshness_check` };
  if (record.outcome === 'updated' && record.revision === revision) return { ok: false, record, problem: `"${id}": its owner recorded a material development against revision ${revision}; revision ${revision + 1} carrying it must be filed and passed by Spike before composition, or, if it cannot pass in time, its check on revision ${revision} recorded again as unchanged or unavailable` };
  if (record.outcome !== 'updated' && record.revision !== revision) return { ok: false, record, problem: `"${id}" changed to revision ${revision} after its facts check on revision ${record.revision} — the passed revision needs its own check` };
  if (article.facts_checked_utc !== record.facts_checked_utc) return { ok: false, record, problem: `"${id}" revision ${revision} carries facts_checked_utc ${JSON.stringify(article.facts_checked_utc ?? null)}, but its facts check stamped ${record.facts_checked_utc} — record the check again` };
  return { ok: true, record };
}

/** The `updated` check a new filing of `revision` answers, if any. */
export const updateFor = (records, revision) => records.filter((item) => item?.outcome === 'updated' && item.revision < revision).sort((left, right) => right.revision - left.revision)[0];

/**
 * Validate the arguments and build the record. `corpusFetchedAt` is the ISO
 * instant of the research corpus the edition was commissioned against; `now`
 * is the clock. Throws an actionable error; nothing is recorded on a throw.
 */
export function buildFreshnessRecord(args, { agent, article, corpusFetchedAt, now = new Date() }) {
  const { outcome } = args;
  if (!FRESHNESS_OUTCOMES.includes(outcome)) throw new Error(`outcome must be one of ${FRESHNESS_OUTCOMES.join(', ')}, got ${JSON.stringify(outcome)}`);
  if (article.revision !== args.revision) throw new Error(`"${args.article_id}" passed at revision ${article.revision}, not ${args.revision} — check the revision Spike passed`);
  let checkedAt = null, requestId = args.request_id ?? null;
  if (requestId !== null && (typeof requestId !== 'string' || !REQUEST_ID.test(requestId))) throw new Error(`request_id must be the research.request.v1 request_id you sent (letters, digits, _ . : -), got ${JSON.stringify(requestId)}`);
  if (outcome === 'unavailable') {
    if (args.checked_at !== undefined) throw new Error('outcome "unavailable" carries no checked_at — the piece is stamped with the research corpus time instead');
  } else {
    if (requestId === null) throw new Error(`outcome "${outcome}" needs request_id: the research request that did the check`);
    if (typeof args.checked_at !== 'string' || !ISO_UTC.test(args.checked_at) || Number.isNaN(Date.parse(args.checked_at))) throw new Error(`checked_at must be the answer's ran_at, an ISO UTC instant like "2026-10-07T13:42:10Z", got ${JSON.stringify(args.checked_at ?? null)}`);
    if (Date.parse(args.checked_at) < Date.parse(corpusFetchedAt)) throw new Error(`checked_at ${args.checked_at} is before the research time ${corpusFetchedAt} — a facts check must run after research froze; send the request and use its answer's ran_at`);
    if (Date.parse(args.checked_at) > now.getTime() + 5 * 60_000) throw new Error(`checked_at ${args.checked_at} is in the future — copy ran_at from the research answer`);
    checkedAt = args.checked_at;
  }
  if (outcome === 'updated' && (typeof args.changes !== 'string' || args.changes.trim().length < 20 || args.changes.length > 1200)) throw new Error('outcome "updated" needs changes: 20-1200 characters naming each material development and any [En] row it supersedes');
  if (outcome !== 'updated' && args.changes !== undefined) throw new Error(`changes belongs to outcome "updated" only`);
  return {
    version: FRESHNESS_VERSION, article_id: args.article_id, revision: args.revision, outcome, request_id: requestId,
    checked_at: checkedAt, facts_checked_utc: clockOf(checkedAt ?? corpusFetchedAt), ...(outcome === 'updated' ? { changes: args.changes.trim() } : {}),
    agent, event_key: args.event_key
  };
}

const ownerOf = (article) => ((article?.byline?.agents ?? [])[0] ?? '').toLowerCase();

/**
 * record_freshness_check. `io` supplies the edition state: read/write records,
 * the PASSed article, whether the edition is
 * composed, the corpus time and the readiness of the rest of the edition.
 */
export async function recordFreshnessCheck(args, io) {
  const agent = io.agent, article = await io.article(args.article_id);
  if (!article) throw new Error(`"${args.article_id}" has no PASSed revision in edition ${args.edition} — the facts check comes after Spike's PASS`);
  const owner = ownerOf(article);
  if (agent !== owner && !(agent === 'brass' && args.outcome === 'unavailable')) throw new Error(agent === 'brass' ? 'Brass may record only outcome "unavailable", for an owner who cannot act before composition' : `"${args.article_id}" belongs to ${owner || 'another desk'}; only its owner records its facts check`);
  if (await io.composed()) throw new Error(`edition ${args.edition} is composed; a facts check recorded now cannot reach the page — tell Caslon in room:release if the story moved`);
  // No refusal when revision r+1 is already filed: if Spike holds the update,
  // the owner (or Brass) can still clear the passed revision r rather than
  // leave the edition uncomposable; a later PASS of r+1 then needs its own check.
  const record = buildFreshnessRecord(args, { agent, article, corpusFetchedAt: await io.corpusFetchedAt(), now: io.now?.() ?? new Date() });
  await io.write(args.article_id, args.revision, record);
  if (record.outcome !== 'updated') await io.stamp(args.article_id, { ...article, facts_checked_utc: record.facts_checked_utc });
  const next = record.outcome === 'updated'
    ? `Facts check saved. File revision ${args.revision + 1} of "${args.article_id}" now with file_article: add each development you named, with its sourced evidence, and keep every verified fact that still stands; file_article stamps facts_checked_utc ${record.facts_checked_utc}. Then announce it in room:filing mentioning @spike. The edition cannot compose until that revision passes.`
    : (await io.ready())
      ? `Facts check saved; every PASSed piece now carries one and the composition prerequisites are ready. Use moltnet_send on network clank-newsroom to target room:release: include edition ${args.edition}, mention @caslon, and say every passed piece is facts-checked and ready to compose. Then end the turn.`
      : 'Facts check saved; the page will print "Facts as of ' + record.facts_checked_utc + ' UTC". No message is needed. End the turn.';
  return { recorded: true, ...record, next };
}
