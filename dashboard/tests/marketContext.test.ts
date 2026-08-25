// dashboard/tests/marketContext.test.ts
import {
  enrichMarketContext,
  percentileRank,
  GAUGES,
  PCT_BURN_IN,
  WARN_PCT,
  type MarketContextRow,
} from '../src/marketContext.js';
import { buildMarketContextQuery } from '../src/query.js';

function row(date: string, over: Partial<MarketContextRow> = {}): MarketContextRow {
  return {
    scan_date: date,
    spx_close: 7000, spx_dist_sma150: 5, spx_dist_sma200: 6,
    rsp_close: 220, rsp_slope21: 1,
    vix: 15,
    xlp_spx_ratio: 0.011, xlp_spx_slope21: 0,
    xly_xlp_ratio: 1.37, xly_xlp_slope21: 1,
    s5fi: 55, s5fi_n: 500,
    spy_wr_1d: -70, spy_wr_1w: -20, qqq_wr_1d: -75, qqq_wr_1w: -40,
    universe_breadth: 50, universe_breadth_n: 600, breadth_spread: 5,
    ...over,
  };
}

const day = (i: number) => `2026-01-${String(i).padStart(2, '0')}`;

describe('buildMarketContextQuery', () => {
  // The fragility panel already shipped this bug once: a plain ASC LIMIT pins
  // the window to the oldest rows and the chart stops advancing.
  it('takes the NEWEST rows and returns them ascending', () => {
    const q = buildMarketContextQuery({});
    expect(q.sql).toMatch(/ORDER BY scan_date DESC LIMIT \?\) ORDER BY scan_date ASC/);
  });

  it('is parameterless apart from the limit', () => {
    expect(buildMarketContextQuery({}).params).toEqual([756]);
  });

  it('supports a from-date window', () => {
    const q = buildMarketContextQuery({ from: '2026-01-01', limit: 10 });
    expect(q.params).toEqual(['2026-01-01', 10]);
  });
});

describe('percentileRank', () => {
  it('ranks the maximum at 100 and the minimum at its share', () => {
    expect(percentileRank([1, 2, 3, 4], 4)).toBe(100);
    expect(percentileRank([1, 2, 3, 4], 1)).toBe(25);
  });
});

describe('enrichMarketContext', () => {
  it('emits null percentiles during burn-in', () => {
    const rows = Array.from({ length: PCT_BURN_IN - 1 }, (_, i) => row(day(i + 1)));
    enrichMarketContext(rows);
    for (const r of rows) {
      expect(r.warn_count).toBeNull();
      for (const g of GAUGES) expect(r.pct![g.key]).toBeNull();
    }
  });

  it('scores rows once past burn-in', () => {
    const rows = Array.from({ length: PCT_BURN_IN + 5 }, (_, i) => row(day(i + 1)));
    enrichMarketContext(rows);
    expect(rows[PCT_BURN_IN - 1]!.pct!.vix).toBeNull();
    expect(rows[PCT_BURN_IN]!.pct!.vix).not.toBeNull();
    expect(typeof rows[PCT_BURN_IN]!.warn_count).toBe('number');
  });

  // The direction table is the substance of this module: a stretched index is a
  // warning at the TOP of its range, a complacent VIX at the BOTTOM.
  it('warns on a high reading for high-side gauges and a low one for low-side', () => {
    const rows = Array.from({ length: PCT_BURN_IN }, (_, i) => row(day(i + 1)));
    rows.push(row(day(PCT_BURN_IN + 1), { spx_dist_sma150: 999, vix: -999 }));
    enrichMarketContext(rows);
    const last = rows[rows.length - 1]!;
    expect(last.pct!.spx_dist_sma150).toBeGreaterThanOrEqual(WARN_PCT);
    expect(last.pct!.vix).toBeLessThanOrEqual(100 - WARN_PCT);
    expect(last.warn_count).toBeGreaterThanOrEqual(2);
  });

  it('never ranks a row against the future', () => {
    // A huge final reading must not raise the percentile of any earlier row.
    const rows = Array.from({ length: PCT_BURN_IN + 2 }, (_, i) => row(day(i + 1)));
    const withSpike = rows.map((r) => ({ ...r }));
    withSpike[withSpike.length - 1]!.vix = 999;
    enrichMarketContext(rows);
    enrichMarketContext(withSpike);
    expect(withSpike[PCT_BURN_IN]!.pct!.vix).toBe(rows[PCT_BURN_IN]!.pct!.vix);
  });

  it('leaves a null gauge null and drops it from the warning count', () => {
    // A flat series puts every gauge at the 100th percentile, so each high-side
    // gauge warns. Nulling one must remove exactly its own warning, no more.
    const base = Array.from({ length: PCT_BURN_IN + 1 }, (_, i) => row(day(i + 1)));
    const holed = base.map((r) => ({ ...r }));
    holed[holed.length - 1]!.s5fi = null;
    enrichMarketContext(base);
    enrichMarketContext(holed);

    const withS5fi = base[base.length - 1]!;
    const without = holed[holed.length - 1]!;
    expect(withS5fi.pct!.s5fi).toBe(100);
    expect(without.pct!.s5fi).toBeNull();
    expect(without.warn_count).toBe(withS5fi.warn_count! - 1);
  });

  it('returns warn_count null when no gauge could be scored at all', () => {
    const blank = GAUGES.reduce((acc, g) => ({ ...acc, [g.key]: null }), {});
    const rows = [row(day(1), blank)];
    enrichMarketContext(rows);
    expect(rows[0]!.warn_count).toBeNull();
  });
});

