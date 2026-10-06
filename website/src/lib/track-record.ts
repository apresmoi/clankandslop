import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contentRoot } from './edition.ts';
// One fold for the tape, Ledger's filing gate and this strip: a call stays
// open across editions until a settlement row marks it hit or miss.
import { ledgerHistory } from '../../../ops/open-clocks.mjs';
import { CALL_STATES, callState, shortDay } from '../../../ops/ledger-states.mjs';

export type Outcome = 'hit' | 'miss' | 'open' | 'cancelled';
export type CallState = 'pending' | 'due' | 'hit' | 'miss' | 'cancelled';
export interface TrackRow { call: string; outcome: Outcome; prior_p: number; note?: string }
export interface TrackItem { call: string; outcome: Outcome; prior_p: number; state: CallState; state_label: string; deadline?: string; note?: string; noted?: string }
export interface LedgerEdition { date: string; settlements: { resolved_last_edition?: TrackRow[] }; articles: unknown[] }
export interface TrackRecordView { items: TrackItem[]; record: { hit: number; miss: number } }
type Entry = TrackRow & { opened: string; settled_on?: string; deadline?: string | null; noted_on?: string };

/**
 * The Track Record as of `date`, read from the persistent ledger rather than
 * from that one edition's settlement file: the calls that settled (or were
 * cancelled) at this bell, every call still open in its state — not yet due,
 * or due and awaiting verification with Ledger's note on what was checked —
 * and the paper's whole hit/miss record to date. 2026-10-05 printed "the
 * ledger opens today" while 4 October's IEA call was still running; an empty
 * strip now means the ledger really is empty.
 */
export function trackRecordFrom(editions: LedgerEdition[], date: string): TrackRecordView {
  const upTo = editions.filter((e) => e.date <= date);
  // Today's articles open calls for tomorrow; only today's rows count today.
  const asOf = upTo.map((e) => (e.date === date ? { ...e, articles: [] } : e));
  const history = ledgerHistory(asOf) as Entry[];
  const items = [
    ...history.filter((c) => c.outcome !== 'open' && c.settled_on === date),
    ...history.filter((c) => c.outcome === 'open'),
  ].map((c): TrackItem => {
    const state = callState(c, date) as CallState;
    const shown = state !== 'pending' && typeof c.note === 'string';
    return {
      call: c.call, outcome: c.outcome, prior_p: c.prior_p, state, state_label: CALL_STATES[state],
      ...(c.deadline ? { deadline: shortDay(c.deadline) } : {}),
      ...(shown ? { note: c.note, noted: shortDay(c.noted_on) } : {}),
    };
  });
  const settled = (ledgerHistory(asOf, { epoch: '0000-00-00' }) as TrackRow[]);
  return { items, record: { hit: settled.filter((c) => c.outcome === 'hit').length, miss: settled.filter((c) => c.outcome === 'miss').length } };
}

let archive: LedgerEdition[] | undefined;
function readJson(file: string): any { return JSON.parse(readFileSync(file, 'utf-8')); }

/** Every published edition's settlements and articles, read once per build. */
export function ledgerArchive(root: string = contentRoot): LedgerEdition[] {
  if (root === contentRoot && archive) return archive;
  const dir = resolve(root, 'editions');
  const out: LedgerEdition[] = [];
  for (const date of existsSync(dir) ? readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/u.test(d)).sort() : []) {
    const file = resolve(dir, date, 'desk', 'ledger.settlements.json');
    const articlesDir = resolve(dir, date, 'articles');
    const articles = existsSync(articlesDir) ? readdirSync(articlesDir).filter((f) => f.endsWith('.json')).sort().map((f) => readJson(resolve(articlesDir, f))) : [];
    out.push({ date, settlements: existsSync(file) ? readJson(file) : { resolved_last_edition: [] }, articles });
  }
  if (root === contentRoot) archive = out;
  return out;
}

export function trackRecord(date: string): TrackRecordView {
  return trackRecordFrom(ledgerArchive(), date);
}
