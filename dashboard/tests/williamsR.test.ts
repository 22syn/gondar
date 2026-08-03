// dashboard/tests/williamsR.test.ts
import { calculateWilliamsR, rollingWilliamsRByDate } from '../src/williamsR.js';

describe('calculateWilliamsR', () => {
  it('returns undefined when not enough data', () => {
    expect(calculateWilliamsR([1, 2], [1, 2], [1, 2], 14)).toBeUndefined();
  });

  it('returns 0 when close equals the period high', () => {
    const highs = Array.from({ length: 14 }, (_, i) => 100 + i);
    const lows = Array.from({ length: 14 }, () => 90);
    const closes = Array.from({ length: 14 }, (_, i) => 100 + i);
    expect(calculateWilliamsR(highs, lows, closes, 14)).toBe(0);
  });

  it('returns -100 when close equals the period low', () => {
    const highs = Array.from({ length: 14 }, () => 110);
    const lows = Array.from({ length: 14 }, (_, i) => 90 - i);
    const closes = [...lows];
    expect(calculateWilliamsR(highs, lows, closes, 14)).toBe(-100);
  });

  it('returns -50 when close is midway through the range', () => {
    const highs = Array.from({ length: 14 }, () => 100);
    const lows = Array.from({ length: 14 }, () => 80);
    const closes = Array.from({ length: 13 }, () => 80).concat(90);
    expect(calculateWilliamsR(highs, lows, closes, 14)).toBe(-50);
  });

  it('returns undefined when the period range is flat', () => {
    const flat = Array.from({ length: 14 }, () => 50);
    expect(calculateWilliamsR(flat, flat, flat, 14)).toBeUndefined();
  });
});

describe('rollingWilliamsRByDate', () => {
  it('keys results by date, skipping the burn-in window', () => {
    const dates = Array.from({ length: 16 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`);
    const closes = dates.map((_, i) => 100 + i);
    const highs = closes;
    const lows = closes.map((c) => c - 5);
    const map = rollingWilliamsRByDate(dates, highs, lows, closes, 14);
    expect(map.size).toBe(3); // indices 13, 14, 15 — first 13 (0..12) are burn-in
    expect(map.has(dates[12]!)).toBe(false);
    expect(map.has(dates[13]!)).toBe(true);
    expect(map.get(dates[13]!)).toBe(0); // still-rising series: close == period high
  });

  it('returns an empty map when the series is shorter than the period', () => {
    const dates = ['2026-01-01', '2026-01-02'];
    const map = rollingWilliamsRByDate(dates, [1, 2], [1, 2], [1, 2], 14);
    expect(map.size).toBe(0);
  });
});
