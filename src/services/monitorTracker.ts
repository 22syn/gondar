/**
 * Gondar — Monitor Tracker.
 *
 * Manages the lifecycle of tracked tickers:
 *
 *   1. NEW alert (Full / Recovery / Watchlist) →
 *        - If ticker not in monitor list → ADD with status='monitoring'
 *        - If ticker in monitor list with status='monitoring' → log event, refresh
 *        - If ticker resolved (graduated/etc.) → log event, don't change status
 *
 *   2. UPDATE pass (per scan) for each entry with status='monitoring':
 *        - GRADUATED:    today's level === 'full' → BUY signal
 *        - MANUAL-ENTRY: pivot break + RVOL ≥ 1.5 + bigMoveToday (priceChange ≥ 3%)
 *        - SMA21-PULLBACK: dist(price, SMA21) ≤ 2% + RVOL ≤ 1.0 + green close
 *        - EXPIRED:     trading-days since firstAlert ≥ 30 with no resolution
 *
 *   Resolution events DO NOT trigger orders — they're alerts for the trader.
 */
import type { MonitorEntry, MonitorState, StockData, MonitorStatus } from '../types/index.js';
import { findEntry } from '../utils/monitorStore.js';
import logger from '../utils/logger.js';

/** Trading-day expiration window for unresolved monitors. */
export const MONITOR_EXPIRY_TRADING_DAYS = 30;
/** Manual-entry trigger: priceChange ≥ X% on a pivot day = real continuation breakout. */
export const MANUAL_ENTRY_DAY_PCT = 3;
/** SMA21-pullback: distance threshold in %. */
export const SMA21_PULLBACK_THRESHOLD_PCT = 2;
/** SMA21-pullback: RVOL must be quiet (institutional NOT selling). */
export const SMA21_PULLBACK_MAX_RVOL = 1.0;

