/**
 * Newlogic Tags Tests
 */

import { computeNewlogicTags } from '../src/utils/technicalAnalysis.js';
import { getTagCount, formatTagsForDisplay } from '../src/utils/tags.js';
import type { StockData } from '../src/types/index.js';

describe('computeNewlogicTags', () => {
    it('returns SMA21 Touch when Low <= SMA21 <= High', () => {
        const tags = computeNewlogicTags({
            sma21: 100,
            lastDayLow: 95,
            lastDayHigh: 105,
            closes: [100, 100, 100],
        });
        expect(tags).toContain('SMA21 Touch');
    });

    it('returns no SMA21 Touch when range does not include SMA21', () => {
        const tags = computeNewlogicTags({
            sma21: 100,
            lastDayLow: 105,
            lastDayHigh: 110,
            closes: [100, 100, 100],
        });
        expect(tags).not.toContain('SMA21 Touch');
    });

    it('returns Pullback 15% when pctFromAth <= -15', () => {
        const tags = computeNewlogicTags({
            pctFromAth: -18,
            closes: Array(25).fill(100),
        });
        expect(tags).toContain('Pullback 15%');
    });

    it('returns no Pullback 15% when pctFromAth > -15', () => {
        const tags = computeNewlogicTags({
            pctFromAth: -10,
            closes: Array(25).fill(100),
        });
        expect(tags).not.toContain('Pullback 15%');
    });

    it('returns 1M Breakout when lastClose > rangeHigh of prior 21 days', () => {
        const closes = [...Array(21).fill(95), 100]; // last close 100, range 95-95
        const tags = computeNewlogicTags({ closes });
        expect(tags).toContain('1M Breakout');
    });
});

describe('getTagCount', () => {
    it('returns 0 when no tags', () => {
        const s: StockData = { ticker: 'X', currentVolume: 1, avgVolume: 1, rvol: 2, priceChange: 0, lastPrice: 100 };
        expect(getTagCount(s)).toBe(0);
    });

    it('returns tag count', () => {
        const s: StockData = {
            ticker: 'X',
            currentVolume: 1,
            avgVolume: 1,
            rvol: 2,
            priceChange: 0,
            lastPrice: 100,
            tags: ['SMA21 Touch', 'Pullback 15%'],
        };
        expect(getTagCount(s)).toBe(2);
    });
});

describe('formatTagsForDisplay', () => {
    it('returns empty string when no tags', () => {
        const s: StockData = { ticker: 'X', currentVolume: 1, avgVolume: 1, rvol: 2, priceChange: 0, lastPrice: 100 };
        expect(formatTagsForDisplay(s)).toBe('');
    });

    it('joins tags with bullet', () => {
        const s: StockData = {
            ticker: 'X',
            currentVolume: 1,
            avgVolume: 1,
            rvol: 2,
            priceChange: 0,
            lastPrice: 100,
            tags: ['SMA21 Touch', 'Pullback 15%'],
        };
        expect(formatTagsForDisplay(s)).toBe('SMA21 Touch • Pullback 15%');
    });
});
