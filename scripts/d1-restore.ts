#!/usr/bin/env npx tsx
/**
 * Restore one (table, scan_date) from a d1-snapshot backup.
 *
 * WHY THIS EXISTS: on 2026-08-08 a verification run of the Lean scan
 * recomputed 2026-08-07 and replaced lean_signals — 149 rows became 43,
 * because Yahoo revised that day's volumes hours after the close. The
 * pre-migration baseline held only content hashes, so it could prove the data
 * had changed but could not put it back. This closes that gap before
 * setup_signals and fragility_daily migrate.
 *
 * DELIBERATELY SEPARATE from d1-snapshot.ts. That script has a hard read-only
 * guard and must keep it: the tool you run to inspect production should not be
 * one edit away from writing to it. All mutation lives here, behind --confirm.
 *
 * Scope is one table and one date per invocation, on purpose. A blanket
 * "restore everything" would happily revert days that changed legitimately.
 *
 * Usage:
 *   npx tsx scripts/d1-restore.ts --file snap.json --table lean_signals \
 *       --date 2026-08-07 [--confirm]
 *
 * Without --confirm it is a DRY RUN: prints what would change and exits.
 */
import fs from 'node:fs';

type Row = Record<string, unknown>;

// Self-contained on purpose: src/utils/d1Client.ts lives on `stable` (added
// with the RS ingest), and these operator scripts live on `main`. Importing
// across the branch split would make this file un-runnable here.
interface D1Config {
    accountId: string;
    databaseId: string;
    apiToken: string;
}
interface Batch {
    sql: string;
    params: unknown[];
}

function d1ConfigFromEnv(): D1Config | null {
    const accountId = process.env.CF_ACCOUNT_ID ?? '';
    const databaseId = process.env.D1_DATABASE_ID ?? '';
    const apiToken = process.env.CF_API_TOKEN ?? '';
    if (!accountId || !databaseId || !apiToken) return null;
    return { accountId, databaseId, apiToken };
}

async function runBatch(batch: Batch, cfg: D1Config): Promise<void> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}/query`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: batch.sql, params: batch.params }),
    });
    if (!res.ok) throw new Error(`D1 request failed ${res.status} ${res.statusText}`);
    const body = (await res.json()) as { success: boolean; errors?: unknown };
    if (!body.success) throw new Error(`D1 error: ${JSON.stringify(body.errors)}`);
}

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const FILE = arg('file');
const TABLE = arg('table');
const DATE = arg('date');
const CONFIRM = process.argv.includes('--confirm');

/** Only these four are ever restorable — the tables the dashboard reads. */
const ALLOWED_TABLES = new Set(['fragility_daily', 'setup_signals', 'rs_daily', 'lean_signals']);

/** SELECT the live rows so a dry run can show the real before/after. */
async function liveCount(table: string, date: string, cfg: D1Config): Promise<number> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}/query`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: `SELECT COUNT(*) AS n FROM ${table} WHERE scan_date = ?`, params: [date] }),
    });
    if (!res.ok) throw new Error(`D1 count failed ${res.status}`);
    const body = (await res.json()) as { result?: Array<{ results?: Row[] }> };
    return Number(body.result?.[0]?.results?.[0]?.n ?? 0);
}

/**
 * Rebuild INSERTs from the stored payload. Columns come from the payload
 * itself rather than a hardcoded list, so this keeps working if a table gains
 * a column — the backup is authoritative about its own shape.
 *
 * D1 caps at 100 bound params per query; chunk to stay under it.
 */
function buildRestoreBatches(table: string, date: string, rows: Row[]): Batch[] {
    const batches: Batch[] = [
        { sql: `DELETE FROM ${table} WHERE scan_date = ?`, params: [date] },
    ];
    if (rows.length === 0) return batches;

    const cols = Object.keys(rows[0]!).sort();
    const perChunk = Math.max(1, Math.floor(100 / cols.length));
    for (let i = 0; i < rows.length; i += perChunk) {
        const slice = rows.slice(i, i + perChunk);
        const placeholders = slice.map(() => `(${cols.map(() => '?').join(',')})`).join(',');
        const params: unknown[] = [];
        for (const r of slice) for (const c of cols) params.push(r[c] ?? null);
        batches.push({
            sql: `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES ${placeholders}`,
            params,
        });
    }
    return batches;
}

async function main(): Promise<void> {
    if (!FILE || !TABLE || !DATE) {
        console.error('Usage: d1-restore.ts --file <snapshot.json> --table <t> --date <YYYY-MM-DD> [--confirm]');
        process.exit(1);
    }
    if (!ALLOWED_TABLES.has(TABLE)) {
        console.error(`Refusing: "${TABLE}" is not one of ${[...ALLOWED_TABLES].join(', ')}`);
        process.exit(1);
    }

    const snap = JSON.parse(fs.readFileSync(FILE, 'utf8')) as {
        capturedAt?: string;
        restorable?: boolean;
        tables: Record<string, { present?: boolean; perDate?: Array<{ scanDate: string; rows: number; payload?: Row[] }> }>;
    };
    if (snap.restorable === false) {
        console.error('Refusing: this snapshot was taken with --no-rows and holds only hashes. Not restorable.');
        process.exit(1);
    }

    const entry = snap.tables?.[TABLE]?.perDate?.find((e) => e.scanDate === DATE);
    if (!entry) {
        console.error(`Refusing: ${TABLE} has no entry for ${DATE} in this snapshot.`);
        process.exit(1);
    }
    if (!entry.payload) {
        console.error(`Refusing: the ${DATE} entry has no row payload — hash only.`);
        process.exit(1);
    }

    const cfg = d1ConfigFromEnv();
    if (!cfg) {
        console.error('Missing CF_ACCOUNT_ID / D1_DATABASE_ID / CF_API_TOKEN.');
        process.exit(1);
    }

    const live = await liveCount(TABLE, DATE, cfg);
    const batches = buildRestoreBatches(TABLE, DATE, entry.payload);

    console.log(`\n  table:    ${TABLE}`);
    console.log(`  date:     ${DATE}`);
    console.log(`  backup:   ${entry.payload.length} rows  (captured ${snap.capturedAt?.slice(0, 19) ?? 'unknown'})`);
    console.log(`  live now: ${live} rows`);
    console.log(`  plan:     DELETE the date, then re-INSERT ${entry.payload.length} rows in ${batches.length - 1} batch(es)`);

    if (!CONFIRM) {
        console.log('\n  DRY RUN — nothing written. Re-run with --confirm to apply.\n');
        return;
    }
    for (const b of batches) await runBatch(b, cfg);
    const after = await liveCount(TABLE, DATE, cfg);
    console.log(`\n  restored. ${TABLE}/${DATE} is now ${after} rows (was ${live}).\n`);
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
