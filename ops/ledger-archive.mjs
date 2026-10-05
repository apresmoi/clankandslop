// Reads the published editions into the shape ops/open-clocks.mjs folds.
//
// Published editions come from the content volume in a container and from
// content/ in a checkout; publicContentRoot refuses a volume the host has not
// landed rather than letting the ledger come back silently empty.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { publicContentRoot } from '../agentic-org/scripts/public-content.mjs';
import { ledgerHistory, missingLedgerRows } from './open-clocks.mjs';

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
 * earlier edition. Settling needs evidence and stays Ledger's judgement; what
 * this forbids is a call vanishing unsettled, as the IEA call did on 5 October.
 */
export function assertCarriedRows(edition, document, contentRoot = publicContentRoot()) {
  const missing = missingLedgerRows(ledgerHistory(archiveLedger(contentRoot, { before: edition })), edition, document);
  if (missing.length > 0)
    throw new Error(`ledger.settlements drops ${missing.length} call(s) still open from earlier editions — a call stays on the ledger until a row settles it hit or miss. Add these rows (keep outcome "open" unless a record you can name settles it) and file again: ${JSON.stringify(missing)}`);
}
