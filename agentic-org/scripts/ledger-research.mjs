// Ledger's own research request, and the line after which its desk is sealed.
//
// On 2026-10-07 Ledger filed every due call "open" at 15:45 and asked Brass
// for a research pull; Brass's answer came back through Brass and the refile
// landed at 16:26. Ledger now asks the research sensor itself (it is a member
// of room:research), one request per due call it could not settle from the
// record, each id stable so a resend is a harmless duplicate.
//
// Once Caslon has composed, a ledger desk refile changes the desk digest the
// composition sealed, and Pressman's staging refuses the edition ("composed
// desk digest changed"). A late answer must not do that silently, so file_desk
// refuses a Ledger refile after composition; an unsettled call stays open and
// carries into the next edition.

import { createHash } from 'node:crypto';

const QUESTION_BYTES = 1200;
// The sensor admits a handful of requests per requester per edition; the rest
// of the due calls are settled from the record or kept open with a note.
export const LEDGER_REQUESTS_MAX = 4;
const bytes = (text) => Buffer.byteLength(text, 'utf8');
const clip = (text, budget) => { if (bytes(text) <= budget) return text; let out = ''; for (const char of text) { if (bytes(`${out}${char}…`) > budget) return `${out}…`; out += char; } return out; };

/** One request per call, its id stable across refiles so a resend is a duplicate, never a conflicting reuse. */
export const ledgerRequestId = (edition, call) => `ledger-${edition}-call-${createHash('sha256').update(String(call).replace(/\s+/gu, ' ').trim().toLowerCase()).digest('hex').slice(0, 10)}`;

/** The exact research.request.v1 text asking whether one due call ({call, deadline}) has resolved. */
export function ledgerResearchRequest(edition, { call, deadline }) {
  const text = String(call).replace(/\s+/gu, ' ').trim(), head = `Has this forecast call resolved${deadline ? ` (deadline ${deadline})` : ''}? Give the dated, sourced outcome, or say none is published yet. The call: `;
  return JSON.stringify({
    kind: 'research.request.v1', request_id: ledgerRequestId(edition, text), from: 'ledger', edition, story_id: 'ledger-settlements',
    question: head + clip(text, QUESTION_BYTES - bytes(head)), discriminator: 'An official or primary published record, dated, that settles the call exactly as stated.'
  });
}

/** The `next` line for an accepted ledger.settlements filing that keeps due calls open, or undefined. */
export function ledgerFilingNext(edition, openDue) {
  if (openDue.length === 0) return undefined;
  const asked = openDue.slice(0, LEDGER_REQUESTS_MAX), rest = openDue.length - asked.length;
  return `Filed. ${openDue.length} due call(s) stay open. Send each text below as its own moltnet_send on network clank-newsroom to room:research (a request already sent is ignored as a duplicate), then end the turn; each answer mentions you. Settle from them and file ledger.settlements again before Caslon composes.${rest > 0 ? ` ${rest} more due call(s) are not asked today: settle them from the record or keep their note.` : ''} ${asked.map((entry) => ledgerResearchRequest(edition, entry)).join(' ')}`;
}

/** Throws when a Ledger desk document would change a composed edition; refiling the same bytes is harmless. */
export function assertLedgerDeskOpen(name, edition, { composed, unchanged = false }) {
  if (!composed || unchanged || !name.startsWith('ledger.')) return;
  throw new Error(`edition ${edition} is composed; refiling ${name} now would change the desk the composition sealed and Pressman could not stage it. Nothing was recorded. A call still open stays open and carries into the next edition's ledger.settlements; end the turn`);
}
