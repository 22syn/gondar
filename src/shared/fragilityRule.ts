/**
 * Purple Fragility — the Alert/Watch rule, single source of truth.
 *
 * This file exists to close the "rule written twice" debt (explainer tab,
 * open-items panel): until 2026-08-25 the same thresholds and boolean
 * conditions lived independently in the engine (purpleFragility.ts) and in
 * the dashboard (app.js), matched by hand. Now every consumer — the engine
 * on BOTH branches, the Pages Function that serves the dashboard, and
 * through it the chart — evaluates the rule from here.
 *
 * Listed in config/shared-files.txt: the branch-drift guard fails CI if the
 * `main` and `stable` copies ever differ, so the two branches behave as one
 * source. Keep this module dependency-free and side-effect-free (no imports,
 * no import.meta, no IO) — it must compile under the repo tsconfig, the
 * dashboard's Bundler resolution, and Jest's CJS transform alike.
 *
 * The rule (calibrated 2026-07-27, docs/research/fragility-calibration on main):
 *   🔴 Alert:  score >= FRAGILITY_THRESHOLD  AND nearHigh
 *   🟡 Watch:  core3 >= CORE3_THRESHOLD  OR  (climax >= CLIMAX_THRESHOLD AND nearHigh)
 *   Only the core3 arm is message-worthy (81% precision vs 31% base rate);
 *   the climax-only arm is chart-only (33% precision, below base rate).
 */

export const FRAGILITY_THRESHOLD = 1.0;
/** Watch-tier threshold on core3 (wick10+dist20+disp10 z-mean). Calibrated
 *  2026-07-20 on the fixed basket, 2y window, 3y fetch: core3>=1.0 preceded
 *  54% of >7% tops at 56% precision (vs 23% catch for mean6>=1.0). */
export const CORE3_THRESHOLD = 1.0;
/** Watch-tier threshold on climax (contextual volume-z). Calibrated 2026-07-22
 *  via split-half stability testing: climax>=1.5 (AND nearHigh) contributed
 *  the majority of the OR-rule's recall lift over core3 alone, stable across
 *  both the 2023-24 and 2025-26 halves. */
export const CLIMAX_THRESHOLD = 1.5;

/** The minimal shape the rule needs. The engine adapts FragilityDay to this
 *  (nearHigh = indexNearHigh); D1 consumers adapt a fragility_daily row via
 *  nearHighFromCanaryCount. */
export interface FragilityRuleInput {
    score: number | null;
    core3: number | null;
    climax: number | null;
    nearHigh: boolean;
}

/** D1 rows carry canary_count instead of a nearHigh boolean. canary_count is
 *  populated ONLY within 2% of the trailing-250d index high, so non-null is an
 *  exact proxy for the engine's indexNearHigh (verified against the source +
 *  D1, 2026-07-27). */
export function nearHighFromCanaryCount(canaryCount: number | null | undefined): boolean {
    return canaryCount != null;
}

/** 🔴 Alert condition: mean6 >= FRAGILITY_THRESHOLD AND the basket is near its high. */
export function alertHolds(d: FragilityRuleInput): boolean {
    return d.nearHigh && d.score != null && d.score >= FRAGILITY_THRESHOLD;
}

export type WatchTrigger = 'core3' | 'climax' | 'both' | null;

/** Which leg(s) of the 🟡 Watch OR-condition are active on a given day, if any. */
export function watchTrigger(d: FragilityRuleInput): WatchTrigger {
    const core3On = d.core3 != null && d.core3 >= CORE3_THRESHOLD;
    const climaxOn = d.nearHigh && d.climax != null && d.climax >= CLIMAX_THRESHOLD;
    if (core3On && climaxOn) return 'both';
    if (core3On) return 'core3';
    if (climaxOn) return 'climax';
    return null;
}

/** Message-worthy only via the core3 arm — the climax-only arm stays computed,
 *  persisted and charted, but must NOT raise a Telegram message (33% precision,
 *  below the 31% base rate; core3 runs 81%. Study 2026-07-27). */
export function watchAlertable(trigger: WatchTrigger): boolean {
    return trigger === 'core3' || trigger === 'both';
}

/** Held state of a single day, for display. 'climax-only' means the Watch tier
 *  holds via the descriptive arm alone — charted, never messaged. */
export type FragilityTier = 'alert' | 'watch-core3' | 'climax-only' | null;

export function tier(d: FragilityRuleInput): FragilityTier {
    if (alertHolds(d)) return 'alert';
    const t = watchTrigger(d);
    if (t == null) return null;
    return watchAlertable(t) ? 'watch-core3' : 'climax-only';
}

/** Chart marker for the day a tier NEWLY fires (matches the one-per-crossing
 *  Telegram alert), not every day it holds — held-days would flood the recent
 *  window. 'watch' = core3 arm (messaged); 'soft' = climax-only (chart-only).
 *  A Watch marker is suppressed while Alert is active — Alert outranks it. */
export type FragilityCross = 'alert' | 'watch' | 'soft' | null;

export function cross(d: FragilityRuleInput, prev: FragilityRuleInput | null): FragilityCross {
    if (alertHolds(d) && !(prev != null && alertHolds(prev))) return 'alert';
    const t = watchTrigger(d);
    if (t != null && !alertHolds(d) && !(prev != null && watchTrigger(prev) != null)) {
        return watchAlertable(t) ? 'watch' : 'soft';
    }
    return null;
}
