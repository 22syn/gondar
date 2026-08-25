// dashboard/functions/api/fragility.ts
//
// Purple List fragility series (fragility_daily) — written daily by the
// Smart pipeline (main branch, fragilityD1Ingest.ts). Standalone per-day
// scalar series: no mergeSetup/enrich involvement. The table may not exist
// until the first Smart ingest — treat errors as an empty series.
import { buildFragilityQuery } from '../../src/query.js';
import { fetchQqqIndex, applyQqqOverlay } from '../../src/qqqOverlay.js';
// The Alert/Watch rule itself lives at the repo root, OUTSIDE dashboard/ — it is
// the single source shared with the engine on both branches (drift-guarded via
// config/shared-files.txt). Wrangler's esbuild bundles it into the Function at
// deploy time. app.js no longer evaluates the rule; it renders the `tier` and
// `cross` fields computed here.
import {
    nearHighFromCanaryCount,
    tier,
    cross,
    type FragilityTier,
    type FragilityCross,
} from '../../../src/shared/fragilityRule.js';

interface Env { DB: D1Database; }

interface FragilityRow {
  scan_date: string;
  score: number;
  /** Watch-tier score (wick10+dist20+disp10 z-mean) — model v2, PR #82. Part of the
   *  real 🟡 alert rule (core3>=1.0 OR climax>=1.5+nearHigh); not drawn as its own
   *  line (would clutter the chart) — surfaced in the tooltip instead. */
  core3: number | null;
  /** Contextual volume climax (euphoria-context, near a high) — model v2, PR #82.
   *  Same tooltip-only treatment as core3. */
  climax: number | null;
  /** Capitulation Score (מד המיצוי) — bottom-detection companion gauge, descriptive
   *  only (no threshold/alert tied to it). See explainer tab for our own validation. */
  capitulation: number | null;
  wick10_z: number | null;
  pct_above50_z: number | null;
  dist20_z: number | null;
  ext50_z: number | null;
  corr20_z: number | null;
  disp10_z: number | null;
  index_value: number | null;
  drawdown_pct: number | null;
  canary_count: number | null;
  /** QQQ close rebased to 100 at this series' first trading day — lets the
   *  dashboard overlay "did the fragility peak lead the market pullback"
   *  without a raw-price/score scale clash. Null when the Yahoo fetch fails
   *  or a given scan_date has no matching QQQ bar (holiday mismatch etc). */
  qqq_index?: number | null;
  /** Held state of the Alert/Watch rule on this day — computed server-side from
   *  the shared rule module so the client never re-implements the rule. */
  tier?: FragilityTier;
  /** Set on the day a tier NEWLY fires (chart marker / one-per-crossing alert). */
  cross?: FragilityCross;
}

// fetchQqqIndex / applyQqqOverlay used to live here. They moved to
// ../../src/qqqOverlay.ts (2026-08-16) so alpha-engine's offline copy of this
// dashboard can RUN them instead of reimplementing them — qqq_index is computed
// at read time and is not a D1 column, so a snapshot-driven copy had no
// benchmark line at all. Behaviour here is unchanged.

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  try {
    const q = buildFragilityQuery({});
    const { results } = await env.DB.prepare(q.sql).bind(...q.params).all<FragilityRow>();
    const rows = results ?? [];
    if (rows.length === 0) return Response.json(rows);

    try {
      applyQqqOverlay(rows, await fetchQqqIndex(rows[0]!.scan_date));
    } catch {
      // Benchmark overlay is best-effort — leave qqq_index unset on failure.
    }

    // Evaluate the Alert/Watch rule once, here, from the shared module. The
    // canary_count → nearHigh proxy is exact (populated only within 2% of the
    // trailing-250d index high).
    const asRuleInput = (r: FragilityRow) => ({
      score: r.score ?? null,
      core3: r.core3,
      climax: r.climax,
      nearHigh: nearHighFromCanaryCount(r.canary_count),
    });
    rows.forEach((r, i) => {
      r.tier = tier(asRuleInput(r));
      r.cross = cross(asRuleInput(r), i > 0 ? asRuleInput(rows[i - 1]!) : null);
    });

    return Response.json(rows);
  } catch {
    // fragility_daily not created yet — the panel simply stays hidden.
    return Response.json([]);
  }
};
