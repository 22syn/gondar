#!/usr/bin/env npx tsx
/**
 * DRY-RUN (read-only): compare Sector values in the universe sheet vs the sector each
 * symbol would get from the friend's watchlists today. Writes nothing.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSharedWatchlistDetailed } from '../src/services/sharedWatchlist.js';
import { tvToYahoo } from '../src/services/symbolMap.js';
import { isIndex } from '../src/config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SHEET_ID = process.env.GOOGLE_SHEET_ID?.trim() ?? '1MstPA9TNElVDTq3UhztkL7BwUGHlktOBDC8HfG478vo';

interface Source { sector?: string; shareUrl: string; universeOnly?: boolean }

async function main(): Promise<void> {
    const sources: Source[] = JSON.parse(
        readFileSync(path.join(PROJECT_ROOT, 'watchlist-sources.json'), 'utf8'),
    );

    // Desired mapping from friend's lists (sector lists first, universeOnly mop up — same as the sync)
    const ordered = [...sources.filter((s) => !s.universeOnly), ...sources.filter((s) => s.universeOnly)];
    const desired = new Map<string, string>();
    for (const s of ordered) {
        const { name, symbols } = await fetchSharedWatchlistDetailed(s.shareUrl);
        const sector = s.sector ?? name ?? 'Other';
        for (const tv of symbols) {
            const yahoo = tvToYahoo(tv);
            if (!yahoo || isIndex(yahoo)) continue;
            const key = yahoo.toUpperCase();
            if (!desired.has(key)) desired.set(key, sector);
        }
    }

    // Sheet state via public CSV export (read-only, same path the radar uses)
    const csvUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;
    const csv = await (await fetch(csvUrl)).text();
    const lines = csv.split('\n').slice(1); // skip header
    const sheet = new Map<string, string[]>(); // symbol -> sectors (dups possible)
    for (const line of lines) {
        const [sym, sec = ''] = line.split(',').map((c) => c.replace(/^"|"$/g, '').trim());
        if (!sym) continue;
        const k = sym.toUpperCase();
        if (!sheet.has(k)) sheet.set(k, []);
        sheet.get(k)!.push(sec);
    }

    let match = 0;
    const mismatches: string[] = [];
    const emptySector: string[] = [];
    const notInFriend: string[] = [];
    for (const [sym, secs] of sheet) {
        const want = desired.get(sym);
        const have = secs[0] ?? '';
        if (!want) { notInFriend.push(sym); continue; }
        if (!have) { emptySector.push(`${sym} -> would be [${want}]`); continue; }
        if (have === want) match++;
        else mismatches.push(`${sym}: sheet=[${have}] friend=[${want}]${secs.length > 1 ? ` (dup rows: ${secs.join(' | ')})` : ''}`);
    }
    const missingFromSheet = [...desired.keys()].filter((k) => !sheet.has(k));

    console.log(`Sheet rows (unique symbols): ${sheet.size}`);
    console.log(`In friend's lists too: ${match + mismatches.length + emptySector.length}`);
    console.log(`  sector MATCHES: ${match}`);
    console.log(`  sector DIFFERS: ${mismatches.length}`);
    console.log(`  sheet sector EMPTY: ${emptySector.length}`);
    console.log(`Only in sheet (user-curated, not in friend's lists): ${notInFriend.length}`);
    console.log(`In friend's lists but missing from sheet: ${missingFromSheet.length} ${missingFromSheet.join(', ')}`);
    console.log('\n--- DIFFERS ---');
    for (const m of mismatches) console.log(m);
    console.log('\n--- EMPTY ---');
    for (const m of emptySector) console.log(m);
}

main().catch((e) => { console.error(e); process.exit(1); });
