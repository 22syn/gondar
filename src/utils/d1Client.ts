/**
 * Minimal Cloudflare D1 HTTP client.
 *
 * Extracted out of setupD1Ingest.ts, which used to carry this transport plus
 * fragilityD1Ingest.ts importing it from there — a dependency that survived
 * only because setup_signals/rs_daily ingest lived in the same file. Now that
 * Smart's automatic setup/RS ingest is retired (Lean/stable owns those tables),
 * setupD1Ingest.ts is gone; this is what fragilityD1Ingest.ts's manual backfill
 * path (scripts/ingest-fragility.ts) still needs.
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
