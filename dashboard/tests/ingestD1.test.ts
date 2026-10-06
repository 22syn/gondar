// dashboard/tests/ingestD1.test.ts
import { buildUpsertBatches, buildDeleteBatches } from '../src/ingestD1.js';

const STAMP = '2026-07-07T23:45:00.000Z';

const row = {
  scanDate: '2026-06-29', ticker: 'ARM', region: 'US', sector: 'Semis',
  signal: 'pullback', signals: ['pullback', 'highVolume'], signalCount: 2,
  rvol: 3.6, athPct: -22, dayPct: 2.8, stage2: 1,
  distPivot: null, score: 90, price: 343, wr14: -18.5, avwapAthPct: 11.1,
};
const PARAMS_PER_ROW = 17;

describe('buildUpsertBatches', () => {
  it('produces INSERT OR REPLACE with 17 params per row (incl. wr14, avwap_ath_pct + ingested_at)', () => {
    const batches = buildUpsertBatches([row as never], STAMP, 100);
    expect(batches).toHaveLength(1);
    expect(batches[0].sql).toMatch(/INSERT OR REPLACE INTO lean_signals/);
    expect(batches[0].sql).toMatch(/signals,signal_count/);
    expect(batches[0].sql).toMatch(/ingested_at/);
    expect(batches[0].sql).toMatch(/wr14,avwap_ath_pct,ingested_at/);
    expect(batches[0].params).toHaveLength(PARAMS_PER_ROW);
    expect(batches[0].params[1]).toBe('ARM');
    // signals is stored as a comma-joined string; signal_count follows it
    expect(batches[0].params[5]).toBe('pullback,highVolume');
    expect(batches[0].params[6]).toBe(2);
    // wr14, then avwap_ath_pct, sit between price and the ingested_at stamp
    expect(batches[0].params[14]).toBe(-18.5);
    expect(batches[0].params[15]).toBe(11.1);
    // ingested_at is the last param of the row
    expect(batches[0].params[16]).toBe(STAMP);
  });
  it('splits into multiple batches by size', () => {
    const rows = Array.from({ length: 250 }, () => row);
    const batches = buildUpsertBatches(rows as never, STAMP, 100);
    expect(batches).toHaveLength(3); // 100 + 100 + 50
    expect(batches[2].params).toHaveLength(50 * PARAMS_PER_ROW);
  });
  it('writes wr14 as null when the row has none (reconstructed rows)', () => {
    const { wr14: _omitted, ...noWr } = row;
    const batches = buildUpsertBatches([noWr as never], STAMP, 100);
    expect(batches[0].params[14]).toBeNull();
  });
  it('writes avwap_ath_pct as null when the row has none (reconstructed rows, no volume series)', () => {
    const { avwapAthPct: _omitted, ...noAvwap } = row;
    const batches = buildUpsertBatches([noAvwap as never], STAMP, 100);
    expect(batches[0].params[15]).toBeNull();
    expect(batches[0].params[16]).toBe(STAMP);
  });
  it('default batch size stays under the 100-bound-param D1 cap', () => {
    const rows = Array.from({ length: 12 }, () => row);
    const batches = buildUpsertBatches(rows as never, STAMP);
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(b.params.length).toBeLessThanOrEqual(100);
  });
  it('one more row per batch would break the cap (why the default is 5, not 6)', () => {
    expect(6 * PARAMS_PER_ROW).toBeGreaterThan(100);
  });
});

describe('buildDeleteBatches', () => {
  it('emits one DELETE per distinct scan_date, sorted', () => {
    const rows = [
      { ...row, scanDate: '2026-06-30' },
      { ...row, scanDate: '2026-06-29' },
      { ...row, scanDate: '2026-06-30', ticker: 'NVDA' },
    ];
    const batches = buildDeleteBatches(rows as never);
    expect(batches).toHaveLength(2);
    expect(batches[0].sql).toBe('DELETE FROM lean_signals WHERE scan_date = ?');
    expect(batches[0].params).toEqual(['2026-06-29']);
    expect(batches[1].params).toEqual(['2026-06-30']);
  });
  it('returns no batches for empty input', () => {
    expect(buildDeleteBatches([])).toHaveLength(0);
  });
});
