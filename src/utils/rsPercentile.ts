/**
 * Gondar — Relative Strength percentile (Phase 2, 2026-05-07).
 *
 * Inspired by championscan.com's "RS Percentile" column. The classic IBD formula
 * is "% outperformance vs all stocks in the universe over 3 months", normalized
 * to a 0-100 percentile rank. We approximate it on our watchlist:
 *
 *   alpha = stock.return63d - spy.return63d
 *
 * then rank-percentile across the watchlist (ties get the average of their
 * positions, percentile = (rank - 1) / (n - 1) × 100). Stock with the highest
 * alpha gets 100; lowest gets 0.
 *
 * Pure & synchronous. The pipeline computes once per scan and mutates each
 * stock's `rsPercentile` field.
 */
import type { StockData } from '../types/index.js';

/**
 * Compute and assign `rsPercentile` (0-100) to each stock in the array.
 * Stocks missing `return63d` are skipped (left undefined).
 *
 * @param stocks   Mutable array — `rsPercentile` is set in place.
 * @param spyReturn63d  SPY's 63-day total return (%). When null/undefined,
 *                      ranking falls back to raw return63d (no SPY-relative).
 */
export function applyRSPercentile(stocks: StockData[], spyReturn63d: number | null): void {
    type Entry = { stock: StockData; alpha: number };
    const entries: Entry[] = [];
    for (const s of stocks) {
        if (s.return63d == null || !Number.isFinite(s.return63d)) continue;
        const alpha = spyReturn63d != null ? s.return63d - spyReturn63d : s.return63d;
        entries.push({ stock: s, alpha });
    }
    if (entries.length === 0) return;
    if (entries.length === 1) {
        entries[0]!.stock.rsPercentile = 50;
        return;
    }

    // Sort ascending by alpha so index 0 = worst, index n-1 = best.
    entries.sort((a, b) => a.alpha - b.alpha);

    // Percentile rank with tie-handling (average rank for tied values).
    const n = entries.length;
    let i = 0;
    while (i < n) {
        let j = i;
        while (j + 1 < n && entries[j + 1]!.alpha === entries[i]!.alpha) j++;
        // i..j are tied. Average rank position (0-indexed):
        const avgPos = (i + j) / 2;
        const pct = n === 1 ? 50 : (avgPos / (n - 1)) * 100;
        for (let k = i; k <= j; k++) {
            entries[k]!.stock.rsPercentile = Math.round(pct);
        }
        i = j + 1;
    }
}

/**
 * Pure helper for testing — returns the percentile array without mutating.
 * Same algorithm; preserves input order (returns undefined for stocks with
 * missing return63d).
 */
export function computeRSPercentiles(
    stocks: StockData[],
    spyReturn63d: number | null
): Array<number | undefined> {
    const result: Array<number | undefined> = stocks.map(() => undefined);
    type Entry = { idx: number; alpha: number };
    const entries: Entry[] = [];
    stocks.forEach((s, idx) => {
        if (s.return63d == null || !Number.isFinite(s.return63d)) return;
        const alpha = spyReturn63d != null ? s.return63d - spyReturn63d : s.return63d;
        entries.push({ idx, alpha });
    });
    if (entries.length === 0) return result;
    if (entries.length === 1) {
        result[entries[0]!.idx] = 50;
        return result;
    }
    entries.sort((a, b) => a.alpha - b.alpha);
    const n = entries.length;
    let i = 0;
    while (i < n) {
        let j = i;
        while (j + 1 < n && entries[j + 1]!.alpha === entries[i]!.alpha) j++;
        const avgPos = (i + j) / 2;
        const pct = Math.round((avgPos / (n - 1)) * 100);
        for (let k = i; k <= j; k++) result[entries[k]!.idx] = pct;
        i = j + 1;
    }
    return result;
}
