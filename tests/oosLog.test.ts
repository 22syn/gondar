// oosLog imports purpleFragility (for FRAGILITY_THRESHOLD), which imports
// p-limit — mock it to avoid ESM import issues in Jest (same as the fragility suite).
jest.mock('p-limit', () => () => (fn: () => Promise<unknown>) => fn());

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    buildOosRow,
    oosRowToCsv,
    parseOosCsv,
    oosRowsToCsv,
    upsertOosRow,
    appendOosLogRow,
    evaluateOosScorecard,
    OOS_START,
    OOS_COLUMNS,
    type OosRow,
} from '../src/utils/oosLog.js';
import type { FragilityResult, FragilityDay } from '../src/services/purpleFragility.js';

/** Minimal FragilityResult good enough for buildOosRow/appendOosLogRow. */
function makeResult(overrides: {
    score?: number | null; core3?: number | null; climax?: number | null;
    capitulation?: number | null; indexValue?: number; drawdownPct?: number;
    indexNearHigh?: boolean; crossedUp?: boolean; core3CrossedUp?: boolean;
    watchTrigger?: 'core3' | 'climax' | 'both' | null;
}): FragilityResult {
    const latest = {
        date: '2026-07-24',
        score: overrides.score ?? 1.2,
        core3: overrides.core3 ?? 0.5,
        climax: overrides.climax ?? 0.1,
        capitulation: overrides.capitulation ?? -0.3,
        indexValue: overrides.indexValue ?? 8.0,
        drawdownPct: overrides.drawdownPct ?? 0,
        indexNearHigh: overrides.indexNearHigh ?? true,
    } as FragilityDay;
    return {
        scanDate: '2026-07-24',
        series: [latest],
        latest,
        prevScore: null,
        crossedUp: overrides.crossedUp ?? false,
        prevCore3: null,
        core3CrossedUp: overrides.core3CrossedUp ?? false,
        watchTrigger: overrides.watchTrigger ?? null,
        canaryCount: 0,
        indexNearHigh: overrides.indexNearHigh ?? true,
        tickersUsed: [],
        tickersFailed: [],
    } as FragilityResult;
}

describe('buildOosRow', () => {
    it('marks alert held when score>=1.0 AND near-high', () => {
        const r = buildOosRow(makeResult({ score: 1.2, indexNearHigh: true }), '2026-07-24', 'stamp');
        expect(r.alert).toBe(1);
        expect(r.index_near_high).toBe(1);
    });

    it('does NOT mark alert when the basket is off its high, even if score>=1.0', () => {
        const r = buildOosRow(makeResult({ score: 1.5, indexNearHigh: false }), '2026-07-24', 'stamp');
        expect(r.alert).toBe(0);
    });

    it('carries the crossing flags and watch trigger straight from the result', () => {
        const r = buildOosRow(
            makeResult({ crossedUp: true, core3CrossedUp: true, watchTrigger: 'climax' }),
            '2026-07-24', 'stamp',
        );
        expect(r.alert_cross).toBe(1);
        expect(r.watch_cross).toBe(1);
        expect(r.watch_trigger).toBe('climax');
        expect(r.watch).toBe(1); // watchTrigger != null => held
    });
});

describe('CSV round-trip', () => {
    it('serializes and parses back to the same values', () => {
        const row = buildOosRow(makeResult({ score: 1.2345, drawdownPct: -3.21 }), '2026-07-24', 's');
        const parsed = parseOosCsv(oosRowsToCsv([row]));
        expect(parsed).toHaveLength(1);
        expect(parsed[0]!.scan_date).toBe('2026-07-24');
        expect(parsed[0]!.score).toBeCloseTo(1.2345, 4);
        expect(parsed[0]!.drawdown_pct).toBeCloseTo(-3.21, 2);
        expect(parsed[0]!.alert).toBe(1);
    });

    it('header lists every column and an empty log parses to []', () => {
        expect(oosRowsToCsv([]).split('\n')[0]).toBe(OOS_COLUMNS.join(','));
        expect(parseOosCsv('scan_date,score\n')).toEqual([]);
    });

    it('null score serializes to an empty cell', () => {
        const res = makeResult({});
        (res.latest as { score: number | null }).score = null; // makeResult's ?? would collapse an explicit null
        const row = buildOosRow(res, '2026-07-24', 's');
        expect(oosRowToCsv(row).split(',')[1]).toBe('');
    });
});

