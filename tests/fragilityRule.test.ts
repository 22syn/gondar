import {
    FRAGILITY_THRESHOLD,
    CORE3_THRESHOLD,
    CLIMAX_THRESHOLD,
    nearHighFromCanaryCount,
    alertHolds,
    watchTrigger,
    watchAlertable,
    tier,
    cross,
    type FragilityRuleInput,
} from '../src/shared/fragilityRule.js';

const day = (over: Partial<FragilityRuleInput> = {}): FragilityRuleInput => ({
    score: null,
    core3: null,
    climax: null,
    nearHigh: false,
    ...over,
});

describe('fragilityRule — thresholds', () => {
    // The calibrated values are load-bearing (study 2026-07-27). A change here
    // must be a deliberate recalibration, never a refactor side effect.
    it('locks the calibrated thresholds', () => {
        expect(FRAGILITY_THRESHOLD).toBe(1.0);
        expect(CORE3_THRESHOLD).toBe(1.0);
        expect(CLIMAX_THRESHOLD).toBe(1.5);
    });
});

describe('nearHighFromCanaryCount', () => {
    it('treats any non-null count (including 0) as near-high', () => {
        expect(nearHighFromCanaryCount(0)).toBe(true);
        expect(nearHighFromCanaryCount(3)).toBe(true);
        expect(nearHighFromCanaryCount(null)).toBe(false);
        expect(nearHighFromCanaryCount(undefined)).toBe(false);
    });
});

describe('alertHolds', () => {
    it('requires BOTH score >= threshold AND nearHigh', () => {
        expect(alertHolds(day({ score: 1.2, nearHigh: true }))).toBe(true);
        expect(alertHolds(day({ score: 1.2, nearHigh: false }))).toBe(false);
        expect(alertHolds(day({ score: 0.9, nearHigh: true }))).toBe(false);
        expect(alertHolds(day({ score: null, nearHigh: true }))).toBe(false);
    });

    it('fires exactly at the threshold', () => {
        expect(alertHolds(day({ score: 1.0, nearHigh: true }))).toBe(true);
    });
});

describe('watchTrigger', () => {
    it('core3 arm fires regardless of nearHigh', () => {
        expect(watchTrigger(day({ core3: 1.0 }))).toBe('core3');
        expect(watchTrigger(day({ core3: 0.99 }))).toBeNull();
    });

    it('climax arm requires nearHigh', () => {
        expect(watchTrigger(day({ climax: 1.5, nearHigh: true }))).toBe('climax');
        expect(watchTrigger(day({ climax: 1.5, nearHigh: false }))).toBeNull();
        expect(watchTrigger(day({ climax: 1.49, nearHigh: true }))).toBeNull();
    });

    it('reports both arms when both fire', () => {
        expect(watchTrigger(day({ core3: 1.1, climax: 2.0, nearHigh: true }))).toBe('both');
    });
});

describe('watchAlertable', () => {
    it('messages only through the core3 arm', () => {
        expect(watchAlertable('core3')).toBe(true);
        expect(watchAlertable('both')).toBe(true);
        expect(watchAlertable('climax')).toBe(false);
        expect(watchAlertable(null)).toBe(false);
    });
});

describe('tier', () => {
    it('alert outranks watch', () => {
        expect(tier(day({ score: 1.2, core3: 1.2, nearHigh: true }))).toBe('alert');
    });

    it('splits the watch arms by alertability', () => {
        expect(tier(day({ core3: 1.1 }))).toBe('watch-core3');
        expect(tier(day({ climax: 2.0, nearHigh: true }))).toBe('climax-only');
        expect(tier(day())).toBeNull();
    });
});

describe('cross — one marker per crossing', () => {
    const quiet = day();
    const watchDay = day({ core3: 1.1 });
    const softDay = day({ climax: 2.0, nearHigh: true });
    const alertDay = day({ score: 1.2, nearHigh: true });

    it('marks only the first day a tier holds', () => {
        expect(cross(watchDay, quiet)).toBe('watch');
        expect(cross(watchDay, watchDay)).toBeNull();
        expect(cross(alertDay, quiet)).toBe('alert');
        expect(cross(alertDay, alertDay)).toBeNull();
        expect(cross(softDay, null)).toBe('soft');
    });

    it('suppresses the watch marker while alert is active', () => {
        const alertAndWatch = day({ score: 1.2, core3: 1.1, nearHigh: true });
        expect(cross(alertAndWatch, quiet)).toBe('alert');
    });

    it('does not re-mark a watch that morphs between arms', () => {
        // soft → watch on consecutive days is one held Watch tier, not two crossings
        expect(cross(watchDay, softDay)).toBeNull();
    });

    it('reproduces the live 2026-08-13 core3 crossing', () => {
        // oos_log.csv: 08-12 core3 0.79 (quiet) → 08-13 core3 1.11, nearHigh=0
        const d12 = day({ score: 0.3854, core3: 0.7858, climax: -0.6867 });
        const d13 = day({ score: 0.5368, core3: 1.1072, climax: -0.6872 });
        expect(cross(d13, d12)).toBe('watch');
        expect(tier(d13)).toBe('watch-core3');
        expect(watchAlertable(watchTrigger(d13))).toBe(true);
    });
});
