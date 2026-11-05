import { COMPOSE_DEADLINE, LATE_ADDITION_CUTOFF, compositionCoverage, composeGateStatus, composeMoment } from './compose-gate.mjs';
import { FULL_EDITION_ARTICLES } from '../../ops/edition-floor.mjs';
import { factsRequestId } from './freshness.mjs';

// `problems` are the facts-check problems that block composition (a recorded
// development whose revision has not passed, a stamp that disagrees with its
// record). A piece with no check yet does not block: it composes stamped with
// the research time. `composed` and `published` say whether the edition already
// has a composition and whether the host proved it on main; a PASS after either
// is a late addition to the same day's edition until its window closes.
export function reviewNoticeInstruction(args, owner, { articles = [], desks = [], problems = [], fresh = true, composed = false, published = false, now = new Date() } = {}) {
  if (args.verdict !== 'PASS') {
    const notes = args.verdict === 'SPIKE' ? 'include your actionable notes; if the lineup needs another piece, tell @brass in room:assignment' : 'and include your actionable notes';
    return `The ${args.verdict} notes were saved only; mentions inside notes were not delivered. Use moltnet_send on network clank-newsroom to target room:filing now: include edition ${args.edition}, article ${args.article_id} revision ${args.revision}, mention @${owner}, ${notes}.`;
  }
  // The owner's facts check runs beside composition, not in front of it. The
  // owner sends it themselves; Spike only names the request_id.
  const check = fresh ? '' : `First use moltnet_send on network clank-newsroom to target room:filing: include edition ${args.edition}, article ${args.article_id} revision ${args.revision}, mention @${owner}, say it passed, and tell them their facts check has not gone out yet: they send it to the research room themselves from RESEARCH_ROUND_TRIP.md, request_id ${factsRequestId(owner, args.edition, args.article_id)}. Do not paste the request into the room. `;
  const moment = composeMoment(composeGateStatus({ edition: args.edition, passed: articles.length, desks: desks.length, coverage: compositionCoverage(articles) }), { composed, published, now });
  const saved = `PASS was saved for edition ${args.edition}, article ${args.article_id} revision ${args.revision}; no Moltnet message was sent.`;
  if (moment === 'closed') return `${saved} ${check}Edition ${args.edition} is published and its late additions closed at ${LATE_ADDITION_CUTOFF} Berlin, so this piece does not join it. Tell @${owner} in room:filing that it passed after the edition closed; do not mention @caslon. Verify the send succeeded before completing the inbox item or ending the turn.`;
  if (problems.length > 0 && (moment === 'compose' || moment === 'recompose')) return `${saved} ${check}The edition waits only on recorded developments (${problems.length}): ${problems.join('; ')}. Their owner's revision or record hands it to Caslon, so do not mention @caslon. Verify every send succeeded before completing the inbox item or ending the turn.`;
  if (moment === 'recompose') return `${saved} ${check}Edition ${args.edition} is already composed${published ? ' and published' : ''}, so this piece is a late addition to it. Use moltnet_send on network clank-newsroom to target room:release now: include that edition, article and revision, mention @caslon, and ask Caslon to read the fresh state/edition/editions/${args.edition}/INDEX and recompose the edition with the piece added. Verify the send succeeded before completing the inbox item or ending the turn. Do not resend a handoff already delivered for this accepted revision.`;
  if (moment === 'compose') return `${saved} The current composition prerequisites are ready. ${check}Use moltnet_send on network clank-newsroom to target room:release now: include that edition, article and revision, mention @caslon, and ask Caslon to read the fresh state/edition/editions/${args.edition}/INDEX and compose from the accepted inputs. Verify the send succeeded before completing the inbox item or ending the turn. Do not resend a handoff already delivered for this accepted revision.`;
  return `PASS was saved. ${check}Continue from the fresh state/edition/editions/${args.edition}/INDEX: review other unreviewed filings one at a time; Caslon composes what has passed at ${COMPOSE_DEADLINE} Berlin. When the INDEX shows passed>=${FULL_EDITION_ARTICLES} and no D ledger.settlements or D ledger.worlddesk rows, use moltnet_send on network clank-newsroom to target room:release mentioning @ledger.`;
}
