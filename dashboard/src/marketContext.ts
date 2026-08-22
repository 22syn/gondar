// dashboard/src/marketContext.ts
//
// Read-time enrichment for the Market Context panel: percentile context and a
// warning count, computed from the stored raw gauges.
//
// Neither is stored in D1, on purpose. Both derive from a rolling window, so
// keeping them out of the table means the window can be retuned without a
// backfill. It also resolves an ordering problem: the warning count is derived
// from the percentiles, so it cannot exist before them.
//
// This lives in src/ rather than inside the Pages Function for the same reason
// qqqOverlay.ts does — alpha-engine vendors this dashboard offline and builds
// its /api/* payloads from a D1 snapshot of table rows. Anything computed at
// read time has to be runnable outside a Worker or that copy silently differs.
//
// **Percentiles are backward-looking only.** Row i is ranked against rows
// 0..i, never against the future. A panel whose historical states were scored
// with hindsight would look far more prescient than it is.

/** Rolling window cap, ~3 years of trading days. */
export const PCT_WINDOW = 756;
/** Prior observations required before a percentile is emitted. */
export const PCT_BURN_IN = 60;
/** A gauge is "warning" at or beyond this percentile, in its warning direction. */
export const WARN_PCT = 90;

/**
 * The six gauges, and which end of their own distribution is the warning.
 *
 * `high` = an unusually high reading is the warning (stretched index, defensive
 * rotation, overbought breadth). `low` = an unusually low reading is
 * (participation narrowing, complacent VIX, risk-off consumer).
 *
 * The direction is the whole content of this table — thresholds are NOT the
 * absolute numbers quoted in the source video. Measured 2026-08-22 on 202
 * trading days of real S5FI: the video's "overbought above 70" fired on 3% of
 * days and its "buying opportunity below 14" fired on ZERO (the minimum reading
 * was 19.3). Percentiles of the gauge's own history fire at a usable rate and
 * survive the fact that our universe is not the video's.
 */
export const GAUGES = [
  { key: 'spx_dist_sma150', label: 'SPX vs SMA150', warnAt: 'high', unit: '%' },
  { key: 'rsp_slope21', label: 'RSP 21d trend', warnAt: 'low', unit: '%' },
  { key: 'vix', label: 'VIX', warnAt: 'low', unit: '' },
  { key: 'xlp_spx_slope21', label: 'XLP/SPX 21d', warnAt: 'high', unit: '%' },
  { key: 'xly_xlp_slope21', label: 'XLY/XLP 21d', warnAt: 'low', unit: '%' },
  { key: 's5fi', label: 'S5FI breadth', warnAt: 'high', unit: '%' },
] as const;

export type GaugeKey = (typeof GAUGES)[number]['key'];

export interface MarketContextRow {
  scan_date: string;
  spx_close: number | null;
  spx_dist_sma150: number | null;
  spx_dist_sma200: number | null;
  rsp_close: number | null;
  rsp_slope21: number | null;
  vix: number | null;
  xlp_spx_ratio: number | null;
  xlp_spx_slope21: number | null;
  xly_xlp_ratio: number | null;
  xly_xlp_slope21: number | null;
  s5fi: number | null;
  s5fi_n: number | null;
  spy_wr_1d: number | null;
  spy_wr_1w: number | null;
  qqq_wr_1d: number | null;
  qqq_wr_1w: number | null;
  /** Percentile of each gauge within its own trailing window; null during burn-in. */
  pct?: Partial<Record<GaugeKey, number | null>>;
  /** How many of the six gauges sit in their warning tail. Null during burn-in. */
  warn_count?: number | null;
}

/**
 * Percentile rank of `value` within `history` (0-100), counting values at or
 * below it. `history` must already include `value`.
 */
export function percentileRank(history: number[], value: number): number {
  if (history.length === 0) return 50;
  const atOrBelow = history.filter((h) => h <= value).length;
  return (atOrBelow / history.length) * 100;
}

/**
 * Attach `pct` and `warn_count` to every row, in place.
 * Rows must be ascending by scan_date — the caller's query guarantees this.
 */
export function enrichMarketContext(rows: MarketContextRow[]): MarketContextRow[] {
  const history: Record<string, number[]> = {};
  for (const g of GAUGES) history[g.key] = [];

  for (const row of rows) {
    const pct: Partial<Record<GaugeKey, number | null>> = {};
    let warn = 0;
    let scored = 0;

    for (const g of GAUGES) {
      const value = row[g.key];
      if (value == null || !Number.isFinite(value)) {
        pct[g.key] = null;
        continue;
      }
      const hist = history[g.key]!;
      // Burn-in is measured on PRIOR observations, before today joins them.
      if (hist.length < PCT_BURN_IN) {
        hist.push(value);
        if (hist.length > PCT_WINDOW) hist.shift();
        pct[g.key] = null;
        continue;
      }
      hist.push(value);
      if (hist.length > PCT_WINDOW) hist.shift();

      const p = percentileRank(hist, value);
      pct[g.key] = p;
      scored++;
      const warning = g.warnAt === 'high' ? p >= WARN_PCT : p <= 100 - WARN_PCT;
      if (warning) warn++;
    }

    row.pct = pct;
    row.warn_count = scored > 0 ? warn : null;
  }
  return rows;
}