describe('breadth spread', () => {
  // The spread is scored so the panel can show its percentile, but it must NOT
  // change warn_count — that number says "N/6" and 250 backfilled rows already
  // carry that definition.
  it('gets a percentile without joining the six', () => {
    const rows = Array.from({ length: PCT_BURN_IN + 1 }, (_, i) => row(day(i + 1)));
    rows[rows.length - 1]!.breadth_spread = 999;
    enrichMarketContext(rows);
    const last = rows[rows.length - 1]!;
    expect(last.pct!.breadth_spread).toBe(100);
    expect(last.warn_count).toBeLessThanOrEqual(GAUGES.length);
  });

  it('an extreme spread does not raise warn_count', () => {
    const calm = Array.from({ length: PCT_BURN_IN + 1 }, (_, i) => row(day(i + 1)));
    const spiked = calm.map((r) => ({ ...r }));
    spiked[spiked.length - 1]!.breadth_spread = 999;
    enrichMarketContext(calm);
    enrichMarketContext(spiked);
    expect(spiked[spiked.length - 1]!.warn_count).toBe(calm[calm.length - 1]!.warn_count);
  });

  it('leaves the spread percentile null when the value is missing', () => {
    const rows = Array.from({ length: PCT_BURN_IN + 1 }, (_, i) => row(day(i + 1)));
    rows[rows.length - 1]!.breadth_spread = null;
    enrichMarketContext(rows);
    expect(rows[rows.length - 1]!.pct!.breadth_spread).toBeNull();
  });
});

describe('universe breadth', () => {
  // Same contract as breadth_spread: percentile scored for the tile's own
  // warning badge, but must NOT join warn_count's "N/6".
  it('gets a percentile without joining the six', () => {
    const rows = Array.from({ length: PCT_BURN_IN + 1 }, (_, i) => row(day(i + 1)));
    rows[rows.length - 1]!.universe_breadth = 999;
    enrichMarketContext(rows);
    const last = rows[rows.length - 1]!;
    expect(last.pct!.universe_breadth).toBe(100);
    expect(last.warn_count).toBeLessThanOrEqual(GAUGES.length);
  });

  it('an extreme universe_breadth does not raise warn_count', () => {
    const calm = Array.from({ length: PCT_BURN_IN + 1 }, (_, i) => row(day(i + 1)));
    const spiked = calm.map((r) => ({ ...r }));
    spiked[spiked.length - 1]!.universe_breadth = 999;
    enrichMarketContext(calm);
    enrichMarketContext(spiked);
    expect(spiked[spiked.length - 1]!.warn_count).toBe(calm[calm.length - 1]!.warn_count);
  });

  it('leaves the percentile null when the value is missing', () => {
    const rows = Array.from({ length: PCT_BURN_IN + 1 }, (_, i) => row(day(i + 1)));
    rows[rows.length - 1]!.universe_breadth = null;
    enrichMarketContext(rows);
    expect(rows[rows.length - 1]!.pct!.universe_breadth).toBeNull();
  });
});
