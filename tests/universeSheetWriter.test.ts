import { selectNewRows, existingSymbolSet, planSectorUpdates } from '../src/services/universeSheetWriter';

describe('existingSymbolSet', () => {
    it('builds an uppercase set and skips the header row', () => {
        const set = existingSymbolSet([['Symbol', 'Sector'], ['nvda', 'Semis'], ['amd', 'Semis']]);
        expect(set.has('NVDA')).toBe(true);
        expect(set.has('AMD')).toBe(true);
        expect(set.has('SYMBOL')).toBe(false);
        expect(set.size).toBe(2);
    });

    it('handles an empty sheet', () => {
        expect(existingSymbolSet([]).size).toBe(0);
    });
});

describe('selectNewRows', () => {
    it('keeps only rows whose symbol is not already present (case-insensitive)', () => {
        const existing = new Set(['NVDA', 'AMD']);
        const rows = [
            { symbol: 'NVDA', sector: 'Semis' },
            { symbol: 'INTC', sector: 'Semis' },
            { symbol: 'amd', sector: 'Semis' },
        ];
        expect(selectNewRows(existing, rows)).toEqual([{ symbol: 'INTC', sector: 'Semis' }]);
    });

    it('returns all rows when nothing exists yet', () => {
        const rows = [{ symbol: 'NVDA', sector: 'Semis' }];
        expect(selectNewRows(new Set(), rows)).toEqual(rows);
    });
});

describe('planSectorUpdates', () => {
    const grid = [
        ['Symbol', 'Sector'],
        ['NVDA', 'AI - Chain'],
        ['amd', 'Semis'],
        ['FLY', ''],
        ['XYZ.TA', 'real estate'],
    ];

    it('rewrites sectors that differ and fills empty ones (case-insensitive symbol match)', () => {
        const rows = [
            { symbol: 'NVDA', sector: 'Semiconductor' },
            { symbol: 'AMD', sector: 'Semis' },
            { symbol: 'FLY', sector: 'Space' },
        ];
        expect(planSectorUpdates(grid, rows)).toEqual([
            { rowNumber: 2, symbol: 'NVDA', from: 'AI - Chain', to: 'Semiconductor' },
            { rowNumber: 4, symbol: 'FLY', from: '', to: 'Space' },
        ]);
    });

    it('leaves rows alone when the symbol is in no source watchlist', () => {
        expect(planSectorUpdates(grid, [{ symbol: 'NVDA', sector: 'AI - Chain' }])).toEqual([]);
    });

    it('never overwrites with an empty sector and skips the header row', () => {
        const rows = [
            { symbol: 'NVDA', sector: '  ' },
            { symbol: 'Symbol', sector: 'Bogus' },
        ];
        expect(planSectorUpdates(grid, rows)).toEqual([]);
    });

    it('updates every duplicate row of the same symbol', () => {
        const dupGrid = [
            ['Symbol', 'Sector'],
            ['BA.L', 'Aerospace & Defense'],
            ['BA.L', 'Defense&Aerspace'],
        ];
        expect(planSectorUpdates(dupGrid, [{ symbol: 'BA.L', sector: 'Defense&Aerspace' }])).toEqual([
            { rowNumber: 2, symbol: 'BA.L', from: 'Aerospace & Defense', to: 'Defense&Aerspace' },
        ]);
    });

    it('first sector wins when the same symbol arrives from two lists', () => {
        const rows = [
            { symbol: 'NVDA', sector: 'Semiconductor' },
            { symbol: 'NVDA', sector: 'AI - Chain' },
        ];
        expect(planSectorUpdates(grid, rows)).toEqual([
            { rowNumber: 2, symbol: 'NVDA', from: 'AI - Chain', to: 'Semiconductor' },
        ]);
    });
});
