// Ledger's own research request, and the line after which its desk is sealed.
//
// On 2026-10-07 Ledger filed every due call "open" at 15:45 and asked Brass
// for a research pull; Brass's answer came back through Brass and the refile
// landed at 16:26. Ledger now asks the research sensor itself (it is a member
// of room:research), in one request that covers every due call it could not
// settle from the record.
//
// Once Caslon has composed, a ledger desk refile changes the desk digest the
// composition sealed, and Pressman's staging refuses the edition ("composed
// desk digest changed"). A late answer must not do that silently, so file_desk
// refuses a Ledger refile after composition; an unsettled call stays open and
// carries into the next edition.

const QUESTION_BYTES = 1200;
const bytes = (text) => Buffer.byteLength(text, 'utf8');

export const ledgerRequestId = (edition) => `ledger-${edition}-calls`;

/** The exact research.request.v1 text for `calls` ([{call, deadline}]), within the sensor's limits. */
export function ledgerResearchRequest(edition, calls) {
  const head = 'Which of these forecast calls has resolved? For each, give the dated, sourced outcome, or say none is published yet:';
  let question = head;
  for (const [index, { call, deadline }] of calls.entries()) {
    const line = ` (${index + 1}) ${String(call).replace(/\s+/gu, ' ').trim().slice(0, 240)}${deadline ? ` [deadline ${deadline}]` : ''}`;
    if (bytes(question + line) > QUESTION_BYTES) break;
    question += line;
  }
  return JSON.stringify({
    kind: 'research.request.v1', request_id: ledgerRequestId(edition), from: 'ledger', edition, story_id: 'ledger-settlements',
    question, discriminator: 'An official or primary published record, dated, that settles the call as stated.'
  });
}

/** The `next` line for an accepted ledger.settlements filing that keeps due calls open, or undefined. */
export function ledgerFilingNext(edition, openDue) {
  if (openDue.length === 0) return undefined;
  return `Filed. ${openDue.length} due call(s) stay open. If you have not sent ${ledgerRequestId(edition)} yet, send this exact text with moltnet_send on network clank-newsroom to room:research, then end the turn; the answer mentions you. Settle from it and file ledger.settlements again before Caslon composes: ${ledgerResearchRequest(edition, openDue)}`;
}

/** Throws when a Ledger desk document would change a composed edition; refiling the same bytes is harmless. */
export function assertLedgerDeskOpen(name, edition, { composed, unchanged = false }) {
  if (!composed || unchanged || !name.startsWith('ledger.')) return;
  throw new Error(`edition ${edition} is composed; refiling ${name} now would change the desk the composition sealed and Pressman could not stage it. Nothing was recorded. A call still open stays open and carries into the next edition's ledger.settlements; end the turn`);
}
