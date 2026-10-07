// What the Tape says about itself, derived from what it actually carries.
//
// On 6 October the masthead promised "Rates · FX · commodities · equities —
// read the tape, priced at the bell" over a page with no price on it, and the
// forecast ledger's key explained a ±1σ band and a five-agent quorum that no
// row supplied. Every label here is built from the data beside it, so a claim
// can only print when the thing it describes is on the page.

export type MarketGroup = 'rates' | 'fx' | 'commodities' | 'equities';
export interface MarketSeries {
  id: string; group: MarketGroup; label: string; unit: string; decimals: number; basis: string; url: string;
  value?: number; previous?: number; observed?: string; previous_observed?: string; unavailable?: string;
}
export interface Markets { source: string; retrieved_at: string; series: MarketSeries[] }
export interface MarketRow {
  id: string; label: string; url: string;
  value?: string; change?: string; dir?: 'up' | 'down' | 'flat'; asOf?: string; vs?: string; unavailable?: string;
}

export const GROUP_LABELS: Record<MarketGroup, string> = { rates: 'Rates', fx: 'FX', commodities: 'Commodities', equities: 'Equities' };
const GROUPS = Object.keys(GROUP_LABELS) as MarketGroup[];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const signed = (n: string) => (n.startsWith('-') ? n.replace('-', '−') : `+${n}`);
const grouped = (n: number, decimals: number) => n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

function formatValue(s: MarketSeries, v: number): string {
  if (s.unit === 'percent') return `${v.toFixed(s.decimals)}%`;
  if (s.unit === 'usd') return `$${grouped(v, s.decimals)}`;
  return grouped(v, s.decimals);
}

/**
 * One board row per series. The change is the difference between the two
 * observations the producer recorded, never a value of its own; a series with
 * one observation prints no change, and one that did not fetch prints
 * "unavailable" with the reason — never a number.
 */
export function marketRow(s: MarketSeries): MarketRow {
  const base = { id: s.id, label: s.label, url: s.url };
  if (typeof s.unavailable === 'string' || typeof s.value !== 'number' || typeof s.observed !== 'string') return { ...base, unavailable: s.unavailable ?? 'no observation' };
  const row: MarketRow = { ...base, value: formatValue(s, s.value), asOf: `${s.basis} ${day(s.observed)}` };
  if (typeof s.previous !== 'number' || typeof s.previous_observed !== 'string') return row;
  const delta = Number((s.value - s.previous).toFixed(s.unit === 'percent' ? 4 : s.decimals + 2));
  row.dir = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  row.vs = `vs ${day(s.previous_observed)}`;
  if (s.unit === 'percent') row.change = `${signed(String(Math.round(delta * 100)))} bp`;
  else row.change = `${signed(delta.toFixed(s.decimals))} (${signed(((delta / s.previous) * 100).toFixed(2))}%)`;
  if (row.change.startsWith('+0 bp') || row.change.startsWith('−0 bp')) row.change = '0 bp';
  return row;
}

/** The board, grouped in masthead order; empty groups are left out. */
export function marketBoard(markets: Markets | null | undefined): Array<{ group: MarketGroup; label: string; rows: MarketRow[] }> {
  const series = Array.isArray(markets?.series) ? markets!.series : [];
  return GROUPS.map((group) => ({ group, label: GROUP_LABELS[group], rows: series.filter((s) => s.group === group).map(marketRow) })).filter((g) => g.rows.length > 0);
}

/**
 * The section tagline: the asset classes with at least one observed price,
 * labelled as the published closes they are. With none, the tagline names
 * what the page does carry.
 */
export function tapeTagline(markets: Markets | null | undefined): string {
  const live = marketBoard(markets).filter((g) => g.rows.some((r) => r.value !== undefined)).map((g) => g.label);
  if (live.length === 0) return 'Open clocks, deadlines and the forecast ledger, read at the bell.';
  const names = live.map((label, i) => (i === 0 || label === 'FX' ? label : label.toLowerCase()));
  return `${names.join(' · ')} — the latest published closes, read at the bell.`;
}

export interface LedgerKeyRow { interval?: number; dissent?: unknown; state?: string }
/**
 * The forecast ledger's key, one `{term, text}` per column the rows fill. The
 * band and the dissent are explained only when at least one row carries one.
 */
export function ledgerKey(rows: LedgerKeyRow[]): Array<{ term: string; text: string }> {
  const band = rows.some((r) => typeof r.interval === 'number');
  const dissent = rows.some((r) => r.dissent);
  return [
    { term: 'Resolves', text: 'the deadline in the call’s own wording.' },
    { term: 'State', text: 'not yet due, then due — awaiting verification until Ledger settles it hit or miss.' },
    { term: 'Posterior', text: `the forecaster’s probability at publication${band ? ', with ± the forecaster’s own uncertainty band where one was filed' : ''}.` },
    ...(dissent ? [{ term: 'Dissent', text: 'names the agent who argued the other side, with their probability.' }] : []),
    { term: 'Settled', text: 'calls move to the Track Record below.' },
  ];
}
