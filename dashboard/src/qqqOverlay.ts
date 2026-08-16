// dashboard/src/qqqOverlay.ts
//
// The QQQ benchmark overlay for the fragility chart, extracted from
// functions/api/fragility.ts (2026-08-16) so it can run outside a Pages
// Function.
//
// Why it moved: alpha-engine vendors this dashboard as an offline copy, and it
// builds its /api/* payloads from a D1 snapshot artifact — table rows only.
// qqq_index is NOT a column; it is computed here at read time, so the vendored
// copy had no benchmark line and its fragility chart quietly differed from the
// live one. The alternative was reimplementing this in that repo, which is
// exactly the drift this codebase avoids elsewhere (it runs enrichRows and
// buildTickerHistory rather than copying them). Same reasoning, same fix.
//
// Pure move: no behaviour change. fragility.ts calls these two in the order it
// used to inline them.

/** Minimum shape the overlay needs — the real row type has far more. */
export interface QqqOverlayRow {
  scan_date: string;
  qqq_index?: number | null;
}

/**
 * Nasdaq-100 (QQQ) benchmark, fetched live from Yahoo Finance. QQQ (not SPY)
 * because the Purple List basket is the radar's own momentum/high-RVOL,
 * growth-tilted watchlist, which tracks the Nasdaq-100 far more tightly than
 * the broader, value-heavier S&P.
 *
 * Returns a date→close map, or an empty map on any failure: the benchmark is
 * best-effort and must never break the fragility panel itself.
 */
export async function fetchQqqIndex(fromDate: string): Promise<Map<string, number>> {
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
 * Rebase QQQ to 100 at the first row's date and write it onto each row as
 * `qqq_index`, so the chart can overlay "did the fragility peak lead the market
 * pullback" without a raw-price/score scale clash.
 *
 * Mutates in place, exactly as the endpoint did. Rows MUST be ascending by
 * scan_date — buildFragilityQuery orders them that way, and "rebased to 100 at
 * the first trading day" is only meaningful against the oldest row.
 */
export function applyQqqOverlay(rows: QqqOverlayRow[], closeByDate: Map<string, number>): void {
  // Carry the last-known close forward over gaps (holidays that don't line up
  // between the two calendars) so the overlay has no null gaps.
  let base: number | null = null;
  let lastClose: number | null = null;
  for (const row of rows) {
    const close: number | null = closeByDate.get(row.scan_date) ?? lastClose;
    if (close == null) { row.qqq_index = null; continue; }
    lastClose = close;
    if (base == null) base = close;
    row.qqq_index = (close / base) * 100;
  }
}
