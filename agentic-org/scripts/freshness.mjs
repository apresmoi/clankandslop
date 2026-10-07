// The facts check between Spike's PASS and composition.
//
// Research freezes at 12:00 Berlin and the paper publishes around 17:00. On
// 2026-10-06 three PASSed pieces were stale by then: a crash piece said 32
// aboard with casualties unconfirmed after the Air Force had confirmed 25 dead
// at 07:14, a party vote was printed as pending after it had been held, and a
// projection ran as a seat lead. So at PASS Spike hands the owner the exact
// research request for the piece (factsCheckRequest), the owner sends it, and
// records the answer with record_freshness_check:
//
//   unchanged    nothing material moved; the PASSed revision runs, stamped
//                with the answer's time.
//   updated      something material moved; the owner files revision r+1 with
//                the development, Spike reviews it as usual, and the filing
//                carries the stamp.
//   unavailable  the answer was refused or never came; the piece runs stamped
//                with the research corpus time, which is the honest "as of".
//
// OFF THE CRITICAL PATH. On 2026-10-07 the check held each piece out of the
// gate for 7-38 minutes, and Foreman cleared his by recording "unavailable"
// for a request he never sent. Now a piece with no check does not stop
// compose_edition: it composes stamped with the research time, which is what
// "unavailable" printed anyway. What still stops it is a check that found
// news ("updated") until that revision passes, and a printed stamp that
// disagrees with its record. Every outcome names the request that was sent
// for this piece, `<owner>-<edition>-facts-<article id>`.
//
// Pure: the records and the article come in, a verdict goes out.

import { escalationRoom } from './agent-rooms.mjs';

export const FRESHNESS_VERSION = 'clank.freshness-check.v1';
export const FRESHNESS_OUTCOMES = Object.freeze(['unchanged', 'updated', 'unavailable']);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/u;
// The research sensor accepts identifiers up to 160 characters.
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,160}$/u;
export const clockOf = (iso) => new Date(iso).toISOString().slice(11, 16);
const ownerOf = (article) => ((article?.byline?.agents ?? [])[0] ?? '').toLowerCase();

/** The request_id of a piece's facts check: one per piece, stable across retries. */
export const factsRequestId = (owner, edition, articleId) => `${owner}-${edition}-facts-${articleId}`;

/**
 * The exact research.request.v1 text the owner sends to room:research for the
 * passed `article`. At most 2048 UTF-8 bytes, the sensor's limit.
 */
export function factsCheckRequest(owner, edition, article) {
  const about = String(article?.headline ?? article?.id ?? '').replace(/\s+/gu, ' ').trim().slice(0, 300);
  return JSON.stringify({
    kind: 'research.request.v1', request_id: factsRequestId(owner, edition, article.id), from: owner, edition, story_id: article.id,
    question: `What has changed since 12:00 Berlin time today about: ${about}? Give dated, sourced developments.`,
    discriminator: 'A dated, sourced development after 12:00 Berlin that changes a fact, figure or status in the piece.'
  });
}

/**
 * The record that governs `article`: the latest check at or below its current
 * revision. An `unchanged`/`unavailable` check covers exactly the revision it
 * was recorded against; an `updated` check covers the revisions filed after it.
 * Returns `{ ok, blocking, record, problem }`. `blocking` problems stop
 * compose_edition; a piece with no check at all does not, it composes stamped
 * with the research time. `problem` is the sentence Caslon relays.
 */
