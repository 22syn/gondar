#!/usr/bin/env npx tsx
/**
 * Self-check for the Market Context panel (2026-08-22).
 *
 * Five checks, all machine-decidable — nothing here needs a human to eyeball a
 * chart. Exits 1 if any check FAILS. Checks that cannot run (no D1 credentials)
 * are reported as SKIP and are never counted as passes: a verification script
 * that quietly reports success for work it did not do is worse than no script.
 *
 *   1. Williams %R matches TradingView          (no credentials needed)
 *   2. s5fi is a sane breadth reading           (no credentials needed)
 *   3. the latest D1 row is populated           (needs CF_*)
 *   4. lean_signals.wr14 coverage               (needs CF_*)
 *   5. the ingest does not lose rows            (needs CF_*, writes one row)
 *
 * Check 1 talks to TradingView's public scanner endpoint directly rather than
 * through the TradingView MCP. Verified 2026-08-22 that it answers without any
 * login or cookie, which is what makes this runnable in CI — the MCP is not
 * available to a plain Node process, and the cookie-based path is exactly the
 * fragility this panel was built to remove.
 *
 * Usage:  npm run verify:market-context [-- --date YYYY-MM-DD]
 */
import { computeMarketContext, MIN_S5FI_CONSTITUENTS } from '../src/services/marketContext.js';
import { ingestMarketContextToD1 } from '../src/utils/marketContextD1Ingest.js';
import { d1ConfigFromEnv, queryRows } from '../src/utils/d1Client.js';
import { getLastTradingDay } from '../src/utils/tradingDate.js';

/** Max allowed divergence from TradingView's own Williams %R, in %R points. */
const WR_TOLERANCE = 0.01;
/** Minimum share of the day's signal rows that must carry a wr14 value. */
const WR14_MIN_COVERAGE = 0.9;
/** At most this many of the six gauges may be null on a healthy trading day. */
const MAX_NULL_GAUGES = 1;

type Status = 'PASS' | 'FAIL' | 'SKIP';
const results: Array<{ n: number; name: string; status: Status; detail: string }> = [];

function record(n: number, name: string, status: Status, detail: string): void {
    results.push({ n, name, status, detail });
    const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⏭️ ';
    console.log(`${icon} ${n}. ${name} — ${detail}`);
}

function argDate(): string {
    const i = process.argv.indexOf('--date');
    if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]!;
    return getLastTradingDay();
}

