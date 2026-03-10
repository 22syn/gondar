/**
 * Smart Volume Radar - RVOL Calculator
 * Calculates Relative Volume and identifies high-volume signals
 */

import { StockData, RVOLConfig } from '../types/index.js';
import logger from '../utils/logger.js';
import { getTagCount, hasAllThreeTags } from '../utils/tags.js';

export { formatRVOL, formatPriceChange } from '../utils/formatters.js';

/**
 * RVOL calculation results
 */
export interface RVOLCalcResult {
    topSignals: StockData[];
    volumeWithoutPrice: StockData[];
}

/**
 * Calculate RVOL and filter/rank stocks
 *
 * Two entry paths (stock enters report if either is met):
 * - Green: RVOL >= minRVOL AND |priceChange| >= priceChangeThreshold (e.g. 2%)
 * - Blue: has ALL three tags — SMA21 Touch, Pullback 15%, 1M Breakout (enters even without green)
 *
 * @param stocks - Array of stock data
 * @param config - RVOL configuration
 * @returns Top signals and volume-without-price stocks
 */
export function calculateRVOL(stocks: StockData[], rvolConfig: RVOLConfig): RVOLCalcResult {
    const { minRVOL, topN, priceChangeThreshold } = rvolConfig;

    // Green path: RVOL >= 2 AND price change >= 2%
    const green = stocks.filter(
        (s) => s.rvol >= minRVOL && Math.abs(s.priceChange) >= priceChangeThreshold
    );
    logger.info(
        `Found ${green.length} green-path stocks (RVOL ≥ ${minRVOL} AND |priceChange| ≥ ${priceChangeThreshold}%)`
    );

    // Blue path: all three tags — enters even without green
    const blueOnly = stocks.filter((s) => hasAllThreeTags(s) && !green.some((g) => g.ticker === s.ticker));
    if (blueOnly.length > 0) {
        logger.info(`Identified ${blueOnly.length} blue-path stocks (all 3 tags, without green)`);
    }

    // Sort green by RVOL descending, tag count as tie-breaker
    green.sort((a, b) => {
        const rvolDiff = b.rvol - a.rvol;
        if (Math.abs(rvolDiff) >= 0.5) return rvolDiff > 0 ? 1 : -1;
        return getTagCount(b) - getTagCount(a) || rvolDiff;
    });

    // Top signals: top N from green + all blue-only
    const topByGreen = green.slice(0, topN);
    const topTickers = new Set(topByGreen.map((s) => s.ticker));
    const blueToAdd = blueOnly.filter((s) => !topTickers.has(s.ticker));
    const topSignals = [...topByGreen, ...blueToAdd];

    // Volume without Price: high RVOL but low price change (silent accumulation)
    const highRVOL = stocks.filter((s) => s.rvol >= minRVOL);
    const volumeWithoutPrice = highRVOL.filter(
        (s) => Math.abs(s.priceChange) < priceChangeThreshold
    );

    if (volumeWithoutPrice.length > 0) {
        logger.info(
            `Identified ${volumeWithoutPrice.length} "Volume w/o Price" stocks (|change| < ${priceChangeThreshold}%)`
        );
    }

    return { topSignals, volumeWithoutPrice };
}

/**
 * Determine if stock is bullish or bearish based on price change
 */
export function isBullish(stock: StockData): boolean {
    return stock.priceChange >= 0;
}
