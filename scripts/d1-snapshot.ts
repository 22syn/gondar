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
        `SELECT scan_date, COUNT(*) AS n FROM ${table} GROUP BY scan_date ORDER BY scan_date DESC LIMIT ${DATE_LIMIT}`,
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
        perDate.push({ scanDate, rows: Number(d.n), hash: contentHash(rows) });
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
        hashExcludes: [...HASH_EXCLUDED],
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
