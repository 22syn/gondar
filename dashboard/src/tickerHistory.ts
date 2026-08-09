// dashboard/src/tickerHistory.ts
//
// Cross-day history for a single ticker: every scan day it appeared on, plus
// the derived answers the dashboard used to make you page through the calendar
// one day at a time — when it last fired, which day it moved hardest, how many
// days in a row it held.
//
// Pure: takes already-merged rows + the scan-date calendar, returns a summary.
// The merge with setup_signals/rs_daily happens in the API, via mergeSetupRows.

import type { LeanRowLike } from './mergeSetup.js';

/** A lean/setup row as served to the panel. Extends the shape mergeSetupRows
 *  operates on, so a ticker's rows can go straight through that merge. */
export interface TickerRow extends LeanRowLike {
  rvol?: number | null;
  ath_pct?: number | null;
  day_pct?: number | null;
  stage2?: number | null;
  price?: number | null;
}

export interface TickerHistory {
  ticker: string;
  /** Every appearance, newest first. */
  appearances: TickerRow[];
  total: number;
  first_seen: string | null;
  last_seen: string | null;
  /**
   * Scan days between the last appearance and the newest scan in the DB.
   * 0 = it is in today's scan. Counted in SCAN days, not calendar days, so
   * weekends and skipped runs never inflate it.
   */
  scan_days_since: number | null;
  /** Longest run of consecutive scan days the ticker appeared on. */
  longest_streak: number;
  /** Length of the run that ends at last_seen (1 for an isolated day). */
  latest_streak: number;
  /** Appearance with the highest RVOL — "the day it jumped". */
  peak_rvol: TickerRow | null;
  /** Appearance with the biggest single-day move. */
  peak_day: TickerRow | null;
  /** Appearance with the highest score. */
  peak_score: TickerRow | null;
  /** Count per signal kind across all appearances, e.g. {pullback: 4}. */
  by_signal: Record<string, number>;
  /** Coverage of the DB itself, so "never appeared" can be stated honestly. */
  scanned_days: number;
  history_from: string | null;
  history_to: string | null;
}

/** Larger of two rows on `key`, ignoring null/undefined. */
function maxBy(a: TickerRow | null, b: TickerRow, key: keyof TickerRow): TickerRow | null {
  const bv = b[key];
  if (typeof bv !== 'number' || Number.isNaN(bv)) return a;
  const av = a ? a[key] : undefined;
  if (typeof av !== 'number' || Number.isNaN(av)) return b;
  return bv > av ? b : a;
}

/**
 * Build the history summary for one ticker.
 * @param ticker      the ticker as stored in D1 (e.g. 'NVDA', 'NICE.TA')
 * @param rows        that ticker's rows, any order (setup/RS already merged in)
 * @param datesDesc   every DISTINCT scan_date in the DB, most recent first
 */
export function buildTickerHistory(
  ticker: string,
  rows: TickerRow[],
  datesDesc: string[],
): TickerHistory {
  const appearances = [...rows].sort((a, b) => b.scan_date.localeCompare(a.scan_date));

  const seen = new Set(appearances.map((r) => r.scan_date));
  // The calendar comes from lean_signals, but a setup-only day has no lean row.
  // Union them in, or that day would score as "not a scan day" and break both
  // the streak walk and scan_days_since.
  const calendar = [...seen].some((d) => !datesDesc.includes(d))
    ? [...new Set([...datesDesc, ...seen])].sort((a, b) => b.localeCompare(a))
    : datesDesc;

  const last_seen = appearances.length ? appearances[0].scan_date : null;
  const first_seen = appearances.length ? appearances[appearances.length - 1].scan_date : null;

  // Streaks walk the scan calendar, not the rows: two appearances a week apart
  // are not a streak even though their rows are adjacent in the array.
  let longest_streak = 0;
  let run = 0;
  for (const d of calendar) {
    if (seen.has(d)) {
      run++;
      if (run > longest_streak) longest_streak = run;
    } else {
      run = 0;
    }
  }

  // The run that ends at last_seen: walk from it toward older dates.
  let latest_streak = 0;
  if (last_seen) {
    for (let i = calendar.indexOf(last_seen); i >= 0 && i < calendar.length; i++) {
      if (!seen.has(calendar[i])) break;
      latest_streak++;
    }
  }

  const idx = last_seen ? calendar.indexOf(last_seen) : -1;
  const scan_days_since = idx >= 0 ? idx : null;

  let peak_rvol: TickerRow | null = null;
  let peak_day: TickerRow | null = null;
  let peak_score: TickerRow | null = null;
  const by_signal: Record<string, number> = {};

  for (const r of appearances) {
    peak_rvol = maxBy(peak_rvol, r, 'rvol');
    peak_day = maxBy(peak_day, r, 'day_pct');
    peak_score = maxBy(peak_score, r, 'score');
    for (const s of (r.signals || r.signal || '').split(',')) {
      const key = s.trim();
      if (key) by_signal[key] = (by_signal[key] ?? 0) + 1;
    }
  }

  return {
    ticker,
    appearances,
    total: appearances.length,
    first_seen,
    last_seen,
    scan_days_since,
    longest_streak,
    latest_streak,
    peak_rvol,
    peak_day,
    peak_score,
    by_signal,
    scanned_days: calendar.length,
    history_from: calendar.length ? calendar[calendar.length - 1] : null,
    history_to: calendar.length ? calendar[0] : null,
  };
}

/**
 * Normalise a user-typed ticker for lookup, and reject anything that is not
 * plausibly one. D1 params are bound, so this is about not round-tripping
 * junk (or a pasted sentence) into a LIKE scan.
 */
export function normalizeTicker(raw: string): string | null {
  const t = raw.trim().toUpperCase();
  if (!t || t.length > 12) return null;
  return /^[A-Z0-9.\-^]+$/.test(t) ? t : null;
}
