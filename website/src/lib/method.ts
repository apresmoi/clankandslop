// Scores use the first publication and the observed event in the same orientation.
import { ledgerHistory, ledgerSnapshot } from '../../../ops/open-clocks.mjs';
import { eventHappened } from '../../../ops/forecast-events.mjs';
import { ledgerArchive, forecastSnapshot, type LedgerEdition } from './track-record.ts';

interface Entry { call: string; prior_p: number; outcome: 'hit' | 'miss' | 'open' | 'cancelled'; opened: string; deadline?: string | null }

export interface CalibrationBin {
  /** "0.5–0.6": the confidence the paper put on its own call. */
  label: string;
  low: number;
  high: number;
  n: number;
  /** Mean stated confidence in the call. */
  stated: number;
  /** Share of those calls that came true. */
  hit_rate: number;
}

export interface MethodRecord {
  as_of: string;
  settled: number;
  hit: number;
  miss: number;
  cancelled: number;
  /** Mean (p − outcome)² over settled calls; 0 is perfect, lower is better. */
  brier: number | null;
  /** The coin flip: p = 0.5 on every call scores 0.25 whatever happens. */
  coin_brier: number;
  /** One fixed p for every call, the share of YES outcomes — known only in hindsight. */
  base_rate: number | null;
  base_rate_brier: number | null;
  calibration: CalibrationBin[];
  /** Open calls, as the Tape sees them going into `as_of`. */
  pending: number;
  due: number;
}

const BINS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
const round = (x: number) => Math.round(x * 1000) / 1000;
// The confidence the paper put on its own call; float noise (1 − 0.3) must not move a bin edge.
const confidence = (p: number) => Math.round(Math.max(p, 1 - p) * 1e9) / 1e9;

/** Did the event the call asks about happen? */
export const happened = eventHappened;

export function methodRecordFrom(editions: LedgerEdition[], date: string, snapshot = ledgerSnapshot(editions, date)): MethodRecord {
  const upTo = editions.filter((e) => e.date <= date);
  // Every call ever settled, the Track Record's "record to date".
  const all = ledgerHistory(upTo, { epoch: '0000-00-00' }) as Entry[];
  const settled = all.filter((c): c is Entry & { outcome: 'hit' | 'miss' } => c.outcome === 'hit' || c.outcome === 'miss');

  const n = settled.length;
  const ys = settled.map((c) => (happened(c) ? 1 : 0));
  const brier = n ? settled.reduce((sum, c, i) => sum + (c.prior_p - ys[i]) ** 2, 0) / n : null;
  const base = n ? ys.reduce((a: number, b) => a + b, 0) / n : null;

  const calibration: CalibrationBin[] = [];
  for (let i = 0; i < BINS.length - 1; i += 1) {
    const [low, high] = [BINS[i], BINS[i + 1]];
    const last = i === BINS.length - 2;
    const inBin = settled.filter((c) => { const conf = confidence(c.prior_p); return conf >= low && (last ? conf <= high : conf < high); });
    if (inBin.length === 0) continue;
    calibration.push({
      label: `${low.toFixed(1)}–${high.toFixed(1)}`, low, high, n: inBin.length,
      stated: round(inBin.reduce((s, c) => s + confidence(c.prior_p), 0) / inBin.length),
      hit_rate: round(inBin.filter((c) => c.outcome === 'hit').length / inBin.length),
    });
  }

  return {
    as_of: date,
    settled: n,
    hit: settled.filter((c) => c.outcome === 'hit').length,
    miss: settled.filter((c) => c.outcome === 'miss').length,
    cancelled: all.filter((c) => c.outcome === 'cancelled').length,
    brier: brier === null ? null : round(brier),
    coin_brier: 0.25,
    base_rate: base === null ? null : round(base),
    base_rate_brier: base === null ? null : round(base * (1 - base)),
    calibration,
    pending: snapshot.pending,
    due: snapshot.due,
  };
}

export function methodRecord(date: string): MethodRecord {
  return methodRecordFrom(ledgerArchive(), date, forecastSnapshot(date));
}
