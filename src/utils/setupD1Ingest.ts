/**
 * Write the daily Smart-Setup signals to D1's `setup_signals`.
 *
 * MIGRATION NOTE (slice 2 of 3, 2026-08-08): `setup_signals` was written by the
 * Smart pipeline on `main`. It moves here so the Lean scan owns it and Smart can
 * be retired. The GONDAR dashboard must not be able to tell the difference, so
 * the row shape, scoring, SQL, batch size and delete-first behaviour are all
 * reproduced EXACTLY as `main` had them.
 *
 * Why this table is written SEPARATELY from `lean_signals` rather than merged
 * into it: the Lean ingest does DELETE-first on `lean_signals` per scan_date
 * (including the 23:45 settled-close refresh), so anything written there from
 * another path would be clobbered. Separate tables plus the dashboard's
 * read-time merge (dashboard/src/mergeSetup.ts) avoid the race entirely. That
 * reasoning still holds now that both writers live in the same process — and
 * folding them together would change what the dashboard reads, which is exactly
 * what this migration must not do.
 *
 * Verify with scripts/d1-snapshot.ts against the pre-slice2 backup in
 * cabinet outputs/2026-08-08-d1-backup-pre-slice2.json. This table carries only
 * 1-4 rows/day (24 across 10 days), so a defect here is nearly invisible without
 * a row-level comparison — do not settle for "the count looks right".
 *
 * Never throws — a D1 or network failure must not fail the scan.
 */
import type { StockData } from '../types/index.js';
import { d1ConfigFromEnv, runBatch, type Batch } from './d1Client.js';
import logger from './logger.js';

export interface SetupRow {
    scanDate: string;
    ticker: string;
    region: 'US' | 'TASE' | 'Foreign';
    sector: string;
    sig: 'setupFull' | 'setupClose' | 'setupRecovery';
    rvol: number;
    athPct: number | null;
    dayPct: number;
    stage2: 0 | 1;
    score: number;
    price: number;
    rs: number | null;
}

const LEVEL_TO_SIG: Record<string, SetupRow['sig']> = {
    full: 'setupFull',
    close: 'setupClose',
    recovery: 'setupRecovery',
};

const SETUP_BASE: Record<SetupRow['sig'], number> = {
    setupFull: 60,
    setupRecovery: 55,
    setupClose: 40,
};

const FOREIGN_SUFFIXES = [
    '.TW', '.KS', '.T', '.MI', '.PA', '.L', '.AS', '.SW', '.VI',
    '.SA', '.BK', '.HK', '.DE', '.CO', '.ST', '.HE', '.OL', '.MC', '.BR', '.TO',
];

export function regionOf(ticker: string): 'US' | 'TASE' | 'Foreign' {
    if (ticker.endsWith('.TA')) return 'TASE';
    if (FOREIGN_SUFFIXES.some((s) => ticker.endsWith(s))) return 'Foreign';
    return 'US';
}

/**
 * One row per stock that reached a momentum level (full / close / recovery).
 * Stocks at level 'none', or without a price, are skipped entirely — this is a
 * signals table, not a universe snapshot (unlike rs_daily).
 */
export function buildSetupRows(stocks: StockData[], scanDate: string): SetupRow[] {
    const rows: SetupRow[] = [];
    for (const s of stocks) {
        const level = s.momentum?.level;
        const sig = level ? LEVEL_TO_SIG[level] : undefined;
        if (!sig || s.lastPrice == null) continue;
        const rvol = s.projectedRvol ?? s.rvol ?? 0;
        const stage2: 0 | 1 = s.momentum?.criteria.stage2 ? 1 : 0;
        const rs = s.rsPercentile ?? null;
        const score = Math.round(
            SETUP_BASE[sig] + Math.min(rvol, 6) * 5 + (stage2 ? 20 : 0) + ((rs ?? 0) >= 90 ? 10 : 0)
        );
        rows.push({
            scanDate,
            ticker: s.ticker,
            region: regionOf(s.ticker),
            sector: s.sector ?? '',
            sig,
            rvol: Math.round(rvol * 100) / 100,
            athPct: s.pctFromAth != null ? Math.round(s.pctFromAth * 100) / 100 : null,
            dayPct: Math.round((s.priceChange ?? 0) * 100) / 100,
            stage2,
            score,
            price: s.lastPrice,
            rs,
        });
    }
    return rows;
}

const SETUP_COLS =
    '(scan_date,ticker,region,sector,sig,rvol,ath_pct,day_pct,stage2,score,price,rs,ingested_at)';

/** D1 caps at 100 bound params/query: 13 cols × 7 = 91. */
export function buildSetupBatches(setupRows: SetupRow[], stamp: string): Batch[] {
    const batches: Batch[] = [
        {
            sql: `CREATE TABLE IF NOT EXISTS setup_signals (
                scan_date TEXT NOT NULL, ticker TEXT NOT NULL, region TEXT, sector TEXT,
                sig TEXT NOT NULL, rvol REAL, ath_pct REAL, day_pct REAL, stage2 INTEGER,
                score INTEGER, price REAL, rs INTEGER, ingested_at TEXT,
                PRIMARY KEY (scan_date, ticker))`,
            params: [],
        },
    ];
    if (setupRows.length === 0) return batches;

    for (const d of [...new Set(setupRows.map((r) => r.scanDate))]) {
        batches.push({ sql: 'DELETE FROM setup_signals WHERE scan_date = ?', params: [d] });
    }
    for (let i = 0; i < setupRows.length; i += 7) {
        const slice = setupRows.slice(i, i + 7);
        const placeholders = slice.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
        const params: unknown[] = [];
        for (const r of slice) {
            params.push(r.scanDate, r.ticker, r.region, r.sector, r.sig, r.rvol,
                r.athPct, r.dayPct, r.stage2, r.score, r.price, r.rs, stamp);
        }
        batches.push({
            sql: `INSERT OR REPLACE INTO setup_signals ${SETUP_COLS} VALUES ${placeholders}`,
            params,
        });
    }
    return batches;
}

/**
 * Ingest the setup signals. Silent no-op without CF_* env (local runs), and
 * swallows failures by design — see the module note.
 *
 * Zero rows is a LEGITIMATE outcome here (some days nothing reaches a momentum
 * level), so unlike the RS ingest this still runs the delete, clearing any
 * stale rows for the date rather than leaving yesterday's signals standing.
 */
export async function ingestSetupToD1(stocks: StockData[], scanDate: string): Promise<void> {
    const cfg = d1ConfigFromEnv();
    if (!cfg) {
        logger.info('📊 D1 setup ingest skipped (CF_* env not configured)');
        return;
    }
    const setupRows = buildSetupRows(stocks, scanDate);
    const stamp = `setup-daily ${new Date().toISOString()}`;
    try {
        for (const batch of buildSetupBatches(setupRows, stamp)) {
            await runBatch(batch, cfg);
        }
        // Explicitly clear the date even when nothing qualified, so a day that
        // goes quiet does not leave the previous run's signals on the dashboard.
        if (setupRows.length === 0) {
            await runBatch(
                { sql: 'DELETE FROM setup_signals WHERE scan_date = ?', params: [scanDate] },
                cfg
            );
        }
        logger.info(`📊 D1 setup ingest: ${setupRows.length} rows for ${scanDate}`);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`📊 D1 setup ingest failed (scan unaffected): ${message}`);
    }
}
