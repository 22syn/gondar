#!/usr/bin/env npx tsx
/**
 * Backfill `market_context` from history (2026-08-24).
 *
 * The panel's percentiles need 60 prior observations before they mean anything,
 * and at one row per trading day that is roughly mid-November. Every gauge is a
 * pure function of price history, so the whole series is computable today.
 *
 * **The cost trick:** computeMarketContext(date) fetches 500 constituents to
 * answer for ONE date. Doing that per day would be 500 x N requests. Here each
 * symbol is fetched ONCE over the full window and every date is computed from
 * the arrays in memory — ~505 requests for the entire backfill, the same order
 * as a single live scan.
 *
 * **Honest limits, both printed in the run summary:**
 *   - Survivorship bias. config/sp500.json is today's membership applied to past
 *     dates; the index changes ~20x/year, so a 1-year backfill is off by ~1-2%
 *     of constituents at the far end. Fine for a percentile distribution, not
 *     fine for claiming an exact historical S5FI print.
 *   - Early dates answer with fewer constituents (recent IPOs have no history),
 *     so any date under MIN_S5FI_CONSTITUENTS gets a null s5fi, exactly like a
 *     live run would.
 *
 * No lookahead: each date is computed from bars up to and including it, via the
 * same truncateTo() the live path uses.
 *
 * Usage:
 *   npx tsx scripts/backfill-market-context.ts --days 250            # dry run
 *   npx tsx scripts/backfill-market-context.ts --days 250 --dump /tmp/r.json
 *   npx tsx scripts/backfill-market-context.ts --days 250 --write    # + D1
 */
import fs from 'node:fs';
import pLimit from 'p-limit';
import {
    fetchSeries,
    truncateTo,
    distanceFromSma,
    slope,
    ratioSeries,
    loadSp500,
    MIN_S5FI_CONSTITUENTS,
    MIN_UNIVERSE_TICKERS,
    type OhlcSeries,
    type MarketContextDay,
} from '../src/services/marketContext.js';
import { calculateSMA, calculateWilliamsR } from '../src/utils/technicalAnalysis.js';
import { fetchAndCacheWatchlist, loadWatchlist } from '../src/config/index.js';
import { buildMarketContextBatches, ensureMarketContextSchema } from '../src/utils/marketContextD1Ingest.js';
import { runBatch, d1ConfigFromEnv } from '../src/utils/d1Client.js';

