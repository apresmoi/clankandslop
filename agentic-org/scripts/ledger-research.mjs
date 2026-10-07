// Ledger's own research request, and the line after which its desk is sealed.
//
// On 2026-10-07 Ledger filed every due call "open" at 15:45 and asked Brass
// for a research pull; Brass's answer came back through Brass and the refile
// landed at 16:26. Ledger now asks the research sensor itself (it is a member
// of room:research), in one request (ledger-<date>-due) listing every due
// call it could not settle from the record.
//
// Once Caslon has composed, a ledger desk refile changes the desk digest the
// composition sealed, and Pressman's staging refuses the edition ("composed
// desk digest changed"). A late answer must not do that silently, so file_desk
// refuses a Ledger refile after composition; an unsettled call stays open and
// carries into the next edition.

const QUESTION_BYTES = 1200;
// The sensor admits a handful of requests per requester per edition. Calls are
// never cut short (a clipped call loses its settlement criteria); a list too
// long for one question overflows into -2, -3, and anything past that is
// settled from the record or kept open with a note.
export const LEDGER_REQUESTS_MAX = 3;
const bytes = (text) => Buffer.byteLength(text, 'utf8');
const HEAD = 'Which of these forecast calls has resolved? For each, give the dated, sourced outcome, or say none is published yet:';

/** `ledger-<date>-due`, then `-due-2`, `-due-3`: the ids RUNBOOK and RESEARCH_ROUND_TRIP name. */
export const ledgerRequestId = (edition, batch = 1) => `ledger-${edition}-due${batch > 1 ? `-${batch}` : ''}`;
const line = (index, { call, deadline }) => ` (${index}) ${String(call).replace(/\s+/gu, ' ').trim()}${deadline ? ` [deadline ${deadline}]` : ''}`;

/** The exact research.request.v1 texts for `calls` ([{call, deadline}]): whole calls, batched to the sensor's limits. */
export function ledgerResearchRequests(edition, calls) {
  const batches = [], left = [];
  let question = HEAD, count = 0;
  for (const entry of calls) {
    const next = line(count + 1, entry);
    if (bytes(HEAD + line(1, entry)) > QUESTION_BYTES) { left.push(entry); continue; }
    if (bytes(question + next) > QUESTION_BYTES) { batches.push(question); question = HEAD; count = 0; }
    if (batches.length >= LEDGER_REQUESTS_MAX) { left.push(entry); continue; }
    question += line(++count, entry);
  }
  if (count > 0 && batches.length < LEDGER_REQUESTS_MAX) batches.push(question);
  const texts = batches.map((text, index) => JSON.stringify({
    kind: 'research.request.v1', request_id: ledgerRequestId(edition, index + 1), from: 'ledger', edition, story_id: 'ledger-settlements',
    question: text, discriminator: 'An official or primary published record, dated, that settles each call exactly as stated.'
  }));
  return { texts, left: left.length };
}

/** The `next` line for an accepted ledger.settlements filing that keeps due calls open, or undefined. */
export function ledgerFilingNext(edition, openDue) {
  if (openDue.length === 0) return undefined;
  const { texts, left } = ledgerResearchRequests(edition, openDue);
  return `Filed. ${openDue.length} due call(s) stay open. If you have not sent ${ledgerRequestId(edition)} today, send ${texts.length === 1 ? 'this exact text' : 'each text below as its own message'} with moltnet_send on network clank-newsroom to room:research, then end the turn; the answer mentions you. Settle from it and file ledger.settlements again before Caslon composes.${left > 0 ? ` ${left} due call(s) did not fit: settle them from the record or keep their note.` : ''} ${texts.join(' ')}`;
}

/** Throws when a Ledger desk document would change a composed edition; refiling the same bytes is harmless. */
export function assertLedgerDeskOpen(name, edition, { composed, unchanged = false }) {
  if (!composed || unchanged || !name.startsWith('ledger.')) return;
  throw new Error(`edition ${edition} is composed; refiling ${name} now would change the desk the composition sealed and Pressman could not stage it. Nothing was recorded. A call still open stays open and carries into the next edition's ledger.settlements; end the turn`);
}
