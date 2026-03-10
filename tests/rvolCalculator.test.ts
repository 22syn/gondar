/**
 * RVOL Calculator Tests
 */

jest.mock('../src/config/index.js', () => ({
    config: {
        formatPrecision: { price: 2, pct: 2, base: 2, rvol: 2, rsi: 0 },
    },
}));

import { calculateRVOL, formatRVOL, formatPriceChange, isBullish } from '../src/services/rvolCalculator';
import { StockData } from '../src/types';

describe('RVOL Calculator', () => {
    const mockStocks: StockData[] = [
        {
            ticker: 'AAPL',
            lastPrice: 180.5,
            priceChange: 5.25,
            currentVolume: 100000000,
            avgVolume: 28571428,
            rvol: 3.5,
        },
        {
            ticker: 'MSFT',
            lastPrice: 405.2,
            priceChange: 0.3,
            currentVolume: 50000000,
            avgVolume: 23809523,
            rvol: 2.1,
        },
        {
            ticker: 'GOOGL',
            lastPrice: 145.0,
            priceChange: -2.1,
            currentVolume: 30000000,
            avgVolume: 20000000,
            rvol: 1.5,
        },
        {
            ticker: 'NVDA',
            lastPrice: 850.0,
            priceChange: 6.25,
            currentVolume: 80000000,
            avgVolume: 16000000,
            rvol: 5.0,
        },
    ];

    describe('calculateRVOL', () => {
        it('should filter green path: RVOL >= minRVOL AND |priceChange| >= threshold', () => {
            const result = calculateRVOL(mockStocks, {
                minRVOL: 2.0,
                topN: 15,
                priceChangeThreshold: 2,
            });

            // Green = RVOL≥2 and |priceChange|≥2% → AAPL (5.25%), NVDA (6.25%). MSFT has 0.3% so excluded.
            expect(result.topSignals).toHaveLength(2);
            expect(result.topSignals.map((s) => s.ticker)).toContain('AAPL');
            expect(result.topSignals.map((s) => s.ticker)).toContain('NVDA');
            expect(result.topSignals.map((s) => s.ticker)).not.toContain('MSFT');
            expect(result.topSignals.map((s) => s.ticker)).not.toContain('GOOGL');
        });

        it('should sort green by RVOL descending', () => {
            const result = calculateRVOL(mockStocks, {
                minRVOL: 2.0,
                topN: 15,
                priceChangeThreshold: 2,
            });

            expect(result.topSignals[0].ticker).toBe('NVDA'); // 5.0x
            expect(result.topSignals[1].ticker).toBe('AAPL'); // 3.5x
        });

        it('should respect topN limit for green', () => {
            const result = calculateRVOL(mockStocks, {
                minRVOL: 2.0,
                topN: 1,
                priceChangeThreshold: 2,
            });

            expect(result.topSignals).toHaveLength(1);
        });

        it('should identify volume without price stocks (high RVOL, low price change)', () => {
            const result = calculateRVOL(mockStocks, {
                minRVOL: 2.0,
                topN: 15,
                priceChangeThreshold: 2,
            });

            expect(result.volumeWithoutPrice).toHaveLength(1);
            expect(result.volumeWithoutPrice[0].ticker).toBe('MSFT'); // 0.3% change
        });

        it('should return empty arrays when no stocks meet threshold', () => {
            const result = calculateRVOL(mockStocks, {
                minRVOL: 10.0,
                topN: 15,
                priceChangeThreshold: 2,
            });

            expect(result.topSignals).toHaveLength(0);
            expect(result.volumeWithoutPrice).toHaveLength(0);
        });

        it('should include blue-path stocks (all 3 tags) in topSignals even without green', () => {
            const stocksWithAllTags = mockStocks.map((s) =>
                s.ticker === 'GOOGL'
                    ? {
                          ...s,
                          tags: ['SMA21 Touch', 'Pullback 15%', '1M Breakout'] as const,
                      }
                    : s
            );
            const result = calculateRVOL(stocksWithAllTags, {
                minRVOL: 2.0,
                topN: 15,
                priceChangeThreshold: 2,
            });

            expect(result.topSignals.map((s) => s.ticker)).toContain('GOOGL');
            expect(result.topSignals).toHaveLength(3); // AAPL, NVDA (green) + GOOGL (blue)
        });

        it('should not include stock with only one tag in blue path', () => {
            const stocksWithOneTag = mockStocks.map((s) =>
                s.ticker === 'GOOGL' ? { ...s, tags: ['SMA21 Touch' as const] } : s
            );
            const result = calculateRVOL(stocksWithOneTag, {
                minRVOL: 2.0,
                topN: 15,
                priceChangeThreshold: 2,
            });

            expect(result.topSignals.map((s) => s.ticker)).not.toContain('GOOGL');
            expect(result.topSignals).toHaveLength(2); // AAPL, NVDA only
        });
    });

    describe('formatRVOL', () => {
        it('should format RVOL with 2 decimal places and x suffix', () => {
            expect(formatRVOL(3.5)).toBe('3.50x');
            expect(formatRVOL(2.0)).toBe('2.00x');
            expect(formatRVOL(10.123)).toBe('10.12x');
        });
    });

    describe('formatPriceChange', () => {
        it('should format positive changes with + sign', () => {
            expect(formatPriceChange(5.25)).toBe('+5.25%');
        });

        it('should format negative changes with - sign', () => {
            expect(formatPriceChange(-2.1)).toBe('-2.10%');
        });

        it('should format zero as positive', () => {
            expect(formatPriceChange(0)).toBe('+0.00%');
        });
    });

    describe('isBullish', () => {
        it('should return true for positive price change', () => {
            expect(isBullish(mockStocks[0])).toBe(true); // AAPL +5.25%
        });

        it('should return false for negative price change', () => {
            expect(isBullish(mockStocks[2])).toBe(false); // GOOGL -2.1%
        });

        it('should return true for zero change', () => {
            const flatStock = { ...mockStocks[0], priceChange: 0 };
            expect(isBullish(flatStock)).toBe(true);
        });
    });
});
