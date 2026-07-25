/**
 * Standalone OOS-log append (no Telegram, no full scan, no D1).
 *
 * Computes the fragility result as of the last trading day and appends the
 * frozen row to results/oos_log.csv. The daily scan already does this inline
 * (src/index.ts); this script is for seeding the log the first time and for
 * manually backfilling a day the scan missed. Fragility uses Yahoo only, so no
 * Cloudflare or Telegram env is required.
 *
 * Run: npx tsx scripts/oos-log.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePurpleFragility } from '../src/services/purpleFragility.js';
import { appendOosLogRow } from '../src/utils/oosLog.js';
import { getLastTradingDay } from '../src/utils/tradingDate.js';
import logger from '../src/utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(__dirname, '..', 'results');

async function main(): Promise<void> {
    const scanDate = getLastTradingDay();
    const result = await computePurpleFragility(scanDate);
    if (!result) {
        logger.error('Fragility compute returned null — nothing logged');
        process.exit(1);
    }
    const ok = appendOosLogRow(result, scanDate, resultsDir);
    if (!ok) {
        logger.error('OOS log append failed or skipped');
        process.exit(1);
    }
    logger.info(`✅ OOS row appended for ${scanDate}`);
}

main().catch((err) => {
    logger.error('oos-log failed:', (err as Error).message);
    process.exit(1);
});
