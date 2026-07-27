#!/usr/bin/env node
/**
 * Watchlist Health Check — evaluates every ticker currently on TradingView and
 * classifies whether the setup is still intact.
 *
 * Ported into this repo 2026-07-27 from smart-volume-radar-tools/tools/tg-radar/
 * so it can run in CI. It previously ran only on Kobi's Mac, wrote its prune
 * queue to the local `$HOME/.cache/`, and had not produced output since
 * 2026-06-02 — which meant the ≥8% prune path documented in the dashboard and
 * the architecture reference could never fire. See
 * `~/cabinet/outputs/2026-07-26-two-radar-improvement.md` (F3).
 *
 * For each ticker, using its first-signal date as the entry reference:
 *   % move since signal · peak gain · drawdown from peak · distance from 52w
 *   high · trading days since signal · RVOL
 *
 * Classification:
 *   ❌ BROKE_DOWN  — now ≤ −8% from signal (setup failed)     → queued for prune
 *   🔥 EXTENDED    — peak ≥ +15% since signal (move captured)  → reported only
 *   💤 STALE       — ≥10 td since signal and flat              → reported only
 *   🟢 VALID       — recent and in range
 *
 * ONLY `BROKE_DOWN` is queued for removal — deliberately narrow. `tv-sync`
 * consumes `prune-queue.json` on its next run and skips any ticker the radar
 * re-flagged that day, so a stock that breaks and immediately re-signals is not
 * dropped.
 *
 * Usage:
 *   node scripts/watchlist-health.mjs                 # report + write prune queue
 *   node scripts/watchlist-health.mjs --telegram      # also send the report
 *   node scripts/watchlist-health.mjs --dry-run       # report only, no queue write
 *   node --env-file=.env scripts/watchlist-health.mjs --telegram   # local creds
 *
 * Env overrides: TV_STATE_PATH · PRUNE_QUEUE_PATH · TELEGRAM_BOT_TOKEN/CHAT_ID
 *
 * Zero npm dependencies on purpose — it runs in the tv-sync job before
 * `npm ci` would matter, and must not be able to break the sync.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DRY_RUN = process.argv.includes('--dry-run');
const TELEGRAM = process.argv.includes('--telegram');

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TV_STATE_PATH = process.env.TV_STATE_PATH
    || path.join(PROJECT_ROOT, 'results', 'tv-state.json');
/** Must match the path tv-sync reads (sync-tv-watchlist.ts PRUNE_QUEUE_PATH). */
const PRUNE_QUEUE_PATH = process.env.PRUNE_QUEUE_PATH
    || path.join(os.homedir(), '.cache', 'svr-tv-sync', 'prune-queue.json');

/** now ≤ this from signal = the setup failed. The only status that prunes. */
const BROKE_DOWN_PCT = -0.08;
/** peak ≥ this = the move was captured; no longer an entry. */
const EXTENDED_PCT = 0.15;
/** trading days with no move = stale. (The original header said 14; the code
 *  has always used 10. Kept at 10 — STALE never prunes, so it is display only.) */
const STALE_TD = 10;
const STALE_BAND = [-0.05, 0.06];

// ─── Yahoo ───────────────────────────────────────────────────────────────
const EXCHANGE_SUFFIX = { TASE: '.TA', TWSE: '.TW', LSE: '.L', SIX: '.SW', XETR: '.DE', EURONEXT: '.PA' };

function yahooSymbol(entry) {
    if (entry.ticker.includes('.')) return entry.ticker;
    const suf = entry.exchange ? EXCHANGE_SUFFIX[entry.exchange] : '';
    return entry.ticker + (suf || '');
}

