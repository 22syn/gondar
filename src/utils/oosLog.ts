/**
 * Out-of-sample (OOS) scorecard log for the Purple Fragility gauge.
 *
 * Writes ONE FROZEN row per scan to results/oos_log.csv — the gauge's
 * real-time reading on that day. This is the honest forward test the Goal
 * Charter requires: the engine recomputes its expanding-z history every run
 * (past z's drift slightly as data corrections land), so the ONLY way to know
 * what the model actually said in real time on a given day is to record it that
 * day and never recompute it. Rows dated before {@link OOS_START} are in-sample
 * and ignored by the scorecard's headline metrics.
 *
 * Contract, mirroring fragilityD1Ingest:
 *  - Append-only + idempotent by date: re-running the same scan_date replaces
 *    that one row in place (a re-run is still "as of today"), never duplicates.
 *  - Fail-open: any IO/parse problem is logged and swallowed — logging the OOS
 *    row must never fail the scan (Telegram already went out).
 *  - No lookahead, no backfill from recompute: only the live daily append is a
 *    truly frozen observation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FRAGILITY_THRESHOLD, type FragilityResult } from '../services/purpleFragility.js';
import logger from './logger.js';

/** The OOS clock starts the day the current rule-set (model v2 + dual-tier
 *  triggers, PR #82) locked. Only rows on/after this date count toward the
 *  scorecard's real out-of-sample precision. */
export const OOS_START = '2026-07-19';

/** Default "a real drawdown followed" threshold (% off the running peak). */
export const OOS_DROP_THRESHOLD = 8;
/** Default forward windows (trading days = subsequent log rows). */
export const OOS_HORIZONS = [15, 25, 40] as const;

export const OOS_COLUMNS = [
    'scan_date', 'score', 'core3', 'climax', 'capitulation',
    'index_value', 'drawdown_pct', 'index_near_high',
    'alert', 'watch', 'alert_cross', 'watch_cross', 'watch_trigger', 'logged_at',
] as const;

export interface OosRow {
    scan_date: string;
    score: number | null;
    core3: number | null;
    climax: number | null;
    capitulation: number | null;
    index_value: number | null;
    drawdown_pct: number | null;
    index_near_high: 0 | 1;
    /** 🔴 Alert condition HELD this day (score>=1.0 AND near-high). */
    alert: 0 | 1;
    /** 🟡 Watch condition HELD this day (core3>=1.0 OR climax>=1.5+near-high). */
    watch: 0 | 1;
    /** 🔴 Alert NEWLY fired this day (the real crossing / Telegram alert). */
    alert_cross: 0 | 1;
    /** 🟡 Watch NEWLY fired this day. */
    watch_cross: 0 | 1;
    watch_trigger: string; // '', 'core3', 'climax', 'both'
    logged_at: string;
}

const b = (v: boolean): 0 | 1 => (v ? 1 : 0);

/**
 * Build the frozen row from the day's fragility result. Pure — no IO.
 * `alert`/`watch` are the HELD states; `*_cross` are the newly-fired events
 * carried straight from the engine (computed against the full series that day).
 */
export function buildOosRow(result: FragilityResult, scanDate: string, stamp: string): OosRow {
    const d = result.latest;
    const alertHeld = result.indexNearHigh && d.score != null && d.score >= FRAGILITY_THRESHOLD;
    const watchHeld = result.watchTrigger != null;
    return {
        scan_date: scanDate,
        score: d.score,
        core3: d.core3,
        climax: d.climax,
        capitulation: d.capitulation,
        index_value: d.indexValue,
        drawdown_pct: d.drawdownPct,
        index_near_high: b(result.indexNearHigh),
        alert: b(alertHeld),
        watch: b(watchHeld),
        alert_cross: b(result.crossedUp),
        watch_cross: b(result.core3CrossedUp),
        watch_trigger: result.watchTrigger ?? '',
        logged_at: stamp,
    };
}

const numCell = (v: number | null, digits: number): string =>
    v == null ? '' : (Math.round(v * 10 ** digits) / 10 ** digits).toString();

export function oosRowToCsv(r: OosRow): string {
    return [
        r.scan_date,
        numCell(r.score, 4), numCell(r.core3, 4), numCell(r.climax, 4), numCell(r.capitulation, 4),
        numCell(r.index_value, 4), numCell(r.drawdown_pct, 2), r.index_near_high,
        r.alert, r.watch, r.alert_cross, r.watch_cross, r.watch_trigger, r.logged_at,
    ].join(',');
}

/** Parse the CSV back to rows. Tolerant of a missing/short line (returns []). */
export function parseOosCsv(text: string): OosRow[] {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length <= 1) return [];
    const num = (s: string): number | null => (s === '' ? null : Number(s));
    const rows: OosRow[] = [];
    for (const line of lines.slice(1)) {
        const c = line.split(',');
        if (c.length < OOS_COLUMNS.length) continue;
        rows.push({
            scan_date: c[0]!,
            score: num(c[1]!), core3: num(c[2]!), climax: num(c[3]!), capitulation: num(c[4]!),
            index_value: num(c[5]!), drawdown_pct: num(c[6]!),
            index_near_high: (c[7] === '1' ? 1 : 0),
            alert: (c[8] === '1' ? 1 : 0), watch: (c[9] === '1' ? 1 : 0),
            alert_cross: (c[10] === '1' ? 1 : 0), watch_cross: (c[11] === '1' ? 1 : 0),
            watch_trigger: c[12] ?? '', logged_at: c[13] ?? '',
        });
    }
    return rows;
}

