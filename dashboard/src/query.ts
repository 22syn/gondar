// dashboard/src/query.ts
export interface Query { sql: string; params: unknown[]; }
export interface SignalParams { from?: string; to?: string; }

const SELECT = 'SELECT scan_date,ticker,region,sector,signal,signals,signal_count,rvol,ath_pct,day_pct,stage2,dist_pivot,score,price,ingested_at,rs FROM lean_signals';

export function buildSignalsQuery(p: SignalParams): Query {
  if (p.from && p.to) {
    return { sql: `${SELECT} WHERE scan_date BETWEEN ? AND ? ORDER BY scan_date DESC, score DESC`, params: [p.from, p.to] };
  }
  return { sql: `${SELECT} WHERE scan_date = (SELECT MAX(scan_date) FROM lean_signals) ORDER BY score DESC`, params: [] };
}

/* ─── Ticker history (cross-day lookup) ───────────────────────────────────────
 *
 * Everything above answers "what fired on day X". These answer "what happened
 * to ticker T across every day we ever scanned" — the lookup the dashboard's
 * search box could not do, because it only ever filtered the loaded day.
 *
 * All three tables are queried by ticker alone: one row per date the ticker
 * cleared the filter. A ticker with zero rows was never surfaced by a scan —
 * which is NOT the same as "it never moved". See buildTickerMatchQuery.
 */

/** Every lean row for one ticker, newest first. */
export function buildTickerLeanQuery(ticker: string): Query {
  return { sql: `${SELECT} WHERE ticker = ? ORDER BY scan_date DESC`, params: [ticker] };
}

/** Every setup row for one ticker (merged into the lean rows by mergeSetupRows). */
export function buildTickerSetupQuery(ticker: string): Query {
  return {
    sql: 'SELECT scan_date,ticker,region,sector,sig,rvol,ath_pct,day_pct,stage2,score,price,rs,ingested_at '
      + 'FROM setup_signals WHERE ticker = ? ORDER BY scan_date DESC',
    params: [ticker],
  };
}

/** Every RS reading for one ticker — present for scanned days with no signal row. */
export function buildTickerRsQuery(ticker: string): Query {
  return {
    sql: 'SELECT scan_date,ticker,rs FROM rs_daily WHERE ticker = ? ORDER BY scan_date DESC',
    params: [ticker],
  };
}

/**
 * Case-insensitive prefix match over every ticker ever scanned, so a partial
 * or wrongly-cased query ("nvd") still resolves. Ordered by how recently the
 * ticker was seen: a name that fired yesterday outranks one last seen in May.
 */
export function buildTickerMatchQuery(prefix: string, limit = 8): Query {
  return {
    sql: 'SELECT ticker, COUNT(*) AS appearances, MAX(scan_date) AS last_seen '
      + 'FROM lean_signals WHERE ticker LIKE ? ESCAPE \'\\\' '
      + 'GROUP BY ticker ORDER BY last_seen DESC, appearances DESC LIMIT ?',
    params: [`${escapeLike(prefix)}%`, limit],
  };
}

/** Distinct tickers with a signal row, for the search box's autocomplete. */
export function buildTickerListQuery(): Query {
  return {
    sql: 'SELECT ticker, COUNT(*) AS appearances, MAX(scan_date) AS last_seen '
      + 'FROM lean_signals GROUP BY ticker ORDER BY ticker',
    params: [],
  };
}

/** All DISTINCT scan_dates, most recent first — the calendar a history is read against. */
export function buildAllScanDatesQuery(): Query {
  return { sql: 'SELECT DISTINCT scan_date FROM lean_signals ORDER BY scan_date DESC', params: [] };
}

/** Neutralise LIKE wildcards in user input so "A%" cannot match everything. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Recent DISTINCT scan_dates on/before `day`, most recent first. */
export function buildRecentDatesQuery(day: string, limit = 12): Query {
  return {
    sql: 'SELECT DISTINCT scan_date FROM lean_signals WHERE scan_date <= ? ORDER BY scan_date DESC LIMIT ?',
    params: [day, limit],
  };
}

/** History rows (for enrichment) across the given dates. One placeholder per date. */
export function buildHistoryRowsQuery(dates: string[]): Query {
  if (dates.length === 0) {
    return {
      sql: 'SELECT scan_date,ticker,signal,signals,score FROM lean_signals WHERE scan_date IN (SELECT NULL WHERE 0)',
      params: [],
    };
  }
  const placeholders = dates.map(() => '?').join(',');
  return {
    sql: `SELECT scan_date,ticker,signal,signals,score FROM lean_signals WHERE scan_date IN (${placeholders})`,
    params: [...dates],
  };
}

/**
 * Setup rows written daily by the Smart pipeline into its OWN table
 * (setup_signals) — merged into lean rows at read time by mergeSetup.ts.
 * The table may not exist until the first Smart ingest runs: callers must
 * treat a query error as "no rows".
 */
export function buildSetupRowsQuery(p: SignalParams): Query {
  const SEL = 'SELECT scan_date,ticker,region,sector,sig,rvol,ath_pct,day_pct,stage2,score,price,rs,ingested_at FROM setup_signals';
  if (p.from && p.to) {
    return { sql: `${SEL} WHERE scan_date BETWEEN ? AND ?`, params: [p.from, p.to] };
  }
  return { sql: `${SEL} WHERE scan_date = (SELECT MAX(scan_date) FROM lean_signals)`, params: [] };
}

