import { compositionCoverage, composeGateStatus } from './compose-gate.mjs';
import { PASSED_ARTICLES_MINIMUM } from '../../ops/edition-floor.mjs';
import { factsRequestId } from './freshness.mjs';

// `problems` are the facts-check problems that block composition (a recorded
// development whose revision has not passed, a stamp that disagrees with its
// record). A piece with no check yet does not block: it composes stamped with
// the research time.
export function reviewNoticeInstruction(args, owner, { articles = [], desks = [], problems = [], fresh = true } = {}) {
  if (args.verdict !== 'PASS') {
    const notes = args.verdict === 'SPIKE' ? 'include your actionable notes; if the lineup needs another piece, tell @brass in room:assignment' : 'and include your actionable notes';
    return `The ${args.verdict} notes were saved only; mentions inside notes were not delivered. Use moltnet_send on network clank-newsroom to target room:filing now: include edition ${args.edition}, article ${args.article_id} revision ${args.revision}, mention @${owner}, ${notes}.`;
  }
  // The owner's facts check runs beside composition, not in front of it. The
  // owner sends it themselves; Spike only names the request_id.
  const check = fresh ? '' : `First use moltnet_send on network clank-newsroom to target room:filing: include edition ${args.edition}, article ${args.article_id} revision ${args.revision}, mention @${owner}, say it passed, and tell them their facts check has not gone out yet: they send it to the research room themselves from RESEARCH_ROUND_TRIP.md, request_id ${factsRequestId(owner, args.edition, args.article_id)}. Do not paste the request into the room. `;
  const readiness = composeGateStatus({ edition: args.edition, passed: articles.length, desks: desks.length, coverage: compositionCoverage(articles) });
  if (readiness.state === 'ready' && problems.length === 0) {
    return `PASS was saved for edition ${args.edition}, article ${args.article_id} revision ${args.revision}; no Moltnet message was sent. The current composition prerequisites are ready. ${check}Use moltnet_send on network clank-newsroom to target room:release now: include that edition, article and revision, mention @caslon, and ask Caslon to read the fresh state/edition/editions/${args.edition}/INDEX and compose from the accepted inputs. Verify the send succeeded before completing the inbox item or ending the turn. Do not resend a handoff already delivered for this accepted revision.`;
  }
  if (readiness.state === 'ready') return `PASS was saved for edition ${args.edition}, article ${args.article_id} revision ${args.revision}; no Moltnet message was sent. ${check}The edition waits only on recorded developments (${problems.length}): ${problems.join('; ')}. Their owner's revision or record hands it to Caslon, so do not mention @caslon. Verify every send succeeded before completing the inbox item or ending the turn.`;
  return `PASS was saved. ${check}Continue from the fresh state/edition/editions/${args.edition}/INDEX: review other unreviewed filings one at a time; when the INDEX shows passed>=${PASSED_ARTICLES_MINIMUM} and no D ledger.settlements or D ledger.worlddesk rows, use moltnet_send on network clank-newsroom to target room:release mentioning @ledger.`;
}
