/**
 * Smart Volume Radar — Lean Radar TradingView watchlist writer (three-list model).
 *
 * Emits THREE separate watchlist files per scan, mirroring three TradingView
 * watchlists kept distinct:
 *
 *   1. "Lean Radar - Breakouts" — high-conviction ACTION list
 *      Contents: 🎓 Graduated (breakout-primary) + 📈 Real Breakouts
 *      Files:    tv-breakouts-{date}.txt + tv-breakouts-latest.txt
 *      Use:     stocks to look at TODAY for a trade decision
 *
 *   2. "Lean Radar - Near" — MONITOR list (approaching breakout)
 *      Contents: 📈 Near Pivot (nearConsolidation) only
 *      Files:    tv-near-{date}.txt + tv-near-latest.txt
 *      Use:     stocks 1-2 days from breakout; daily check for transitions
 *
 *   3. "Lean Radar - Creep" — QUIET LEADERS list
 *      Contents: 🐢 Creep (Stage 2, low RVOL, positive 63d momentum)
 *      Files:    tv-creep-{date}.txt + tv-creep-latest.txt
 *      Use:     slow accumulators to track before they show up loud
 *
 * Pullback and Volume signals are intentionally NOT included — those are
 * different trade archetypes (buy-on-dip / volume-context), shown in the
 * Telegram report and the dashboard but kept out of TradingView (2026-08-05:
 * they're the two largest tiers, ~120 and ~85 tickers per fortnight, and put
 * the watchlists back into the unreadable state this split was made to fix).
 *
 * Back-compat: tv-watchlist-latest.txt is kept as a copy of the breakouts
 * file (for callers that haven't migrated yet).
 *
 * Exchange prefixes for TV format:
 *   .TA  → TASE:        .DE  → XETR:       .PA  → EURONEXT:
 *   .AS  → EURONEXT:    .SW  → SIX:        .L   → LSE:
 *   .MI  → MIL:         .VI  → VIE:        .TW  → TWSE:
 *   .KS  → KRX:         .SA  → BMFBOVESPA: .MC  → BME:
 *   plain (no dot)      → no prefix (TradingView resolves NYSE/NASDAQ)
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LeanScanResult } from './format.js';

const EXCHANGE_PREFIX: Record<string, string> = {
    '.TA': 'TASE',
    '.DE': 'XETR',
    '.PA': 'EURONEXT',
    '.AS': 'EURONEXT',
    '.SW': 'SIX',
    '.L': 'LSE',
    '.MI': 'MIL',
    '.VI': 'VIE',
    '.TW': 'TWSE',
    '.KS': 'KRX',
    '.SA': 'BMFBOVESPA',
    '.MC': 'BME',
};

/** Map a SVR ticker (e.g. "NICE.TA", "RHM.DE", "NVDA") to TradingView format
 *  (e.g. "TASE:NICE", "XETR:RHM", "NVDA"). */
export function toTradingViewSymbol(svrTicker: string): string {
    for (const [suffix, prefix] of Object.entries(EXCHANGE_PREFIX)) {
        if (svrTicker.endsWith(suffix)) {
            const base = svrTicker.slice(0, -suffix.length);
            return `${prefix}:${base}`;
        }
    }
    // US class shares: Yahoo writes MOG-A / BRK-B, TradingView writes MOG.A / BRK.B.
    // Only a single trailing letter class qualifies — real tickers with hyphens
    // elsewhere (none in the universe today) must not be rewritten.
    if (/^[A-Z]+-[A-Z]$/.test(svrTicker)) return svrTicker.replace('-', '.');
    return svrTicker;
}

type BreakoutKind = 'graduated' | 'breakout';
type NearKind = 'nearBreakout';

export interface BreakoutsEntry {
    svrTicker: string;
    tvSymbol: string;
    kind: BreakoutKind;
    detail: string;
}
export interface NearEntry {
    svrTicker: string;
    tvSymbol: string;
    kind: NearKind;
    detail: string;
}
export interface CreepEntry {
    svrTicker: string;
    tvSymbol: string;
    kind: 'creep';
    detail: string;
}

/** Build the BREAKOUTS list: graduated (breakout-primary) + real breakouts.
 *  This is the high-conviction "act today" list. */
export function buildBreakoutsList(result: LeanScanResult): BreakoutsEntry[] {
    const seen = new Set<string>();
    const out: BreakoutsEntry[] = [];

    // 1. Graduated — ONLY where today's signal is a real breakout
    for (const g of result.graduated ?? []) {
        if (g.primary !== 'breakout') continue;
        if (seen.has(g.stock.ticker)) continue;
        out.push({
            svrTicker: g.stock.ticker,
            tvSymbol: toTradingViewSymbol(g.stock.ticker),
            kind: 'graduated',
            detail: g.primaryDetail,
        });
        seen.add(g.stock.ticker);
    }

    // 2. Real Consolidation Breakouts
    for (const r of result.consolidationBreakouts) {
        if (seen.has(r.stock.ticker)) continue;
        out.push({
            svrTicker: r.stock.ticker,
            tvSymbol: toTradingViewSymbol(r.stock.ticker),
            kind: 'breakout',
            detail: `${r.signal.window} base ${r.signal.baseRangePct.toFixed(1)}%, pivot $${r.signal.windowHigh.toFixed(2)}`,
        });
        seen.add(r.stock.ticker);
    }

    return out;
}

