#!/usr/bin/env npx tsx
/**
 * Smart Volume Radar — populate the universe sheet from a friend's shared TradingView
 * watchlists (one watchlist per sector). Runs in CI before the daily scan, or manually
 * via `npm run sync-friend-watchlists`. No browser/login — reads public share pages.
 *
 * Env: GOOGLE_SHEET_ID (target), and one of GOOGLE_SHEETS_CREDENTIALS /
 * GOOGLE_SHEETS_CREDENTIALS_JSON (service account). Sources: watchlist-sources.json.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../src/utils/logger.js';
import { fetchSharedWatchlistDetailed } from '../src/services/sharedWatchlist.js';
import { tvToYahoo } from '../src/services/symbolMap.js';
import { isIndex } from '../src/config/index.js';
import { mergeUniverseSheet, type UniverseRow } from '../src/services/universeSheetWriter.js';

interface Source {
    /** Optional explicit sector label; defaults to the watchlist's own name. */
    sector?: string;
    shareUrl: string;
    /**
     * Broad membership lists (e.g. the TLV-125 index): their symbols join the universe,
     * but their name becomes the sector only for symbols in no other watchlist.
     */
    universeOnly?: boolean;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function loadSources(): Source[] {
    const file = path.join(PROJECT_ROOT, 'watchlist-sources.json');
    let raw: string;
    try {
        raw = readFileSync(file, 'utf8');
    } catch {
        throw new Error(`Cannot read ${file}. Copy watchlist-sources.example.json and fill it in.`);
    }
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error('watchlist-sources.json must be a JSON array');
    return data.map((row, i) => {
        const r = row as Record<string, unknown>;
        if (typeof r.shareUrl !== 'string' || !r.shareUrl.trim()) {
            throw new Error(`watchlist-sources[${i}]: "shareUrl" must be a non-empty string`);
        }
        const sector = typeof r.sector === 'string' && r.sector.trim() ? r.sector.trim() : undefined;
        return { sector, shareUrl: r.shareUrl.trim(), universeOnly: r.universeOnly === true };
    });
}

async function main(): Promise<void> {
    const sheetId = process.env.GOOGLE_SHEET_ID?.trim();
    if (!sheetId) throw new Error('GOOGLE_SHEET_ID is required (target universe sheet).');

    const sources = loadSources();
    const seen = new Set<string>();
    const rows: UniverseRow[] = [];
    const skipped: string[] = [];
    let failures = 0;

    // Sector lists claim symbols first (in file order); universeOnly lists only mop up.
    const ordered = [...sources.filter((s) => !s.universeOnly), ...sources.filter((s) => s.universeOnly)];
    for (const s of ordered) {
        const label = s.sector ?? s.shareUrl;
        try {
            const { name, symbols: tvSymbols } = await fetchSharedWatchlistDetailed(s.shareUrl);
            const sector = s.sector ?? name ?? 'Other';
            if (tvSymbols.length === 0) {
                logger.warn(`${sector}: read 0 symbols — skipping this source (suspected fetch/parse miss)`);
                failures++;
                continue;
            }
            let added = 0;
            for (const tv of tvSymbols) {
                const yahoo = tvToYahoo(tv);
                if (!yahoo) {
                    skipped.push(`${tv} (${sector})`);
                    continue;
                }
                if (isIndex(yahoo)) {
                    skipped.push(`${tv}→${yahoo} index (${sector})`);
                    continue;
                }
                const key = yahoo.toUpperCase();
                if (seen.has(key)) continue; // first sector wins, mirrors loadWatchlist dedup
                seen.add(key);
                rows.push({ symbol: yahoo, sector });
                added++;
            }
            logger.info(`${sector}: ${added} symbols (${tvSymbols.length} read)`);
        } catch (e) {
            logger.error(`${label}: ${(e as Error).message}`);
            failures++;
        }
    }

    if (skipped.length > 0) {
        logger.warn(`Skipped ${skipped.length} unmapped symbols: ${skipped.join(', ')}`);
    }
    if (rows.length === 0) {
        logger.warn('No symbols resolved from any source — nothing to merge.');
        if (failures > 0) process.exitCode = 1;
        return;
    }

    const { added, updated, alreadyPresent } = await mergeUniverseSheet(sheetId, rows);
    logger.info(
        `Universe sheet merged: +${added.length} new, ${updated.length} sector updates, ` +
            `${alreadyPresent} already present ` +
            `(from ${rows.length} resolved across ${sources.length - failures}/${sources.length} sources).`,
    );
    if (added.length > 0) {
        logger.info(`Added: ${added.map((r) => `${r.symbol} [${r.sector}]`).join(', ')}`);
    }
    if (updated.length > 0) {
        logger.info(
            `Sector updates: ${updated.map((u) => `${u.symbol} [${u.from || '(empty)'}→${u.to}]`).join(', ')}`,
        );
    }
    if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
    logger.error(`fatal: ${(e as Error).message}`);
    process.exit(1);
});
