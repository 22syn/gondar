/**
 * Smart Volume Radar - Trading Date Utility
 * Returns the last US trading day (NYSE/NASDAQ) for scan consistency.
 * Handles weekends AND full-day market holidays.
 */

/**
 * NYSE/NASDAQ full-day closures that fall on a WEEKDAY, 2026-2028. Weekend
 * holidays are omitted because the weekend walk-back below already covers them;
 * where a fixed-date holiday falls on a Saturday the observed Friday closure IS
 * listed (2026-07-03 for July 4th, 2027-12-24 for Christmas).
 *
 * Hardcoded rather than computed: Good Friday needs an Easter algorithm, and
 * NYSE's observance rules have an exception (a Saturday New Year's Day does NOT
 * close the preceding Friday) that is easier to get right in a table someone can
 * eyeball than in code. Half-day early closes are deliberately absent — the
 * market IS open, so the day is a trading day.
 *
 * EXTEND THIS BEFORE 2029. Past the last entry the behaviour silently degrades to
 * weekends-only, which is what this replaced.
 */
const MARKET_HOLIDAYS = new Set([
    // 2026
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
    '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
    // 2027
    '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
    '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
    // 2028
    '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19',
    '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25',
]);

/** Is this YYYY-MM-DD a day the US market actually traded? */
export function isTradingDay(ymd: string): boolean {
    const day = new Date(`${ymd}T00:00:00Z`).getUTCDay();
    return day !== 0 && day !== 6 && !MARKET_HOLIDAYS.has(ymd);
}

/**
 * Get the last US trading day as YYYY-MM-DD.
 * - Weekday at/after 16:00 ET → today
 * - Weekday before 16:00 ET → the previous trading day
 * - Weekend → the preceding Friday
 *
 * @param now Instant to resolve from. Defaults to the current time; injectable for tests.
 */
export function getLastTradingDay(now: Date = new Date()): string {
    const nyParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: 'numeric',
        hour12: false,
    }).formatToParts(now);

    const get = (type: string): string => nyParts.find((p) => p.type === type)?.value ?? '';
    // `hour12: false` can render midnight as "24" depending on ICU version; fold it to 0 so
    // midnight isn't mistaken for after-close.
    const hour = (parseInt(get('hour'), 10) || 0) % 24;

    // Anchor a UTC-midnight Date on the NEW YORK calendar date. Everything below is then
    // pure calendar arithmetic on that anchor. The previous implementation mixed a NY-derived
    // weekday with UTC date arithmetic, and the two disagree for ~4-5 hours every evening —
    // which is how Sunday 20:00 ET returned Monday, and Monday morning returned Sunday.
    const day = new Date(Date.UTC(
        Number(get('year')),
        Number(get('month')) - 1,
        Number(get('day')),
    ));

    // Before 16:00 ET the session hasn't closed, so today isn't a completed trading day yet.
    if (hour < 16) {
        day.setUTCDate(day.getUTCDate() - 1);
    }

    // Walk back off Saturday/Sunday AND market holidays. The weekend half is the step the
    // old weekday/UTC mix could skip entirely, letting a weekend date reach the scan.
    //
    // Holidays were "Phase 1: weekends only" until 2026-08-16. The gap was not theoretical:
    // Labor Day is Monday 2026-09-07, the scan is scheduled Mon-Fri, and the frozen OOS log
    // takes one immutable row per returned date — so that Monday would have recorded a day
    // the market never opened. Walking back means the holiday's scan re-reports the previous
    // session instead, and appendOosLogRow upserts, so the row is a no-op rather than junk.
    //
    // Loop, not an if: Christmas 2026 is Friday 12-25, so 12-26/27 is a weekend and the walk
    // has to cross both kinds in one pass.
    while (day.getUTCDay() === 0 || day.getUTCDay() === 6
        || MARKET_HOLIDAYS.has(day.toISOString().slice(0, 10))) {
        day.setUTCDate(day.getUTCDate() - 1);
    }

    return day.toISOString().slice(0, 10);
}
