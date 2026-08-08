/**
 * Write the daily RS-percentile snapshot to D1's `rs_daily`.
 *
 * MIGRATION NOTE (slice 1 of 3, 2026-08-08): `rs_daily` was written by the
 * Smart pipeline on `main` (src/utils/setupD1Ingest.ts). It is moving here so
 * the Lean scan owns it and Smart can be retired. The GONDAR dashboard must not
 * be able to tell the difference, so the SQL, the batch size, the delete-first
 * behaviour and the row contents are all reproduced EXACTLY as `main` had them:
 *
 *   - DELETE per scan_date before inserting, so a re-run of the same trading day
 *     fully replaces the earlier run rather than accumulating duplicates. The
 *     Lean scan runs twice on weekdays (20:15 primary + 23:45 settled-close
 *     refresh) and the second must overwrite the first.
 *   - batch size 30: D1 caps at 100 bound params per query, and 3 cols × 30 = 90.
 *   - only stocks with a non-null rsPercentile are written.
 *
 * Verify with scripts/d1-snapshot.ts: the per-date content hashes must match the
 * pre-migration baseline (results/d1-snapshot-before-migration.json).
 *
 * Never throws — a D1 or network failure must not fail the scan, whose Telegram
 * report has already been sent by the time this runs.
 */
import type { StockData } from '../types/index.js';
import { d1ConfigFromEnv, runBatch, type Batch } from './d1Client.js';
import logger from './logger.js';

export interface RsRow {
    scanDate: string;
    ticker: string;
    rs: number;
}

/** Stocks without a computed percentile are skipped, not written as null. */
export function buildRsRows(stocks: StockData[], scanDate: string): RsRow[] {
    return stocks
        .filter((s) => s.rsPercentile != null)
        .map((s) => ({ scanDate, ticker: s.ticker, rs: s.rsPercentile! }));
}

/** D1 caps at 100 bound params/query: 3 cols × 30 = 90. */
export function buildRsBatches(rsRows: RsRow[]): Batch[] {
    const batches: Batch[] = [
        {
            sql: `CREATE TABLE IF NOT EXISTS rs_daily (
                scan_date TEXT NOT NULL, ticker TEXT NOT NULL, rs INTEGER,
                PRIMARY KEY (scan_date, ticker))`,
            params: [],
        },
    ];
    if (rsRows.length === 0) return batches;

    for (const d of [...new Set(rsRows.map((r) => r.scanDate))]) {
        batches.push({ sql: 'DELETE FROM rs_daily WHERE scan_date = ?', params: [d] });
    }
    for (let i = 0; i < rsRows.length; i += 30) {
        const slice = rsRows.slice(i, i + 30);
        const placeholders = slice.map(() => '(?,?,?)').join(',');
        const params: unknown[] = [];
        for (const r of slice) params.push(r.scanDate, r.ticker, r.rs);
        batches.push({
            sql: `INSERT OR REPLACE INTO rs_daily (scan_date,ticker,rs) VALUES ${placeholders}`,
            params,
        });
    }
    return batches;
}

/**
 * Ingest the RS snapshot. Silent no-op when CF_* env is absent (local runs),
 * and swallows failures by design — see the module note.
 */
export async function ingestRsToD1(stocks: StockData[], scanDate: string): Promise<void> {
    const cfg = d1ConfigFromEnv();
    if (!cfg) {
        logger.info('📊 D1 RS ingest skipped (CF_* env not configured)');
        return;
    }
    const rsRows = buildRsRows(stocks, scanDate);
    if (rsRows.length === 0) {
        logger.warn('📊 D1 RS ingest: no stocks had rsPercentile — nothing written');
        return;
    }
    try {
        for (const batch of buildRsBatches(rsRows)) {
            await runBatch(batch, cfg);
        }
        logger.info(`📊 D1 RS ingest: ${rsRows.length} rows for ${scanDate}`);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`📊 D1 RS ingest failed (scan unaffected): ${message}`);
    }
}
