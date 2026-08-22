// dashboard/src/ingestD1.ts
export interface Row {
  scanDate: string; ticker: string; region: string; sector: string; signal: string;
  signals: string[]; signalCount: number;
  rvol: number; athPct: number | null; dayPct: number; stage2: number;
  distPivot: number | null; score: number; price: number;
  /** Williams %R(14), daily. Null for reconstructed/back-seeded rows. */
  wr14?: number | null;
}
export interface Batch { sql: string; params: unknown[]; }

const COLS = '(scan_date,ticker,region,sector,signal,signals,signal_count,rvol,ath_pct,day_pct,stage2,dist_pivot,score,price,wr14,ingested_at)';

/**
 * Delete-first batches: one DELETE per distinct scan_date in `rows`, so a
 * re-run of the same trading day fully replaces the earlier run — including
 * tickers that fired earlier but no longer fire (stale closes, late Yahoo
 * data). The DB keeps exactly one run per trading day: the most recent.
 */
export function buildDeleteBatches(rows: Row[]): Batch[] {
  const dates = [...new Set(rows.map((r) => r.scanDate))].sort();
  return dates.map((d) => ({ sql: 'DELETE FROM lean_signals WHERE scan_date = ?', params: [d] }));
}

// batchSize 6: D1 caps at 100 bound params/query; 16 cols × 6 = 96.
export function buildUpsertBatches(rows: Row[], ingestedAt: string, batchSize = 6): Batch[] {
  const batches: Batch[] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const placeholders = slice.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
    const params: unknown[] = [];
    for (const r of slice) {
      params.push(r.scanDate, r.ticker, r.region, r.sector, r.signal,
        r.signals.join(','), r.signalCount, r.rvol,
        r.athPct, r.dayPct, r.stage2, r.distPivot, r.score, r.price, r.wr14 ?? null, ingestedAt);
    }
    batches.push({ sql: `INSERT OR REPLACE INTO lean_signals ${COLS} VALUES ${placeholders}`, params });
  }
  return batches;
}

export interface D1Config { accountId: string; databaseId: string; apiToken: string; }

async function runBatch(batch: Batch, cfg: D1Config): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: batch.sql, params: batch.params }),
  });
  if (!res.ok) throw new Error(`D1 ingest failed ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { success: boolean; errors?: unknown };
  if (!body.success) throw new Error(`D1 error: ${JSON.stringify(body.errors)}`);
}

/**
 * Idempotent schema guard: adds ingested_at if missing (migration
 * 0002_add_ingested_at.sql, self-applied because the D1 lives on a CF account
 * only CI holds credentials for). "duplicate column" errors are expected
 * no-ops on every run after the first.
 */
export async function ensureSchema(cfg: D1Config): Promise<void> {
  try {
    await runBatch({ sql: 'ALTER TABLE lean_signals ADD COLUMN ingested_at TEXT', params: [] }, cfg);
  } catch (e) {
    if (!/duplicate column/i.test((e as Error).message)) throw e;
  }
  // migration 0004_add_wr14.sql, same self-applying pattern.
  try {
    await runBatch({ sql: 'ALTER TABLE lean_signals ADD COLUMN wr14 REAL', params: [] }, cfg);
  } catch (e) {
    if (!/duplicate column/i.test((e as Error).message)) throw e;
  }
}

export async function ingestRows(rows: Row[], cfg: D1Config, ingestedAt?: string): Promise<void> {
  const stamp = ingestedAt ?? new Date().toISOString();
  for (const batch of buildDeleteBatches(rows)) await runBatch(batch, cfg);
  for (const batch of buildUpsertBatches(rows, stamp)) await runBatch(batch, cfg);
}
