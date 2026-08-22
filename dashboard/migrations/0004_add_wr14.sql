-- Williams %R(14), daily, per signal row. Added 2026-08-22 with the Market
-- Context panel. Self-applied by ensureSchema() in dashboard/src/ingestD1.ts —
-- the D1 lives on a Cloudflare account only CI holds credentials for, so a
-- migration file alone would never run. Kept here as the record of intent.
ALTER TABLE lean_signals ADD COLUMN wr14 REAL;
