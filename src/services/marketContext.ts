/**
 * Market Context (2026-08-22) — a market-wide pressure reading, DISPLAY ONLY.
 *
 * Six gauges, none of which gate anything. They exist so the daily signal list
 * can be read against the tape it was produced in: an alert on a day when the
 * S&P sits 12% above its SMA150 and the VIX is at 13 is not the same alert as
 * one produced the day after a shakeout.
 *
 *   1. spxDistSma150 / spxDistSma200 — how stretched the index is
 *   2. rspSlope21                    — equal-weight S&P trend (participation)
 *   3. vix                           — volatility / complacency
 *   4. xlpSpxSlope21                 — defensive rotation (staples vs index)
 *   5. xlyXlpSlope21                 — risk-on/risk-off (discretionary vs staples)
 *   6. s5fi                          — % of S&P 500 above its own SMA50
 *
 * Plus Williams %R for SPY and QQQ on both daily and weekly bars, which replaces
 * the weekly TradingView screenshot that used to carry this (see CHANGELOG).
 * Weekly is derived from the daily fetch via aggregateWeekly() rather than a
 * separate `1wk` Yahoo request — see that function's doc comment in
 * technicalAnalysis.ts for why Yahoo's own weekly bars cannot be trusted for a
 * historical `asOfDate` (fixed 2026-08-24, after it shipped a real bug).
 *
 * **s5fi is computed, not fetched.** No free API serves S5FI or any breadth
 * index — checked 2026-08-22: the entire public-apis Finance section has zero
 * breadth entries, Finnhub's /index/constituents is paid-tier, TradingView's
 * scanner API returns nothing for INDEX:S5FI, and Yahoo 404s every spelling.
 * So we compute the definition ourselves over config/sp500.json. Measured cost:
 * ~23s for 500 symbols at concurrency 8 with range=3mo.
 *
 * Fail-open throughout, per the convention in this codebase: every field is
 * independently nullable, nothing is ever carried forward from a previous day,
 * and any failure yields null rather than a plausible-looking guess.
 */
import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { calculateSMA, calculateWilliamsR, aggregateWeekly } from '../utils/technicalAnalysis.js';
import { computeUniverseBreadth } from '../utils/universeBreadth.js';
import logger from '../utils/logger.js';

const SP500_PATH = path.join(process.cwd(), 'config', 'sp500.json');

/** Bars used for the ratio/trend slopes — one trading month. */
const SLOPE_BARS = 21;
/** Williams %R lookback, matching TradingView's default. */
const WR_PERIODS = 14;
/**
 * Below this many responding constituents s5fi is reported as null rather than
 * as a partial number. A breadth reading taken over a different denominator is
 * not comparable to the other days in the series, which is the only thing the
 * series is for.
 */
export const MIN_S5FI_CONSTITUENTS = 450;
/** Concurrency for the constituent sweep. p-limit, never sleep() — house rule. */
const S5FI_CONCURRENCY = 8;

export { computeUniverseBreadth, MIN_UNIVERSE_TICKERS } from '../utils/universeBreadth.js';

export interface OhlcSeries {
    /** YYYY-MM-DD ascending, aligned to the other arrays. */
    dates: string[];
    closes: number[];
    highs: number[];
    lows: number[];
}

export interface MarketContextDay {
    scanDate: string;
    spxClose: number | null;
    spxDistSma150: number | null;
    spxDistSma200: number | null;
    rspClose: number | null;
    rspSlope21: number | null;
    vix: number | null;
    xlpSpxRatio: number | null;
    xlpSpxSlope21: number | null;
    xlyXlpRatio: number | null;
    xlyXlpSlope21: number | null;
    s5fi: number | null;
    /** How many constituents actually answered — the honesty column for s5fi. */
    s5fiN: number | null;
    /** % of S&P 500 above its own SMA200 (the longer-trend breadth, "S5TH"). */
    s5th: number | null;
    /** How many constituents had ≥200 bars to answer s5th. */
    s5thN: number | null;
    /** Nearest swing-low support below the current close, in index points. */
    spxSupport: number | null;
    spyWr1d: number | null;
    spyWr1w: number | null;
    qqqWr1d: number | null;
    qqqWr1w: number | null;
    /** % of the radar's OWN scanned universe closing above its SMA50. */
    universeBreadth: number | null;
    /** Tickers that answered — the honesty column for universeBreadth. */
    universeBreadthN: number | null;
    /** s5fi − universeBreadth, in percentage points. Null unless both exist. */
    breadthSpread: number | null;
}