/** TradingView's own Williams %R for SPY and QQQ, daily and weekly. */
async function fetchTradingViewWr(): Promise<Record<string, number> | null> {
    try {
        const res = await fetch('https://scanner.tradingview.com/america/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
            body: JSON.stringify({
                symbols: { tickers: ['AMEX:SPY', 'NASDAQ:QQQ'], query: { types: [] } },
                columns: ['W.R', 'W.R|1W'],
            }),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { data?: Array<{ s: string; d: number[] }> };
        const out: Record<string, number> = {};
        for (const row of body.data ?? []) {
            const key = row.s.split(':')[1]!;
            if (row.d[0] != null) out[`${key}_1d`] = row.d[0];
            if (row.d[1] != null) out[`${key}_1w`] = row.d[1];
        }
        return Object.keys(out).length === 4 ? out : null;
    } catch {
        return null;
    }
}

async function main(): Promise<void> {
    const date = argDate();
    console.log(`\n🔍 Verifying market context for ${date}\n`);

    const mc = await computeMarketContext(date);

    // ── 1. Williams %R vs TradingView ────────────────────────────────────────
    const tv = await fetchTradingViewWr();
    if (!tv) {
        record(1, 'Williams %R vs TradingView', 'SKIP', 'TradingView scanner unreachable');
    } else {
        const pairs: Array<[string, number | null, number]> = [
            ['SPY 1D', mc.spyWr1d, tv.SPY_1d!],
            ['SPY 1W', mc.spyWr1w, tv.SPY_1w!],
            ['QQQ 1D', mc.qqqWr1d, tv.QQQ_1d!],
            ['QQQ 1W', mc.qqqWr1w, tv.QQQ_1w!],
        ];
        const bad = pairs.filter(([, ours, theirs]) => ours == null || Math.abs(ours - theirs) > WR_TOLERANCE);
        const worst = Math.max(...pairs.map(([, o, t]) => (o == null ? Infinity : Math.abs(o - t))));
        record(
            1,
            'Williams %R vs TradingView',
            bad.length === 0 ? 'PASS' : 'FAIL',
            bad.length === 0
                ? `4/4 within ${WR_TOLERANCE} (worst ${worst.toExponential(2)})`
                : `off by more than ${WR_TOLERANCE}: ${bad.map(([n]) => n).join(', ')}`
        );
    }

    // ── 2. s5fi sanity ───────────────────────────────────────────────────────
    // NOTE: only today's reading is checked here. A drift check against the real
    // index would need a historical S5FI series we deliberately do not have.
    if (mc.s5fi == null) {
        record(2, 's5fi breadth reading', 'FAIL', `null (only ${mc.s5fiN ?? 0} constituents answered)`);
    } else if (mc.s5fi <= 0 || mc.s5fi >= 100 || (mc.s5fiN ?? 0) < MIN_S5FI_CONSTITUENTS) {
        record(2, 's5fi breadth reading', 'FAIL', `${mc.s5fi.toFixed(2)}% on n=${mc.s5fiN}`);
    } else {
        record(2, 's5fi breadth reading', 'PASS', `${mc.s5fi.toFixed(2)}% on n=${mc.s5fiN} constituents`);
    }

    const cfg = d1ConfigFromEnv();
    if (!cfg) {
        record(3, 'latest D1 row populated', 'SKIP', 'CF_* not configured');
        record(4, 'lean_signals.wr14 coverage', 'SKIP', 'CF_* not configured');
        record(5, 'ingest does not lose rows', 'SKIP', 'CF_* not configured');
    } else {
        // ── 5a. Row count BEFORE the write ───────────────────────────────────
        const before = await queryRows<{ n: number }>(
            { sql: 'SELECT COUNT(*) AS n FROM market_context', params: [] },
            cfg
        ).catch(() => [{ n: -1 }]);
        const beforeN = before[0]?.n ?? -1;

        await ingestMarketContextToD1(mc, cfg);

        // ── 3. Latest row populated ──────────────────────────────────────────
        const rows = await queryRows<Record<string, number | null>>(
            {
                sql: 'SELECT * FROM market_context WHERE scan_date = ?',
                params: [date],
            },
            cfg
        );
        const row = rows[0];
        if (!row) {
            record(3, 'latest D1 row populated', 'FAIL', `no market_context row for ${date}`);
        } else {
            const gauges = [
                'spx_dist_sma150',
                'rsp_slope21',
                'vix',
                'xlp_spx_slope21',
                'xly_xlp_slope21',
                's5fi',
            ];
            const nulls = gauges.filter((g) => row[g] == null);
            record(
                3,
                'latest D1 row populated',
                nulls.length <= MAX_NULL_GAUGES ? 'PASS' : 'FAIL',
                nulls.length === 0 ? 'all six gauges present' : `null gauges: ${nulls.join(', ')}`
            );
        }

        // ── 4. wr14 coverage on the day's signal rows ────────────────────────
        const cov = await queryRows<{ total: number; have: number }>(
            {
                sql:
                    'SELECT COUNT(*) AS total, SUM(CASE WHEN wr14 IS NOT NULL THEN 1 ELSE 0 END) AS have ' +
                    'FROM lean_signals WHERE scan_date = ?',
                params: [date],
            },
            cfg
        );
        const total = cov[0]?.total ?? 0;
        const have = cov[0]?.have ?? 0;
        if (total === 0) {
            record(4, 'lean_signals.wr14 coverage', 'SKIP', `no lean_signals rows for ${date}`);
        } else {
            const ratio = have / total;
            record(
                4,
                'lean_signals.wr14 coverage',
                ratio >= WR14_MIN_COVERAGE ? 'PASS' : 'FAIL',
                `${have}/${total} = ${(ratio * 100).toFixed(1)}% (need ${WR14_MIN_COVERAGE * 100}%)`
            );
        }

        // ── 5b. Row count AFTER the write ────────────────────────────────────
        const after = await queryRows<{ n: number }>(
            { sql: 'SELECT COUNT(*) AS n FROM market_context', params: [] },
            cfg
        );
        const afterN = after[0]?.n ?? -1;
        record(
            5,
            'ingest does not lose rows',
            afterN >= beforeN && afterN >= 0 ? 'PASS' : 'FAIL',
            `${beforeN} → ${afterN} rows (must never decrease)`
        );
    }

    const failed = results.filter((r) => r.status === 'FAIL').length;
    const skipped = results.filter((r) => r.status === 'SKIP').length;
    const passed = results.filter((r) => r.status === 'PASS').length;
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error(`❌ verify-market-context crashed: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
});
