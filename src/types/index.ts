/**
 * Smart Volume Radar - Type Definitions
 * Core interfaces for stock data, news, and RVOL results
 */

/** Newlogic tags: independent signals per stock */
export type NewlogicTag = 'SMA21 Touch' | 'Pullback 15%' | '1M Breakout';

/**
 * Raw stock data from market API
 */
export interface StockData {
    ticker: string;
    currentVolume: number;
    avgVolume: number;
    rvol: number;
    priceChange: number;
    lastPrice: number;
    sma50?: number;
    sma200?: number;
    sma21?: number;
    rsi?: number;
    sector?: string;
    /** All-time high (52w) from price history */
    ath?: number;
    /** Source of high: 5y = Yahoo 5-year history, 52w = Twelve Data 52-week high */
    athSource?: '5y' | '52w';
    /** Percentage distance from ATH (e.g. -15 = 15% below ATH) */
    pctFromAth?: number;
    /** Months since ATH was reached (approx consolidation duration) */
    monthsInConsolidation?: number;
    /** Last trading day low (for SMA21 Touch) — Yahoo only */
    lastDayLow?: number;
    /** Last trading day high (for SMA21 Touch) — Yahoo only */
    lastDayHigh?: number;
    /** Newlogic tags: SMA21 Touch, Pullback 15%, 1M Breakout */
    tags?: NewlogicTag[];
}

/**
 * News article from Finnhub
 */
export interface NewsItem {
    headline: string;
    url: string;
    source: string;
    publishedAt: Date;
}

/**
 * RVOL result with news enrichment
 */
export interface RVOLResult extends StockData {
    news: NewsItem[];
    isVolumeWithoutPrice: boolean;
}

/**
 * Configuration for RVOL calculation
 */
export interface RVOLConfig {
    minRVOL: number;
    topN: number;
    priceChangeThreshold: number;
}

/**
 * Daily scan results
 */
export interface ScanResults {
    date: string;
    totalScanned: number;
    signalsFound: number;
    topSignals: RVOLResult[];
    volumeWithoutPrice: StockData[];
    executionTimeMs: number;
}

/** Per-stock entry for stored results */
export interface StoredSignal {
    ticker: string;
    lastPrice: number;
    rvol: number;
    tags: NewlogicTag[];
    source: 'topSignals' | 'volumeWithoutPrice';
}

/** Daily scan output for persistence and evaluation */
export interface StoredScanResult {
    date: string; // YYYY-MM-DD
    signals: StoredSignal[];
}

/**
 * API response from Finnhub news endpoint
 */
export interface FinnhubNewsResponse {
    category: string;
    datetime: number;
    headline: string;
    id: number;
    image: string;
    related: string;
    source: string;
    summary: string;
    url: string;
}

/**
 * Market status for checking if market is open
 */
export interface MarketStatus {
    isOpen: boolean;
    exchange: string;
    currentTime: Date;
    message?: string;
}

/**
 * Telegram API Error response
 */
export interface TelegramApiError {
    ok: boolean;
    error_code: number;
    description: string;
}
