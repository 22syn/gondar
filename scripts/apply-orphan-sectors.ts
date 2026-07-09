#!/usr/bin/env npx tsx
/**
 * One-off: assign canonical sectors to a fixed set of symbols that are in NO friend
 * watchlist (so the weekly sync never touches them). Updates only column B of the exact
 * rows whose symbol matches (case-insensitive, all duplicate rows). Never deletes.
 * Auth: GOOGLE_SHEET_ID + GOOGLE_SHEETS_CREDENTIALS (service-account JSON path).
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { google } from 'googleapis';

// symbol (uppercase) -> canonical sector
const MAP: Record<string, string> = {
    'RENK.VI': 'Defense&Aerspace',
    'NW0.HM': 'Defense&Aerspace',
    BAESY: 'Defense&Aerspace',
    TXT: 'Defense&Aerspace',
    SOLS: 'Chemicals',
    EXE: 'OIL',
    LEU: 'cleantech',
    ASTS: 'Space',
    WMT: 'BASIC',
    COST: 'BASIC',
    IBIT: 'Finance',
};

async function main(): Promise<void> {
    const sheetId = process.env.GOOGLE_SHEET_ID?.trim();
    if (!sheetId) throw new Error('GOOGLE_SHEET_ID is required.');
    const keyPath = process.env.GOOGLE_SHEETS_CREDENTIALS?.trim();
    if (!keyPath) throw new Error('GOOGLE_SHEETS_CREDENTIALS (path to service-account JSON) is required.');
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

    const want = new Map(Object.entries(MAP).map(([k, v]) => [k.toUpperCase(), v]));
    const updates: Array<{ row: number; symbol: string; from: string; to: string }> = [];
    for (let i = 0; i < grid.length; i++) {
        const sym = (grid[i]?.[0] ?? '').trim();
        if (!sym) continue;
        const to = want.get(sym.toUpperCase());
        if (!to) continue;
        const from = (grid[i]?.[1] ?? '').trim();
        if (from === to) continue;
        updates.push({ row: i + 1, symbol: sym, from, to });
    }

    const found = new Set(updates.map((u) => u.symbol.toUpperCase()));
    const missing = [...want.keys()].filter((k) => !grid.some((r) => (r?.[0] ?? '').trim().toUpperCase() === k));

    console.log(`Planned ${updates.length} update(s):`);
    for (const u of updates) console.log(`  B${u.row}  ${u.symbol.padEnd(12)} [${u.from || '(empty)'}] -> [${u.to}]`);
    if (missing.length) console.log(`Symbols not present in sheet (skipped): ${missing.join(', ')}`);

    if (process.argv.includes('--apply') && updates.length) {
        await api.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetId,
            requestBody: {
                valueInputOption: 'RAW',
                data: updates.map((u) => ({ range: `'${tab}'!B${u.row}`, values: [[u.to]] })),
            },
        });
        console.log('APPLIED.');
    } else if (!process.argv.includes('--apply')) {
        console.log('DRY-RUN (pass --apply to write).');
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
