/**
 * Market Context -> D1 `market_context` (2026-08-22). One row per trading day,
 * read by the dashboard's Market Context panel.
 *
 * **Write shape: INSERT OR REPLACE on a single scan_date. No DELETE, ever.**
 * That is a hard rule here, not a style preference. Rows have been lost twice in
 * this project to an ingest that cleared a range before rewriting it, and unlike
 * fragility_daily — which rewrites a whole recomputed series and therefore needs
 * a bounded range delete — this table only ever writes today. A primary key on
 * scan_date plus INSERT OR REPLACE makes the re-run at 23:45 idempotent without
 * any statement that can remove a row it has no replacement for.
 *
 * Percentiles and the warning count are deliberately NOT stored. They are
 * derived from a rolling window and are computed at read time in the dashboard,
 * so the window can be retuned without a backfill.
 *
 * Never throws — a D1 outage must not fail a scan whose report has already gone
 * out. Returns true on write, false on skip/failure.
 */
import { runBatch, d1ConfigFromEnv, type Batch, type D1Config } from './d1Client.js';
import type { MarketContextDay } from '../services/marketContext.js';
import logger from './logger.js';

const COLS =
    '(scan_date, spx_close, spx_dist_sma150, spx_dist_sma200, rsp_close, rsp_slope21, vix, ' +
    'xlp_spx_ratio, xlp_spx_slope21, xly_xlp_ratio, xly_xlp_slope21, s5fi, s5fi_n, ' +
    'spy_wr_1d, spy_wr_1w, qqq_wr_1d, qqq_wr_1w, ' +
    'universe_breadth, universe_breadth_n, breadth_spread, ingested_at)';

/** 21 columns, one row — far under D1's 100-bound-param cap. */
export const MARKET_CONTEXT_COL_COUNT = 21;

const round = (x: number | null, digits: number): number | null =>
    x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** digits) / 10 ** digits;

export function buildMarketContextBatches(day: MarketContextDay, stamp: string): Batch[] {
    return [
        {
            sql: `CREATE TABLE IF NOT EXISTS market_context (
                scan_date TEXT PRIMARY KEY,
                spx_close REAL, spx_dist_sma150 REAL, spx_dist_sma200 REAL,
                rsp_close REAL, rsp_slope21 REAL,
                vix REAL,
                xlp_spx_ratio REAL, xlp_spx_slope21 REAL,
                xly_xlp_ratio REAL, xly_xlp_slope21 REAL,
                s5fi REAL, s5fi_n INTEGER,
                spy_wr_1d REAL, spy_wr_1w REAL, qqq_wr_1d REAL, qqq_wr_1w REAL,
                universe_breadth REAL, universe_breadth_n INTEGER, breadth_spread REAL,
                ingested_at TEXT)`,
            params: [],
        },
        {
            sql: `INSERT OR REPLACE INTO market_context ${COLS} VALUES (${'?,'.repeat(MARKET_CONTEXT_COL_COUNT - 1)}?)`,
            params: [
                day.scanDate,
                round(day.spxClose, 4),
                round(day.spxDistSma150, 4),
                round(day.spxDistSma200, 4),
                round(day.rspClose, 4),
                round(day.rspSlope21, 4),
                round(day.vix, 4),
                round(day.xlpSpxRatio, 8),
                round(day.xlpSpxSlope21, 4),
                round(day.xlyXlpRatio, 8),
                round(day.xlyXlpSlope21, 4),
                round(day.s5fi, 4),
                day.s5fiN,
                round(day.spyWr1d, 4),
                round(day.spyWr1w, 4),
                round(day.qqqWr1d, 4),
                round(day.qqqWr1w, 4),
                round(day.universeBreadth, 4),
                day.universeBreadthN,
                round(day.breadthSpread, 4),
                stamp,
            ],
        },
    ];
}

/**
 * Add columns that arrived after the table already existed. Same
 * duplicate-column-tolerant pattern as fragilityD1Ingest and
 * dashboard/src/ingestD1.ts's ensureSchema.
 *
 * Exported because more than one writer exists: the live ingest below AND
 * scripts/backfill-market-context.ts, which builds and runs its own batches to
 * avoid re-deriving a day it already has. The backfill bypassing this is
 * exactly how run 32703929257 failed with "no column named universe_breadth" —
 * every writer must call it, so it lives here rather than inline.
 */
export async function ensureMarketContextSchema(config: D1Config): Promise<void> {
    for (const col of ['universe_breadth REAL', 'universe_breadth_n INTEGER', 'breadth_spread REAL']) {
        try {
            await runBatch({ sql: `ALTER TABLE market_context ADD COLUMN ${col}`, params: [] }, config);
        } catch (err) {
            if (!/duplicate column/i.test((err as Error).message)) throw err;
        }
    }
}

export async function ingestMarketContextToD1(
    day: MarketContextDay | null,
    cfg?: D1Config
): Promise<boolean> {
    try {
        if (!day) return false;
        const config: D1Config | null = cfg ?? d1ConfigFromEnv();
        if (!config) {
            logger.info('🌍 D1 market-context ingest skipped (CF_* env not configured)');
            return false;
        }
        const stamp = new Date().toISOString();
        await ensureMarketContextSchema(config);
        for (const batch of buildMarketContextBatches(day, stamp)) {
            await runBatch(batch, config);
        }
        logger.info(`🌍 D1 market-context row written for ${day.scanDate}`);
        return true;
    } catch (err) {
        logger.warn(
            `🌍 D1 market-context ingest failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
        );
        return false;
    }
}
