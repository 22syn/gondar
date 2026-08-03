// dashboard/functions/api/fragility.ts
//
// Purple List fragility series (fragility_daily) — written daily by the
// Smart pipeline (main branch, fragilityD1Ingest.ts). Standalone per-day
// scalar series: no mergeSetup/enrich involvement. The table may not exist
// until the first Smart ingest — treat errors as an empty series.
import { buildFragilityQuery } from '../../src/query.js';

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
}

/**
 * Nasdaq-100 (QQQ) benchmark, fetched live from Yahoo Finance and rebased to
 * 100 at the first row's date. QQQ (not SPY) because the Purple List basket
 * is the radar's own momentum/high-RVOL, growth-tilted watchlist, which
 * tracks the Nasdaq-100 far more tightly than the broader, value-heavier S&P.
 * Best-effort: any failure here must not break the fragility panel itself.
 */
async function fetchQqqIndex(fromDate: string): Promise<Map<string, number>> {
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

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  try {
    const q = buildFragilityQuery({});
    const { results } = await env.DB.prepare(q.sql).bind(...q.params).all<FragilityRow>();
    const rows = results ?? [];
    if (rows.length === 0) return Response.json(rows);

    try {
      const closeByDate = await fetchQqqIndex(rows[0]!.scan_date);
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

    return Response.json(rows);
  } catch {
    // fragility_daily not created yet — the panel simply stays hidden.
    return Response.json([]);
  }
};
