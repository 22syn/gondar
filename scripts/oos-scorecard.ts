/**
 * OOS Scorecard — reads the frozen results/oos_log.csv and reports the gauge's
 * true out-of-sample track record: for each real alert/watch crossing since
 * {@link OOS_START}, did a drawdown of >= threshold% off the peak actually
 * follow within 15/25/40 trading days? Crossings without enough forward data
 * yet are counted as "pending" (not scored). Read-only.
 *
 * Run: npx tsx scripts/oos-scorecard.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    parseOosCsv, evaluateOosScorecard, OOS_START, OOS_DROP_THRESHOLD,
    type OosScorecard, type OosTierEval,
} from '../src/utils/oosLog.js';
import logger from '../src/utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, '..', 'results', 'oos_log.csv');

const pct = (v: number | null): string => (v == null ? '  —  ' : `${(v * 100).toFixed(0)}%`.padStart(5));

function printTier(name: string, t: OosTierEval, horizons: number[]): void {
    logger.info(`  ${name}: ${t.crossings} crossing(s), ${t.pending} still pending (not enough forward data)`);
    const cells = horizons.map((h) => {
        const m = t.matured[h]!;
        return `@${h}d ${pct(t.precision[h] ?? null)} (${m.hits}/${m.matured})`;
    });
    logger.info(`     precision: ${cells.join('   ')}`);
    for (const e of t.events) {
        const marks = horizons.map((h) => `${h}d:${e.hit[h] == null ? '…' : e.hit[h] ? 'HIT' : 'miss'}`).join(' ');
        logger.info(`     ${e.date}  ${marks}`);
    }
}

function main(): void {
    if (!fs.existsSync(file)) {
        logger.warn(`No OOS log yet at ${file} — run the daily scan or scripts/oos-log.ts to start it.`);
        return;
    }
    const rows = parseOosCsv(fs.readFileSync(file, 'utf-8'));
    const s: OosScorecard = evaluateOosScorecard(rows);

    logger.info('━━━━━ OOS SCORECARD (Purple Fragility) ━━━━━');
    logger.info(`OOS clock start: ${OOS_START} | drop threshold: -${OOS_DROP_THRESHOLD}% off peak`);
    logger.info(`Log rows: ${s.totalRows} total, ${s.oosRows} in-window (${s.firstOos ?? '—'} .. ${s.lastOos ?? '—'})`);
    if (s.latest) {
        const l = s.latest;
        const state = l.alert ? '🔴 Alert' : l.watch ? '🟡 Watch' : '🟢 quiet';
        logger.info(
            `Latest (${l.scan_date}): score ${l.score?.toFixed(2) ?? '—'} | ${state} | ` +
            `DD ${l.drawdown_pct?.toFixed(1) ?? '—'}% | nearHigh ${l.index_near_high ? 'yes' : 'no'}`
        );
    }
    if (s.oosRows === 0) {
        logger.info('No out-of-sample rows yet — accumulating. Re-run after more trading days.');
        return;
    }
    printTier('🔴 Alert', s.alert, s.horizons);
    printTier('🟡 Watch', s.watch, s.horizons);

    const maturedAlert = s.horizons.some((h) => s.alert.matured[h]!.matured > 0);
    const maturedWatch = s.horizons.some((h) => s.watch.matured[h]!.matured > 0);
    if (!maturedAlert && !maturedWatch) {
        logger.info('');
        logger.info('Note: no crossing has matured yet (need ≥15 trading days of forward data');
        logger.info('after a crossing). Numbers will populate as the window fills.');
    }
}

main();
