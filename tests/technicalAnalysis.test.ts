/**
 * Technical Analysis utility tests
 */
import {
    calculateSMA,
    calculateRSI,
    calculate52wHighAndConsolidation,
    isNearSMA,
    computeNewlogicTags,
    calculateSMA200Slope,
    countConsecutiveGreenDays,
    detectEarningsGap,
    calculateAVWAP,
    calculateDaysSinceLastHigh,
    calculateBollingerBands,
    calculateEMA,
    countAccumulationDistributionDays,
    calculateWilliamsR,
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

describe('computeNewlogicTags', () => {
    it('SMA21 Touch = true when lastClose within thresholdPct of sma21', () => {
        const tags = computeNewlogicTags({
            sma21: 100,
            lastClose: 101,
            sma21TouchThresholdPct: 3,
            closes: [100, 100, 100],
        });
        expect(tags).toContain('SMA21 Touch');
    });

    it('SMA21 Touch = false when lastClose outside threshold', () => {
        const tags = computeNewlogicTags({
            sma21: 100,
            lastClose: 110,
            sma21TouchThresholdPct: 3,
            closes: [100, 100, 100],
        });
        expect(tags).not.toContain('SMA21 Touch');
    });

    it('SMA21 Touch skipped when sma21 missing', () => {
        const tags = computeNewlogicTags({
            lastClose: 100,
            closes: [100, 100, 100],
        });
        expect(tags).not.toContain('SMA21 Touch');
    });

    it('SMA21 Touch skipped when lastClose missing and closes empty', () => {
        const tags = computeNewlogicTags({
            sma21: 100,
            closes: [],
        });
        expect(tags).not.toContain('SMA21 Touch');
    });

    it('1M Breakout unchanged', () => {
        const closes = [...Array(21).fill(95), 100];
        const tags = computeNewlogicTags({ closes });
        expect(tags).toContain('1M Breakout');
    });

    it('Pullback 15% unchanged', () => {
        const tags = computeNewlogicTags({
            pctFromAth: -18,
            closes: Array(25).fill(100),
        });
        expect(tags).toContain('Pullback 15%');
    });
});

describe('calculateSMA200Slope', () => {
    it('returns undefined with insufficient data', () => {
        expect(calculateSMA200Slope([1, 2, 3], 20)).toBeUndefined();
    });

    it('detects an upward-sloping series', () => {
        // 220 closes ramping linearly upward → SMA200 series climbs.
        const closes = Array.from({ length: 220 }, (_, i) => 100 + i * 0.5);
        expect(calculateSMA200Slope(closes, 20)).toBe('up');
    });

    it('detects a downward-sloping series', () => {
        const closes = Array.from({ length: 220 }, (_, i) => 200 - i * 0.5);
        expect(calculateSMA200Slope(closes, 20)).toBe('down');
    });

    it('detects flat when series is steady', () => {
        const closes = Array(220).fill(100);
        expect(calculateSMA200Slope(closes, 20)).toBe('flat');
    });
});

describe('countConsecutiveGreenDays', () => {
    it('returns 0 when fewer than 2 closes', () => {
        expect(countConsecutiveGreenDays([100], 15)).toBe(0);
    });

    it('counts strictly increasing closes', () => {
        const closes = [100, 101, 102, 103, 104, 105]; // 5 green steps
        expect(countConsecutiveGreenDays(closes, 15)).toBe(5);
    });

    it('handles flat days as not-green (close[i] > close[i-1])', () => {
        const closes = [100, 100, 100, 101, 101, 102]; // green steps: 100→101, 101→102 = 2
        expect(countConsecutiveGreenDays(closes, 15)).toBe(2);
    });

    it('respects window size', () => {
        const closes = [100, 101, 102, 103, 104, 105]; // 5 green
        // window=3 means consider last 4 closes → [102,103,104,105] → 3 green steps
        expect(countConsecutiveGreenDays(closes, 3)).toBe(3);
    });
});

describe('detectEarningsGap', () => {
    const dates = ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05'];

    it('returns null with no gaps ≥ 3%', () => {
        const opens = [100, 101, 102, 103, 104];
        const highs = [101, 102, 103, 104, 105];
        expect(detectEarningsGap(opens, highs, dates, 60, 3)).toBeNull();
    });

    it('detects a gap-up when open > prevHigh by ≥ 3%', () => {
        const opens = [100, 101, 110, 111, 112]; // index 2: open 110 vs prevHigh 102 = +7.84%
        const highs = [101, 102, 112, 113, 114];
        const gap = detectEarningsGap(opens, highs, dates, 60, 3);
        expect(gap).not.toBeNull();
        expect(gap!.date).toBe('2024-01-03');
        expect(gap!.level).toBe(102); // the prev-high we gapped over
    });

    it('returns the most recent gap when multiple exist', () => {
        // Two clear gaps: index 1 (open 110 over high 101 = +8.9%) and index 3 (open 130 over high 116 = +12%).
        // Indices 2 and 4 stay flat (under 3% threshold) so the most-recent gap is 2024-01-04.
        const opens = [100, 110, 111, 130, 131];
        const highs = [101, 111, 112, 131, 132];
        const gap = detectEarningsGap(opens, highs, dates, 60, 3);
        expect(gap!.date).toBe('2024-01-04');
    });

    it('respects lookback window', () => {
        const opens = [100, 110, 111, 112, 113]; // gap at index 1 only
        const highs = [101, 111, 112, 113, 114];
        // lookback=2 → start = max(1, 5-2) = 3 → only inspect indices 3,4 → no gap
        expect(detectEarningsGap(opens, highs, dates, 2, 3)).toBeNull();
    });
});

describe('calculateDaysSinceLastHigh', () => {
    it('returns undefined when fewer than 22 closes', () => {
        expect(calculateDaysSinceLastHigh(Array(20).fill(100), 252)).toBeUndefined();
    });

    it('on a fresh-ATH breakout day, returns base length (NOT 0)', () => {
        // 22-day base near $25, then today breaks to $30.
        // Prior high in the base = $25 on day 0. Today = day 22. → daysSince = 22.
        const closes: number[] = [25];
        for (let i = 1; i < 22; i++) closes.push(22 + Math.random() * 0.5); // base in 22.0–22.5
        closes.push(30); // today: breakout
        const days = calculateDaysSinceLastHigh(closes, 252);
        expect(days).toBe(22);
    });

    it('in a steady uptrend (new high every day), returns ~1', () => {
        const closes = Array.from({ length: 50 }, (_, i) => 100 + i); // strictly increasing
        const days = calculateDaysSinceLastHigh(closes, 252);
        expect(days).toBe(1); // prior high was yesterday
    });

    it('returns the gap between two distinct highs in the window', () => {
        // High of $50 on day 5, then dip to $40 for 30 days, then today $51.
        const closes: number[] = [];
        for (let i = 0; i < 5; i++) closes.push(40);
        closes.push(50); // day 5: prior high
        for (let i = 0; i < 30; i++) closes.push(42);
        closes.push(51); // today: breakout
        // index of prior high (within 0.5%): day 5. Today: day 36. → 31 days.
        expect(calculateDaysSinceLastHigh(closes, 252)).toBe(31);
    });
});

describe('calculateAVWAP', () => {
    it('returns undefined when anchor is out of bounds', () => {
        const v = calculateAVWAP([1], [1], [1], [1], 5);
        expect(v).toBeUndefined();
    });

    it('computes typical-price weighted VWAP from anchor', () => {
        // anchor=0, two bars with vol 100 then 200, typical prices 10 and 20
        // VWAP = (10*100 + 20*200) / (100+200) = 5000/300 = 16.666...
        const v = calculateAVWAP([10, 20], [10, 20], [10, 20], [100, 200], 0);
        expect(v).toBeDefined();
        expect(v!).toBeCloseTo(16.666, 2);
    });

    it('returns undefined when all volumes are zero from anchor', () => {
        const v = calculateAVWAP([10, 20], [10, 20], [10, 20], [0, 0], 0);
        expect(v).toBeUndefined();
    });
});

// ─── Phase 2 Indicators ──────────────────────────────────────────────────

describe('calculateBollingerBands', () => {
    it('returns undefined when not enough data', () => {
        expect(calculateBollingerBands([1, 2, 3], 20)).toBeUndefined();
    });

    it('mid equals SMA of the last `period` closes', () => {
        const closes = Array.from({ length: 25 }, (_, i) => i + 1); // 1..25
        const bb = calculateBollingerBands(closes, 20, 2);
        expect(bb).toBeDefined();
        // Last 20 closes are 6..25, sum = 310, avg = 15.5
        expect(bb!.mid).toBeCloseTo(15.5, 5);
        // Standard deviation of 6..25 (population) ≈ 5.766
        expect(bb!.upper).toBeGreaterThan(bb!.mid);
        expect(bb!.lower).toBeLessThan(bb!.mid);
        // Upper - Mid should equal Mid - Lower (symmetric)
        expect(bb!.upper - bb!.mid).toBeCloseTo(bb!.mid - bb!.lower, 5);
    });

    it('zero stdDev (constant series) → all three values equal', () => {
        const closes = Array(20).fill(50);
        const bb = calculateBollingerBands(closes, 20, 2);
        expect(bb!.upper).toBe(50);
        expect(bb!.mid).toBe(50);
        expect(bb!.lower).toBe(50);
    });
});

describe('calculateEMA', () => {
    it('returns undefined when not enough data', () => {
        expect(calculateEMA([1, 2, 3], 10)).toBeUndefined();
    });

    it('seeds with SMA, then iterates with k = 2/(N+1)', () => {
        const closes = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
        // EMA10 of 1..20: seed = SMA of 1..10 = 5.5; then iterate.
        // Expected after iterating with closes 11..20 (k = 2/11 ≈ 0.1818):
        const ema = calculateEMA(closes, 10);
        expect(ema).toBeDefined();
        // After 10 iterations of strictly increasing prices, EMA should be in the range
        // (seed=5.5, latest=20). Easy bound check + a known-value tolerance:
        expect(ema!).toBeGreaterThan(13);
        expect(ema!).toBeLessThan(18);
    });

    it('on a constant series returns that constant', () => {
        const closes = Array(15).fill(42);
        expect(calculateEMA(closes, 10)).toBeCloseTo(42, 5);
    });
});

describe('countAccumulationDistributionDays', () => {
    it('zero counts when not enough data (need ≥ 21 bars)', () => {
        const closes = [1, 2, 3, 4, 5];
        const volumes = [1000, 1000, 1000, 1000, 1000];
        const r = countAccumulationDistributionDays(closes, volumes);
        expect(r.accumulationDays).toBe(0);
        expect(r.distributionDays).toBe(0);
    });

    it('counts above-average volume up-days as accumulation', () => {
        // 21 baseline bars (close steady, volume 1000) + 5 up-days with high volume
        const closes = [
            ...Array(21).fill(100),
            101, 102, 103, 104, 105, // 5 up-days
        ];
        const volumes = [
            ...Array(21).fill(1000),
            5000, 5000, 5000, 5000, 5000, // high volume
        ];
        const r = countAccumulationDistributionDays(closes, volumes, 25);
        expect(r.accumulationDays).toBe(5);
        expect(r.distributionDays).toBe(0);
    });

    it('counts above-average volume down-days as distribution', () => {
        const closes = [
            ...Array(21).fill(100),
            99, 98, 97, // 3 down-days
        ];
        const volumes = [
            ...Array(21).fill(1000),
            5000, 5000, 5000, // high volume
        ];
        const r = countAccumulationDistributionDays(closes, volumes, 25);
        expect(r.accumulationDays).toBe(0);
        expect(r.distributionDays).toBe(3);
    });

    it('ignores days with normal/below-average volume', () => {
        const closes = [
            ...Array(21).fill(100),
            105, 104, 103, // big price moves
        ];
        const volumes = [
            ...Array(21).fill(5000),
            500, 500, 500, // tiny volume on the moves
        ];
        const r = countAccumulationDistributionDays(closes, volumes, 25);
        expect(r.accumulationDays).toBe(0);
        expect(r.distributionDays).toBe(0);
    });
});

describe('calculateWilliamsR', () => {
    // Hand-computed: over the last 5 bars highestHigh=20, lowestLow=10, close=18.
    // -100 * (20 - 18) / (20 - 10) = -20.
    const highs = [12, 15, 20, 18, 19];
    const lows = [10, 11, 16, 14, 17];
    const closes = [11, 14, 17, 15, 18];

    it('computes %R over the trailing window', () => {
        expect(calculateWilliamsR(highs, lows, closes, 5)).toBeCloseTo(-20, 10);
    });

    it('returns 0 when the close sits at the top of the range', () => {
        expect(calculateWilliamsR([10, 20], [5, 8], [7, 20], 2)).toBe(0);
    });

    it('returns -100 when the close sits at the bottom of the range', () => {
        expect(calculateWilliamsR([10, 20], [5, 8], [7, 5], 2)).toBe(-100);
    });

    it('uses only the last `periods` bars, ignoring older extremes', () => {
        // The 999 high is outside the 2-bar window and must not affect the result.
        const r = calculateWilliamsR([999, 10, 20], [1, 5, 8], [500, 7, 20], 2);
        expect(r).toBe(0);
    });

    it('defaults to 14 periods', () => {
        const h = Array.from({ length: 14 }, (_, i) => 10 + i);
        const l = Array.from({ length: 14 }, (_, i) => i);
        const c = Array.from({ length: 14 }, (_, i) => 5 + i);
        // highestHigh=23, lowestLow=0, close=18 → -100*(23-18)/23
        expect(calculateWilliamsR(h, l, c)).toBeCloseTo((-100 * 5) / 23, 10);
    });

    it('returns undefined on a flat window (division by zero)', () => {
        expect(calculateWilliamsR([5, 5, 5], [5, 5, 5], [5, 5, 5], 3)).toBeUndefined();
    });

    it('returns undefined when there are fewer bars than periods', () => {
        expect(calculateWilliamsR([1, 2], [0, 1], [1, 2], 5)).toBeUndefined();
    });

    it('returns undefined when the arrays disagree in length', () => {
        expect(calculateWilliamsR([1, 2, 3], [0, 1], [1, 2, 3], 2)).toBeUndefined();
    });

    it('returns undefined on a non-finite bar inside the window', () => {
        expect(calculateWilliamsR([1, NaN, 3], [0, 1, 2], [1, 2, 3], 2)).toBeUndefined();
    });

    it('stays within [-100, 0] for arbitrary input', () => {
        const r = calculateWilliamsR([9, 14, 11], [3, 6, 4], [8, 13, 7], 3)!;
        expect(r).toBeLessThanOrEqual(0);
        expect(r).toBeGreaterThanOrEqual(-100);
    });
});
