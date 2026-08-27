import {
    buildMarketContextBatches,
    ingestMarketContextToD1,
    MARKET_CONTEXT_COL_COUNT,
} from '../src/utils/marketContextD1Ingest.js';
import type { MarketContextDay } from '../src/services/marketContext.js';

function day(overrides: Partial<MarketContextDay> = {}): MarketContextDay {
    return {
        scanDate: '2026-08-21',
        spxClose: 7674.3701171875,
        spxDistSma150: 6.8033373411248155,
        spxDistSma200: 8.154856544063735,
        rspClose: 221.6699981689453,
        rspSlope21: 4.60079279173416,
        vix: 15.130000114440918,
        xlpSpxRatio: 0.01120482809021506,
        xlpSpxSlope21: -0.24188599253689874,
        xlyXlpRatio: 1.3724851677521925,
        xlyXlpSlope21: 5.005964793069899,
        s5fi: 57.28542914171657,
        s5fiN: 501,
        s5th: 61.4771457085828,
        s5thN: 498,
        spxSupport: 7123.45,
        spyWr1d: -72.41401640989774,
        spyWr1w: -21.739176924250863,
        qqqWr1d: -78.15166058571212,
        qqqWr1w: -40.23542228707095,
        universeBreadth: 55.85,
        universeBreadthN: 419,
        breadthSpread: 1.44,
        ...overrides,
    };
}

describe('buildMarketContextBatches', () => {
    it('stays under the D1 100-bound-param cap', () => {
        expect(MARKET_CONTEXT_COL_COUNT).toBeLessThanOrEqual(100);
    });

    it('emits CREATE first, then a single-row INSERT OR REPLACE', () => {
        const batches = buildMarketContextBatches(day(), 'stamp');
        expect(batches).toHaveLength(2);
        expect(batches[0]!.sql).toContain('CREATE TABLE IF NOT EXISTS market_context');
        expect(batches[0]!.sql).toContain('scan_date TEXT PRIMARY KEY');
        expect(batches[1]!.sql).toContain('INSERT OR REPLACE INTO market_context');
    });

    // The whole point of this table's write shape. Rows have been lost twice in
    // this project to an ingest that cleared a range before rewriting it.
    it('never emits a DELETE', () => {
        const sql = buildMarketContextBatches(day(), 'stamp')
            .map((b) => b.sql)
            .join(' ');
        expect(sql).not.toMatch(/\bDELETE\b/i);
        expect(sql).not.toMatch(/\bDROP\b/i);
    });

    it('binds exactly one parameter per column', () => {
        const insert = buildMarketContextBatches(day(), 'stamp')[1]!;
        expect(insert.params).toHaveLength(MARKET_CONTEXT_COL_COUNT);
        expect((insert.sql.match(/\?/g) ?? []).length).toBe(MARKET_CONTEXT_COL_COUNT);
        expect(insert.params[0]).toBe('2026-08-21');
        expect(insert.params[MARKET_CONTEXT_COL_COUNT - 1]).toBe('stamp');
        expect(insert.params[13]).toBe(61.4771); // s5th, 4dp
        expect(insert.params[14]).toBe(498);     // s5th_n
        expect(insert.params[15]).toBe(7123.45); // spx_support, 2dp
        expect(insert.params[20]).toBe(55.85);   // universe_breadth
        expect(insert.params[21]).toBe(419);     // universe_breadth_n
        expect(insert.params[22]).toBe(1.44);    // breadth_spread — s5fi minus universe
    });

    it('rounds without inventing precision, and keeps s5fi_n an integer', () => {
        const insert = buildMarketContextBatches(day(), 'stamp')[1]!;
        expect(insert.params[11]).toBe(57.2854); // s5fi, 4dp
        expect(insert.params[12]).toBe(501); // s5fi_n, untouched
        expect(insert.params[7]).toBe(0.01120483); // xlp/spx ratio keeps 8dp
    });

    it('passes nulls through as null rather than 0', () => {
        const insert = buildMarketContextBatches(
            day({ s5fi: null, s5fiN: null, vix: null }),
            'stamp'
        )[1]!;
        expect(insert.params[6]).toBeNull(); // vix
        expect(insert.params[11]).toBeNull(); // s5fi
        expect(insert.params[12]).toBeNull(); // s5fi_n
    });

    it('treats a non-finite value as null', () => {
        const insert = buildMarketContextBatches(day({ vix: NaN }), 'stamp')[1]!;
        expect(insert.params[6]).toBeNull();
    });
});

describe('ingestMarketContextToD1', () => {
    it('no-ops on a null day', async () => {
        await expect(ingestMarketContextToD1(null)).resolves.toBe(false);
    });

    it('skips when D1 is unconfigured rather than throwing', async () => {
        const saved = { ...process.env };
        delete process.env.CF_ACCOUNT_ID;
        delete process.env.D1_DATABASE_ID;
        delete process.env.CF_API_TOKEN;
        await expect(ingestMarketContextToD1(day())).resolves.toBe(false);
        process.env = saved;
    });
});