async function fetchYahoo(sym) {
    try {
        const r = await fetch(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1y`,
            { headers: { 'User-Agent': 'Mozilla/5.0' } },
        );
        if (!r.ok) return null;
        const d = await r.json();
        const res = d?.chart?.result?.[0];
        const ts = res?.timestamp ?? [];
        const q = res?.indicators?.quote?.[0] ?? {};
        const out = { ts: [], close: [], vol: [] };
        for (let i = 0; i < ts.length; i++) {
            const c = q.close?.[i];
            if (c != null && c > 0) { out.ts.push(ts[i]); out.close.push(c); out.vol.push(q.volume?.[i] ?? 0); }
        }
        return out.close.length > 30 ? out : null;
    } catch { return null; }
}

function pLimit(n) {
    let active = 0; const queue = [];
    const run = () => {
        if (active >= n || !queue.length) return;
        active++;
        const { fn, resolve } = queue.shift();
        fn().then(resolve).finally(() => { active--; run(); });
    };
    return (fn) => new Promise((resolve) => { queue.push({ fn, resolve }); run(); });
}

// ─── Evaluation ──────────────────────────────────────────────────────────
function indexOfSignalDay(series, signalDate) {
    const t0 = new Date(`${signalDate}T00:00:00Z`).getTime() / 1000;
    for (let i = 0; i < series.ts.length; i++) if (series.ts[i] >= t0) return i;
    return -1;
}

function evaluate(series, signalDate) {
    const idx = indexOfSignalDay(series, signalDate);
    if (idx < 0) return null;
    const entry = series.close[idx];
    const last = series.close[series.close.length - 1];
    const sinceSignal = series.close.slice(idx);
    const peak = Math.max(...sinceSignal);
    const high52 = Math.max(...series.close);
    const tdSince = series.close.length - 1 - idx;

    const pctNow = last / entry - 1;
    const pctPeak = peak / entry - 1;
    const fromHigh = last / high52 - 1;

    const vols = series.vol.slice(-22, -1).filter((v) => v > 0);
    const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
    const rvol = avgVol ? series.vol[series.vol.length - 1] / avgVol : 0;

    let status, emoji, note;
    if (pctNow <= BROKE_DOWN_PCT) {
        status = 'BROKE_DOWN'; emoji = '❌'; note = 'נשברה מתחת לכניסה';
    } else if (pctPeak >= EXTENDED_PCT) {
        status = 'EXTENDED'; emoji = '🔥'; note = `רצה +${(pctPeak * 100).toFixed(0)}% — מהלך נתפס`;
    } else if (tdSince >= STALE_TD && pctNow > STALE_BAND[0] && pctNow < STALE_BAND[1]) {
        status = 'STALE'; emoji = '💤'; note = `${tdSince} ימים ללא תנועה`;
    } else {
        status = 'VALID'; emoji = '🟢'; note = 'סטאפ תקין';
    }
    return { entry, last, pctNow, pctPeak, fromHigh, tdSince, rvol, status, emoji, note };
}

// ─── Telegram ────────────────────────────────────────────────────────────
async function sendTelegram(text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
        console.error('⚠️ --telegram requested but TELEGRAM_BOT_TOKEN/CHAT_ID are not set — skipping send.');
        return;
    }
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!r.ok) throw new Error(`Telegram ${r.status}: ${await r.text()}`);
}

// ─── Main ────────────────────────────────────────────────────────────────
async function main() {
    if (!fs.existsSync(TV_STATE_PATH)) {
        console.error(`⚠️ No tv-state at ${TV_STATE_PATH} — nothing to check.`);
        return;
    }
    const state = JSON.parse(fs.readFileSync(TV_STATE_PATH, 'utf8'));
    const watchlists = state.watchlists ?? {};
    const limit = pLimit(8);
    const results = [];

    await Promise.all(
        Object.entries(watchlists).flatMap(([list, entries]) =>
            (entries ?? []).map((entry) => limit(async () => {
                const sym = yahooSymbol(entry);
                const series = await fetchYahoo(sym);
                results.push({
                    list, ticker: entry.ticker, sym, signalDate: entry.signalDate,
                    ev: series ? evaluate(series, entry.signalDate) : null,
                });
            })),
        ),
    );

    const tally = { VALID: 0, EXTENDED: 0, STALE: 0, BROKE_DOWN: 0, NODATA: 0 };

    // Iterate the lists actually present rather than a hardcoded order — the
    // Smart Radar BUY/WATCH lists were dropped from TV sync on 2026-07-25.
    for (const list of Object.keys(watchlists)) {
        const items = results.filter((r) => r.list === list).sort((a, b) => a.ticker.localeCompare(b.ticker));
        if (!items.length) continue;
        console.log(`\n📋 ${list}`);
        console.log(`${'Ticker'.padEnd(9)} ${'Signal'.padEnd(7)} ${'Now%'.padStart(7)} ${'Peak%'.padStart(7)} ${'52wH%'.padStart(7)} ${'td'.padStart(3)}  Status`);
        console.log('─'.repeat(70));
        for (const r of items) {
            if (!r.ev) {
                tally.NODATA++;
                console.log(`${r.ticker.padEnd(9)} ${r.signalDate.slice(5).padEnd(7)} ${'—'.padStart(7)}  ⚠️ no Yahoo data (${r.sym})`);
                continue;
            }
            const e = r.ev;
            tally[e.status]++;
            console.log(
                `${r.ticker.padEnd(9)} ${r.signalDate.slice(5).padEnd(7)} `
                + `${(e.pctNow * 100).toFixed(1).padStart(6)}% ${(e.pctPeak * 100).toFixed(1).padStart(6)}% `
                + `${(e.fromHigh * 100).toFixed(1).padStart(6)}% ${String(e.tdSince).padStart(3)}  ${e.emoji} ${e.status}`,
            );
        }
    }

    console.log(`\n📊 ${tally.VALID} valid · ${tally.EXTENDED} extended · ${tally.STALE} stale · ${tally.BROKE_DOWN} broke down · ${tally.NODATA} no-data`);

    // ─── Prune queue — BROKE_DOWN only ───────────────────────────────────
    const pruneQueue = {};
    for (const r of results) {
        if (r.ev?.status !== 'BROKE_DOWN') continue;
        const key = r.ticker.split(':').pop().toUpperCase().replace(/\.[A-Z]+$/, '');
        (pruneQueue[r.list] ??= []).push({
            ticker: key,
            reason: `broke down ${(r.ev.pctNow * 100).toFixed(0)}% from signal ${r.signalDate}`,
            queuedAt: new Date().toISOString().slice(0, 10),
        });
    }
    const total = Object.values(pruneQueue).reduce((a, v) => a + v.length, 0);

    if (DRY_RUN) {
        console.log(`\n(dry-run — would queue ${total} ticker(s): ${JSON.stringify(pruneQueue)})`);
        return;
    }

    // Merge rather than overwrite: an entry queued on a previous run that the
    // sync has not consumed yet (e.g. the sync failed) must survive.
    let existing = {};
    try {
        if (fs.existsSync(PRUNE_QUEUE_PATH)) existing = JSON.parse(fs.readFileSync(PRUNE_QUEUE_PATH, 'utf8'));
    } catch { existing = {}; }

    for (const [list, entries] of Object.entries(pruneQueue)) {
        const seen = new Set((existing[list] ?? []).map((e) => e.ticker));
        existing[list] = [...(existing[list] ?? []), ...entries.filter((e) => !seen.has(e.ticker))];
    }

    try {
        fs.mkdirSync(path.dirname(PRUNE_QUEUE_PATH), { recursive: true });
        fs.writeFileSync(PRUNE_QUEUE_PATH, JSON.stringify(existing, null, 2));
        const carried = Object.values(existing).reduce((a, v) => a + v.length, 0);
        console.log(`\n📤 Prune queue → ${PRUNE_QUEUE_PATH} (${total} new, ${carried} pending total)`);
    } catch (e) {
        // Never fail the job over this — the sync still runs, it just won't prune.
        console.error(`⚠️ Could not write prune queue: ${e.message}`);
    }

    if (TELEGRAM) {
        const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const flagged = results.filter((r) => r.ev && r.ev.status !== 'VALID');
        const lines = [`🩺 <b>בדיקת בריאות Watchlist</b> — ${state.updatedAt ?? ''}`, ''];
        if (!flagged.length) {
            lines.push('✅ כל המניות עדיין רלוונטיות — אין מה להסיר.');
        } else {
            const by = (s) => flagged.filter((r) => r.ev.status === s);
            const broke = by('BROKE_DOWN'); const ext = by('EXTENDED'); const stale = by('STALE');
            if (broke.length) {
                lines.push('❌ <b>נשברו — יוסרו בסנכרון הקרוב</b>');
                broke.forEach((r) => lines.push(`  • <code>${esc(r.ticker)}</code> — ${(r.ev.pctNow * 100).toFixed(0)}%`));
                lines.push('');
            }
            if (ext.length) {
                lines.push('🔥 <b>רצו — מהלך נתפס (לא כניסה)</b>');
                ext.forEach((r) => lines.push(`  • <code>${esc(r.ticker)}</code> — peak +${(r.ev.pctPeak * 100).toFixed(0)}%`));
                lines.push('');
            }
            if (stale.length) {
                lines.push('💤 <b>מיושנות (ללא תנועה)</b>');
                stale.forEach((r) => lines.push(`  • <code>${esc(r.ticker)}</code> — ${r.ev.tdSince} ימים`));
                lines.push('');
            }
            lines.push(`<i>${tally.VALID} מניות עדיין תקינות.</i>`);
        }
        await sendTelegram(lines.join('\n'));
        console.log('✅ Sent to Telegram');
    }
}

main().catch((e) => {
    // Health is advisory: a failure here must never take down the sync that
    // follows it in the same job.
    console.error(`⚠️ watchlist-health failed (non-fatal): ${e.message}`);
    process.exit(0);
});