const WR_PERIODS = 14;
const CONCURRENCY = 8;

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main(): Promise<void> {
    const days = parseInt(arg('days', '250'), 10);
    const write = process.argv.includes('--write');
    // 2y of daily bars: MA50 and MA200 both need runway before the first
    // emitted date, and SMA200 is the longest lookback in the gauge set.
    const RANGE = '2y';

    console.log(`\n📅 Backfilling the last ${days} trading days (${write ? 'WRITE' : 'dry run'})\n`);

    const t0 = Date.now();
    const [spx, rsp, vix, xlp, xly, spyD, spyW, qqqD, qqqW] = await Promise.all([
        fetchSeries('^GSPC', '1d', RANGE),
        fetchSeries('RSP', '1d', RANGE),
        fetchSeries('^VIX', '1d', RANGE),
        fetchSeries('XLP', '1d', RANGE),
        fetchSeries('XLY', '1d', RANGE),
        fetchSeries('SPY', '1d', RANGE),
        fetchSeries('SPY', '1wk', RANGE),
        fetchSeries('QQQ', '1d', RANGE),
        fetchSeries('QQQ', '1wk', RANGE),
    ]);
    if (!spx) throw new Error('^GSPC fetch failed — cannot pick the trading calendar');

    const symbols = loadSp500();
    const limit = pLimit(CONCURRENCY);
    let ok = 0;
    const constituents = (
        await Promise.all(
            symbols.map((s) => limit(async () => {
                const r = await fetchSeries(s, '1d', RANGE);
                if (r) ok++;
                return r;
            }))
        )
    ).filter((s): s is OhlcSeries => s !== null);
    console.log(`📡 fetched ${ok}/${symbols.length} constituents + 9 index series in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // The radar's own universe, for universeBreadth and the spread. Same
    // fetch-once trick. Best-effort: if the watchlist sheet is unreachable the
    // backfill still produces every other gauge.
    let universe: OhlcSeries[] = [];
    try {
        await fetchAndCacheWatchlist();
        const wl = loadWatchlist();
        let uok = 0;
        universe = (
            await Promise.all(
                wl.map((t) => limit(async () => {
                    const r = await fetchSeries(t, '1d', RANGE);
                    if (r) uok++;
                    return r;
                }))
            )
        ).filter((x): x is OhlcSeries => x !== null);
        console.log(`📡 fetched ${uok}/${wl.length} universe tickers`);
    } catch (err) {
        console.warn(`⚠️  watchlist unavailable (${(err as Error).message}) — universeBreadth will be null`);
    }
    console.log();

    // Trading calendar = the index's own bar dates, newest `days` of them.
    const calendar = spx.dates.slice(-days);

    // Pre-index every constituent by date so each day is an O(1) lookup rather
    // than a scan of 500 arrays.
    const index = (list: OhlcSeries[]) =>
        list.map((c) => {
            const idx = new Map<string, number>();
            c.dates.forEach((d, i) => idx.set(d, i));
            return { c, idx };
        });
    const byDate = index(constituents);
    const uniByDate = index(universe);

    /** % of `set` closing above its own SMA50 on `date`, plus how many answered. */
    const breadthOn = (set: ReturnType<typeof index>, date: string) => {
        let above = 0, answered = 0;
        for (const { c, idx } of set) {
            const i = idx.get(date);
            if (i === undefined || i < 50) continue;
            const sma50 = calculateSMA(c.closes.slice(i - 49, i + 1), 50);
            if (sma50 == null) continue;
            answered++;
            if (c.closes[i]! > sma50) above++;
        }
        return { above, answered };
    };

    const rows: MarketContextDay[] = [];
    const nCounts: number[] = [];
    for (const date of calendar) {
        const t = (s: OhlcSeries | null) => (s ? truncateTo(s, date) : null);
        const tSpx = t(spx), tRsp = t(rsp), tVix = t(vix), tXlp = t(xlp), tXly = t(xly);
        const last = (s: OhlcSeries | null) => (s && s.closes.length ? s.closes[s.closes.length - 1]! : null);

        const { above, answered } = breadthOn(byDate, date);
        nCounts.push(answered);
        const s5fi = answered >= MIN_S5FI_CONSTITUENTS ? (above / answered) * 100 : null;

        const u = breadthOn(uniByDate, date);
        const universeBreadth = u.answered >= MIN_UNIVERSE_TICKERS ? (u.above / u.answered) * 100 : null;
        const breadthSpread = s5fi != null && universeBreadth != null ? s5fi - universeBreadth : null;

        const wr = (s: OhlcSeries | null): number | null => {
            if (!s) return null;
            const x = truncateTo(s, date);
            return calculateWilliamsR(x.highs, x.lows, x.closes, WR_PERIODS) ?? null;
        };
        const xlpSpx = tXlp && tSpx ? ratioSeries(tXlp, tSpx) : [];
        const xlyXlp = tXly && tXlp ? ratioSeries(tXly, tXlp) : [];

        rows.push({
            scanDate: date,
            spxClose: last(tSpx),
            spxDistSma150: tSpx ? distanceFromSma(tSpx.closes, 150) : null,
            spxDistSma200: tSpx ? distanceFromSma(tSpx.closes, 200) : null,
            rspClose: last(tRsp),
            rspSlope21: tRsp ? slope(tRsp.closes) : null,
            vix: last(tVix),
            xlpSpxRatio: xlpSpx.length ? xlpSpx[xlpSpx.length - 1]! : null,
            xlpSpxSlope21: slope(xlpSpx),
            xlyXlpRatio: xlyXlp.length ? xlyXlp[xlyXlp.length - 1]! : null,
            xlyXlpSlope21: slope(xlyXlp),
            s5fi,
            s5fiN: answered,
            spyWr1d: wr(spyD), spyWr1w: wr(spyW),
            qqqWr1d: wr(qqqD), qqqWr1w: wr(qqqW),
            universeBreadth, universeBreadthN: u.answered, breadthSpread,
        });
    }

    const gauges = ['spxDistSma150', 'rspSlope21', 'vix', 'xlpSpxSlope21', 'xlyXlpSlope21', 's5fi'] as const;
    const complete = rows.filter((r) => gauges.every((g) => r[g] != null)).length;
    const nullS5fi = rows.filter((r) => r.s5fi == null).length;
    console.log(`🧮 computed ${rows.length} rows  ${rows[0]!.scanDate} → ${rows[rows.length - 1]!.scanDate}`);
    console.log(`   all six gauges present: ${complete}/${rows.length}`);
    console.log(`   s5fi null (under ${MIN_S5FI_CONSTITUENTS} constituents): ${nullS5fi}`);
    console.log(`   constituents answering: min ${Math.min(...nCounts)}, max ${Math.max(...nCounts)}`);
    console.log(`   ⚠️  survivorship: today's S&P membership AND today's watchlist applied to past dates`);
    const sp = rows.map((r) => r.breadthSpread).filter((v): v is number => v != null);
    if (sp.length) {
        const srt = [...sp].sort((a, b) => a - b);
        const pct = (x: number) => srt[Math.floor((x / 100) * (srt.length - 1))]!.toFixed(1);
        console.log(`   universeBreadth present on ${rows.filter((r) => r.universeBreadth != null).length}/${rows.length} rows`);
        console.log(`   spread (s5fi − universe) pp: min ${pct(0)} p10 ${pct(10)} med ${pct(50)} p90 ${pct(90)} max ${pct(100)}`);
    }
    const s5 = rows.map((r) => r.s5fi).filter((v): v is number => v != null).sort((a, b) => a - b);
    if (s5.length) {
        const p = (x: number) => s5[Math.floor((x / 100) * (s5.length - 1))]!.toFixed(1);
        console.log(`   s5fi distribution: min ${p(0)} p10 ${p(10)} med ${p(50)} p90 ${p(90)} max ${p(100)}`);
    }

    // --dump lets the computed series be inspected (or enriched with the
    // dashboard's percentile logic) before anything touches D1.
    const dump = arg('dump', '');
    if (dump) {
        fs.writeFileSync(dump, JSON.stringify(rows.map((r) => ({
            scan_date: r.scanDate, spx_close: r.spxClose,
            spx_dist_sma150: r.spxDistSma150, spx_dist_sma200: r.spxDistSma200,
            rsp_close: r.rspClose, rsp_slope21: r.rspSlope21, vix: r.vix,
            xlp_spx_ratio: r.xlpSpxRatio, xlp_spx_slope21: r.xlpSpxSlope21,
            xly_xlp_ratio: r.xlyXlpRatio, xly_xlp_slope21: r.xlyXlpSlope21,
            s5fi: r.s5fi, s5fi_n: r.s5fiN,
            universe_breadth: r.universeBreadth, universe_breadth_n: r.universeBreadthN,
            breadth_spread: r.breadthSpread,
            spy_wr_1d: r.spyWr1d, spy_wr_1w: r.spyWr1w,
            qqq_wr_1d: r.qqqWr1d, qqq_wr_1w: r.qqqWr1w,
        }))));
        console.log(`   dumped to ${dump}`);
    }

    if (!write) {
        console.log('\n(dry run — pass --write to ingest)\n');
        return;
    }
    const cfg = d1ConfigFromEnv();
    if (!cfg) { console.error('❌ CF_* not configured'); process.exit(2); }
    // The table predates universe_breadth/breadth_spread. This script runs its
    // own batches rather than going through ingestMarketContextToD1, so it has
    // to apply the same migration — skipping it is how run 32703929257 died.
    await ensureMarketContextSchema(cfg);

    let written = 0;
    for (const row of rows) {
        for (const batch of buildMarketContextBatches(row, new Date().toISOString())) {
            await runBatch(batch, cfg);
        }
        written++;
        if (written % 50 === 0) console.log(`   …${written}/${rows.length}`);
    }
    console.log(`\n✅ wrote ${written} rows (INSERT OR REPLACE, no deletes)\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
