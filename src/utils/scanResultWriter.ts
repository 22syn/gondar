/**
 * Gondar — New scan-result schema writer.
 *
 * Serializes a full scan (all stocks, including level='none') to
 * `results/scan-YYYY-MM-DD.json`. Format defined in types/index.ts::ScanResultDay.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ScanResultDay, ScanStockSnapshot, StockData } from '../types/index.js';

/**
 * Map a StockData (with momentum populated) to a ScanStockSnapshot.
 * Drops legacy fields (entryPath, tags, monthsInConsolidation) — new schema only.
 */
export function buildScanSnapshot(s: StockData): ScanStockSnapshot {
    if (!s.momentum) {
        throw new Error(`buildScanSnapshot: ${s.ticker} has no momentum result — call evaluateMomentumSetup first`);
    }
    const snap: ScanStockSnapshot = {
        ticker: s.ticker,
        sector: s.sector,
        level: s.momentum.level,
        lastPrice: s.lastPrice,
        priceChange: s.priceChange,
        currentVolume: s.currentVolume,
        avgVolume: s.avgVolume,
        rvol: s.rvol,
        projectedRvol: s.projectedRvol ?? s.rvol,
        sma21: s.sma21,
        sma50: s.sma50,
        sma200: s.sma200,
        sma200Slope: s.sma200Slope,
        sma50Slope: s.sma50Slope,
        rsi: s.rsi,
        ath: s.ath,
        pctFromAth: s.pctFromAth,
        daysSinceAth: s.daysSinceAth,
        consecutiveGreenDays: s.consecutiveGreenDays,
        gapDay: s.gapDay ?? null,
        avwapFromGap: s.avwapFromGap,
        momentum: s.momentum,
    };
    if (s.momentum.highConvictionBypass) snap.highConvictionBypass = true;
    return snap;
}

/**
 * Build the full per-day scan result from a list of fetched stocks + scan metadata.
 */
export function buildScanResultDay(args: {
    date: string;
    marketRegime: 'bull' | 'bear';
    watchlistTotal: number;
    fetchedSuccessfully: number;
    failedTickers: string[];
    stocks: StockData[];
    scanTimeMs?: number;
}): ScanResultDay {
    const stocks = args.stocks.map(buildScanSnapshot);
    const summary = {
        full: stocks.filter((s) => s.level === 'full').length,
        recovery: stocks.filter((s) => s.level === 'recovery').length,
        watchlist: stocks.filter((s) => s.level === 'close').length,
        none: stocks.filter((s) => s.level === 'none').length,
    };
    return {
        date: args.date,
        scanTimeMs: args.scanTimeMs,
        marketRegime: args.marketRegime,
        watchlistTotal: args.watchlistTotal,
        fetchedSuccessfully: args.fetchedSuccessfully,
        failedTickers: args.failedTickers,
        summary,
        stocks,
    };
}

/** Write the day's scan to results/scan-YYYY-MM-DD.json. */
export function writeScanResultDay(result: ScanResultDay, resultsDir: string): void {
    fs.mkdirSync(resultsDir, { recursive: true });
    const filePath = path.join(resultsDir, `scan-${result.date}.json`);
    fs.writeFileSync(filePath, JSON.stringify(result, null, 2) + '\n', 'utf-8');
}
