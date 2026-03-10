/**
 * writeScanResults utility tests
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    buildStoredScanResult,
    writeScanResults,
} from '../src/utils/writeScanResults.js';
import type { RVOLResult, StockData } from '../src/types/index.js';

const baseStock: StockData = {
    ticker: 'AAPL',
    currentVolume: 1_000_000,
    avgVolume: 500_000,
    rvol: 2,
    priceChange: 1.5,
    lastPrice: 100,
};

function toRVOLResult(s: StockData): RVOLResult {
    return { ...s, news: [], isVolumeWithoutPrice: false };
}

describe('buildStoredScanResult', () => {
    it('adds tags when stock has tags', () => {
        const taggedStock: StockData = {
            ...baseStock,
            tags: ['SMA21 Touch', 'Pullback 15%'],
        };
        const result = buildStoredScanResult('2026-03-08', [toRVOLResult(taggedStock)], []);
        expect(result.date).toBe('2026-03-08');
        expect(result.signals).toHaveLength(1);
        expect(result.signals[0].tags).toEqual(['SMA21 Touch', 'Pullback 15%']);
        expect(result.signals[0].source).toBe('topSignals');
        expect(result.signals[0].ticker).toBe('AAPL');
        expect(result.signals[0].lastPrice).toBe(100);
        expect(result.signals[0].rvol).toBe(2);
    });

    it('adds empty tags when stock has no tags', () => {
        const noneStock: StockData = {
            ...baseStock,
            ticker: 'GOOG',
        };
        const result = buildStoredScanResult('2026-03-08', [toRVOLResult(noneStock)], []);
        expect(result.signals).toHaveLength(1);
        expect(result.signals[0].tags).toEqual([]);
    });

    it('sets source "topSignals" for finalSignals and "volumeWithoutPrice" for volumeWithoutPrice', () => {
        const stock: StockData = { ...baseStock, ticker: 'A' };
        const silentStock: StockData = { ...baseStock, ticker: 'B', tags: ['1M Breakout'] };
        const result = buildStoredScanResult('2026-03-08', [toRVOLResult(stock)], [silentStock]);
        expect(result.signals).toHaveLength(2);
        expect(result.signals[0].source).toBe('topSignals');
        expect(result.signals[0].ticker).toBe('A');
        expect(result.signals[1].source).toBe('volumeWithoutPrice');
        expect(result.signals[1].ticker).toBe('B');
    });
});

describe('writeScanResults', () => {
    it('creates file and JSON is valid', () => {
        const outDir = path.join(os.tmpdir(), `smart-volume-radar-test-${Date.now()}`);
        const stored = {
            date: '2026-03-08',
            signals: [
                { ticker: 'AAPL', lastPrice: 100, rvol: 2, tags: ['SMA21 Touch'], source: 'topSignals' as const },
            ],
        };
        writeScanResults(stored, outDir);
        const filePath = path.join(outDir, 'scan-2026-03-08.json');
        expect(fs.existsSync(filePath)).toBe(true);
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(content);
        expect(parsed.date).toBe('2026-03-08');
        expect(parsed.signals).toHaveLength(1);
        expect(parsed.signals[0]).toEqual({
            ticker: 'AAPL',
            lastPrice: 100,
            rvol: 2,
            tags: ['SMA21 Touch'],
            source: 'topSignals',
        });
        fs.rmSync(outDir, { recursive: true, force: true });
    });
});
