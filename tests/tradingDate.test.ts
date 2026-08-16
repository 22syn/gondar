/**
 * Tests for getLastTradingDay().
 *
 * Every scan resolves its date through this function, so if it returns a non-trading day
 * the whole run queries market data for a day that has no session. Two production issues
 * documented in .github/workflows (the DST offset and the TASE late-settlement correction)
 * both trace back to trading-day resolution, and this module had no tests.
 *
 * Instants are given as explicit UTC so the suite is independent of the machine's timezone.
 * August is EDT (UTC-4); January is EST (UTC-5).
 */
import { getLastTradingDay, isTradingDay } from '../src/utils/tradingDate.js';

/** 2026-08-07 Fri · 08-08 Sat · 08-09 Sun · 08-10 Mon · 08-11 Tue */
const at = (iso: string): Date => new Date(iso);

describe('getLastTradingDay', () => {
    describe('weekday after the close (>= 16:00 ET)', () => {
        it('returns today once the session has settled', () => {
            // Mon 20:00 EDT = Tue 00:00 UTC — the UTC date has already rolled over,
            // so returning the UTC day here would report Tuesday.
            expect(getLastTradingDay(at('2026-08-11T00:00:00Z'))).toBe('2026-08-10');
        });

        it('returns Friday itself on Friday evening', () => {
            expect(getLastTradingDay(at('2026-08-08T00:00:00Z'))).toBe('2026-08-07');
        });

        it('handles the 16:00 ET boundary exactly', () => {
            // 15:59 ET → not closed yet; 16:00 ET → closed.
            expect(getLastTradingDay(at('2026-08-11T19:59:00Z'))).toBe('2026-08-10'); // Tue 15:59 ET
            expect(getLastTradingDay(at('2026-08-11T20:00:00Z'))).toBe('2026-08-11'); // Tue 16:00 ET
        });
    });

    describe('weekday before the close (< 16:00 ET)', () => {
        it('returns the previous weekday mid-session', () => {
            expect(getLastTradingDay(at('2026-08-11T13:00:00Z'))).toBe('2026-08-10'); // Tue 09:00 ET
        });

        it('skips back over the weekend on Monday morning', () => {
            // Mon 09:00 EDT. Stepping back one calendar day lands on Sunday, which is not a
            // trading day — the answer must be the preceding Friday.
            expect(getLastTradingDay(at('2026-08-10T13:00:00Z'))).toBe('2026-08-07');
        });

        it('skips back over the weekend in the early hours of Monday', () => {
            expect(getLastTradingDay(at('2026-08-10T05:00:00Z'))).toBe('2026-08-07'); // Mon 01:00 ET
        });
    });

    describe('weekends', () => {
        it('returns Friday on Saturday, morning or evening', () => {
            expect(getLastTradingDay(at('2026-08-08T14:00:00Z'))).toBe('2026-08-07'); // Sat 10:00 ET
            expect(getLastTradingDay(at('2026-08-09T00:00:00Z'))).toBe('2026-08-07'); // Sat 20:00 ET
        });

        it('returns Friday on Sunday, morning or evening', () => {
            expect(getLastTradingDay(at('2026-08-09T14:00:00Z'))).toBe('2026-08-07'); // Sun 10:00 ET
            // Sun 20:00 EDT = Mon 00:00 UTC. Deriving the weekday from the UTC date here
            // reports Monday and skips the weekend rollback entirely.
            expect(getLastTradingDay(at('2026-08-10T00:00:00Z'))).toBe('2026-08-07');
        });
    });

    describe('daylight saving', () => {
        it('resolves correctly in EST (winter, UTC-5)', () => {
            // Mon 2026-01-12 09:00 EST = 14:00 UTC → previous trading day is Fri 01-09.
            expect(getLastTradingDay(at('2026-01-12T14:00:00Z'))).toBe('2026-01-09');
            // Mon 2026-01-12 20:00 EST = Tue 01:00 UTC → still Monday in ET.
            expect(getLastTradingDay(at('2026-01-13T01:00:00Z'))).toBe('2026-01-12');
        });

        it('treats 20:15 UTC as before the close in winter but after it in summer', () => {
            // This is the offset behind the daily-scan schedule note: 20:15 UTC is 15:15 EST
            // (45 min before the close) in winter, but 16:15 EDT (after it) in summer.
            expect(getLastTradingDay(at('2026-01-13T20:15:00Z'))).toBe('2026-01-12'); // Tue 15:15 EST → Mon
            expect(getLastTradingDay(at('2026-08-11T20:15:00Z'))).toBe('2026-08-11'); // Tue 16:15 EDT → Tue
        });
    });

    describe('output contract', () => {
        it('always returns a YYYY-MM-DD string that is never a weekend', () => {
            // Walk a full week at 3-hour steps; every answer must be a real weekday.
            for (let h = 0; h < 24 * 7; h += 3) {
                const out = getLastTradingDay(new Date(Date.UTC(2026, 7, 7, h)));
                expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
                const dow = new Date(`${out}T00:00:00Z`).getUTCDay();
                expect(dow).toBeGreaterThanOrEqual(1);
                expect(dow).toBeLessThanOrEqual(5);
            }
        });

        it('never returns a date in the future', () => {
            const now = at('2026-08-11T13:00:00Z');
            expect(getLastTradingDay(now) <= now.toISOString().slice(0, 10)).toBe(true);
        });

        it('defaults to the current time when called with no argument', () => {
            expect(getLastTradingDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        });
    });

    describe('market holidays', () => {
        // The case this was written for: the scan is scheduled Mon-Fri, Labor Day is a
        // Monday, and the frozen OOS log takes one immutable row per returned date. Before
        // the holiday table this returned 09-07 and recorded a day with no session.
        it('walks back off Labor Day (Mon 2026-09-07) to the Friday before', () => {
            expect(getLastTradingDay(at('2026-09-07T21:00:00Z'))).toBe('2026-09-04');
        });

        it('crosses a holiday AND the weekend behind it in one pass', () => {
            // Christmas 2026 is Friday 12-25, so 12-26/27 are the weekend behind it.
            expect(getLastTradingDay(at('2026-12-27T21:00:00Z'))).toBe('2026-12-24');
        });

        it('handles a Saturday holiday observed on the Friday (July 4th 2026)', () => {
            // 07-04 is a Saturday; the market closes Friday 07-03.
            expect(getLastTradingDay(at('2026-07-04T21:00:00Z'))).toBe('2026-07-02');
        });

        it('treats Good Friday as a closure', () => {
            expect(getLastTradingDay(at('2026-04-03T21:00:00Z'))).toBe('2026-04-02');
        });

        it('never returns a holiday for any instant across a full year', () => {
            for (let i = 0; i < 365; i++) {
                const out = getLastTradingDay(new Date(Date.UTC(2026, 0, 1 + i, 21)));
                expect(isTradingDay(out)).toBe(true);
            }
        });
    });

    describe('isTradingDay', () => {
        it('rejects weekends', () => {
            expect(isTradingDay('2026-08-15')).toBe(false); // Saturday
            expect(isTradingDay('2026-08-16')).toBe(false); // Sunday
        });

        it('rejects listed holidays and accepts ordinary weekdays', () => {
            expect(isTradingDay('2026-09-07')).toBe(false); // Labor Day
            expect(isTradingDay('2026-09-08')).toBe(true);
            expect(isTradingDay('2026-08-14')).toBe(true);
        });
    });
});
