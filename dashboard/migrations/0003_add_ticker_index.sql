-- Index for the cross-day ticker lookup (/api/ticker).
-- Without it, every ticker search full-scans lean_signals; the existing indexes
-- are on scan_date and score, which a `WHERE ticker = ?` query cannot use.
-- Apply to prod D1 (radar-dashboard) once, before deploying /api/ticker:
--   npx wrangler d1 execute <db-name> --remote --file=migrations/0003_add_ticker_index.sql
CREATE INDEX IF NOT EXISTS idx_lean_ticker ON lean_signals(ticker);
