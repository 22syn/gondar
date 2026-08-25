/**
 * One-off: fetch and cache raw OHLCV (5y, same fetchPurpleOhlcv as production)
 * for the current Purple basket + a candidate pool, so basket-swap-eval.ts /
 * basket-swap-deepdive.ts don't re-hit Yahoo on every run. Writes
 * basket-swap-raw.json in this directory (committed snapshot, like
 * fragility-full.json for the nearHigh study).
 *
 * Run from repo root: npx tsx docs/research/fragility-calibration/basket-swap-fetch.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { loadPurpleList, fetchPurpleOhlcv, splicePredecessor, type OhlcvSeries } from '../../../src/services/purpleFragility.js';
import { getLastTradingDay } from '../../../src/utils/tradingDate.js';
import logger from '../../../src/utils/logger.js';

// Candidates: real AI/semis capex-cycle exposure, distinct sub-sectors.
// Deliberately excludes mega-caps (NVDA/AVGO/AMD/SMCI) — already tested
// 2026-07-22 and rejected (chronic-euphoria Z, doesn't spike, dilutes the
// cross-sectional features — see radar-purple-fragility memory, part י"ד).
// ASX = AMKR's direct OSAT peer (Taiwan ADR).
export const CANDIDATES = ['LRCX', 'ASML', 'AMAT', 'KLAC', 'ASX', 'STM', 'ON', 'TER', 'ENTG', 'COHR'];

async function main(): Promise<void> {
    const asOfDate = getLastTradingDay();
    const base = loadPurpleList();
    const limit = pLimit(3);

    const baseSeries = await Promise.all(
        base.map((entry) =>
            limit(async () => {
                const main = await fetchPurpleOhlcv(entry.yahooSymbol ?? entry.ticker, entry.ticker, asOfDate);
                if (!entry.predecessorYahoo || !main) return { ticker: entry.ticker, series: main };
                const pre = await fetchPurpleOhlcv(entry.predecessorYahoo, entry.ticker, asOfDate);
                if (!pre) return { ticker: entry.ticker, series: main };
                return { ticker: entry.ticker, series: splicePredecessor(pre, main) };
            })
        )
    );

    const candSeries = await Promise.all(
        CANDIDATES.map((t) => limit(() => fetchPurpleOhlcv(t, t, asOfDate)).then((s) => ({ ticker: t, series: s })))
    );

    const out: Record<string, OhlcvSeries> = {};
    for (const { ticker, series } of [...baseSeries, ...candSeries]) {
        if (series) out[ticker] = series;
        else logger.warn(`missing ${ticker}`);
    }
    const outPath = path.join(import.meta.dirname, 'basket-swap-raw.json');
    fs.writeFileSync(outPath, JSON.stringify(out));
    logger.info(`wrote ${Object.keys(out).length} series to ${outPath}`);
}
if (import.meta.url === `file://${process.argv[1]}`) main();