/**
 * Raw Yahoo chart fetch returning aligned OHLC arrays plus dates.
 * Returns null on any transport/shape problem — callers degrade to a null field.
 */
export async function fetchSeries(
    symbol: string,
    interval: '1d' | '1wk' = '1d',
    range = '2y'
): Promise<OhlcSeries | null> {
    const url =
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
        `?interval=${interval}&range=${range}`;
    try {
        const r = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                Accept: 'application/json',
            },
        });
        if (!r.ok) return null;
        const data = (await r.json()) as {
            chart?: {
                result?: Array<{
                    timestamp?: number[];
                    indicators?: {
                        quote?: Array<{
                            close?: (number | null)[];
                            high?: (number | null)[];
                            low?: (number | null)[];
                        }>;
                    };
                }>;
            };
        };
        const result = data?.chart?.result?.[0];
        const q = result?.indicators?.quote?.[0];
        const ts = result?.timestamp;
        if (!q?.close || !ts) return null;

        const out: OhlcSeries = { dates: [], closes: [], highs: [], lows: [] };
        for (let i = 0; i < q.close.length; i++) {
            const c = q.close[i];
            const t = ts[i];
            if (c == null || !Number.isFinite(c) || t == null) continue;
            out.dates.push(new Date(t * 1000).toISOString().slice(0, 10));
            out.closes.push(c);
            out.highs.push(q.high?.[i] ?? c);
            out.lows.push(q.low?.[i] ?? c);
        }
        return out.closes.length > 0 ? out : null;
    } catch {
        return null;
    }
}

/**
 * Drop every bar after `asOfDate` so a backfill sees exactly what the day saw.
 * Weekly bars are stamped with the week's OPEN date, so a weekly bar is kept
 * when its stamp is on or before asOfDate — the partial current week is only
 * excluded once asOfDate precedes it.
 */
export function truncateTo(series: OhlcSeries, asOfDate: string): OhlcSeries {
    let n = series.dates.length;
    while (n > 0 && series.dates[n - 1]! > asOfDate) n--;
    return {
        dates: series.dates.slice(0, n),
        closes: series.closes.slice(0, n),
        highs: series.highs.slice(0, n),
        lows: series.lows.slice(0, n),
    };
}

/** Percent distance of the last close from its own SMA(periods). */
export function distanceFromSma(closes: number[], periods: number): number | null {
    const sma = calculateSMA(closes, periods);
    const last = closes[closes.length - 1];
    if (sma == null || sma <= 0 || last == null) return null;
    return ((last - sma) / sma) * 100;
}

/** Percent change over the trailing `bars` — the trend direction of a level or ratio. */
export function slope(values: number[], bars: number = SLOPE_BARS): number | null {
    if (values.length < bars + 1) return null;
    const last = values[values.length - 1]!;
    const prev = values[values.length - 1 - bars]!;
    if (!Number.isFinite(prev) || prev === 0) return null;
    return ((last - prev) / Math.abs(prev)) * 100;
}

/**
 * Element-wise ratio of two series, joined on date so a holiday in one market
 * cannot silently shift the two against each other.
 */
export function ratioSeries(a: OhlcSeries, b: OhlcSeries): number[] {
    const bByDate = new Map(b.dates.map((d, i) => [d, b.closes[i]!]));
    const out: number[] = [];
    for (let i = 0; i < a.dates.length; i++) {
        const denom = bByDate.get(a.dates[i]!);
        if (denom == null || denom === 0) continue;
        out.push(a.closes[i]! / denom);
    }
    return out;
}

