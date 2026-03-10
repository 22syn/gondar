/**
 * Technical Analysis utility tests
 */
import {
    calculateSMA,
    calculateRSI,
    calculate52wHighAndConsolidation,
    isNearSMA,
} from '../src/utils/technicalAnalysis.js';

describe('calculateSMA', () => {
    it('returns undefined when not enough data', () => {
        expect(calculateSMA([1, 2, 3], 5)).toBeUndefined();
    });

    it('returns average of last N values', () => {
        const prices = [10, 20, 30, 40, 50];
        expect(calculateSMA(prices, 3)).toBe(40); // (30+40+50)/3
    });

    it('handles exactly N values', () => {
        const prices = [1, 2, 3];
        expect(calculateSMA(prices, 3)).toBe(2); // (1+2+3)/3
    });

    it('handles single period', () => {
        const prices = [100];
        expect(calculateSMA(prices, 1)).toBe(100);
    });
});

describe('calculateRSI', () => {
    it('returns undefined when not enough data', () => {
        expect(calculateRSI([1, 2, 3], 14)).toBeUndefined();
    });

    it('returns 100 when all gains (no losses)', () => {
        const prices = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114];
        expect(calculateRSI(prices, 14)).toBe(100);
    });

    it('returns low value when all losses', () => {
        const prices = [100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86];
        const rsi = calculateRSI(prices, 14);
        expect(rsi).toBeDefined();
        expect(rsi!).toBeLessThan(10);
    });

    it('returns ~50 for alternating gains/losses', () => {
        const prices: number[] = [];
        for (let i = 0; i < 20; i++) {
            prices.push(100 + (i % 2 === 0 ? 1 : -1));
        }
        const rsi = calculateRSI(prices, 14);
        expect(rsi).toBeDefined();
        expect(rsi!).toBeGreaterThan(40);
        expect(rsi!).toBeLessThan(60);
    });
});

describe('calculate52wHighAndConsolidation', () => {
    it('returns null when less than 22 closes', () => {
        const closes = Array(21).fill(100);
        expect(calculate52wHighAndConsolidation(closes)).toBeNull();
    });

    it('returns ath and pctFromAth', () => {
        const closes = Array(100).fill(100);
        closes[99] = 90; // last close 10% below high
        const result = calculate52wHighAndConsolidation(closes);
        expect(result).not.toBeNull();
        expect(result!.ath).toBe(100);
        expect(result!.pctFromAth).toBe(-10);
    });

    it('returns monthsInConsolidation', () => {
        const closes = Array(252).fill(100);
        closes[251] = 95;
        const result = calculate52wHighAndConsolidation(closes);
        expect(result).not.toBeNull();
        expect(result!.monthsInConsolidation).toBeGreaterThanOrEqual(0);
    });
});

describe('isNearSMA', () => {
    it('returns true when within threshold', () => {
        expect(isNearSMA(100, 99, 2)).toBe(true); // 1% diff
        expect(isNearSMA(100, 98, 3)).toBe(true); // 2% diff
    });

    it('returns false when outside threshold', () => {
        expect(isNearSMA(100, 95, 3)).toBe(false); // 5% diff
    });

    it('returns false when sma is 0', () => {
        expect(isNearSMA(100, 0, 10)).toBe(false);
    });

    it('returns true when within threshold', () => {
        expect(isNearSMA(100, 98, 3)).toBe(true); // 2% diff
    });
});
