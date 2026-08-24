import { computeUniverseBreadth, MIN_UNIVERSE_TICKERS } from '../src/utils/universeBreadth.js';

const mk = (n: number, aboveFrac: number) =>
  Array.from({ length: n }, (_, i) => ({ sma50: 100, lastPrice: i < n * aboveFrac ? 110 : 90 }));

describe('computeUniverseBreadth', () => {
  it('is the share of tickers closing above their own SMA50', () => {
    const r = computeUniverseBreadth(mk(400, 0.25));
    expect(r.n).toBe(400);
    expect(r.value).toBeCloseTo(25, 6);
  });

  it('ignores tickers with no sma50 or no price, and counts only the rest', () => {
    const base = mk(300, 0.5);
    const r = computeUniverseBreadth([...base, { sma50: undefined, lastPrice: 10 }, { sma50: 100 }]);
    expect(r.n).toBe(300);
    expect(r.value).toBeCloseTo(50, 6);
  });

  it('reports null rather than a thin reading below the minimum', () => {
    const r = computeUniverseBreadth(mk(MIN_UNIVERSE_TICKERS - 1, 0.5));
    expect(r.value).toBeNull();
    expect(r.n).toBe(MIN_UNIVERSE_TICKERS - 1);
  });

  it('treats a non-positive sma50 as unusable', () => {
    const r = computeUniverseBreadth([...mk(250, 1), ...Array.from({ length: 60 }, () => ({ sma50: 0, lastPrice: 5 }))]);
    expect(r.n).toBe(250);
    expect(r.value).toBe(100);
  });

  it('returns null on an empty universe', () => {
    expect(computeUniverseBreadth([]).value).toBeNull();
  });
});