/** Serialize rows (sorted by date) to a full CSV document with header. */
export function oosRowsToCsv(rows: OosRow[]): string {
    const sorted = [...rows].sort((x, y) => (x.scan_date < y.scan_date ? -1 : x.scan_date > y.scan_date ? 1 : 0));
    return [OOS_COLUMNS.join(','), ...sorted.map(oosRowToCsv)].join('\n') + '\n';
}

/** Upsert `row` into the row list by scan_date (replace-in-place or append). Pure. */
export function upsertOosRow(existing: OosRow[], row: OosRow): OosRow[] {
    const out = existing.filter((r) => r.scan_date !== row.scan_date);
    out.push(row);
    return out;
}

const OOS_FILE = 'oos_log.csv';

/**
 * Append (or replace) the day's frozen row in results/oos_log.csv.
 * Never throws — a no-op when the fragility compute failed today.
 */
export function appendOosLogRow(
    result: FragilityResult | null,
    scanDate: string,
    dir: string,
    stamp = new Date().toISOString()
): boolean {
    try {
        if (!result || result.latest?.score == null) return false;
        const file = path.join(dir, OOS_FILE);
        let existing: OosRow[] = [];
        if (fs.existsSync(file)) {
            existing = parseOosCsv(fs.readFileSync(file, 'utf-8'));
        }
        const row = buildOosRow(result, scanDate, stamp);
        const merged = upsertOosRow(existing, row);
        fs.writeFileSync(file, oosRowsToCsv(merged));
        logger.info(`🟣 OOS log: row for ${scanDate} written (${merged.length} rows, OOS since ${OOS_START})`);
        return true;
    } catch (err) {
        logger.warn(`🟣 OOS log append failed (non-fatal): ${(err as Error).message}`);
        return false;
    }
}

export interface OosTierEval {
    crossings: number;
    pending: number;
    precision: Record<number, number | null>;
    matured: Record<number, { hits: number; matured: number }>;
    events: Array<{ date: string; hit: Record<number, boolean | null>; minDrawdown: Record<number, number | null> }>;
}

export interface OosScorecard {
    oosStart: string;
    dropThreshold: number;
    horizons: number[];
    totalRows: number;
    oosRows: number;
    firstOos: string | null;
    lastOos: string | null;
    latest: OosRow | null;
    alert: OosTierEval;
    watch: OosTierEval;
}

/**
 * Evaluate the frozen log: for each OOS crossing, did a drawdown of at least
 * `dropThreshold`% off the peak follow within each horizon? Only crossings with
 * enough subsequent rows count toward that horizon's precision; the rest are
 * "pending" (not yet matured). Pure — the scorecard script is a thin IO wrapper.
 */
export function evaluateOosScorecard(
    rows: OosRow[],
    opts: { start?: string; dropThreshold?: number; horizons?: number[] } = {}
): OosScorecard {
    const start = opts.start ?? OOS_START;
    const drop = opts.dropThreshold ?? OOS_DROP_THRESHOLD;
    const horizons = opts.horizons ?? [...OOS_HORIZONS];
    const sorted = [...rows].sort((a, c) => (a.scan_date < c.scan_date ? -1 : a.scan_date > c.scan_date ? 1 : 0));
    const oos = sorted.filter((r) => r.scan_date >= start);

    const tier = (key: 'alert_cross' | 'watch_cross'): OosTierEval => {
        const matured: Record<number, { hits: number; matured: number }> = {};
        for (const h of horizons) matured[h] = { hits: 0, matured: 0 };
        const events: OosTierEval['events'] = [];
        let crossings = 0;
        let pending = 0;
        for (let i = 0; i < oos.length; i++) {
            if (oos[i]![key] !== 1) continue;
            crossings++;
            const forward = oos.slice(i + 1);
            const hit: Record<number, boolean | null> = {};
            const minDrawdown: Record<number, number | null> = {};
            let anyPending = false;
            for (const h of horizons) {
                const window = forward.slice(0, h);
                if (window.length < h) { hit[h] = null; minDrawdown[h] = null; anyPending = true; continue; }
                const dds = window.map((r) => r.drawdown_pct).filter((x): x is number => x != null);
                const minDd = dds.length ? Math.min(...dds) : 0;
                const isHit = minDd <= -drop;
                matured[h]!.matured++;
                if (isHit) matured[h]!.hits++;
                hit[h] = isHit;
                minDrawdown[h] = minDd;
            }
            if (anyPending) pending++;
            events.push({ date: oos[i]!.scan_date, hit, minDrawdown });
        }
        const precision: Record<number, number | null> = {};
        for (const h of horizons) precision[h] = matured[h]!.matured > 0 ? matured[h]!.hits / matured[h]!.matured : null;
        return { crossings, pending, precision, matured, events };
    };

    return {
        oosStart: start,
        dropThreshold: drop,
        horizons,
        totalRows: sorted.length,
        oosRows: oos.length,
        firstOos: oos[0]?.scan_date ?? null,
        lastOos: oos[oos.length - 1]?.scan_date ?? null,
        latest: sorted[sorted.length - 1] ?? null,
        alert: tier('alert_cross'),
        watch: tier('watch_cross'),
    };
}
