/**
 * AVWAP anchored at the 52w high — Lean Radar (`stable`) only.
 *
 * Deliberately NOT in technicalAnalysis.ts: that file is on the shared-files list
 * (config/shared-files.txt) and must stay byte-identical between `main` and `stable`.
 */
import { calculateAVWAP } from './technicalAnalysis.js';

/**
 * Index of the highest HIGH within the last `window` bars (first occurrence on ties).
 * Series shorter than `window` (a fresh IPO) use every bar available.
 * Returns undefined for an empty series.
 */
export function findAthAnchorIndex(highs: number[], window: number = 252): number | undefined {
    if (highs.length === 0) return undefined;
    const start = Math.max(0, highs.length - window);
    let best = start;
    for (let i = start + 1; i < highs.length; i++) {
        if (highs[i]! > highs[best]!) best = i;
    }
    return best;
}

/**
 * AVWAP anchored at the bar of the highest high in the last `window` bars (52w proxy) — the
 * average cost basis of everyone who bought since the peak. DISPLAY ONLY: a 2026-10-06 study of
 * 583 tickers x 4y found no edge for reclaiming or losing this level (the mean is right-tail only,
 * the median trade lags same-RS peers), so nothing may gate or score on it.
 */
export function calculateAvwapFromAth(
    highs: number[],
    lows: number[],
    closes: number[],
    volumes: number[],
    window: number = 252
): number | undefined {
    const anchor = findAthAnchorIndex(highs, window);
    return anchor == null ? undefined : calculateAVWAP(highs, lows, closes, volumes, anchor);
}
