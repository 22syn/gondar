// dashboard/tests/query.test.ts
import {
  buildSignalsQuery,
  buildSummaryQuery,
  buildRecentDatesQuery,
  buildHistoryRowsQuery,
  buildTickerLeanQuery,
  buildTickerSetupQuery,
  buildTickerRsQuery,
  buildTickerLatestPriceQuery,
  buildTickerMatchQuery,
  buildTickerListQuery,
  buildAllScanDatesQuery,
} from '../src/query.js';

describe('buildSignalsQuery', () => {
  it('defaults to latest day when no params', () => {
    const q = buildSignalsQuery({});
    expect(q.sql).toMatch(/scan_date = \(SELECT MAX\(scan_date\) FROM lean_signals\)/);
    expect(q.params).toEqual([]);
  });
  it('selects the signals + signal_count columns', () => {
    const q = buildSignalsQuery({});
    expect(q.sql).toMatch(/signals,signal_count/);
  });
  it('filters by date range', () => {
    const q = buildSignalsQuery({ from: '2026-06-01', to: '2026-06-29' });
    expect(q.sql).toMatch(/scan_date BETWEEN \? AND \?/);
    expect(q.params).toEqual(['2026-06-01', '2026-06-29']);
  });
});

describe('buildRecentDatesQuery', () => {
  it('selects distinct scan_dates on/before day, DESC, with limit', () => {
    const q = buildRecentDatesQuery('2026-06-03', 12);
    expect(q.sql).toBe(
      'SELECT DISTINCT scan_date FROM lean_signals WHERE scan_date <= ? ORDER BY scan_date DESC LIMIT ?',
    );
    expect(q.params).toEqual(['2026-06-03', 12]);
  });
  it('defaults limit to 12', () => {
    const q = buildRecentDatesQuery('2026-06-03');
    expect(q.params).toEqual(['2026-06-03', 12]);
  });
});

describe('buildHistoryRowsQuery', () => {
  it('emits one placeholder per date and passes dates as params', () => {
    const q = buildHistoryRowsQuery(['2026-06-03', '2026-06-02', '2026-06-01']);
    expect(q.sql).toBe(
      'SELECT scan_date,ticker,signal,signals,score FROM lean_signals WHERE scan_date IN (?,?,?)',
    );
    expect(q.params).toEqual(['2026-06-03', '2026-06-02', '2026-06-01']);
  });
  it('produces valid SQL and no params for an empty date list', () => {
    const q = buildHistoryRowsQuery([]);
    expect(q.sql).toMatch(/WHERE scan_date IN \(SELECT NULL WHERE 0\)/);
    expect(q.params).toEqual([]);
  });
});

describe('buildSummaryQuery', () => {
  it('groups counts by date', () => {
    const q = buildSummaryQuery({});
    expect(q.sql).toMatch(/GROUP BY scan_date/);
  });
});

describe('buildFragilityQuery', () => {
  // Imported lazily to keep the existing import block untouched.
  const { buildFragilityQuery } = require('../src/query.js');

  it('defaults to the NEWEST 250 rows, returned ascending for the chart', () => {
    const q = buildFragilityQuery({});
    expect(q.sql).toMatch(/FROM fragility_daily WHERE score IS NOT NULL/);
    // Inner query grabs the most recent rows (DESC LIMIT), outer re-sorts ASC
    // so the chart both stays current and still plots left-to-right.
    expect(q.sql).toMatch(/ORDER BY scan_date DESC LIMIT \?/);
    expect(q.sql).toMatch(/ORDER BY scan_date ASC$/);
    expect(q.params).toEqual([250]);
  });

  it('selects the score, core3, climax, capitulation score, six z components, index, drawdown and canary', () => {
    const q = buildFragilityQuery({});
    for (const col of ['score', 'core3', 'climax', 'capitulation', 'wick10_z', 'pct_above50_z', 'dist20_z', 'ext50_z', 'corr20_z', 'disp10_z', 'index_value', 'drawdown_pct', 'canary_count']) {
      expect(q.sql).toContain(col);
    }
  });

  it('applies from-date filter and custom limit', () => {
    const q = buildFragilityQuery({ from: '2026-01-01', limit: 60 });
    expect(q.sql).toMatch(/AND scan_date >= \?/);
    expect(q.params).toEqual(['2026-01-01', 60]);
  });
});

describe('ticker history queries', () => {
  it('selects one ticker across every date, newest first', () => {
    const q = buildTickerLeanQuery('NVDA');
    expect(q.sql).toMatch(/WHERE ticker = \? ORDER BY scan_date DESC$/);
    expect(q.sql).not.toMatch(/scan_date BETWEEN/);
    expect(q.params).toEqual(['NVDA']);
  });

  it('reads setup and RS rows for the same ticker', () => {
    expect(buildTickerSetupQuery('NVDA').sql).toMatch(/FROM setup_signals WHERE ticker = \?/);
    expect(buildTickerRsQuery('NVDA').sql).toMatch(/FROM rs_daily WHERE ticker = \?/);
    expect(buildTickerSetupQuery('NVDA').params).toEqual(['NVDA']);
  });

  describe('buildTickerLatestPriceQuery', () => {
    it('takes the newest PRICED rs_daily row, not just the newest row', () => {
      // rs_daily.price only started filling 2026-08-17, so a ticker's most
      // recent row is very often null-priced. Without the IS NOT NULL filter
      // the panel would compare against nothing and report a bogus 0%.
      const q = buildTickerLatestPriceQuery('NVDA');
      expect(q.sql).toContain('FROM rs_daily');
      expect(q.sql).toContain('price IS NOT NULL');
      expect(q.sql).toMatch(/ORDER BY scan_date DESC LIMIT 1/);
      expect(q.params).toEqual(['NVDA']);
    });

    it('binds the ticker rather than interpolating it', () => {
      const q = buildTickerLatestPriceQuery("X' OR 1=1--");
      expect(q.sql).not.toContain('OR 1=1');
      expect(q.params).toEqual(["X' OR 1=1--"]);
    });

    it('selects the two fields the comparison needs', () => {
      expect(buildTickerLatestPriceQuery('NVDA').sql).toContain('SELECT scan_date,price');
    });
  });

  it('prefix-matches tickers, most recently seen first', () => {
    const q = buildTickerMatchQuery('NVD', 8);
    expect(q.sql).toMatch(/ticker LIKE \?/);
    expect(q.sql).toMatch(/ORDER BY last_seen DESC, appearances DESC LIMIT \?/);
    expect(q.params).toEqual(['NVD%', 8]);
  });

  it('escapes LIKE wildcards so a typed % cannot match everything', () => {
    expect(buildTickerMatchQuery('A%').params[0]).toBe('A\\%%');
    expect(buildTickerMatchQuery('A_B').params[0]).toBe('A\\_B%');
    expect(buildTickerMatchQuery('A%').sql).toMatch(/ESCAPE/);
  });

  it('lists every distinct ticker with its appearance count and last-seen date', () => {
    const q = buildTickerListQuery();
    expect(q.sql).toMatch(/COUNT\(\*\) AS appearances/);
    expect(q.sql).toMatch(/MAX\(scan_date\) AS last_seen/);
    expect(q.sql).toMatch(/GROUP BY ticker/);
    expect(q.params).toEqual([]);
  });

  it('returns the full scan calendar, newest first', () => {
    const q = buildAllScanDatesQuery();
    expect(q.sql).toBe('SELECT DISTINCT scan_date FROM lean_signals ORDER BY scan_date DESC');
    expect(q.params).toEqual([]);
  });
});
