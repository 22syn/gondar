// dashboard/functions/api/fragility.ts
//
// Purple List fragility series (fragility_daily) — written daily by the
// Smart pipeline (main branch, fragilityD1Ingest.ts). Standalone per-day
// scalar series: no mergeSetup/enrich involvement. The table may not exist
// until the first Smart ingest — treat errors as an empty series.
import { buildFragilityQuery } from '../../src/query.js';
import { rollingWilliamsRByDate } from '../../src/williamsR.js';

interface Env { DB: D1Database; }

interface FragilityRow {
  scan_date: string;
  score: number;
  /** Watch-tier score (wick10+dist20+disp10 z-mean) — model v2, PR #82. Part of the
   *  real 🟡 alert rule (core3>=1.0 OR climax>=1.5+nearHigh); not drawn as its own
   *  line (would clutter the chart) — surfaced in the tooltip instead. */
  core3: number | null;
  /** Contextual volume climax (euphoria-context, near a high) — model v2, PR #82.
   *  Same tooltip-only treatment as core3. */
  climax: number | null;
  /** Capitulation Score (מד המיצוי) — bottom-detection companion gauge, descriptive
   *  only (no threshold/alert tied to it). See explainer tab for our own validation. */
  capitulation: number | null;
  wick10_z: number | null;
  pct_above50_z: number | null;
  dist20_z: number | null;
  ext50_z: number | null;
  corr20_z: number | null;
  disp10_z: number | null;
  index_value: number | null;
  drawdown_pct: number | null;
  canary_count: number | null;
  /** QQQ close rebased to 100 at this series' first trading day — lets the
   *  dashboard overlay "did the fragility peak lead the market pullback"
   *  without a raw-price/score scale clash. Null when the Yahoo fetch fails
   *  or a given scan_date has no matching QQQ bar (holiday mismatch etc). */
  qqq_index?: number | null;
  /** Williams %R (14-WEEK) on SPY — a market-wide "panic extreme" timing gauge.
   *  Deliberately SPY + weekly, not QQQ + daily: this replicates the exact
   *  instrument/timeframe in RonnieV's reference chart (SPY, 1W, TradingView,
   *  reused for the Tariffgeddon/Iran/QQQ-2026-correction tweet) rather than
   *  an assumed default. Updates once per completed week — the same value
   *  repeats across every trading day within that week (a step function, by
   *  design). Null on Yahoo fetch failure or during the 14-week burn-in. */
  spy_w_williams_r?: number | null;
  /** SPY close for that same completed weekly bar (raw $, not rebased) — the
   *  price panel that pairs with spy_w_williams_r, so "what did price actually
   *  do" sits directly under "what did the oscillator say" like RonnieV's
   *  reference chart (oscillator pane above, price pane below). */
  spy_price?: number | null;
}

/** One completed SPY weekly bar. */
interface WeeklyPoint {
  /** Yahoo's bar date for that week (typically the week's first trading day). */
  date: string;
  close: number;
  /** Williams %R at this bar; undefined during the 14-week burn-in. */
  wr: number | undefined;
}

const WILLIAMS_R_PERIOD = 14;

/**
 * Nasdaq-100 (QQQ) daily close, fetched live from Yahoo Finance and rebased
 * to 100 at the first row's date. QQQ (not SPY) because the Purple List
 * basket is the radar's own momentum/high-RVOL, growth-tilted watchlist,
 * which tracks the Nasdaq-100 far more tightly than the broader,
 * value-heavier S&P. Best-effort: any failure must not break the panel.
 */
async function fetchQqqCloseByDate(fromDate: string): Promise<Map<string, number>> {
  const rangeDays = Math.ceil((Date.now() - new Date(fromDate + 'T00:00:00Z').getTime()) / 86_400_000) + 5;
  const range = rangeDays > 365 ? '2y' : '1y';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/QQQ?interval=1d&range=${range}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json',
    },
  });
  if (!response.ok) return new Map();

  const data = (await response.json()) as { chart?: { result?: Array<{
    timestamp?: number[];
    indicators?: { quote?: Array<{ close?: (number | null)[] }> };
  }> } };
  const result = data?.chart?.result?.[0];
  const ts = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!ts?.length || !closes?.length) return new Map();

  const closeByDate = new Map<string, number>();
  for (let i = 0; i < ts.length; i++) {
    const close = closes[i];
    if (close == null) continue;
    const date = new Date(ts[i]! * 1000).toISOString().slice(0, 10);
    closeByDate.set(date, close);
  }
  return closeByDate;
}