/** Build the NEAR list: stocks approaching breakout (within 2% of pivot). */
export function buildNearList(result: LeanScanResult): NearEntry[] {
    const seen = new Set<string>();
    const out: NearEntry[] = [];

    for (const r of result.nearConsolidation) {
        if (seen.has(r.stock.ticker)) continue;
        out.push({
            svrTicker: r.stock.ticker,
            tvSymbol: toTradingViewSymbol(r.stock.ticker),
            kind: 'nearBreakout',
            detail: `${r.signal.window} base, ${r.signal.distanceToPivotPct.toFixed(2)}% below pivot $${r.signal.windowHigh.toFixed(2)}`,
        });
        seen.add(r.stock.ticker);
    }

    return out;
}

/** Build the CREEP list: quiet Stage-2 leaders grinding up on low RVOL.
 *  A separate archetype from breakouts — held apart on purpose so the
 *  breakout lists stay a clean "act today" surface. */
export function buildCreepList(result: LeanScanResult): CreepEntry[] {
    const seen = new Set<string>();
    const out: CreepEntry[] = [];

    // ?? [] — snapshots/fixtures written before the creep tier existed.
    for (const r of result.creep ?? []) {
        if (seen.has(r.stock.ticker)) continue;
        out.push({
            svrTicker: r.stock.ticker,
            tvSymbol: toTradingViewSymbol(r.stock.ticker),
            kind: 'creep',
            detail: `mom63 ${r.signal.mom63.toFixed(1)}%, ${r.signal.pctFromAth.toFixed(1)}% from ATH`,
        });
        seen.add(r.stock.ticker);
    }

    return out;
}

function writeListFile(
    dir: string,
    dateStamp: string,
    fileBaseName: string,
    title: string,
    sectionLabel: string,
    entries: Array<{ tvSymbol: string; kind: string }>
): { dated: string; latest: string; count: number } {
    const lines: string[] = [];
    lines.push(`###${title} — ${dateStamp}`);
    lines.push(`###Generated: ${new Date().toISOString()}`);
    lines.push(`###Total: ${entries.length} symbols`);
    lines.push('');
    if (entries.length > 0) {
        lines.push(`###${sectionLabel}`);
        for (const e of entries) lines.push(e.tvSymbol);
    } else {
        lines.push('###(none today)');
    }
    const content = lines.join('\n') + '\n';
    const dated = path.join(dir, `${fileBaseName}-${dateStamp}.txt`);
    const latest = path.join(dir, `${fileBaseName}-latest.txt`);
    fs.writeFileSync(dated, content);
    fs.writeFileSync(latest, content);
    return { dated, latest, count: entries.length };
}

export interface WatchlistWriteResult {
    breakouts: { dated: string; latest: string; count: number };
    near: { dated: string; latest: string; count: number };
    creep: { dated: string; latest: string; count: number };
    /** Back-compat: tv-watchlist-latest.txt = breakouts file. */
    legacyLatestPath: string;
}

export function writeTradingViewWatchlist(
    scanDate: string,
    result: LeanScanResult,
    resultsDir: string
): WatchlistWriteResult {
    const breakouts = buildBreakoutsList(result);
    const near = buildNearList(result);
    const creep = buildCreepList(result);

    const bResult = writeListFile(
        resultsDir,
        scanDate,
        'tv-breakouts',
        'Lean Radar — Breakouts (ACTION)',
        '🎓 Graduated + 📈 Real Breakouts',
        breakouts
    );
    const nResult = writeListFile(
        resultsDir,
        scanDate,
        'tv-near',
        'Lean Radar — Near (MONITOR)',
        '📈 Near Pivot — within 2% of base high',
        near
    );

    const cResult = writeListFile(
        resultsDir,
        scanDate,
        'tv-creep',
        'Lean Radar — Creep (QUIET LEADERS)',
        '🐢 Creep — Stage 2, low RVOL, grinding up',
        creep
    );

    // Back-compat: keep tv-watchlist-latest.txt = breakouts content
    const legacyLatest = path.join(resultsDir, 'tv-watchlist-latest.txt');
    fs.copyFileSync(bResult.latest, legacyLatest);

    return {
        breakouts: bResult,
        near: nResult,
        creep: cResult,
        legacyLatestPath: legacyLatest,
    };
}

/** Back-compat shim — old callers may still import buildBreakoutWatchlist
 *  expecting the combined list. Now returns ONLY the action list (breakouts). */
export const buildBreakoutWatchlist = buildBreakoutsList;
