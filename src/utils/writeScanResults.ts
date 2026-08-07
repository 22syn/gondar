/**
 * Gondar - Scan Results Persistence
 * Builds StoredScanResult and writes to disk for evaluation scripts.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { RVOLResult, StockData, StoredSignal, StoredScanResult } from '../types/index.js';
import type { ScanDebugInfo } from '../services/rvolCalculator.js';

export function buildStoredScanResult(
    date: string,
    finalSignals: RVOLResult[],
    volumeWithoutPrice: StockData[]
): StoredScanResult {
    type SourceType = StoredSignal['source'];
    const toSignal = (s: StockData, source: SourceType): StoredSignal => {
        const sig: StoredSignal = {
            ticker: s.ticker,
            lastPrice: s.lastPrice,
            rvol: s.rvol,
            tags: s.tags ?? [],
            source,
        };
        if (
            s.momentum?.level === 'full' ||
            s.momentum?.level === 'recovery' ||
            s.momentum?.level === 'close'
        ) {
            sig.momentumLevel = s.momentum.level;
        }
        return sig;
    };
    const entryPathToSource = (p: StockData['entryPath']): SourceType => {
        switch (p) {
            case 'green':
                return 'topSignals-green';
            case 'pullback':
                return 'topSignals-pullback';
            case 'sma21':
                return 'topSignals-sma21';
            default:
                return 'topSignals-green';
        }
    };
    const fromTop = finalSignals.map((s) => toSignal(s, entryPathToSource(s.entryPath)));
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

/** Payload for scan-debug-{date}.json — for investigating missing signals */
export interface ScanDebugPayload {
    date: string;
    failedTickers: string[];
    fetchedCount: number;
    debug: ScanDebugInfo;
}

export function writeScanDebug(payload: ScanDebugPayload, outDir: string): void {
    const file = path.join(outDir, `scan-debug-${payload.date}.json`);
    fs.mkdirSync(outDir, { recursive: true });
    const serialized = JSON.stringify(
        payload,
        (_, v) => (v instanceof Date ? v.toISOString() : v),
        2
    );
    fs.writeFileSync(file, serialized + '\n', 'utf-8');
}
