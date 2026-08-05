/**
 * Smart Volume Radar - Trading Date Utility
 * Returns the last US trading day (NYSE/NASDAQ) for scan consistency.
 * Phase 1: weekends only; no holiday calendar.
 */

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

    // Walk back off Saturday/Sunday. This is the step the old weekday/UTC mix could skip
    // entirely, letting a weekend date reach the scan.
    while (day.getUTCDay() === 0 || day.getUTCDay() === 6) {
        day.setUTCDate(day.getUTCDate() - 1);
    }

    return day.toISOString().slice(0, 10);
}