/** Approximate trading-day distance (Mon–Fri only). Good enough for 30-day expiry. */
function tradingDaysBetween(fromIso: string, toIso: string): number {
    const from = new Date(fromIso + 'T00:00:00Z');
    const to = new Date(toIso + 'T00:00:00Z');
    let days = 0;
    const cur = new Date(from);
    while (cur < to) {
        const day = cur.getUTCDay();
        if (day >= 1 && day <= 5) days++;
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return days;
}

/**
 * Add a new alert to the monitor state. Idempotent: if ticker already exists with
 * an unresolved status, just appends an event. Returns the entry (new or existing).
 */
export function recordAlert(
    state: MonitorState,
    stock: StockData,
    asOfDate: string
): { entry: MonitorEntry; isNew: boolean } {
    const level = stock.momentum?.level;
    if (level !== 'full' && level !== 'recovery' && level !== 'close') {
        throw new Error(`recordAlert called on non-alerting stock ${stock.ticker} (level=${level})`);
    }

    const existing = findEntry(state, stock.ticker);
    const rvol = stock.projectedRvol ?? stock.rvol;

    if (existing) {
        existing.events.push({
            date: asOfDate,
            type: `re-alert-${level}`,
            price: stock.lastPrice,
            rvol,
        });
        existing.lastChecked = asOfDate;
        return { entry: existing, isNew: false };
    }

    const newEntry: MonitorEntry = {
        ticker: stock.ticker,
        firstAlertDate: asOfDate,
        firstAlertLevel: level,
        firstAlertPrice: stock.lastPrice,
        firstAlertRvol: rvol,
        lastChecked: asOfDate,
        status: 'monitoring',
        sector: stock.sector,
        events: [
            {
                date: asOfDate,
                type: `alert-${level}`,
                price: stock.lastPrice,
                rvol,
                note: `First alert (${level})`,
            },
        ],
    };
    state.entries.push(newEntry);
    return { entry: newEntry, isNew: true };
}

/**
 * Outcome of a single monitor check. If `transitioned`, the entry's status changed.
 */
export interface CheckResult {
    entry: MonitorEntry;
    transitioned: boolean;
    newStatus?: MonitorStatus;
    reason?: string;
}

/**
 * Check ONE monitor entry against today's stock data + run the state machine.
 * Returns a CheckResult; mutates the entry in place.
 */
export function checkMonitorEntry(
    entry: MonitorEntry,
    stock: StockData | null,
    asOfDate: string
): CheckResult {
    if (entry.status !== 'monitoring') {
        // Already resolved; just record latest price if we have it.
        if (stock) entry.lastChecked = asOfDate;
        return { entry, transitioned: false };
    }

    // 1. EXPIRED — check first (doesn't need today's data).
    const elapsed = tradingDaysBetween(entry.firstAlertDate, asOfDate);
    if (elapsed >= MONITOR_EXPIRY_TRADING_DAYS) {
        entry.status = 'expired';
        entry.resolvedDate = asOfDate;
        entry.resolvedReason = `${elapsed} trading days without resolution`;
        if (stock) entry.resolvedPrice = stock.lastPrice;
        entry.lastChecked = asOfDate;
        entry.events.push({
            date: asOfDate,
            type: 'expired',
            price: stock?.lastPrice ?? entry.firstAlertPrice,
            note: entry.resolvedReason,
        });
        return { entry, transitioned: true, newStatus: 'expired', reason: entry.resolvedReason };
    }

    // No data today (delisted? holiday? fetch failure?) — keep monitoring.
    if (!stock) {
        entry.lastChecked = asOfDate;
        return { entry, transitioned: false };
    }

    const m = stock.momentum;
    const rvol = stock.projectedRvol ?? stock.rvol;

    // 2. GRADUATED — strongest signal, check first.
    if (m?.level === 'full') {
        entry.status = 'graduated';
        entry.resolvedDate = asOfDate;
        entry.resolvedPrice = stock.lastPrice;
        entry.resolvedReason = `Full Setup confirmed (RVOL ${rvol.toFixed(2)})`;
        entry.lastChecked = asOfDate;
        entry.events.push({
            date: asOfDate,
            type: 'graduated',
            price: stock.lastPrice,
            rvol,
            note: 'Full Setup → BUY signal',
        });
        return { entry, transitioned: true, newStatus: 'graduated', reason: entry.resolvedReason };
    }

    // 3. MANUAL-ENTRY — clean continuation breakout: pivot + RVOL + bigMoveToday.
    const isPivot = m?.criteria.pivotBreakout === true;
    const isBigMove = (stock.priceChange ?? 0) >= MANUAL_ENTRY_DAY_PCT;
    const goodRvol = rvol >= 1.5;
    const stage2 = m?.criteria.stage2 === true;
    if (isPivot && isBigMove && goodRvol && stage2) {
        entry.status = 'manual-entry';
        entry.resolvedDate = asOfDate;
        entry.resolvedPrice = stock.lastPrice;
        entry.resolvedReason =
            `Pivot break + RVOL ${rvol.toFixed(2)} + +${(stock.priceChange ?? 0).toFixed(1)}% day`;
        entry.lastChecked = asOfDate;
        entry.events.push({
            date: asOfDate,
            type: 'manual-entry',
            price: stock.lastPrice,
            rvol,
            note: entry.resolvedReason,
        });
        return { entry, transitioned: true, newStatus: 'manual-entry', reason: entry.resolvedReason };
    }

    // 4. SMA21-PULLBACK — quiet pullback for clean re-entry.
    const sma21 = stock.sma21;
    if (sma21 != null && sma21 > 0 && stock.lastPrice > 0) {
        const distPct = (Math.abs(stock.lastPrice - sma21) / sma21) * 100;
        const greenClose = (stock.priceChange ?? 0) > 0;
        if (distPct <= SMA21_PULLBACK_THRESHOLD_PCT && rvol <= SMA21_PULLBACK_MAX_RVOL && greenClose && stage2) {
            entry.status = 'sma21-pullback';
            entry.resolvedDate = asOfDate;
            entry.resolvedPrice = stock.lastPrice;
            entry.resolvedReason =
                `Quiet pullback to SMA21 (dist ${distPct.toFixed(1)}%, RVOL ${rvol.toFixed(2)}, green)`;
            entry.lastChecked = asOfDate;
            entry.events.push({
                date: asOfDate,
                type: 'sma21-pullback',
                price: stock.lastPrice,
                rvol,
                note: entry.resolvedReason,
            });
            return { entry, transitioned: true, newStatus: 'sma21-pullback', reason: entry.resolvedReason };
        }
    }

    // No transition — just refresh lastChecked.
    entry.lastChecked = asOfDate;
    return { entry, transitioned: false };
}

/**
 * Run a full monitor update: check all currently-monitoring entries against today's data,
 * then add today's NEW alerts.
 *
 * @param state         Current monitor state (mutated in place)
 * @param stocksByTicker Map ticker → today's StockData (with .momentum populated)
 * @param asOfDate      Today's date (YYYY-MM-DD)
 * @returns Summary of transitions + new entries (for Telegram)
 */
export interface MonitorUpdateSummary {
    /** Existing entries that transitioned to a non-monitoring state today */
    transitions: CheckResult[];
    /** Brand-new monitor entries added this scan */
    newEntries: MonitorEntry[];
    /** Re-alerts on existing monitoring entries */
    reAlerts: MonitorEntry[];
    /** Count of still-active 'monitoring' entries after the update */
    activeCount: number;
}

export function updateMonitorState(
    state: MonitorState,
    stocksByTicker: Map<string, StockData>,
    asOfDate: string
): MonitorUpdateSummary {
    const transitions: CheckResult[] = [];
    const newEntries: MonitorEntry[] = [];
    const reAlerts: MonitorEntry[] = [];

    // 1. Check existing 'monitoring' entries.
    for (const entry of state.entries) {
        if (entry.status !== 'monitoring') continue;
        const stock = stocksByTicker.get(entry.ticker.toUpperCase()) ?? null;
        const result = checkMonitorEntry(entry, stock, asOfDate);
        if (result.transitioned) transitions.push(result);
    }

    // 2. Process today's alerts (Full / Recovery / Watchlist) — add or refresh.
    for (const [, stock] of stocksByTicker) {
        const level = stock.momentum?.level;
        if (level !== 'full' && level !== 'recovery' && level !== 'close') continue;
        const { entry, isNew } = recordAlert(state, stock, asOfDate);
        if (isNew) {
            newEntries.push(entry);
        } else if (entry.status === 'monitoring') {
            reAlerts.push(entry);
        }
    }

    state.lastUpdated = asOfDate;
    const activeCount = state.entries.filter((e) => e.status === 'monitoring').length;

    logger.info(
        `📊 Monitor update: ${transitions.length} transitions | ${newEntries.length} new | ${reAlerts.length} re-alerts | ${activeCount} active`
    );

    return { transitions, newEntries, reAlerts, activeCount };
}
