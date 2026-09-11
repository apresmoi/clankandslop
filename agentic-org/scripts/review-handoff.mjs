import { compositionCoverage, composeGateStatus } from './compose-gate.mjs';

export function reviewNoticeInstruction(args, owner, { articles = [], desks = [] } = {}) {
  if (args.verdict !== 'PASS') {
    const notes = args.verdict === 'SPIKE' ? 'include your actionable notes, and mention @brass if a replacement is required' : 'and include your actionable notes';
    return `The ${args.verdict} notes were saved only; mentions inside notes were not delivered. Use moltnet_send on network clank-newsroom to target room:filing now: include edition ${args.edition}, article ${args.article_id} revision ${args.revision}, mention @${owner}, ${notes}.`;
  }
  const readiness = composeGateStatus({ edition: args.edition, passed: articles.length, desks: desks.length, coverage: compositionCoverage(articles) });
  if (readiness.state === 'ready') {
    return `PASS was saved for edition ${args.edition}, article ${args.article_id} revision ${args.revision}; no Moltnet message was sent. The current composition prerequisites are ready. Use moltnet_send on network clank-newsroom to target room:release now: include that edition, article and revision, mention @caslon, and ask Caslon to read the fresh state/edition/editions/${args.edition}/INDEX and compose from the accepted inputs. Verify the send succeeded before completing the inbox item or ending the turn. Do not resend a handoff already delivered for this accepted revision.`;
  }
  return `PASS was saved. Continue from the fresh state/edition/editions/${args.edition}/INDEX: review other unreviewed filings one at a time; when the INDEX shows passed>=5 and no D ledger.settlements or D ledger.worlddesk rows, use moltnet_send on network clank-newsroom to target room:release mentioning @ledger.`;
}
