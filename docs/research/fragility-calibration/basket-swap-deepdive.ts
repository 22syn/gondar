/**
 * Deep-dive the swap-study shortlist: permutation significance + split-half
 * stability, so a promising cell from basket-swap-eval.ts isn't reported as
 * real before checking it survives the same scrutiny prior fragility studies
 * applied (n is small — 6-11 Alert events per basket, all clustered in the
 * same ~9-month live window).
 *
 * Run from repo root: npx tsx docs/research/fragility-calibration/basket-swap-deepdive.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildFragilityDays, type FragilityDay, type OhlcvSeries } from '../../../src/services/purpleFragility.js';
import { BASE } from './basket-swap-eval.js';

const raw: Record<string, OhlcvSeries> = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, 'basket-swap-raw.json'), 'utf-8')
);

function buildFor(tickers: string[]): FragilityDay[] {
    const series = tickers.map((t) => raw[t]!);
    return buildFragilityDays(series)!.days;
}

function basketDd(days: FragilityDay[], i: number, horizon: number): number | null {
    const base = days[i]!.indexValue;
    const path = days.slice(i + 1, i + 1 + horizon);
    if (path.length === 0) return null;
    return Math.min(...path.map((d) => d.indexValue / base - 1)) * 100;
}

function alertEvents(days: FragilityDay[]): number[] {
    const ev: number[] = [];
    for (let i = 0; i < days.length; i++) {
        const d = days[i]!, p = i > 0 ? days[i - 1]! : null;
        const fires = d.indexNearHigh && d.score != null && d.score >= 1.0;
        const pfires = p != null && p.indexNearHigh && p.score != null && p.score >= 1.0;
        if (fires && !pfires) ev.push(i);
    }
    return ev;
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

function icOf(days: FragilityDay[]): number | null {
    const xs: number[] = [], ys: number[] = [];
    days.forEach((d, i) => {
        if (d.score == null) return;
        const fwd = basketDd(days, i, 20);
        if (fwd != null) { xs.push(d.score); ys.push(fwd); }
    });
    return pearson(xs, ys);
}

function rate(days: FragilityDay[], idxs: number[], thresh: number, horizon: number): [number, number, number] {
    let hits = 0, tot = 0;
    for (const i of idxs) {
        const dd = basketDd(days, i, horizon);
        if (dd == null) continue;
        tot++;
        if (dd <= thresh) hits++;
    }
    return [hits, tot, tot ? (hits / tot) * 100 : NaN];
}

// Deterministic LCG so this is reproducible without Math.random.
function makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function permP(days: FragilityDay[], idxs: number[], thresh: number, horizon: number, nperm = 20000): number | null {
    const scored = days.map((_, i) => i).filter((i) => days[i]!.score != null);
    const N = scored.length;
    const posOf = new Map(scored.map((idx, pos) => [idx, pos]));
    const [, , obs] = rate(days, idxs, thresh, horizon);
    if (idxs.length === 0 || Number.isNaN(obs)) return null;
    const rng = makeRng(20260825);
    const positions = idxs.map((i) => posOf.get(i)!);
    let cnt = 0, valid = 0;
    for (let p = 0; p < nperm; p++) {
        const off = Math.floor(rng() * N);
        const shifted = positions.map((pos) => scored[(pos + off) % N]!);
        const [, tt, rr] = rate(days, shifted, thresh, horizon);
        if (tt === 0 || Number.isNaN(rr)) continue;
        valid++;
        if (rr >= obs) cnt++;
    }
    return valid ? (cnt + 1) / (valid + 1) : null;
}

function report(label: string, tickers: string[]): void {
    const days = buildFor(tickers);
    const ev = alertEvents(days);
    const [h, t, r] = rate(days, ev, -8, 20);
    const allIdx = days.map((_, i) => i).filter((i) => days[i]!.score != null);
    const base = rate(days, allIdx, -8, 20)[2];
    const lift = base ? r / base : NaN;
    const p = permP(days, ev, -8, 20);

    // Split-half: first half vs second half of the ALIGNED calendar (own regime each).
    const mid = Math.floor(days.length / 2);
    const halves: Array<[string, FragilityDay[]]> = [
        ['H1', days.slice(0, mid)],
        ['H2', days.slice(mid)],
    ];
    const halfStats = halves.map(([lbl, hd]) => {
        const hev = alertEvents(hd);
        const [hh, ht, hr] = rate(hd, hev, -8, 20);
        const hic = icOf(hd);
        return `${lbl} events:${hev.length} ${hh}/${ht}=${Number.isNaN(hr) ? 'n/a' : hr.toFixed(0) + '%'} IC=${hic != null ? hic.toFixed(3) : 'n/a'}`;
    });

    console.log(
        `  ${label.padEnd(20)} n=${ev.length.toString().padStart(2)}  ${h}/${t}=${r.toFixed(0).padStart(3)}%  ` +
        `lift=${lift.toFixed(2)}x  p=${p != null ? p.toFixed(4) : 'n/a'}  IC(full)=${icOf(days)?.toFixed(3) ?? 'n/a'}`
    );
    console.log(`  ${''.padEnd(20)} ${halfStats.join('  |  ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    console.log('Deep-dive: permutation significance + split-half stability');
    console.log('(basket<=-8% within 20 scan-days, base rate recomputed per basket)');
    console.log('='.repeat(100));
    report('BASE (current 10)', BASE);
    report('drop SEDG (9)', BASE.filter((t) => t !== 'SEDG'));
    report('AMKR->KLAC', BASE.map((t) => (t === 'AMKR' ? 'KLAC' : t)));
    report('AMKR->ASX', BASE.map((t) => (t === 'AMKR' ? 'ASX' : t)));
    report('AMKR->ENTG', BASE.map((t) => (t === 'AMKR' ? 'ENTG' : t)));
    report('AMKR->ASML', BASE.map((t) => (t === 'AMKR' ? 'ASML' : t)));
    report('AMKR->STM', BASE.map((t) => (t === 'AMKR' ? 'STM' : t)));
}
