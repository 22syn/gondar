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
 * PARITY CONTRACT DELIBERATELY BROKEN (2026-08-17): `price` was added as a
 * fourth column, so the row shape no longer matches what `main` wrote. This was
 * a conscious call — the Smart D1 path is being retired, and the dashboard needs
 * a daily price for EVERY scanned ticker, not just the ones that fired a signal
 * (`lean_signals.price` only covers appearance days). Without it the ticker
 * history panel cannot say what a stock has done since a chosen signal.
 * Consequences of the break: the batch size had to drop 30 → 24 (4 × 24 = 96;
 * 30 would be 120 and exceed the cap), and per-date content hashes will no
 * longer match the pre-migration baseline — that baseline is a completed
 * one-time migration check, not a live assertion. scripts/d1-snapshot.ts uses
 * `SELECT *`, so backups and d1-restore pick the column up on their own.
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
    /**
     * Close for that scan, in the ticker's own raw units — agorot for .TA, and
     * whatever the listing quotes elsewhere. Deliberately NOT normalised: the
     * dashboard only ever divides two of these against each other for the same
     * ticker, where the scale cancels. Mixing in a differently-scaled quote
     * would silently corrupt .TA percentages.
     */
    price: number | null;
}

/** Stocks without a computed percentile are skipped, not written as null. */
export function buildRsRows(stocks: StockData[], scanDate: string): RsRow[] {
    return stocks
        .filter((s) => s.rsPercentile != null)
        .map((s) => ({
            scanDate,
            ticker: s.ticker,
            rs: s.rsPercentile!,
            // A stock can rank without a usable close (thin foreign listings).
            // Write null rather than 0 — the dashboard shows "no current price"
            // for null, but would render a real −100% for 0.
            price: s.lastPrice ?? null,
        }));
}

/**
 * CREATE + ALTER, run before any insert.
 *
 * `CREATE TABLE IF NOT EXISTS` alone is not enough to add `price`: every
 * deployment already HAS rs_daily, so the CREATE is a no-op there and the new
 * column would never appear. The ALTER is what actually migrates them, and it
 * is expected to fail with "duplicate column" on every run after the first —
 * same self-healing pattern as dashboard/src/ingestD1.ts's ensureSchema().
 *
 * Returned as data rather than executed here so the SQL is unit-testable
 * without mocking the D1 client.
 */
export function buildRsSchemaBatches(): Batch[] {
    return [
        {
            sql: `CREATE TABLE IF NOT EXISTS rs_daily (
                scan_date TEXT NOT NULL, ticker TEXT NOT NULL, rs INTEGER, price REAL,
                PRIMARY KEY (scan_date, ticker))`,
            params: [],
        },
        { sql: 'ALTER TABLE rs_daily ADD COLUMN price REAL', params: [] },
    ];
}

/**
 * True only for the benign "this column is already here" error. Anything else —
 * auth, network, a genuinely broken statement — must propagate, or a real
 * failure would be hidden and the inserts would then fail on every row.
 */
export function isDuplicateColumnError(message: string): boolean {
    return /duplicate column/i.test(message);
}

/** D1 caps at 100 bound params/query: 4 cols × 24 = 96. */
export function buildRsBatches(rsRows: RsRow[]): Batch[] {
    const batches: Batch[] = [
        {
            sql: `CREATE TABLE IF NOT EXISTS rs_daily (
                scan_date TEXT NOT NULL, ticker TEXT NOT NULL, rs INTEGER, price REAL,
                PRIMARY KEY (scan_date, ticker))`,
            params: [],
        },
    ];
    if (rsRows.length === 0) return batches;

    for (const d of [...new Set(rsRows.map((r) => r.scanDate))]) {
        batches.push({ sql: 'DELETE FROM rs_daily WHERE scan_date = ?', params: [d] });
    }
    for (let i = 0; i < rsRows.length; i += 24) {
        const slice = rsRows.slice(i, i + 24);
        const placeholders = slice.map(() => '(?,?,?,?)').join(',');
        const params: unknown[] = [];
        for (const r of slice) params.push(r.scanDate, r.ticker, r.rs, r.price);
        batches.push({
            sql: `INSERT OR REPLACE INTO rs_daily (scan_date,ticker,rs,price) VALUES ${placeholders}`,
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
        // Migrate before inserting: the 4-column INSERT below fails outright on
        // a deployment whose rs_daily predates the `price` column.
        for (const batch of buildRsSchemaBatches()) {
            try {
                await runBatch(batch, cfg);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (!isDuplicateColumnError(message)) throw err;
            }
        }
        for (const batch of buildRsBatches(rsRows)) {
            await runBatch(batch, cfg);
        }
        const priced = rsRows.filter((r) => r.price != null).length;
        logger.info(
            `📊 D1 RS ingest: ${rsRows.length} rows for ${scanDate} (${priced} with price)`
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`📊 D1 RS ingest failed (scan unaffected): ${message}`);
    }
}
