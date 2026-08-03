// dashboard/src/williamsR.ts
//
// Williams %R (Larry Williams, 1973) — a momentum oscillator on a -100..0
// scale: %R = (highestHigh - close) / (highestHigh - lowestLow) * -100.
// Readings above -20 are conventionally "overbought"; below -80 "oversold"
// (panic extreme) — the reading RonnieV's tweet used to call market-wide
// corrections (Tariffgeddon 2025, Iran 2026, QQQ 2026). Applied here to QQQ
// itself (a market gauge), NOT per-ticker — see fragility.ts.
//
// Standalone copy of the same formula in the parent engine's
// src/utils/technicalAnalysis.ts: this dashboard is a self-contained
// Cloudflare Pages project (see functions/*.ts, which only ever import from
// dashboard/src/, never the parent repo's src/), so the logic is duplicated
// rather than imported across that boundary.

/** Returns `undefined` if fewer than `period` bars are available, or the range is flat. */
export function calculateWilliamsR(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14
): number | undefined {
  const len = Math.min(highs.length, lows.length, closes.length);
  if (len < period) return undefined;
  const windowHighs = highs.slice(len - period, len);
  const windowLows = lows.slice(len - period, len);
  const highestHigh = Math.max(...windowHighs);
  const lowestLow = Math.min(...windowLows);
  const range = highestHigh - lowestLow;
  if (range <= 0) return undefined;
  const close = closes[len - 1]!;
  const result = ((highestHigh - close) / range) * -100;
  return result === 0 ? 0 : result; // normalize -0 (close === highestHigh)
}

/**
 * Rolling Williams %R over an entire ascending-date series, keyed by date.
 * `dates[i]` corresponds to `highs[i]`/`lows[i]`/`closes[i]`.
 */
export function rollingWilliamsRByDate(
  dates: string[],
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14
): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = period - 1; i < dates.length; i++) {
    const v = calculateWilliamsR(
      highs.slice(0, i + 1),
      lows.slice(0, i + 1),
      closes.slice(0, i + 1),
      period
    );
    if (v != null) out.set(dates[i]!, v);
  }
  return out;
}
