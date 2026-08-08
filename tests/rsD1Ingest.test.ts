/**
 * rs_daily ingest — the contract that keeps the GONDAR dashboard unchanged
 * after RS moved from the Smart pipeline (main) to the Lean scan (stable).
 *
 * These assertions are deliberately about EXACT SQL and batch shape, not just
 * "it produces rows": the migration's whole acceptance criterion is that D1
 * ends up byte-identical to what `main` wrote. A prettier refactor that changes
 * the SQL is a regression, and this test is what says so.
 */
import { buildRsRows, buildRsBatches } from '../src/utils/rsD1Ingest.js';
import type { StockData } from '../src/types/index.js';

function stock(ticker: string, rsPercentile?: number): StockData {
    return { ticker, rsPercentile } as StockData;
}

describe('buildRsRows', () => {
    it('keeps only stocks with a computed percentile', () => {
        const rows = buildRsRows(
            [stock('AAA', 90), stock('BBB'), stock('CCC', 0)],
            '2026-08-07'
        );
        expect(rows).toEqual([
            { scanDate: '2026-08-07', ticker: 'AAA', rs: 90 },
            // rs 0 is a real percentile (weakest stock), NOT a missing value —
            // a truthiness filter here would silently drop the whole bottom rank.
            { scanDate: '2026-08-07', ticker: 'CCC', rs: 0 },
        ]);
    });

    it('returns an empty array when nothing has a percentile', () => {
        expect(buildRsRows([stock('AAA'), stock('BBB')], '2026-08-07')).toEqual([]);
    });
});

describe('buildRsBatches', () => {
    it('creates the table even when there are no rows', () => {
        const batches = buildRsBatches([]);
        expect(batches).toHaveLength(1);
        expect(batches[0]!.sql).toContain('CREATE TABLE IF NOT EXISTS rs_daily');
        expect(batches[0]!.params).toEqual([]);
    });

    it('deletes the scan_date before inserting, so a re-run replaces it', () => {
        // The Lean scan runs twice on weekdays (20:15 primary, 23:45 settled
        // close). Without delete-first the second run would accumulate rows
        // instead of correcting the first.
        const rows = buildRsRows([stock('AAA', 50)], '2026-08-07');
        const batches = buildRsBatches(rows);
        const del = batches.find((b) => b.sql.startsWith('DELETE'));
        expect(del).toEqual({
            sql: 'DELETE FROM rs_daily WHERE scan_date = ?',
            params: ['2026-08-07'],
        });
        expect(batches.indexOf(del!)).toBeLessThan(
            batches.findIndex((b) => b.sql.startsWith('INSERT'))
        );
    });

    it('chunks inserts at 30 rows to stay under D1’s 100-bound-param cap', () => {
        const stocks = Array.from({ length: 633 }, (_, i) => stock(`T${i}`, i % 101));
        const batches = buildRsBatches(buildRsRows(stocks, '2026-08-07'));
        const inserts = batches.filter((b) => b.sql.startsWith('INSERT'));

        expect(inserts).toHaveLength(Math.ceil(633 / 30)); // 22
        for (const b of inserts) {
            // 3 columns per row; the cap is 100.
            expect(b.params.length).toBeLessThanOrEqual(90);
            expect(b.params.length % 3).toBe(0);
        }
        expect(inserts.reduce((n, b) => n + b.params.length / 3, 0)).toBe(633);
    });

    it('emits one DELETE per distinct scan_date', () => {
        const rows = [
            { scanDate: '2026-08-06', ticker: 'AAA', rs: 10 },
            { scanDate: '2026-08-07', ticker: 'AAA', rs: 20 },
            { scanDate: '2026-08-07', ticker: 'BBB', rs: 30 },
        ];
        const deletes = buildRsBatches(rows).filter((b) => b.sql.startsWith('DELETE'));
        expect(deletes.map((d) => d.params[0]).sort()).toEqual(['2026-08-06', '2026-08-07']);
    });

    it('writes exactly (scan_date, ticker, rs) in that order', () => {
        const batches = buildRsBatches([{ scanDate: '2026-08-07', ticker: 'AAA', rs: 77 }]);
        const insert = batches.find((b) => b.sql.startsWith('INSERT'))!;
        expect(insert.sql).toBe(
            'INSERT OR REPLACE INTO rs_daily (scan_date,ticker,rs) VALUES (?,?,?)'
        );
        expect(insert.params).toEqual(['2026-08-07', 'AAA', 77]);
    });
});
