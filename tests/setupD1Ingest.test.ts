/**
 * setup_signals ingest — the contract that keeps the GONDAR dashboard unchanged
 * after the Smart Setup signals moved from the Smart pipeline (main) to the Lean
 * scan (stable).
 *
 * This table carries only 1-4 rows/day, so a defect here is nearly invisible in
 * aggregate checks. The assertions are deliberately about exact SQL, scoring and
 * batch shape: the acceptance criterion is byte-identical D1 output, so a
 * refactor that changes any of them is a regression even if it still "works".
 */
import { buildSetupRows, buildSetupBatches, regionOf } from '../src/utils/setupD1Ingest.js';
import type { StockData } from '../src/types/index.js';

function stock(over: Partial<StockData> & { ticker: string }): StockData {
    return {
        lastPrice: 100,
        priceChange: 1,
        rvol: 2,
        momentum: { level: 'full', criteria: { stage2: true } },
        ...over,
    } as StockData;
}

describe('regionOf', () => {
    it('classifies TASE, foreign and US suffixes', () => {
        expect(regionOf('TEVA.TA')).toBe('TASE');
        expect(regionOf('EZJ.L')).toBe('Foreign');
        expect(regionOf('000660.KS')).toBe('Foreign');
        expect(regionOf('ABNB')).toBe('US');
    });
});

describe('buildSetupRows', () => {
    it('skips stocks that reached no momentum level', () => {
        const rows = buildSetupRows(
            [
                stock({ ticker: 'AAA' }),
                stock({ ticker: 'BBB', momentum: { level: 'none', criteria: {} } as never }),
            ],
            '2026-08-07'
        );
        expect(rows.map((r) => r.ticker)).toEqual(['AAA']);
    });

    it('skips a stock with no price, even at a valid level', () => {
        const rows = buildSetupRows([stock({ ticker: 'AAA', lastPrice: undefined })], '2026-08-07');
        expect(rows).toEqual([]);
    });

    it('prefers projectedRvol over raw rvol', () => {
        const [row] = buildSetupRows(
            [stock({ ticker: 'AAA', rvol: 2, projectedRvol: 5 })],
            '2026-08-07'
        );
        expect(row!.rvol).toBe(5);
    });

    it('scores base + rvol(capped at 6) + stage2 + rs>=90', () => {
        // full=60, rvol capped 6*5=30, stage2=20, rs>=90=10  ->  120
        const [hot] = buildSetupRows(
            [stock({ ticker: 'AAA', projectedRvol: 99, rsPercentile: 90 })],
            '2026-08-07'
        );
        expect(hot!.score).toBe(120);

        // close=40, rvol 1*5=5, no stage2, rs 89 misses the bonus  ->  45
        const [cool] = buildSetupRows(
            [
                stock({
                    ticker: 'BBB',
                    projectedRvol: 1,
                    rsPercentile: 89,
                    momentum: { level: 'close', criteria: { stage2: false } } as never,
                }),
            ],
            '2026-08-07'
        );
        expect(cool!.score).toBe(45);
    });

    it('rounds rvol/athPct/dayPct to 2dp and keeps null athPct', () => {
        const [row] = buildSetupRows(
            [stock({ ticker: 'AAA', projectedRvol: 1.23456, priceChange: -2.71828, pctFromAth: undefined })],
            '2026-08-07'
        );
        expect(row!.rvol).toBe(1.23);
        expect(row!.dayPct).toBe(-2.72);
        expect(row!.athPct).toBeNull();
    });
});

describe('buildSetupBatches', () => {
    it('creates the table even with no rows', () => {
        const b = buildSetupBatches([], 'stamp');
        expect(b).toHaveLength(1);
        expect(b[0]!.sql).toContain('CREATE TABLE IF NOT EXISTS setup_signals');
    });

    it('deletes each scan_date before inserting', () => {
        const rows = buildSetupRows([stock({ ticker: 'AAA' })], '2026-08-07');
        const b = buildSetupBatches(rows, 'stamp');
        const del = b.find((x) => x.sql.startsWith('DELETE'));
        expect(del).toEqual({
            sql: 'DELETE FROM setup_signals WHERE scan_date = ?',
            params: ['2026-08-07'],
        });
        expect(b.indexOf(del!)).toBeLessThan(b.findIndex((x) => x.sql.startsWith('INSERT')));
    });

    it('chunks at 7 rows — 13 cols x 7 = 91, under D1’s 100-param cap', () => {
        const rows = buildSetupRows(
            Array.from({ length: 20 }, (_, i) => stock({ ticker: `T${i}` })),
            '2026-08-07'
        );
        const inserts = buildSetupBatches(rows, 'stamp').filter((x) => x.sql.startsWith('INSERT'));
        expect(inserts).toHaveLength(3); // 7 + 7 + 6
        for (const x of inserts) {
            expect(x.params.length).toBeLessThanOrEqual(91);
            expect(x.params.length % 13).toBe(0);
        }
    });

    it('writes the 13 columns in the exact documented order', () => {
        const rows = buildSetupRows([stock({ ticker: 'AAA', rsPercentile: 50, pctFromAth: -3 })], '2026-08-07');
        const insert = buildSetupBatches(rows, 'STAMP').find((x) => x.sql.startsWith('INSERT'))!;
        expect(insert.sql).toContain(
            '(scan_date,ticker,region,sector,sig,rvol,ath_pct,day_pct,stage2,score,price,rs,ingested_at)'
        );
        expect(insert.params).toEqual([
            '2026-08-07', 'AAA', 'US', '', 'setupFull', 2, -3, 1, 1, 90, 100, 50, 'STAMP',
        ]);
    });
});
