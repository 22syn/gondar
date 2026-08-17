/**
 * rs_daily ingest — exact SQL and batch shape, not just "it produces rows".
 *
 * These assertions started life as a byte-identical parity contract with what
 * the Smart pipeline on `main` wrote. That parity was deliberately broken on
 * 2026-08-17 by adding a `price` column (see the module header for why), so the
 * expected shape below is now 4 columns at batch size 24. The assertions stay
 * exact for the same original reason: a refactor that quietly changes this SQL
 * changes what the dashboard reads, and this test is what says so.
 */
import {
    buildRsRows,
    buildRsBatches,
    buildRsSchemaBatches,
    isDuplicateColumnError,
} from '../src/utils/rsD1Ingest.js';
import type { StockData } from '../src/types/index.js';

function stock(ticker: string, rsPercentile?: number, lastPrice?: number): StockData {
    return { ticker, rsPercentile, lastPrice } as StockData;
}

describe('buildRsRows', () => {
    it('keeps only stocks with a computed percentile', () => {
        const rows = buildRsRows(
            [stock('AAA', 90, 12.5), stock('BBB', undefined, 99), stock('CCC', 0, 3)],
            '2026-08-07'
        );
        expect(rows).toEqual([
            { scanDate: '2026-08-07', ticker: 'AAA', rs: 90, price: 12.5 },
            // rs 0 is a real percentile (weakest stock), NOT a missing value —
            // a truthiness filter here would silently drop the whole bottom rank.
            { scanDate: '2026-08-07', ticker: 'CCC', rs: 0, price: 3 },
        ]);
    });

    it('returns an empty array when nothing has a percentile', () => {
        expect(buildRsRows([stock('AAA'), stock('BBB')], '2026-08-07')).toEqual([]);
    });

    it('writes price null — not 0 — when a ranked stock has no close', () => {
        // 0 would render as a real -100% in the dashboard's since-signal maths;
        // null is what makes it show "no current price" instead.
        const [row] = buildRsRows([stock('AAA', 50)], '2026-08-07');
        expect(row!.price).toBeNull();
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

    it('chunks inserts at 24 rows to stay under D1’s 100-bound-param cap', () => {
        const stocks = Array.from({ length: 633 }, (_, i) => stock(`T${i}`, i % 101));
        const batches = buildRsBatches(buildRsRows(stocks, '2026-08-07'));
        const inserts = batches.filter((b) => b.sql.startsWith('INSERT'));

        expect(inserts).toHaveLength(Math.ceil(633 / 24)); // 27
        for (const b of inserts) {
            // 4 columns per row; the cap is 100. At the old batch size of 30
            // this would be 120 and D1 would reject the whole insert.
            expect(b.params.length).toBeLessThanOrEqual(96);
            expect(b.params.length % 4).toBe(0);
        }
        expect(inserts.reduce((n, b) => n + b.params.length / 4, 0)).toBe(633);
    });

    it('emits one DELETE per distinct scan_date', () => {
        const rows = [
            { scanDate: '2026-08-06', ticker: 'AAA', rs: 10, price: 1 },
            { scanDate: '2026-08-07', ticker: 'AAA', rs: 20, price: 2 },
            { scanDate: '2026-08-07', ticker: 'BBB', rs: 30, price: 3 },
        ];
        const deletes = buildRsBatches(rows).filter((b) => b.sql.startsWith('DELETE'));
        expect(deletes.map((d) => d.params[0]).sort()).toEqual(['2026-08-06', '2026-08-07']);
    });

    it('writes exactly (scan_date, ticker, rs, price) in that order', () => {
        const batches = buildRsBatches([
            { scanDate: '2026-08-07', ticker: 'AAA', rs: 77, price: 42.5 },
        ]);
        const insert = batches.find((b) => b.sql.startsWith('INSERT'))!;
        expect(insert.sql).toBe(
            'INSERT OR REPLACE INTO rs_daily (scan_date,ticker,rs,price) VALUES (?,?,?,?)'
        );
        expect(insert.params).toEqual(['2026-08-07', 'AAA', 77, 42.5]);
    });

    it('declares price on the CREATE, for databases that do not exist yet', () => {
        expect(buildRsBatches([])[0]!.sql).toContain('price REAL');
    });
});

describe('schema migration', () => {
    it('CREATEs then ALTERs — the CREATE alone cannot add price to an existing table', () => {
        const [create, alter] = buildRsSchemaBatches();
        expect(create!.sql).toContain('CREATE TABLE IF NOT EXISTS rs_daily');
        expect(create!.sql).toContain('price REAL');
        expect(alter!.sql).toBe('ALTER TABLE rs_daily ADD COLUMN price REAL');
        expect(alter!.params).toEqual([]);
    });

    it('swallows only duplicate-column; a real failure must still surface', () => {
        // Every run after the first hits the duplicate-column path, so it has to
        // be benign — but swallowing anything else would hide a broken ingest
        // behind a green scan, which is exactly the failure this guards.
        expect(isDuplicateColumnError('duplicate column name: price')).toBe(true);
        expect(isDuplicateColumnError('SQLITE_ERROR: duplicate column')).toBe(true);
        expect(isDuplicateColumnError('Authentication error')).toBe(false);
        expect(isDuplicateColumnError('no such table: rs_daily')).toBe(false);
        expect(isDuplicateColumnError('network timeout')).toBe(false);
    });
});
