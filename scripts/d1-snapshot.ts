#!/usr/bin/env npx tsx
/**
 * READ-ONLY snapshot of the four D1 tables the GONDAR dashboard reads.
 *
 * Purpose: the Smart -> Lean ingest migration must be INVISIBLE to the
 * dashboard. This captures a "before" fingerprint so an "after" run can be
 * diffed against it. If the fingerprints differ, the migration is wrong.
 *
 * SAFETY: every statement here is a SELECT. There is a hard guard below that
 * refuses to send anything else, so this script cannot mutate D1 even if
 * edited carelessly.
 *
 * `ingested_at` is deliberately EXCLUDED from the content hash: it is a
 * wall-clock stamp that legitimately changes on every re-ingest. Including it
 * would make every before/after comparison fail for the one reason we don't
 * care about. It is still reported, just not hashed.
 *
 * Usage (needs CF_ACCOUNT_ID / D1_DATABASE_ID / CF_API_TOKEN):
 *   npx tsx scripts/d1-snapshot.ts [--dates 10] [--out results/d1-snapshot.json]
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Tables the dashboard reads. All four are keyed by scan_date. */
const TABLES = ['fragility_daily', 'setup_signals', 'rs_daily', 'lean_signals'] as const;

/** Columns excluded from the content hash — they change without meaning. */
const HASH_EXCLUDED = new Set(['ingested_at']);

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const DATE_LIMIT = parseInt(arg('dates', '10'), 10);
const OUT_PATH = arg('out', 'results/d1-snapshot.json');

/**
 * Per-table overrides for the date window, for tables whose consumers read far
 * more history than the shared limit gives and whose rows are cheap enough that
 * it costs nothing.
 *
 * fragility_daily is one row per trading day — 60 days is 0.03 MB, 250 is
 * ~0.13 MB. Meanwhile /api/fragility asks for `limit ?? 250`, so the live chart
 * draws a year while a 60-date snapshot could only ever show two months. That
 * gap is what made alpha-engine's vendored copy of this dashboard visibly
 * disagree with the live one.
 *
 * Raising the shared limit instead would have been ~15 MB: rs_daily alone is
 * ~630 rows PER DAY (1.0 MB at 29 days), and lean_signals ~55/day. Those two are
 * read per-day by the grid and genuinely do not need a year in the artifact.
 */
const DATE_LIMIT_BY_TABLE: Record<string, number> = {
    fragility_daily: Math.max(DATE_LIMIT, 250),
};
const dateLimitFor = (table: string): number => DATE_LIMIT_BY_TABLE[table] ?? DATE_LIMIT;

/**
 * Include every row's full payload, not just a content hash.
 *
 * Added 2026-08-08 after a hard lesson: hashes DETECT that data changed but
 * cannot put it back. A verification run of the Lean scan recomputed
 * 2026-08-07 and replaced lean_signals (149 rows -> 43, because Yahoo revised
 * that day's volumes hours after the close). The pre-migration baseline held
 * only hashes, so the original rows were unrecoverable.
 *
 * The remaining migration slices write setup_signals and fragility_daily —
 * tables the dashboard renders directly — so a real restorable backup has to
 * exist BEFORE they move. Defaults ON: a backup you have to remember to ask
 * for is not a backup.
 */
const WITH_ROWS = !process.argv.includes('--no-rows');

interface D1Config {
    accountId: string;
    databaseId: string;
    apiToken: string;
}

type Row = Record<string, unknown>;

/**
 * Run one SELECT against D1. Refuses anything else — this script must never be
 * able to write, whatever a future edit does to the query strings.
 */
async function query(sql: string, cfg: D1Config): Promise<Row[]> {
    const normalized = sql.trim().toUpperCase();
    if (!normalized.startsWith('SELECT')) {
        throw new Error(`d1-snapshot is read-only; refusing non-SELECT statement: ${sql.slice(0, 60)}`);
    }
    const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}/query`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, params: [] }),
    });
    if (!res.ok) {
        // Never echo the response body wholesale — it can contain the request
        // context. Status + a short reason is enough to debug.
        throw new Error(`D1 request failed ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as {
        success: boolean;
        errors?: unknown;
        result?: Array<{ results?: Row[] }>;
    };
    if (!body.success) throw new Error(`D1 error: ${JSON.stringify(body.errors)}`);
    return body.result?.[0]?.results ?? [];
}

