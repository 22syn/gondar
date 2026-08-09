#!/usr/bin/env npx tsx
/**
 * One-off: fold every sheet row whose Sector is NOT one of the canonical watchlist names
 * (nor already "Others") into the "Others" catch-all. These are symbols in no friend
 * watchlist that have no natural canonical home. Updates only column B of matching rows;
 * never deletes. Dry-run by default; pass --apply to write.
 * Auth: GOOGLE_SHEET_ID + GOOGLE_SHEETS_CREDENTIALS (service-account JSON path).
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { google } from 'googleapis';

const OTHERS = 'Others';
const CANONICAL = new Set([
    'מניב', 'מגורים', 'Space', 'Software', 'Semiconductor', 'Oil - Related', 'Finance',
    'ETF - world', 'ETF - US', 'Defense&Aerspace', 'Data Centers', 'Cyber', 'Cruise',
    'commodities', 'cleantech', 'Chemicals', 'BASIC', 'Banks', 'Airlines', 'AI - Chain',
    'OIL', 'Housing', 'gas stations', 'Food chain', 'TLV - 125',
]);

async function main(): Promise<void> {
    const sheetId = process.env.GOOGLE_SHEET_ID?.trim();
    if (!sheetId) throw new Error('GOOGLE_SHEET_ID is required.');
    const keyPath = process.env.GOOGLE_SHEETS_CREDENTIALS?.trim();
    if (!keyPath) throw new Error('GOOGLE_SHEETS_CREDENTIALS (service-account JSON path) is required.');
    const creds = JSON.parse(readFileSync(keyPath, 'utf8')) as { client_email: string; private_key: string };

    const auth = new google.auth.JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    await auth.authorize();
    const api = google.sheets({ version: 'v4', auth });

    const meta = await api.spreadsheets.get({ spreadsheetId: sheetId });
    const tab = meta.data.sheets?.[0]?.properties?.title;
    if (!tab) throw new Error('no tabs found');

    const res = await api.spreadsheets.values.get({ spreadsheetId: sheetId, range: `'${tab}'!A:B` });
    const grid = (res.data.values ?? []) as string[][];

    const updates: Array<{ row: number; symbol: string; from: string }> = [];
    for (let i = 0; i < grid.length; i++) {
        const sym = (grid[i]?.[0] ?? '').trim();
        if (!sym) continue;
        if (i === 0 && sym.toLowerCase() === 'symbol') continue; // header
        const sec = (grid[i]?.[1] ?? '').trim();
        if (!sec) continue; // leave truly-empty rows alone
        if (CANONICAL.has(sec) || sec === OTHERS) continue;
        updates.push({ row: i + 1, symbol: sym, from: sec });
    }

    console.log(`Planned ${updates.length} -> "${OTHERS}":`);
    for (const u of updates) console.log(`  B${u.row}  ${u.symbol.padEnd(12)} [${u.from}] -> [${OTHERS}]`);

    if (process.argv.includes('--apply') && updates.length) {
        await api.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetId,
            requestBody: {
                valueInputOption: 'RAW',
                data: updates.map((u) => ({ range: `'${tab}'!B${u.row}`, values: [[OTHERS]] })),
            },
        });
        console.log('APPLIED.');
    } else if (!process.argv.includes('--apply')) {
        console.log('DRY-RUN (pass --apply to write).');
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