export function freshnessStatus(article, records = []) {
  const revision = article?.revision, id = article?.id ?? '?';
  const record = records.filter((item) => Number.isSafeInteger(item?.revision) && item.revision <= revision).sort((left, right) => right.revision - left.revision)[0];
  if (!record) return { ok: false, blocking: false, problem: `"${id}" revision ${revision} has no facts check recorded; it composes stamped with the research time` };
  if (record.outcome === 'updated' && record.revision === revision) return { ok: false, blocking: true, record, problem: `"${id}": its owner recorded a material development against revision ${revision}; revision ${revision + 1} carrying it must be filed and passed by Spike before composition, or, if it cannot pass in time, its check on revision ${revision} recorded again as "unavailable"` };
  if (record.outcome !== 'updated' && record.revision !== revision) return { ok: false, blocking: false, record, problem: `"${id}" changed to revision ${revision} after its facts check on revision ${record.revision}; it composes stamped with the research time` };
  if (article.facts_checked_utc !== record.facts_checked_utc) return { ok: false, blocking: true, record, problem: `"${id}" revision ${revision} carries facts_checked_utc ${JSON.stringify(article.facts_checked_utc ?? null)}, but its facts check stamped ${record.facts_checked_utc} — record the check again` };
  return { ok: true, blocking: false, record };
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
  const requestId = args.request_id ?? null, expected = factsRequestId(ownerOf(article), args.edition, args.article_id);
  // Every outcome names the request that was sent. "unavailable" used to need
  // none, and on 2026-10-07 it was recorded for a request never sent.
  if (requestId === null) throw new Error(`outcome "${outcome}" needs request_id "${expected}": the facts-check request sent to room:research for this piece. If it was never sent, send it now and record the answer`);
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw new Error(`request_id must be the research.request.v1 request_id you sent (letters, digits, _ . : -), got ${JSON.stringify(requestId)}`);
  if (requestId !== expected) throw new Error(`request_id must be "${expected}", the facts-check request for this piece, got ${JSON.stringify(requestId)}`);
  let checkedAt = null;
  if (outcome === 'unavailable') {
    if (args.checked_at !== undefined) throw new Error('outcome "unavailable" carries no checked_at — the piece is stamped with the research corpus time instead');
  } else {
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

/**
 * record_freshness_check. `io` supplies the edition state: read/write records,
 * the PASSed article, its existing records, whether the edition is composed,
 * the corpus time and the readiness of the rest of the edition.
 */
export async function recordFreshnessCheck(args, io) {
  const agent = io.agent, article = await io.article(args.article_id);
  if (!article) throw new Error(`"${args.article_id}" has no PASSed revision in edition ${args.edition} — the facts check comes after Spike's PASS`);
  const owner = ownerOf(article);
  if (agent !== owner && !(agent === 'brass' && args.outcome === 'unavailable')) throw new Error(agent === 'brass' ? 'Brass may record only outcome "unavailable", for an owner who cannot act before composition' : `"${args.article_id}" belongs to ${owner || 'another desk'}; only its owner records its facts check`);
  if (await io.composed()) throw new Error(`edition ${args.edition} is composed; nothing was recorded and the page keeps its stamp. If the story moved materially, tell @caslon in ${escalationRoom(agent)}`);
  // No refusal when revision r+1 is already filed: if Spike holds the update,
  // the owner (or Brass) can still clear the passed revision r rather than
  // leave the edition uncomposable; a later PASS of r+1 then needs its own check.
  const record = buildFreshnessRecord(args, { agent, article, corpusFetchedAt: await io.corpusFetchedAt(), now: io.now?.() ?? new Date() });
  const records = (await io.records?.(args.article_id)) ?? [];
  // A development already on record for this revision cannot be taken back as
  // "unchanged"; if its revision cannot pass in time, it runs as "unavailable".
  if (record.outcome === 'unchanged' && records.some((item) => item?.revision === args.revision && item.outcome === 'updated')) throw new Error(`revision ${args.revision} of "${args.article_id}" already has a development on record ("updated"); file revision ${args.revision + 1} with it, or record "unavailable" if it cannot pass before composition`);
  const wasBlocking = freshnessStatus({ id: args.article_id, ...article }, records).blocking;
  await io.write(args.article_id, args.revision, record);
  if (record.outcome !== 'updated') await io.stamp(args.article_id, { ...article, facts_checked_utc: record.facts_checked_utc });
  // Only a check that cleared what was holding the edition hands it to Caslon;
  // a piece with no check never held it, and Spike's PASS already handed off.
  const next = record.outcome === 'updated'
    ? `Facts check saved. File revision ${args.revision + 1} of "${args.article_id}" now with file_article: add each development you named, with its sourced evidence, and keep every verified fact that still stands; file_article stamps facts_checked_utc ${record.facts_checked_utc}. Then announce it in room:filing mentioning @spike. The edition cannot compose until that revision passes.`
    : wasBlocking && (await io.ready())
      ? `Facts check saved; nothing holds the edition now. Use moltnet_send on network clank-newsroom to target room:filing: include edition ${args.edition}, mention @caslon, and say every passed piece is ready to compose. Then end the turn.`
      : `Facts check saved; the page will print "Facts as of ${record.facts_checked_utc} UTC". No message is needed. End the turn.`;
  return { recorded: true, ...record, next };
}
