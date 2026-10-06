-- Price vs the AVWAP anchored at the 52w-high bar, in percent, per signal row. Display only:
-- a 2026-10-06 study (583 tickers x 4y) found no edge for the level, so nothing scores or gates
-- on it. Self-applied by ensureSchema() in dashboard/src/ingestD1.ts — the D1 lives on a
-- Cloudflare account only CI holds credentials for, so a migration file alone would never run.
-- Kept here as the record of intent.
ALTER TABLE lean_signals ADD COLUMN avwap_ath_pct REAL;