/**
 * SPY weekly Williams %R (14-week) — the exact instrument/timeframe/period
 * in RonnieV's reference chart (SPY · 1W · TradingView) for the "panic
 * extreme" market-timing gauge his tweet described. Fetched live from Yahoo
 * (weekly bars), computed once per completed week. Best-effort: any failure
 * must not break the fragility panel itself.
 */
async function fetchSpyWeeklyWilliamsR(fromDate: string): Promise<WeeklyPoint[]> {
  const weeksSpan = Math.ceil((Date.now() - new Date(fromDate + 'T00:00:00Z').getTime()) / (7 * 86_400_000));
  // Generous buffer: burn-in (14 weeks) + the visible span, rounded up to a Yahoo
  // range bucket. NEVER 'max': Yahoo silently coarsens interval=1wk+range=max to
  // MONTHLY bars (verified empirically) — always request an explicit bounded range.
  const range = weeksSpan + WILLIAMS_R_PERIOD > 100 ? '5y' : '2y';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1wk&range=${range}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json',
    },
  });
  if (!response.ok) return [];

  const data = (await response.json()) as { chart?: { result?: Array<{
    timestamp?: number[];
    indicators?: { quote?: Array<{ close?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[] }> };
  }> } };
  const result = data?.chart?.result?.[0];
  const ts = result?.timestamp;
  const quote = result?.indicators?.quote?.[0];
  const rawCloses = quote?.close;
  if (!ts?.length || !rawCloses?.length) return [];

  const dates: string[] = [];
  const closes: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = 0; i < ts.length; i++) {
    const close = rawCloses[i];
    if (close == null) continue;
    const date = new Date(ts[i]! * 1000).toISOString().slice(0, 10);
    const high = quote?.high?.[i];
    const low = quote?.low?.[i];
    dates.push(date);
    closes.push(close);
    highs.push(high != null && high > 0 ? high : close);
    lows.push(low != null && low > 0 ? low : close);
  }

  const wrByDate = rollingWilliamsRByDate(dates, highs, lows, closes, WILLIAMS_R_PERIOD);
  return dates.map((d, i) => ({ date: d, close: closes[i]!, wr: wrByDate.get(d) }));
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  try {
    const q = buildFragilityQuery({});
    const { results } = await env.DB.prepare(q.sql).bind(...q.params).all<FragilityRow>();
    const rows: FragilityRow[] = results ?? [];
    if (rows.length === 0) return Response.json(rows);

    try {
      const closeByDate = await fetchQqqCloseByDate(rows[0]!.scan_date);
      // Carry the last-known close forward over gaps (holidays that don't
      // line up between the two calendars) so the overlay has no null gaps.
      let base: number | null = null;
      let lastClose: number | null = null;
      for (const row of rows) {
        const close: number | null = closeByDate.get(row.scan_date) ?? lastClose;
        if (close == null) { row.qqq_index = null; continue; }
        lastClose = close;
        if (base == null) base = close;
        row.qqq_index = (close / base) * 100;
      }
    } catch {
      // Benchmark overlay is best-effort — leave qqq_index unset on failure.
    }

    try {
      const weekly = await fetchSpyWeeklyWilliamsR(rows[0]!.scan_date);
      // Step function: each daily row gets the most recent COMPLETED weekly
      // bar's price/W%R (the last weekly.date <= row.scan_date). Both arrays
      // are ascending, so a single moving pointer does the merge in one pass.
      // Price advances every week; W%R only once it's past its 14-week burn-in.
      let wIdx = 0;
      let lastWilliamsR: number | null = null;
      let lastPrice: number | null = null;
      for (const row of rows) {
        while (wIdx < weekly.length && weekly[wIdx]!.date <= row.scan_date) {
          if (weekly[wIdx]!.wr != null) lastWilliamsR = weekly[wIdx]!.wr!;
          lastPrice = weekly[wIdx]!.close;
          wIdx++;
        }
        row.spy_w_williams_r = lastWilliamsR;
        row.spy_price = lastPrice;
      }
    } catch {
      // Best-effort — leave spy_w_williams_r unset on failure.
    }

    return Response.json(rows);
  } catch {
    // fragility_daily not created yet — the panel simply stays hidden.
    return Response.json([]);
  }
};
