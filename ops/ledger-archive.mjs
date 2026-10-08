// Reads the published editions into the shape ops/open-clocks.mjs folds.
//
// Published editions come from the content volume in a container and from
// content/ in a checkout; publicContentRoot refuses a volume the host has not
// landed rather than letting the ledger come back silently empty.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { publicContentRoot } from '../agentic-org/scripts/public-content.mjs';
import { NOTE_MIN_WORDS, SETTLE_GRACE_DAYS, callKey, carriedCalls, dueCallFindings, ledgerHistory, missingLedgerRows } from './open-clocks.mjs';
import { callState } from './ledger-states.mjs';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** `[{date, settlements, articles}]` for every published edition before `before` (all, if omitted). */
export function archiveLedger(contentRoot = publicContentRoot(), { before } = {}) {
  const dir = resolve(contentRoot, 'editions');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const date of readdirSync(dir).filter((name) => DATE.test(name)).sort()) {
    if (before !== undefined && date >= before) continue;
    const settlementsFile = resolve(dir, date, 'desk', 'ledger.settlements.json');
    const articlesDir = resolve(dir, date, 'articles');
    const articles = existsSync(articlesDir) ? readdirSync(articlesDir).filter((f) => f.endsWith('.json')).sort().map((f) => readJson(resolve(articlesDir, f))) : [];
    out.push({ date, settlements: existsSync(settlementsFile) ? readJson(settlementsFile) : { resolved_last_edition: [] }, articles });
  }
  return out;
}

/**
 * Refuses a `ledger.settlements` filing that drops a call still open from an
 * earlier edition, or leaves a due call unexplained. Settling needs evidence
 * and stays Ledger's judgement; what this forbids is a call vanishing
 * unsettled, as the IEA call did on 5 October, and an overdue call printed as
 * plain "open" with no word on what was checked, as three were on 6 October.
 */
export function assertCarriedRows(edition, document, contentRoot = publicContentRoot()) {
  const history = ledgerHistory(archiveLedger(contentRoot, { before: edition }));
  const missing = missingLedgerRows(history, edition, document);
  if (missing.length > 0)
    throw new Error(`ledger.settlements drops ${missing.length} call(s) still open from earlier editions — a call stays on the ledger until a row settles it hit, miss or cancelled. Add these rows (keep outcome "open" unless a record you can name settles it) and file again: ${JSON.stringify(missing)}`);
  const findings = dueCallFindings(history, edition, document);
  const overdue = findings.filter((f) => f.must_settle);
  if (overdue.length > 0)
    throw new Error(`ledger.settlements keeps ${overdue.length} call(s) open more than ${SETTLE_GRACE_DAYS} days past their deadline — a call that far past its window is settled, not explained: "miss" when the record that would make it a hit is still absent after checking the corpus and the research answer (say what you searched in "note"), "hit" when that record exists (name it in "note"), or "cancelled" with the reason in "note" when no public record could ever decide it as worded. Fix these rows and file again: ${JSON.stringify(overdue.map(({ must_settle, ...f }) => f))}`);
  const due = findings;
  if (due.length > 0)
    throw new Error(`ledger.settlements leaves ${due.length} due call(s) unexplained — each call whose deadline has passed is settled "hit" or "miss" from a record you can name, "cancelled" with the reason in "note", or stays "open" with a "note" of at least ${NOTE_MIN_WORDS} words saying what you checked and why it is still unresolved (e.g. "Checked the day's corpus and research answer ledger-<date>-calls; no IEA schedule found by 16:00 UTC"). Fix these rows and file again: ${JSON.stringify(due)}`);
}

/**
 * The due calls a `ledger.settlements` filing for `edition` keeps "open":
 * deadline passed, nothing on the record settles them yet. These are what
 * Ledger asks the research sensor about. `[{call, deadline}]`.
 */
export function openDueCalls(edition, document, contentRoot = publicContentRoot()) {
  const history = ledgerHistory(archiveLedger(contentRoot, { before: edition }));
  const rows = new Map((Array.isArray(document?.resolved_last_edition) ? document.resolved_last_edition : []).map((row) => [callKey(row?.call), row]));
  return carriedCalls(history, edition).filter((entry) => callState(entry, edition) === 'due' && (rows.get(callKey(entry.call))?.outcome ?? 'open') === 'open').map(({ call, deadline }) => ({ call, deadline: deadline ?? null }));
}
