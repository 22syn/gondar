// p-limit is ESM-only; mock it the same way marketData.test.ts does so the
// module under test imports cleanly under ts-jest.
jest.mock('p-limit', () => () => (fn: () => Promise<unknown>) => fn());

import { nearestSupport } from '../src/services/marketContext.js';

describe('nearestSupport', () => {
    // Two pivot lows (45 at idx 2, 44 at idx 7) with window=2.
    const lows = [50, 48, 45, 47, 49, 52, 46, 44, 46, 48, 50];

    it('returns the nearest pivot low below the current close', () => {
        // Both 45 and 44 sit below 55 → the higher (nearer) shelf wins.
        expect(nearestSupport(lows, 55, 126, 2)).toBe(45);
    });

    it('skips a pivot the price has already fallen through', () => {
        // 45 is not below 44.5, so the next shelf down (44) is the support.
        expect(nearestSupport(lows, 44.5, 126, 2)).toBe(44);
    });

    it('returns null when price is at or below every low', () => {
        expect(nearestSupport(lows, 40, 126, 2)).toBeNull();
    });

    it('falls back to the lowest low below price when no clean pivot qualifies', () => {
        // Monotonic decline has no interior pivot; the lowest low under price is 41.
        const declining = [60, 55, 50, 45, 41];
        expect(nearestSupport(declining, 44, 126, 2)).toBe(41);
    });

    it('returns null for a series too short to hold a pivot', () => {
        expect(nearestSupport([50, 48, 46, 45], 55, 126, 2)).toBeNull();
    });

    it('returns null when the last close is unknown', () => {
        expect(nearestSupport(lows, null, 126, 2)).toBeNull();
    });
});
