/**
 * Smart Volume Radar - Scan Results Persistence
 * Builds StoredScanResult and writes to disk for evaluation scripts.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { RVOLResult, StockData, StoredSignal, StoredScanResult } from '../types/index.js';

export function buildStoredScanResult(
    date: string,
    finalSignals: RVOLResult[],
    volumeWithoutPrice: StockData[]
): StoredScanResult {
    const toSignal = (s: StockData, source: 'topSignals' | 'volumeWithoutPrice'): StoredSignal => ({
        ticker: s.ticker,
        lastPrice: s.lastPrice,
        rvol: s.rvol,
        tags: s.tags ?? [],
        source,
    });
    const fromTop = finalSignals.map((s) => toSignal(s, 'topSignals'));
    const fromSilent = volumeWithoutPrice.map((s) => toSignal(s, 'volumeWithoutPrice'));
    return {
        date,
        signals: [...fromTop, ...fromSilent],
    };
}

export function writeScanResults(result: StoredScanResult, outDir: string): void {
    const file = path.join(outDir, `scan-${result.date}.json`);
    fs.mkdirSync(outDir, { recursive: true });
    const serialized = JSON.stringify(
        result,
        (_, v) => (v instanceof Date ? v.toISOString() : v),
        2
    );
    fs.writeFileSync(file, serialized + '\n', 'utf-8');
}
