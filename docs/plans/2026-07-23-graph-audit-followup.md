> NEXT SESSION: review this plan before making structural changes to this repo, and report status to Kobi.

# Graph-Audit Follow-up — smart-volume-radar-engine (2026-07-23)

## Graph snapshot

- **Code symbols:** 811 (1477 total nodes).
- **Top hubs (god nodes):**
  - `scripts/sync-tv-watchlist.ts` — degree 67
  - `src/services/marketData.ts` — degree 67
  - `src/types/index.ts` — degree 65
  - `src/index.ts` — degree 64
  - `src/config/index.ts` — degree 53
- **Import cycles:** none.
- **Age:** ~17 days since last commit.
- **Zero-edge nodes:** 3 (`eslint.config.js`, `jest.config.cjs`, `jest.setup.cjs`) — config/entry files, not dead code; do not remove.

## Change-risk hotspots

These files have the largest blast radius in the graph — a change here ripples widely. Add/extend tests and review carefully before touching:

- `src/services/marketData.ts` — Yahoo/Twelve Data fetch layer feeding the whole scan.
- `src/types/index.ts` — shared interfaces; a type change touches nearly every module.
- `src/index.ts` — main orchestration/entry point.
- `src/config/index.ts` — env + watchlist loading; misconfig breaks every run.
- `scripts/sync-tv-watchlist.ts` — TradingView sync script (large, standalone).

## Context — this repo is being retired into `smart-volume-radar-sync`

Graph + file-level audit confirms `engine` and `sync` are **duplicates**. 26 of 28 shared `.ts` files are byte-identical. **`engine` has zero unique files**; `sync` is a strict superset = engine plus a Google-Sheets watchlist feature (`sharedWatchlist.ts`, `symbolMap.ts`, `universeSheetWriter.ts`, dep `googleapis`, script `sync-friend-watchlists`). Two files have drifted (split-brain):

- `src/utils/championScore.ts` — **newer in engine** (Jul 4 vs Jun 3 in sync).
- `src/services/marketData.ts` — **newer in sync** (Jul 5 vs Jul 1 in engine).

**Decision: `sync` becomes canonical; this repo (`engine`) is archived** (tag + README redirect, not deleted).

## Action items — consolidation (engine side)

1. **Safety tag.** Tag this repo at current HEAD (e.g. `pre-consolidation-2026-07-23`) and push the tag before any change.
2. **Reconcile the 2 drifted files.**
   - Port engine's newer `src/utils/championScore.ts` (Jul 4) into `sync`.
   - Confirm `sync`'s `src/services/marketData.ts` (Jul 5) already contains engine's Jul-1 fixes; if not, merge them forward into `sync`.
3. **Archive this repo.** After parity is verified in `sync`: keep the safety tag, replace this repo's README with a redirect pointing to `smart-volume-radar-sync` as canonical. **Do not delete** the repo or history.
4. **Cutover.** Move any cron/launchd/GitHub-Actions schedule that runs the daily scan from this repo to `sync`.
5. **Parity check.** Before decommissioning, verify `sync`'s `scan-now` output matches this repo's for the same watchlist/day.
6. **Do NOT** build a monorepo or shared package — over-engineering for a single-owner two-repo case. The Sheets services in `sync` are feature-gated behind `RADAR_SHEETS_SYNC=on|off` (default `off` = current engine behavior), so `sync` can stand in for engine without behavior change.

_No structural refactor of engine's own code is warranted — the repo is being retired, not evolved._
