/**
 * Smart Volume Radar - Technical Analysis Utility
 * Calculates SMA, RSI, ATH, and consolidation metrics from price history
 */

/**
 * Calculate Simple Moving Average
 */
export function calculateSMA(prices: number[], periods: number): number | undefined {
    if (prices.length < periods) return undefined;
    const slice = prices.slice(-periods);
    const sum = slice.reduce((a, b) => a + b, 0);
    return sum / periods;
}

/** ~21 trading days per month */
const TRADING_DAYS_PER_MONTH = 21;

/** ~252 trading days per year (52 weeks) */
const TRADING_DAYS_52W = 252;

/**
 * Calculate 52-week high, % from high, and months in consolidation
 * Uses last 252 trading days (1 year) instead of 5y – more relevant for breakout setups
 */
export function calculate52wHighAndConsolidation(closes: number[]): {
    ath: number;
    pctFromAth: number;
    monthsInConsolidation: number;
} | null {
    if (closes.length < 22) return null; // need ~1 month of data
    const lookback = closes.slice(-TRADING_DAYS_52W);
    const ath = Math.max(...lookback);
    const lastClose = lookback[lookback.length - 1];
    const pctFromAth = ath > 0 ? ((lastClose - ath) / ath) * 100 : 0;

    // Find last index (within 52w window) where price was within 2% of 52w high
    let athIndex = -1;
    const athThreshold = ath * 0.98;
    for (let i = lookback.length - 1; i >= 0; i--) {
        if (lookback[i] >= athThreshold) {
            athIndex = i;
            break;
        }
    }
    const tradingDaysSinceAth = athIndex >= 0 ? lookback.length - 1 - athIndex : lookback.length - 1;
    const monthsInConsolidation = tradingDaysSinceAth / TRADING_DAYS_PER_MONTH;

    return { ath, pctFromAth, monthsInConsolidation };
}

/**
 * Check if price is "touching" SMA (within threshold %)
 */
export function isNearSMA(price: number, sma: number, thresholdPct: number): boolean {
    if (sma <= 0) return false;
    const pctDiff = Math.abs(price - sma) / sma * 100;
    return pctDiff <= thresholdPct;
}

import type { NewlogicTag } from '../types/index.js';

/** ~21 trading days = 1 month consolidation window */
const CONSOLIDATION_DAYS_1M = 21;

/**
 * Compute Newlogic tags from raw inputs.
 * - SMA21 Touch: Low ≤ SMA21 ≤ High (intraday touch)
 * - Pullback 15%: pctFromAth ≤ -15 (52w high)
 * - 1M Breakout: consolidated ~1 month, then lastClose > rangeHigh
 */
export function computeNewlogicTags(params: {
    sma21?: number;
    lastDayLow?: number;
    lastDayHigh?: number;
    pctFromAth?: number;
    closes: number[];
}): NewlogicTag[] {
    const tags: NewlogicTag[] = [];
    const { sma21, lastDayLow, lastDayHigh, pctFromAth, closes } = params;

    if (sma21 != null && sma21 > 0 && lastDayLow != null && lastDayHigh != null) {
        if (lastDayLow <= sma21 && sma21 <= lastDayHigh) tags.push('SMA21 Touch');
    }

    if (pctFromAth != null && pctFromAth <= -15) tags.push('Pullback 15%');

    if (closes.length >= CONSOLIDATION_DAYS_1M + 1) {
        const lookback = closes.slice(-CONSOLIDATION_DAYS_1M - 1);
        const rangeCloses = lookback.slice(0, -1);
        const lastClose = lookback[lookback.length - 1];
        const rangeHigh = Math.max(...rangeCloses);
        if (lastClose > rangeHigh) tags.push('1M Breakout');
    }

    return tags;
}

/**
 * Calculate Relative Strength Index (RSI) using Wilder's Smoothing
 * Matches TradingView and standard charting platforms.
 * First 14 periods: simple average of gains/losses.
 * Thereafter: ((PreviousAvg * 13) + Current) / 14
 */
export function calculateRSI(prices: number[], periods: number = 14): number | undefined {
    if (prices.length < periods + 1) return undefined;

    let sumGain = 0;
    let sumLoss = 0;
    for (let i = 1; i <= periods && i < prices.length; i++) {
        const diff = prices[i] - prices[i - 1];
        sumGain += diff >= 0 ? diff : 0;
        sumLoss += diff < 0 ? -diff : 0;
    }

    let avgGain = sumGain / periods;
    let avgLoss = sumLoss / periods;

    for (let i = periods + 1; i < prices.length; i++) {
        const diff = prices[i] - prices[i - 1];
        const gain = diff >= 0 ? diff : 0;
        const loss = diff < 0 ? -diff : 0;
        avgGain = (avgGain * (periods - 1) + gain) / periods;
        avgLoss = (avgLoss * (periods - 1) + loss) / periods;
    }

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}
