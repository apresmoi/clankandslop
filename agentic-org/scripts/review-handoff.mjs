import { compositionCoverage, composeGateStatus } from './compose-gate.mjs';

export function reviewNoticeInstruction(args, owner, { articles = [], desks = [], problems = [], fresh = true } = {}) {
  if (args.verdict !== 'PASS') {
    const notes = args.verdict === 'SPIKE' ? 'include your actionable notes, and mention @brass if a replacement is required' : 'and include your actionable notes';
    return `The ${args.verdict} notes were saved only; mentions inside notes were not delivered. Use moltnet_send on network clank-newsroom to target room:filing now: include edition ${args.edition}, article ${args.article_id} revision ${args.revision}, mention @${owner}, ${notes}.`;
  }
  // A PASS is not the last word on a piece any more: its owner checks what
  // changed since research froze, and only the last facts check makes the
  // edition composable. So Spike tells the owner, and Caslon hears from
  // whoever completes the set.
  const check = fresh ? '' : `First use moltnet_send on network clank-newsroom to target room:filing: include edition ${args.edition}, article ${args.article_id} revision ${args.revision}, mention @${owner}, and say it passed and needs its facts check now. `;
  const readiness = composeGateStatus({ edition: args.edition, passed: articles.length, desks: desks.length, coverage: compositionCoverage(articles) });
  if (readiness.state === 'ready' && problems.length === 0) {
    return `PASS was saved for edition ${args.edition}, article ${args.article_id} revision ${args.revision}; no Moltnet message was sent. The current composition prerequisites are ready. ${check}Use moltnet_send on network clank-newsroom to target room:release now: include that edition, article and revision, mention @caslon, and ask Caslon to read the fresh state/edition/editions/${args.edition}/INDEX and compose from the accepted inputs. Verify the send succeeded before completing the inbox item or ending the turn. Do not resend a handoff already delivered for this accepted revision.`;
  }
  if (readiness.state === 'ready') return `PASS was saved for edition ${args.edition}, article ${args.article_id} revision ${args.revision}; no Moltnet message was sent. ${check}The edition waits only on facts checks (${problems.length}); the owner who records the last one hands it to Caslon, so do not mention @caslon. Verify every send succeeded before completing the inbox item or ending the turn.`;
  return `PASS was saved. ${check}Continue from the fresh state/edition/editions/${args.edition}/INDEX: review other unreviewed filings one at a time; when the INDEX shows passed>=5 and no D ledger.settlements or D ledger.worlddesk rows, use moltnet_send on network clank-newsroom to target room:release mentioning @ledger.`;
}
