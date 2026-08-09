#!/usr/bin/env npx tsx
/** READ-ONLY: list sheet symbols that appear in NO friend watchlist, with current sector. */
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
    const sources: Source[] = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'watchlist-sources.json'), 'utf8'));
    const ordered = [...sources.filter((s) => !s.universeOnly), ...sources.filter((s) => s.universeOnly)];

    const canonical = new Set<string>();
    const desired = new Set<string>();
    for (const s of ordered) {
        const { name, symbols } = await fetchSharedWatchlistDetailed(s.shareUrl);
        canonical.add(s.sector ?? name ?? 'Other');
        for (const tv of symbols) {
            const y = tvToYahoo(tv);
            if (!y || isIndex(y)) continue;
            desired.add(y.toUpperCase());
        }
    }

    const csv = await (await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`)).text();
    const rows = csv.split('\n').slice(1);
    const orphans: Array<[string, string]> = [];
    const seen = new Set<string>();
    for (const line of rows) {
        const [sym, sec = ''] = line.split(',').map((c) => c.replace(/^"|"$/g, '').trim());
        if (!sym) continue;
        const k = sym.toUpperCase();
        if (desired.has(k) || seen.has(k)) continue;
        seen.add(k);
        orphans.push([sym, sec]);
    }

    console.log('CANONICAL SECTORS (watchlist names):');
    console.log([...canonical].join(' | '));
    console.log(`\nORPHANS (in sheet, not in any friend watchlist): ${orphans.length}\n`);
    for (const [sym, sec] of orphans) console.log(`${sym.padEnd(12)} current=[${sec}]`);
}

main().catch((e) => { console.error(e); process.exit(1); });
