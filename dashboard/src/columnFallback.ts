// dashboard/src/columnFallback.ts
import { COLUMN_TIERS, type ColumnTier } from './query.js';

/**
 * Optional lean_signals columns (wr14, avwap_ath_pct) are added by ensureSchema() during ingest,
 * so a dashboard deploy can land before them and SQLite fails the whole SELECT on an unknown
 * column. Run `attempt` against each column tier, richest first, and return the first one D1
 * accepts. When even the legacy tier fails the LAST error is rethrown (a real D1 outage, not a
 * missing column).
 */
export async function withColumnFallback<T>(attempt: (tier: ColumnTier) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (const tier of COLUMN_TIERS) {
    try {
      return await attempt(tier);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}
