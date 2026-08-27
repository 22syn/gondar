/**
 * Targeted backfill for the two columns added in #219 — s5th (% of S&P 500
 * above its SMA200) and spx_support (nearest swing-low). It writes ONLY those
 * columns, via `UPDATE ... WHERE scan_date = ?`, and never touches s5fi,
 * universe_breadth, the ratios or Williams %R.
 *
 * Why not the full backfill-market-context.ts: that one INSERT OR REPLACEs the
 * whole row, which would recompute every gauge against TODAY's S&P membership
 * and watchlist — re-applying survivorship bias to the point-in-time-correct
 * rows the daily scan has accreted since the last full backfill. This script
 * leaves every existing value in place and only fills the new columns.
 *
 * Usage:
 *   npx tsx scripts/backfill-s5th-support.ts --days 520              # dry run
 *   npx tsx scripts/backfill-s5th-support.ts --days 520 --range 3y --write
 *
 * The fetch window must exceed --days by ~200 bars so the FAR edge still has a
 * 200-bar average for s5th; a 3y range covers a ~2y (~504 trading day) history.
 * s5th stays null on any date without 200 prior bars (the very oldest rows, and
 * recently-listed constituents), exactly as the live path reports it.
 */
import pLimit from 'p-limit';
import {
    fetchSeries,
    truncateTo,
    nearestSupport,
    loadSp500,
    MIN_S5FI_CONSTITUENTS,
    type OhlcSeries,
} from '../src/services/marketContext.js';
import { calculateSMA } from '../src/utils/technicalAnalysis.js';
import { runBatch, d1ConfigFromEnv } from '../src/utils/d1Client.js';

const CONCURRENCY = 8;

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const round = (x: number | null, digits: number): number | null =>
    x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** digits) / 10 ** digits;

async function main(): Promise<void> {
    const days = parseInt(arg('days', '520'), 10);
    const range = arg('range', '3y');
    const write = process.argv.includes('--write');
    console.log(`\n📅 Backfilling s5th + spx_support for the last ${days} trading days ` +
        `(range ${range}, ${write ? 'WRITE' : 'dry run'})\n`);

    const t0 = Date.now();
    const spx = await fetchSeries('^GSPC', '1d', range);
    if (!spx) throw new Error('^GSPC fetch failed — cannot pick the trading calendar');

    const symbols = loadSp500();
    const limit = pLimit(CONCURRENCY);
    let ok = 0;
    const constituents = (
        await Promise.all(symbols.map((s) => limit(async () => {
            const r = await fetchSeries(s, '1d', range);
            if (r) ok++;
            return r;
        })))
    ).filter((s): s is OhlcSeries => s !== null);
    console.log(`📡 fetched ${ok}/${symbols.length} constituents + ^GSPC in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // Pre-index each constituent by date for O(1) per-day lookups.
    const byDate = constituents.map((c) => {
        const idx = new Map<string, number>();
        c.dates.forEach((d, i) => idx.set(d, i));
        return { c, idx };
    });

    /** % of constituents above their own SMA200 on `date`, plus how many answered. */
    const s5thOn = (date: string): { value: number | null; n: number } => {
        let above = 0, answered = 0;
        for (const { c, idx } of byDate) {
            const i = idx.get(date);
            if (i === undefined || i < 200) continue;
            const sma = calculateSMA(c.closes.slice(i - 199, i + 1), 200);
            if (sma == null) continue;
            answered++;
            if (c.closes[i]! > sma) above++;
        }
        return { value: answered >= MIN_S5FI_CONSTITUENTS ? (above / answered) * 100 : null, n: answered };
    };

    const calendar = spx.dates.slice(-days);
    const cfg = write ? d1ConfigFromEnv() : null;
    if (write && !cfg) { console.error('❌ CF_* not configured'); process.exit(2); }

    let updated = 0, withS5th = 0, withSupport = 0, skipped = 0;
    for (const date of calendar) {
        const { value: s5th, n: s5thN } = s5thOn(date);
        const tSpx = truncateTo(spx, date);
        const lastClose = tSpx.closes.length ? tSpx.closes[tSpx.closes.length - 1]! : null;
        const support = nearestSupport(tSpx.lows, lastClose);

        if (s5th == null && support == null) { skipped++; continue; }  // nothing to add
        if (s5th != null) withS5th++;
        if (support != null) withSupport++;

        if (cfg) {
            // UPDATE only — the row must already exist (written by a prior scan
            // or the full backfill); a date not yet in the table is a no-op.
            await runBatch({
                sql: 'UPDATE market_context SET s5th = ?, s5th_n = ?, spx_support = ? WHERE scan_date = ?',
                params: [round(s5th, 4), s5thN, round(support, 2), date],
            }, cfg);
        }
        updated++;
        if (updated % 50 === 0) console.log(`   …${updated}/${calendar.length}`);
    }

    console.log(`\n🧮 ${calendar.length} dates  ${calendar[0]} → ${calendar[calendar.length - 1]}`);
    console.log(`   s5th computed: ${withS5th}  ·  support computed: ${withSupport}  ·  fully-null skipped: ${skipped}`);
    console.log(write ? `\n✅ UPDATEd ${updated} rows (targeted columns only, no INSERT/DELETE)\n`
        : `\n(dry run — pass --write to apply)\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
