/**
 * Minimal Cloudflare D1 HTTP client, shared by the dashboard ingest paths.
 *
 * Extracted so the RS / setup / fragility ingests can share one transport
 * instead of each carrying its own copy of the fetch + error handling. On
 * `main` this helper lives inside setupD1Ingest.ts; here it stands alone
 * because the three ingests are being migrated in separate slices and would
 * otherwise duplicate it three times.
 *
 * Note the deliberate asymmetry with the dashboard's own `dashboard/src/ingestD1.ts`:
 * that module is part of the Pages package and ingests `lean_signals`. This one
 * lives in the scan's own `src/` so the Lean pipeline can write its D1 tables
 * without the scan depending on the dashboard package.
 */

export interface D1Config {
    accountId: string;
    databaseId: string;
    apiToken: string;
}

export interface Batch {
    sql: string;
    params: unknown[];
}

/** Read D1 credentials from the environment. Returns null when unconfigured. */
export function d1ConfigFromEnv(): D1Config | null {
    const accountId = process.env.CF_ACCOUNT_ID ?? '';
    const databaseId = process.env.D1_DATABASE_ID ?? '';
    const apiToken = process.env.CF_API_TOKEN ?? '';
    if (!accountId || !databaseId || !apiToken) return null;
    return { accountId, databaseId, apiToken };
}

/**
 * Execute one SQL batch against D1.
 *
 * Throws on failure — callers decide whether that is fatal. For scan ingests it
 * is NOT: the Telegram report has already gone out by then, so a D1 outage must
 * never fail the scan.
 */
export async function runBatch(batch: Batch, cfg: D1Config): Promise<void> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}/query`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: batch.sql, params: batch.params }),
    });
    if (!res.ok) throw new Error(`D1 request failed ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { success: boolean; errors?: unknown };
    if (!body.success) throw new Error(`D1 error: ${JSON.stringify(body.errors)}`);
}

/**
 * Execute one read query and return its rows.
 *
 * `runBatch` above discards results — every ingest path only needs to know the
 * statement succeeded. Verification needs the values back (row counts, the
 * latest row's fields), so this is the read-side counterpart. Throws on
 * failure, same contract as runBatch.
 */
export async function queryRows<T = Record<string, unknown>>(
    batch: Batch,
    cfg: D1Config
): Promise<T[]> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}/query`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: batch.sql, params: batch.params }),
    });
    if (!res.ok) throw new Error(`D1 request failed ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
        success: boolean;
        errors?: unknown;
        result?: Array<{ results?: T[] }>;
    };
    if (!body.success) throw new Error(`D1 error: ${JSON.stringify(body.errors)}`);
    return body.result?.[0]?.results ?? [];
}