/** Read the committed constituent list. Returns [] (never throws) if unusable. */
export function loadSp500(): string[] {
    try {
        const raw = JSON.parse(fs.readFileSync(SP500_PATH, 'utf-8')) as unknown;
        if (!Array.isArray(raw)) {
            logger.warn(`⚠️ ${SP500_PATH} is not an array — s5fi will be null`);
            return [];
        }
        return raw.filter((s): s is string => typeof s === 'string' && s.length > 0);
    } catch (err) {
        logger.warn(`⚠️ Could not read ${SP500_PATH} (${(err as Error).message}) — s5fi will be null`);
        return [];
    }
}

/** Reduce per-constituent votes to { value: % true, n: answered } with the honesty floor. */
function tallyBreadth(votes: Array<boolean | null>, label: string, total: number): { value: number | null; n: number | null } {
    const answered = votes.filter((v): v is boolean => v !== null);
    if (answered.length < MIN_S5FI_CONSTITUENTS) {
        logger.warn(
            `⚠️ ${label}: only ${answered.length}/${total} constituents answered ` +
                `(need ${MIN_S5FI_CONSTITUENTS}) — reporting null rather than a partial reading`
        );
        return { value: null, n: answered.length };
    }
    return { value: (answered.filter(Boolean).length / answered.length) * 100, n: answered.length };
}

/**
 * Breadth above the 50- and 200-day moving averages in ONE fetch per
 * constituent — s5fi (% above SMA50) and s5th (% above SMA200). `range=1y`
 * (~252 bars) is the smallest Yahoo window that still leaves a 200-bar average
 * with margin; s5th votes null for any constituent with fewer than 200 bars
 * (recent listings), so its `n` can trail s5fi's slightly.
 */
export async function computeBreadth(
    asOfDate: string
): Promise<{ s5fi: { value: number | null; n: number | null }; s5th: { value: number | null; n: number | null } }> {
    const symbols = loadSp500();
    if (symbols.length === 0) return { s5fi: { value: null, n: null }, s5th: { value: null, n: null } };

    const limit = pLimit(S5FI_CONCURRENCY);
    const votes = await Promise.all(
        symbols.map((sym) =>
            limit(async () => {
                const s = await fetchSeries(sym, '1d', '1y');
                if (!s) return { above50: null, above200: null };
                const closes = truncateTo(s, asOfDate).closes;
                const last = closes[closes.length - 1];
                if (last == null) return { above50: null, above200: null };
                const sma50 = calculateSMA(closes, 50);
                const sma200 = calculateSMA(closes, 200);
                return {
                    above50: sma50 == null ? null : last > sma50,
                    above200: sma200 == null ? null : last > sma200,
                };
            })
        )
    );

    return {
        s5fi: tallyBreadth(votes.map((v) => v.above50), 's5fi', symbols.length),
        s5th: tallyBreadth(votes.map((v) => v.above200), 's5th', symbols.length),
    };
}

/**
 * Nearest swing-low support below the current close. Scans the trailing
 * `lookback` bars for pivot lows (a low that is the strict minimum of the
 * ±`window` bars around it), keeps those below the close, and returns the
 * highest such level — the first shelf price would fall to. Falls back to the
 * lowest low in the window when no clean pivot sits below. Null when the series
 * is too short or price is already at its low.
 */
export function nearestSupport(
    lows: number[],
    lastClose: number | null,
    lookback = 126,
    window = 5
): number | null {
    if (lastClose == null || lows.length < window * 2 + 1) return null;
    const start = Math.max(window, lows.length - lookback);
    const pivots: number[] = [];
    for (let i = start; i < lows.length - window; i++) {
        const lo = lows[i]!;
        let isPivot = true;
        for (let j = i - window; j <= i + window; j++) {
            if (j !== i && lows[j]! <= lo) { isPivot = false; break; }
        }
        if (isPivot && lo < lastClose) pivots.push(lo);
    }
    if (pivots.length) return Math.max(...pivots);
    const belows = lows.slice(Math.max(0, lows.length - lookback)).filter((l) => l < lastClose);
    return belows.length ? Math.max(...belows) : null;
}