/** RS percentiles for all scanned tickers (rs_daily) — fills rs on lean rows. */
export function buildRsDailyQuery(p: SignalParams): Query {
  const SEL = 'SELECT scan_date,ticker,rs FROM rs_daily';
  if (p.from && p.to) {
    return { sql: `${SEL} WHERE scan_date BETWEEN ? AND ?`, params: [p.from, p.to] };
  }
  return { sql: `${SEL} WHERE scan_date = (SELECT MAX(scan_date) FROM lean_signals)`, params: [] };
}

/** Per-date setup counts for the summary merge. setup_new = setup rows with
 *  no lean row that day (added to the day's total).
 *
 *  Deliberately carries NO rs count: RS lives in rs_daily for every scanned
 *  ticker, not just the handful with a setup row, so counting it here would
 *  under-report by an order of magnitude. See buildRsSummaryQuery. */
export function buildSetupSummaryQuery(): Query {
  return {
    sql: `SELECT scan_date,
      SUM(sig='setupFull') AS setup_full,
      SUM(sig!='setupFull') AS setup_other,
      SUM(NOT EXISTS (SELECT 1 FROM lean_signals ls
                      WHERE ls.scan_date=setup_signals.scan_date
                        AND ls.ticker=setup_signals.ticker)) AS setup_new
      FROM setup_signals GROUP BY scan_date`,
    params: [],
  };
}

/**
 * Authoritative per-date RS threshold counts.
 *
 * RS stopped being written into lean_signals on 2026-07-08 and now lives in
 * rs_daily, filled in at read time by mergeSetup. The summary endpoint never
 * followed, so `SUM(rs>=90) FROM lean_signals` returned 0 for every day after
 * that date while the table below it showed the real values.
 *
 * Counts over exactly the row set the signals endpoint returns: every lean row
 * for the day, plus setup rows that have no lean row, with RS resolved in the
 * same precedence mergeSetupRows uses (own column first, then rs_daily).
 */
export function buildRsSummaryQuery(): Query {
  return {
    sql: `SELECT scan_date,
      SUM(rs>=80) AS rs80,
      SUM(rs>=90) AS rs90
      FROM (
        SELECT l.scan_date AS scan_date, COALESCE(l.rs, r.rs) AS rs
          FROM lean_signals l
          LEFT JOIN rs_daily r
            ON r.scan_date = l.scan_date AND r.ticker = l.ticker
        UNION ALL
        SELECT s.scan_date, COALESCE(s.rs, r2.rs)
          FROM setup_signals s
          LEFT JOIN rs_daily r2
            ON r2.scan_date = s.scan_date AND r2.ticker = s.ticker
         WHERE NOT EXISTS (SELECT 1 FROM lean_signals ls
                           WHERE ls.scan_date = s.scan_date
                             AND ls.ticker = s.ticker)
      ) GROUP BY scan_date`,
    params: [],
  };
}

export function buildSummaryQuery(_p: SignalParams): Query {
  return {
    sql: `SELECT scan_date,
      COUNT(*) AS total,
      SUM(signals LIKE '%setupFull%') AS setup_full,
      SUM(signals LIKE '%setupClose%' OR signals LIKE '%setupRecovery%') AS setup_other,
      SUM(signal='breakout') AS breakout,
      SUM(signal='highVolume') AS high_volume,
      SUM(signal='pullback') AS pullback,
      SUM(signal='creep') AS creep,
      SUM(signal LIKE 'near%') AS near_all,
      SUM(score>=70) AS score70,
      SUM(score>=65) AS score65,
      -- Fallback only: lean_signals.rs is NULL after 2026-07-08. Overwritten by
      -- buildRsSummaryQuery whenever rs_daily is present.
      SUM(rs>=80) AS rs80,
      SUM(rs>=90) AS rs90,
      MAX(ingested_at) AS last_run
      FROM lean_signals GROUP BY scan_date ORDER BY scan_date DESC`,
    params: [],
  };
}

/**
 * Fragility time series written daily by the Smart pipeline into its OWN
 * table (fragility_daily) — a per-day scalar series, not per-ticker rows, so
 * it never goes through mergeSetup. The table may not exist until the first
 * Smart ingest runs: callers must treat a query error as "no rows".
 */
export interface FragilityParams { from?: string; limit?: number; }

export function buildFragilityQuery(p: FragilityParams = {}): Query {
  const SEL =
    'SELECT scan_date,score,core3,climax,capitulation,wick10_z,pct_above50_z,dist20_z,ext50_z,corr20_z,disp10_z,' +
    'index_value,drawdown_pct,canary_count FROM fragility_daily WHERE score IS NOT NULL';
  const limit = p.limit ?? 250;
  if (p.from) {
    return {
      sql: `${SEL} AND scan_date >= ? ORDER BY scan_date ASC LIMIT ?`,
      params: [p.from, limit],
    };
  }
  // Newest `limit` rows, returned oldest→newest so the chart still plots
  // left-to-right. The inner query takes the most RECENT rows (DESC LIMIT);
  // the outer query re-sorts ascending. A plain `ORDER BY scan_date ASC LIMIT`
  // pinned the chart to the OLDEST rows and it stopped advancing as the table
  // grew — the ingest appends one row per trading day but never prunes, so the
  // window kept sliding further into the past every day.
  return {
    sql: `SELECT * FROM (${SEL} ORDER BY scan_date DESC LIMIT ?) ORDER BY scan_date ASC`,
    params: [limit],
  };
}