describe('upsertOosRow', () => {
    it('replaces a same-date row instead of duplicating', () => {
        const a = buildOosRow(makeResult({ score: 1.0 }), '2026-07-24', 's');
        const b = buildOosRow(makeResult({ score: 0.5 }), '2026-07-24', 's');
        const out = upsertOosRow([a], b);
        expect(out).toHaveLength(1);
        expect(out[0]!.score).toBe(0.5);
    });
});

describe('appendOosLogRow (IO)', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oos-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('creates the file and is idempotent by date (re-run replaces, never dupes)', () => {
        appendOosLogRow(makeResult({ score: 1.0 }), '2026-07-24', dir);
        appendOosLogRow(makeResult({ score: 0.7 }), '2026-07-24', dir); // same date, re-run
        appendOosLogRow(makeResult({ score: 0.2, indexNearHigh: false }), '2026-07-27', dir);
        const rows = parseOosCsv(fs.readFileSync(path.join(dir, 'oos_log.csv'), 'utf-8'));
        expect(rows).toHaveLength(2);
        expect(rows.find((r) => r.scan_date === '2026-07-24')!.score).toBeCloseTo(0.7, 4);
    });

    it('fails open: null result writes nothing and returns false', () => {
        expect(appendOosLogRow(null, '2026-07-24', dir)).toBe(false);
        expect(fs.existsSync(path.join(dir, 'oos_log.csv'))).toBe(false);
    });
});

describe('evaluateOosScorecard', () => {
    const day = (i: number): string => new Date(Date.UTC(2026, 6, 19 + i)).toISOString().slice(0, 10);
    const row = (i: number, o: Partial<OosRow> = {}): OosRow => ({
        scan_date: day(i), score: 0.5, core3: 0, climax: 0, capitulation: 0,
        index_value: 8, drawdown_pct: 0, index_near_high: 1,
        alert: 0, watch: 0, alert_cross: 0, watch_cross: 0, watch_trigger: '', logged_at: 's',
        ...o,
    });

    it('counts an alert crossing followed by a >=8% drawdown as a hit', () => {
        const rows: OosRow[] = [];
        rows.push(row(0, { alert_cross: 1 }));           // crossing on OOS day 0
        for (let i = 1; i <= 44; i++) rows.push(row(i, { drawdown_pct: i === 6 ? -11 : -1 }));
        const s = evaluateOosScorecard(rows);
        expect(s.alert.crossings).toBe(1);
        expect(s.alert.matured[15]!.matured).toBe(1);
        expect(s.alert.precision[15]).toBe(1); // -11% within 15 days
    });

    it('marks a late crossing as pending when there is not enough forward data', () => {
        const rows: OosRow[] = [];
        for (let i = 0; i < 43; i++) rows.push(row(i));
        rows.push(row(43, { alert_cross: 1 })); // only 1 forward row after this
        const s = evaluateOosScorecard(rows);
        expect(s.alert.crossings).toBe(1);
        expect(s.alert.pending).toBe(1);
        expect(s.alert.matured[15]!.matured).toBe(0);
        expect(s.alert.precision[15]).toBeNull();
    });

    it('ignores crossings dated before the OOS start', () => {
        const preStart = new Date(Date.UTC(2026, 6, 10)).toISOString().slice(0, 10);
        expect(preStart < OOS_START).toBe(true);
        const rows: OosRow[] = [
            row(0, { scan_date: preStart, alert_cross: 1 }),
            ...Array.from({ length: 30 }, (_, i) => row(i, { drawdown_pct: -20 })),
        ];
        const s = evaluateOosScorecard(rows);
        expect(s.alert.crossings).toBe(0); // the pre-OOS crossing is excluded
    });
});