/** Stable hash of a date's rows: sorted keys, sorted rows, volatile cols dropped. */
function contentHash(rows: Row[]): string {
    const canonical = rows
        .map((r) => {
            const keys = Object.keys(r).filter((k) => !HASH_EXCLUDED.has(k)).sort();
            return JSON.stringify(keys.map((k) => [k, r[k]]));
        })
        .sort()
        .join('\n');
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

interface DateFingerprint {
    scanDate: string;
    rows: number;
    hash: string;
    /** Full row payloads — present unless --no-rows. This is what makes the
     *  snapshot restorable by scripts/d1-restore.ts rather than merely
     *  diffable. Stored verbatim, including `ingested_at`, so a restore
     *  reproduces the original exactly even though that column is excluded
     *  from `hash`. */
    payload?: Row[];
}

interface TablePresent {
    present: true;
    totalRows: number;
    dateRange: { min: unknown; max: unknown };
    distinctDatesSampled: number;
    perDate: DateFingerprint[];
}

interface TableAbsent {
    present: false;
    reason: string;
}

type TableSnapshot = TablePresent | TableAbsent;

/** A table that does not exist yet is a fact worth recording, not a crash. */
async function snapshotTable(table: string, cfg: D1Config): Promise<TableSnapshot> {
    let total: number;
    try {
        const [row] = await query(`SELECT COUNT(*) AS n FROM ${table}`, cfg);
        total = Number(row?.n ?? 0);
    } catch (err) {
        return { present: false, reason: err instanceof Error ? err.message : String(err) };
    }

    const dates = await query(
        `SELECT scan_date, COUNT(*) AS n FROM ${table} GROUP BY scan_date ORDER BY scan_date DESC LIMIT ${dateLimitFor(table)}`,
        cfg
    );

    const perDate: DateFingerprint[] = [];
    for (const d of dates) {
        const scanDate = String(d.scan_date);
        // Order by every table's real key so the hash is stable across runs.
        const rows = await query(
            `SELECT * FROM ${table} WHERE scan_date = '${scanDate}' ORDER BY scan_date`,
            cfg
        );
        const entry: DateFingerprint = { scanDate, rows: Number(d.n), hash: contentHash(rows) };
        if (WITH_ROWS) entry.payload = rows;
        perDate.push(entry);
    }

    const allDates = await query(
        `SELECT MIN(scan_date) AS lo, MAX(scan_date) AS hi FROM ${table}`,
        cfg
    );

    return {
        present: true,
        totalRows: total,
        dateRange: { min: allDates[0]?.lo ?? null, max: allDates[0]?.hi ?? null },
        distinctDatesSampled: perDate.length,
        perDate,
    };
}

async function main(): Promise<void> {
    const cfg: D1Config = {
        accountId: process.env.CF_ACCOUNT_ID ?? '',
        databaseId: process.env.D1_DATABASE_ID ?? '',
        apiToken: process.env.CF_API_TOKEN ?? '',
    };
    if (!cfg.accountId || !cfg.databaseId || !cfg.apiToken) {
        console.error('Missing CF_ACCOUNT_ID / D1_DATABASE_ID / CF_API_TOKEN.');
        process.exit(1);
    }

    const tables: Record<string, TableSnapshot> = {};
    for (const table of TABLES) {
        process.stderr.write(`  reading ${table}...\n`);
        tables[table] = await snapshotTable(table, cfg);
    }

    const snapshot = {
        capturedAt: new Date().toISOString(),
        // Last 4 chars only — enough to confirm the "after" run hit the same
        // database, without putting the id into a stored artifact.
        databaseIdTail: cfg.databaseId.slice(-4),
        dateLimit: DATE_LIMIT,
        // Which tables did NOT use dateLimit, so a consumer comparing two
        // snapshots can tell "fewer dates" from "fewer rows on those dates".
        dateLimitByTable: DATE_LIMIT_BY_TABLE,
        hashExcludes: [...HASH_EXCLUDED],
        // Consumers (and d1-restore.ts) must be able to tell a restorable
        // backup from a hash-only fingerprint without inspecting every entry.
        restorable: WITH_ROWS,
        tables,
    };

    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));

    console.log(`\nD1 snapshot -> ${OUT_PATH}\n`);
    for (const table of TABLES) {
        const t = tables[table]!;
        if (!t.present) {
            console.log(`  ${table.padEnd(16)} ABSENT (${t.reason})`);
            continue;
        }
        console.log(
            `  ${table.padEnd(16)} ${String(t.totalRows).padStart(7)} rows  ${t.dateRange.min} -> ${t.dateRange.max}`
        );
        for (const d of t.perDate.slice(0, 3)) {
            console.log(`      ${d.scanDate}  ${String(d.rows).padStart(5)} rows  ${d.hash}`);
        }
    }
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
