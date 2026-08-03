# GONDAR Dashboard

Cloudflare Pages app over D1 (`lean-radar`). Data from the daily scan.

Styled with the **XSHEVA design system** (`colors_and_type.css` in the Xsheva
Design System project): single accent `#FF6B35` on `#101622`, Space Grotesk,
Material Symbols Outlined for every icon, no emoji.

## Names that are deliberately still "Lean"

These are external identifiers, not display copy — renaming them breaks a live
integration, so they were left alone in the 2026-08-03 rename:

| Identifier | Where | Why it is pinned |
|---|---|---|
| `Lean Radar - Daily Scan` | workflow `name:` in `daily-scan-lean.yml` | `scripts/sync-tv-watchlist.ts` finds the run with `gh run list --workflow="Lean Radar - Daily Scan"` |
| `Lean Radar - Breakouts` / `Lean Radar - Near` | `sync-tv-watchlist.ts` | actual watchlist names inside the TradingView account; the sync matches on the exact string |
| `lean-radar` (D1), `src/lean/`, `lean-*.json` | engine + storage | internal names with no user-visible surface |

To finish the rename, the TradingView lists must be renamed in TradingView
**and** in `sync-tv-watchlist.ts` in the same change.

## Secrets (GitHub Actions)
- `CF_API_TOKEN` — Cloudflare token, permission: Account › D1 › Edit
- `CF_ACCOUNT_ID` — Cloudflare account id
- `D1_DATABASE_ID` — `lean-radar` database id (from `wrangler d1 create`)

## Schema:  `wrangler d1 execute lean-radar --remote --file schema.sql`
## Seed:    `npx tsx scripts/seed.ts ../results`
## Deploy:  `wrangler pages deploy public --project-name radar-dashboard`  (live: https://radar-dashboard-c9o.pages.dev)
## Access:  Cloudflare Zero Trust → Access → email allowlist (Kobi + friend).

## Local dev (no login, no Cloudflare account needed)

The production site sits behind Cloudflare Access — `wrangler pages dev` runs
entirely on localhost and never touches Access, so this is the way to test
changes or let an agent inspect the dashboard without credentials.

```sh
cd dashboard
npm install

# One-time (or whenever you want fresh data): build a local D1 from real
# dashboard-{date}.json files — e.g. pulled from a Lean Radar Daily Scan
# artifact, or from ../results if you've run the scan locally.
npm run db:local:schema
npm run seed:local:sql -- /path/to/dir/with/dashboard-*.json
npm run db:local:seed

npm run dev   # → http://localhost:8788, no login
```

`npm run dev` reads the D1 binding straight from `wrangler.toml` (don't add
`--d1 DB` back — it makes Miniflare create a second, disconnected local
database keyed by binding name instead of `database_id`, so the app ends up
querying an empty one: "no such table: lean_signals"). `--persist-to` and
`--compatibility-date` are baked into the `dev` script so `db:local:*` and
`dev` always agree on where local D1 state lives.
