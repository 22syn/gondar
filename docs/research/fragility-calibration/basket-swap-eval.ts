/**
 * Swap study: does replacing SEDG and/or AMKR in the Purple basket produce a
 * stronger fragility signal? Reuses the production buildFragilityDays on
 * arbitrary ticker subsets of basket-swap-raw.json (basket-swap-fetch.ts).
 * Alert/Watch thresholds are held fixed at the locked production values
 * (score>=1.0 AND nearHigh(2%); core3>=1.0) — this measures whether a
 * different basket produces a better signal under the SAME rule, not a
 * re-tuned one. See basket-swap-deepdive.ts before trusting any cell here —
 * this pass alone doesn't check regime stability or significance.
 *
 * Run from repo root: npx tsx docs/research/fragility-calibration/basket-swap-eval.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildFragilityDays, type FragilityDay, type OhlcvSeries } from '../../../src/services/purpleFragility.js';
import { CANDIDATES } from './basket-swap-fetch.js';

const raw: Record<string, OhlcvSeries> = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, 'basket-swap-raw.json'), 'utf-8')
);

export const BASE = ['SMTC', 'AMKR', 'CRDO', 'IFX', 'MRVL', 'MU', 'ONTO', 'SEDG', 'SNDK', 'TSM'];

function evalBasket(tickers: string[]): { days: FragilityDay[]; tickers: string[] } | null {
    const series = tickers.map((t) => raw[t]).filter((s): s is OhlcvSeries => s != null);
    if (series.length !== tickers.length) return null;
    return buildFragilityDays(series);
}

function basketDd(days: FragilityDay[], i: number, horizon: number): number | null {
    const base = days[i]!.indexValue;
    const path = days.slice(i + 1, i + 1 + horizon);
    if (path.length === 0) return null;
    return Math.min(...path.map((d) => d.indexValue / base - 1)) * 100;
}

function pearson(xs: number[], ys: number[]): number | null {
    const n = xs.length;
    if (n < 10) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
        num += (xs[i]! - mx) * (ys[i]! - my);
        dx += (xs[i]! - mx) ** 2;
        dy += (ys[i]! - my) ** 2;
    }
    if (dx === 0 || dy === 0) return null;
    return num / Math.sqrt(dx * dy);
}

function evalConfig(label: string, tickers: string[]): void {
    const built = evalBasket(tickers);
    if (!built) { console.log(`  ${label}: FAILED (missing series)`); return; }
    const { days } = built;
    const scored = days.filter((d) => d.score != null);
    if (scored.length < 100) { console.log(`  ${label}: only ${scored.length} scored days, skipping`); return; }

    const icPairs: Array<[number, number]> = [];
    days.forEach((d, i) => {
        if (d.score == null) return;
        const fwd = basketDd(days, i, 20);
        if (fwd != null) icPairs.push([d.score, fwd]);
    });
    const ic = pearson(icPairs.map((p) => p[0]), icPairs.map((p) => p[1]));

    const alertEvents: number[] = [];
    const watchEvents: number[] = [];
    for (let i = 0; i < days.length; i++) {
        const d = days[i]!, p = i > 0 ? days[i - 1]! : null;
        const fires = d.indexNearHigh && d.score != null && d.score >= 1.0;
        const pfires = p != null && p.indexNearHigh && p.score != null && p.score >= 1.0;
        if (fires && !pfires) alertEvents.push(i);
        const w = d.core3 != null && d.core3 >= 1.0;
        const pw = p != null && p.core3 != null && p.core3 >= 1.0;
        if (w && !pw) watchEvents.push(i);
    }

    const allIdx = days.map((_, i) => i).filter((i) => days[i]!.score != null);
    const rate = (idxs: number[], thresh: number, horizon: number): [number, number, number] => {
        let hits = 0, tot = 0;
        for (const i of idxs) {
            const dd = basketDd(days, i, horizon);
            if (dd == null) continue;
            tot++;
            if (dd <= thresh) hits++;
        }
        return [hits, tot, tot ? (hits / tot) * 100 : NaN];
    };
    const baseRate = rate(allIdx, -8, 20)[2];
    const [ah, at, ar] = rate(alertEvents, -8, 20);
    const [wh, wt, wr] = rate(watchEvents, -8, 20);
    const alertLift = baseRate ? ar / baseRate : NaN;
    const watchLift = baseRate ? wr / baseRate : NaN;

    console.log(
        `  ${label.padEnd(28)} days=${days.length.toString().padStart(4)}(${scored.length} scored)  ` +
        `IC=${ic != null ? ic.toFixed(3).padStart(6) : '  n/a'}  ` +
        `Alert n=${alertEvents.length.toString().padStart(2)} ${ah}/${at}=${ar.toFixed(0).padStart(3)}% (${alertLift.toFixed(2)}x)  ` +
        `Watch n=${watchEvents.length.toString().padStart(2)} ${wh}/${wt}=${wr.toFixed(0).padStart(3)}% (${watchLift.toFixed(2)}x)`
    );
}

if (import.meta.url === `file://${process.argv[1]}`) {
    console.log('='.repeat(100));
    console.log('BASELINE + LEAVE-ONE-OUT');
    console.log('='.repeat(100));
    evalConfig('BASE (current 10)', BASE);
    evalConfig('drop SEDG (9)', BASE.filter((t) => t !== 'SEDG'));
    evalConfig('drop AMKR (9)', BASE.filter((t) => t !== 'AMKR'));

    console.log();
    console.log('='.repeat(100));
    console.log('SEDG -> candidate');
    console.log('='.repeat(100));
    for (const c of CANDIDATES) {
        if (BASE.includes(c)) continue;
        evalConfig(`SEDG->${c}`, BASE.map((t) => (t === 'SEDG' ? c : t)));
    }

    console.log();
    console.log('='.repeat(100));
    console.log('AMKR -> candidate');
    console.log('='.repeat(100));
    for (const c of CANDIDATES) {
        if (BASE.includes(c)) continue;
        evalConfig(`AMKR->${c}`, BASE.map((t) => (t === 'AMKR' ? c : t)));
    }
}
