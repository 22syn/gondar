/**
 * AVWAP-from-ATH anchor tests (Lean Radar only — see src/utils/avwapAnchor.ts)
 */
import { calculateAVWAP } from '../src/utils/technicalAnalysis.js';
import { findAthAnchorIndex, calculateAvwapFromAth } from '../src/utils/avwapAnchor.js';

describe('findAthAnchorIndex', () => {
    it('returns undefined for an empty series', () => {
        expect(findAthAnchorIndex([])).toBeUndefined();
    });

    it('returns the index of the highest high', () => {
        expect(findAthAnchorIndex([5, 30, 20, 10])).toBe(1);
    });

    it('takes the FIRST occurrence on ties (matches the research anchor)', () => {
        expect(findAthAnchorIndex([5, 30, 20, 30])).toBe(1);
    });

    it('ignores a higher peak that fell outside the window', () => {
        // the 100 at index 0 is older than the last 3 bars
        expect(findAthAnchorIndex([100, 10, 12, 11], 3)).toBe(2);
    });

    it('uses every bar of a series shorter than the window (a fresh IPO)', () => {
        expect(findAthAnchorIndex([150, 225, 190, 170], 252)).toBe(1);
    });
});

describe('calculateAvwapFromAth', () => {
    it('anchors at the peak bar: typical price weighted by volume from there on', () => {
        // peak at index 1 (high 40); bars from there: typical 40, 20, 30 with equal volume
        const closes = [10, 40, 20, 30];
        const v = calculateAvwapFromAth(closes, closes, closes, [100, 100, 100, 100]);
        expect(v).toBeCloseTo(30, 6);
    });

    it('equals calculateAVWAP at the anchor found by findAthAnchorIndex', () => {
        const highs = [11, 12, 50, 40, 35, 38];
        const lows = [9, 10, 44, 33, 30, 34];
        const closes = [10, 11, 46, 36, 32, 37];
        const vols = [50, 60, 500, 200, 150, 120];
        const anchor = findAthAnchorIndex(highs)!;
        expect(calculateAvwapFromAth(highs, lows, closes, vols)).toBe(calculateAVWAP(highs, lows, closes, vols, anchor));
    });

    it('honours the window: an older, higher peak does not become the anchor', () => {
        const highs = [100, 10, 12, 11];
        const flat = [100, 10, 12, 11];
        const vols = [1000, 10, 10, 10];
        // window 3 -> anchor index 2 -> (12 + 11) / 2 = 11.5, untouched by the huge-volume 100 bar
        expect(calculateAvwapFromAth(highs, flat, flat, vols, 3)).toBeCloseTo(11.5, 6);
    });

    it('returns undefined for an empty series or when no volume trades from the anchor', () => {
        expect(calculateAvwapFromAth([], [], [], [])).toBeUndefined();
        expect(calculateAvwapFromAth([10, 20], [10, 20], [10, 20], [0, 0])).toBeUndefined();
    });
});
