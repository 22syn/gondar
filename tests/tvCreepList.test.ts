/**
 * Lean Radar TradingView watchlist — Creep list builder.
 */
import { buildCreepList } from '../src/lean/tradingViewWatchlist';
import type { LeanScanResult } from '../src/lean/format';

function creepEntry(ticker: string, mom63 = 25.5, pctFromAth = -8.2) {
    return {
        stock: { ticker } as LeanScanResult['creep'][number]['stock'],
        signal: { mom63, pctFromAth, avgDollarVolumeUsd: 5_000_000 },
    };
}

function resultWith(creep: LeanScanResult['creep']): LeanScanResult {
    return { creep } as LeanScanResult;
}

describe('buildCreepList', () => {
    it('maps each creep signal to a TradingView symbol with a momentum detail', () => {
        const out = buildCreepList(resultWith([creepEntry('NVDA', 31.4, -4.6)]));
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ svrTicker: 'NVDA', tvSymbol: 'NVDA', kind: 'creep' });
        expect(out[0]!.detail).toBe('mom63 31.4%, -4.6% from ATH');
    });

    it('applies the exchange prefix for non-US tickers', () => {
        const out = buildCreepList(resultWith([creepEntry('NICE.TA'), creepEntry('RHM.DE')]));
        expect(out.map((e) => e.tvSymbol)).toEqual(['TASE:NICE', 'XETR:RHM']);
    });

    it('rewrites US class shares from Yahoo dashes to TradingView dots', () => {
        const out = buildCreepList(resultWith([creepEntry('MOG-A'), creepEntry('BRK-B')]));
        expect(out.map((e) => e.tvSymbol)).toEqual(['MOG.A', 'BRK.B']);
    });

    it('de-duplicates repeated tickers', () => {
        const out = buildCreepList(resultWith([creepEntry('KO'), creepEntry('KO')]));
        expect(out).toHaveLength(1);
    });

    it('returns an empty list when the snapshot predates the creep tier', () => {
        expect(buildCreepList({} as LeanScanResult)).toEqual([]);
    });
});