/**
 * Daily and weekly Williams %R for one symbol, from a SINGLE daily fetch.
 *
 * Weekly is derived via aggregateWeekly() over the already-truncated daily
 * bars rather than a separate `1wk` Yahoo fetch — see that function's doc
 * comment for why the `1wk` endpoint cannot be trusted for a historical
 * `asOfDate`. This also means one fewer Yahoo request per symbol than before.
 */
async function williamsFor(
    symbol: string,
    asOfDate: string
): Promise<{ daily: number | null; weekly: number | null }> {
    const s = await fetchSeries(symbol, '1d', '2y');
    if (!s) return { daily: null, weekly: null };
    const t = truncateTo(s, asOfDate);
    const daily = calculateWilliamsR(t.highs, t.lows, t.closes, WR_PERIODS) ?? null;
    const w = aggregateWeekly(t);
    const weekly = calculateWilliamsR(w.highs, w.lows, w.closes, WR_PERIODS) ?? null;
    return { daily, weekly };
}

/**
 * Build the day's row. Never throws for a data reason — every gauge degrades to
 * null on its own. The caller still wraps this in try/catch so an unforeseen
 * failure cannot take the scan down with it.
 */
export async function computeMarketContext(
    asOfDate: string,
    universe: ReadonlyArray<{ lastPrice?: number; sma50?: number }> = []
): Promise<MarketContextDay> {
    const [spxRaw, rspRaw, vixRaw, xlpRaw, xlyRaw] = await Promise.all([
        fetchSeries('^GSPC'),
        fetchSeries('RSP'),
        fetchSeries('^VIX'),
        fetchSeries('XLP'),
        fetchSeries('XLY'),
    ]);

    const spx = spxRaw && truncateTo(spxRaw, asOfDate);
    const rsp = rspRaw && truncateTo(rspRaw, asOfDate);
    const vixS = vixRaw && truncateTo(vixRaw, asOfDate);
    const xlp = xlpRaw && truncateTo(xlpRaw, asOfDate);
    const xly = xlyRaw && truncateTo(xlyRaw, asOfDate);

    const last = (s: OhlcSeries | null | undefined): number | null =>
        s && s.closes.length > 0 ? s.closes[s.closes.length - 1]! : null;

    const xlpSpx = xlp && spx ? ratioSeries(xlp, spx) : [];
    const xlyXlp = xly && xlp ? ratioSeries(xly, xlp) : [];

    const [breadthMas, spyWr, qqqWr] = await Promise.all([
        computeBreadth(asOfDate),
        williamsFor('SPY', asOfDate),
        williamsFor('QQQ', asOfDate),
    ]);
    const s5fi = breadthMas.s5fi;

    const breadth = computeUniverseBreadth(universe);
    const spread =
        s5fi.value != null && breadth.value != null ? s5fi.value - breadth.value : null;

    return {
        scanDate: asOfDate,
        spxClose: last(spx),
        spxDistSma150: spx ? distanceFromSma(spx.closes, 150) : null,
        spxDistSma200: spx ? distanceFromSma(spx.closes, 200) : null,
        rspClose: last(rsp),
        rspSlope21: rsp ? slope(rsp.closes) : null,
        vix: last(vixS),
        xlpSpxRatio: xlpSpx.length > 0 ? xlpSpx[xlpSpx.length - 1]! : null,
        xlpSpxSlope21: slope(xlpSpx),
        xlyXlpRatio: xlyXlp.length > 0 ? xlyXlp[xlyXlp.length - 1]! : null,
        xlyXlpSlope21: slope(xlyXlp),
        s5fi: s5fi.value,
        s5fiN: s5fi.n,
        s5th: breadthMas.s5th.value,
        s5thN: breadthMas.s5th.n,
        spxSupport: spx ? nearestSupport(spx.lows, last(spx)) : null,
        spyWr1d: spyWr.daily,
        spyWr1w: spyWr.weekly,
        qqqWr1d: qqqWr.daily,
        qqqWr1w: qqqWr.weekly,
        universeBreadth: breadth.value,
        universeBreadthN: breadth.n,
        breadthSpread: spread,
    };
}
