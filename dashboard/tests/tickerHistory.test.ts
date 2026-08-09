// dashboard/tests/tickerHistory.test.ts
import { buildTickerHistory, normalizeTicker, type TickerRow } from '../src/tickerHistory.js';

/** Scan calendar, newest first — five consecutive trading days. */
const DATES = ['2026-08-07', '2026-08-06', '2026-08-05', '2026-08-04', '2026-08-03'];

function row(scan_date: string, over: Partial<TickerRow> = {}): TickerRow {
  return {
    scan_date,
    ticker: 'NVDA',
    signal: 'pullback',
    signals: 'pullback',
    signal_count: 1,
    score: 60,
    rvol: 2,
    day_pct: 1,
    rs: 88,
    ...over,
  };
}

describe('buildTickerHistory', () => {
  it('reports the last appearance and how many scan days ago it was', () => {
    const h = buildTickerHistory('NVDA', [row('2026-08-05'), row('2026-08-03')], DATES);
    expect(h.last_seen).toBe('2026-08-05');
    expect(h.first_seen).toBe('2026-08-03');
    expect(h.scan_days_since).toBe(2); // 08-07 and 08-06 have passed since
    expect(h.total).toBe(2);
  });

  it('scores today\'s appearance as zero scan days since', () => {
    const h = buildTickerHistory('NVDA', [row('2026-08-07')], DATES);
    expect(h.scan_days_since).toBe(0);
  });

  it('counts streaks over the scan calendar, not over adjacent rows', () => {
    // 08-06 + 08-05 are consecutive; 08-03 is isolated.
    const h = buildTickerHistory('NVDA', [row('2026-08-06'), row('2026-08-05'), row('2026-08-03')], DATES);
    expect(h.longest_streak).toBe(2);
    expect(h.latest_streak).toBe(2);
  });

  it('reports a one-day latest streak when the run is a single day', () => {
    const h = buildTickerHistory('NVDA', [row('2026-08-07'), row('2026-08-05'), row('2026-08-04')], DATES);
    expect(h.latest_streak).toBe(1);
    expect(h.longest_streak).toBe(2);
  });

  it('picks the peak RVOL, day move and score days', () => {
    const h = buildTickerHistory('NVDA', [
      row('2026-08-07', { rvol: 2.1, day_pct: 1.0, score: 55 }),
      row('2026-08-05', { rvol: 6.4, day_pct: 3.0, score: 51 }),
      row('2026-08-03', { rvol: 1.2, day_pct: 9.5, score: 81 }),
    ], DATES);
    expect(h.peak_rvol?.scan_date).toBe('2026-08-05');
    expect(h.peak_day?.scan_date).toBe('2026-08-03');
    expect(h.peak_score?.scan_date).toBe('2026-08-03');
  });

  it('ignores null metrics when picking peaks', () => {
    const h = buildTickerHistory('NVDA', [
      row('2026-08-07', { rvol: null }),
      row('2026-08-05', { rvol: 3 }),
    ], DATES);
    expect(h.peak_rvol?.scan_date).toBe('2026-08-05');
  });

  it('counts every signal in a merged row, not just the primary', () => {
    const h = buildTickerHistory('NVDA', [
      row('2026-08-07', { signal: 'pullback', signals: 'pullback,setupFull' }),
      row('2026-08-05', { signal: 'pullback', signals: 'pullback' }),
    ], DATES);
    expect(h.by_signal).toEqual({ pullback: 2, setupFull: 1 });
  });

  it('returns an empty history with the DB coverage window intact', () => {
    const h = buildTickerHistory('ZZZZ', [], DATES);
    expect(h.total).toBe(0);
    expect(h.last_seen).toBeNull();
    expect(h.scan_days_since).toBeNull();
    expect(h.longest_streak).toBe(0);
    expect(h.scanned_days).toBe(5);
    expect(h.history_from).toBe('2026-08-03');
    expect(h.history_to).toBe('2026-08-07');
  });

  it('folds a setup-only day into the calendar instead of dropping it', () => {
    // 2026-08-08 has a setup row but no lean row, so it is missing from DATES.
    const h = buildTickerHistory('NVDA', [row('2026-08-08'), row('2026-08-07')], DATES);
    expect(h.last_seen).toBe('2026-08-08');
    expect(h.scan_days_since).toBe(0);
    expect(h.latest_streak).toBe(2);
    expect(h.scanned_days).toBe(6);
  });

  it('sorts appearances newest first regardless of input order', () => {
    const h = buildTickerHistory('NVDA', [row('2026-08-03'), row('2026-08-07'), row('2026-08-05')], DATES);
    expect(h.appearances.map((r) => r.scan_date)).toEqual(['2026-08-07', '2026-08-05', '2026-08-03']);
  });
});

describe('normalizeTicker', () => {
  it('uppercases and trims', () => {
    expect(normalizeTicker('  nvda ')).toBe('NVDA');
  });
  it('keeps suffixed and index symbols', () => {
    expect(normalizeTicker('nice.ta')).toBe('NICE.TA');
    expect(normalizeTicker('^gspc')).toBe('^GSPC');
    expect(normalizeTicker('brk-b')).toBe('BRK-B');
  });
  it('rejects empty, over-long and non-ticker input', () => {
    expect(normalizeTicker('')).toBeNull();
    expect(normalizeTicker('   ')).toBeNull();
    expect(normalizeTicker('A'.repeat(13))).toBeNull();
    expect(normalizeTicker('drop table')).toBeNull();
    expect(normalizeTicker("NVDA'--")).toBeNull();
    expect(normalizeTicker('NV%DA')).toBeNull();
  });
});
