/**
 * Gondar - RVOL Calculator
 * Calculates Relative Volume and identifies high-volume signals
 */

import { StockData, RVOLConfig } from '../types/index.js';
import logger from '../utils/logger.js';
import { getTagCount } from '../utils/tags.js';

export { formatRVOL, formatPriceChange } from '../utils/formatters.js';

/** Debug entry for scan investigation */
export interface ScanDebugEntry {
    ticker: string;
    rvol: number;
    priceChange: number;
    rank: number;
}

/** Debug info written to scan-debug-{date}.json for future investigation */
export interface ScanDebugInfo {
    greenSortedFull: ScanDebugEntry[];
    greenCount: number;
    pullbackOnlyCount: number;
    sma21OnlyCount: number;
    topN: number;
    minRVOL: number;
    priceChangeThreshold: number;
}

/**
 * RVOL calculation results
 */
export interface RVOLCalcResult {
    topSignals: StockData[];
    volumeWithoutPrice: StockData[];
    /** Always present for scan-debug file; use for investigation when signals are missing */
    debug: ScanDebugInfo;
}

/**
 * Calculate RVOL and filter/rank stocks
 *
 * Three entry paths (stock enters report if any is met):
 * - Green: RVOL >= minRVOL AND |priceChange| >= priceChangeThreshold (e.g. 2%)
 * - Pullback: has tag "Pullback 15%" (enters even without green)
 * - SMA21: has tag "SMA21 Touch" (enters even without green)
 * 1M Breakout is informational only, not an entry path.
 *
 * @param stocks - Array of stock data
 * @param config - RVOL configuration
 * @returns Top signals and volume-without-price stocks
 */
export function calculateRVOL(stocks: StockData[], rvolConfig: RVOLConfig): RVOLCalcResult {
    const { minRVOL, topN, priceChangeThreshold } = rvolConfig;

    const hasPullback = (s: StockData): boolean => (s.tags ?? []).includes('Pullback 15%');
    const hasSma21Touch = (s: StockData): boolean => (s.tags ?? []).includes('SMA21 Touch');

    // Green path: RVOL >= 2 AND price change >= 2%
    const green = stocks.filter(
        (s) => s.rvol >= minRVOL && Math.abs(s.priceChange) >= priceChangeThreshold
    );
    logger.info(
        `Found ${green.length} green-path stocks (RVOL ≥ ${minRVOL} AND |priceChange| ≥ ${priceChangeThreshold}%)`
    );

    // Sort green by RVOL descending, tag count as tie-breaker
    green.sort((a, b) => {
        const rvolDiff = b.rvol - a.rvol;
        if (Math.abs(rvolDiff) >= 0.5) return rvolDiff > 0 ? 1 : -1;
        return getTagCount(b) - getTagCount(a) || rvolDiff;
    });

    const topByGreen = green.slice(0, topN).map((s) => ({ ...s, entryPath: 'green' as const }));
    const topTickers = new Set(topByGreen.map((s) => s.ticker));

    // Pullback path: has Pullback 15%, not already in topSignals
    const pullbackOnly = stocks
        .filter((s) => hasPullback(s) && !topTickers.has(s.ticker))
        .map((s) => ({ ...s, entryPath: 'pullback' as const }));
    if (pullbackOnly.length > 0) {
        logger.info(`Identified ${pullbackOnly.length} pullback-path stocks (Pullback 15%, without green)`);
    }
    for (const s of pullbackOnly) topTickers.add(s.ticker);

    // SMA21 path: has SMA21 Touch, not already in topSignals
    const sma21Only = stocks
        .filter((s) => hasSma21Touch(s) && !topTickers.has(s.ticker))
        .map((s) => ({ ...s, entryPath: 'sma21' as const }));
    if (sma21Only.length > 0) {
        logger.info(`Identified ${sma21Only.length} SMA21-path stocks (SMA21 Touch, without green/pullback)`);
    }

    const topSignals = [...topByGreen, ...pullbackOnly, ...sma21Only];

    // Volume without Price: high RVOL but low price change (silent accumulation)
    const topTickersSet = new Set(topSignals.map((s) => s.ticker));
    const highRVOL = stocks.filter((s) => s.rvol >= minRVOL);
    const volumeWithoutPrice = highRVOL.filter(
        (s) =>
            Math.abs(s.priceChange) < priceChangeThreshold && !topTickersSet.has(s.ticker)
    );

    if (volumeWithoutPrice.length > 0) {
        logger.info(
            `Identified ${volumeWithoutPrice.length} "Volume w/o Price" stocks (|change| < ${priceChangeThreshold}%)`
        );
    }

    const greenSortedFull: ScanDebugEntry[] = green.map((s, i) => ({
        ticker: s.ticker,
        rvol: s.rvol,
        priceChange: s.priceChange,
        rank: i + 1,
    }));

    const debug: ScanDebugInfo = {
        greenSortedFull,
        greenCount: green.length,
        pullbackOnlyCount: pullbackOnly.length,
        sma21OnlyCount: sma21Only.length,
        topN,
        minRVOL,
        priceChangeThreshold,
    };

    return { topSignals, volumeWithoutPrice, debug };
}

/**
 * Determine if stock is bullish or bearish based on price change
 */
export function isBullish(stock: StockData): boolean {
    return stock.priceChange >= 0;
}

/** NYSE regular session length in minutes (09:30 – 16:00 ET). */
export const NYSE_SESSION_MINUTES = 390;

/**
 * Minutes elapsed since today's NYSE open in America/New_York.
 * Returns NYSE_SESSION_MINUTES on weekends or after close (so projectedRvol === rvol).
 * Returns 1 (clamped) for the first minute to avoid divide-by-zero / huge projections.
 */
export function marketSessionMinutesElapsed(now: Date = new Date()): number {
    // Pull H/M/weekday in America/New_York directly via Intl (handles DST automatically).
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
        weekday: 'short',
    }).formatToParts(now);
    const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
    if (weekday === 'Sat' || weekday === 'Sun') return NYSE_SESSION_MINUTES;
    const h = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
    const m = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
    const minutesFromMidnight = h * 60 + m;
    const openMinutes = 9 * 60 + 30;
    const elapsed = minutesFromMidnight - openMinutes;
    if (elapsed >= NYSE_SESSION_MINUTES) return NYSE_SESSION_MINUTES;
    if (elapsed < 1) return NYSE_SESSION_MINUTES; // pre-market / overnight → treat as full session
    return elapsed;
}

/**
 * Time-weighted intraday RVOL.
 *   projectedVolume = currentVolume / (minutesElapsed / 390)
 *   projectedRvol   = projectedVolume / avg63DayVolume
 * After close (≥390 min) this equals raw RVOL.
 */
export function projectedRvol(
    currentVolume: number,
    avg63DayVolume: number,
    minutesElapsed: number
): number {
    if (avg63DayVolume <= 0) return 0;
    const elapsed = Math.min(Math.max(minutesElapsed, 1), NYSE_SESSION_MINUTES);
    const projected = currentVolume / (elapsed / NYSE_SESSION_MINUTES);
    return projected / avg63DayVolume;
}
