/**
 * Merge symbols into the radar universe Google Sheet (columns Symbol | Sector) via the
 * Sheets API. Appends symbols not already present and refreshes the Sector column so each
 * symbol matches the name of the source watchlist it belongs to today. Never deletes rows;
 * symbols that appear in no source watchlist keep their existing sector untouched. The
 * scan pipeline keeps reading this same sheet through its public CSV export.
 *
 * Auth: a service account, from GOOGLE_SHEETS_CREDENTIALS (path to JSON) or
 * GOOGLE_SHEETS_CREDENTIALS_JSON (raw JSON, e.g. a CI secret). The sheet must be shared
 * with the service-account email as Editor (and kept "anyone with link can view" so the
 * scan's CSV read keeps working).
 */
import { readFileSync } from 'node:fs';
import { google } from 'googleapis';
import type { sheets_v4 } from 'googleapis';

export interface UniverseRow {
    symbol: string;
    sector: string;
}

export interface SectorUpdate {
    /** 1-based row number in the sheet. */
    rowNumber: number;
    symbol: string;
    from: string;
    to: string;
}

export interface MergeResult {
    added: UniverseRow[];
    updated: SectorUpdate[];
    alreadyPresent: number;
}

interface ServiceAccount {
    client_email: string;
    private_key: string;
}

function loadCredentials(): ServiceAccount {
    const inline = process.env.GOOGLE_SHEETS_CREDENTIALS_JSON;
    if (inline && inline.trim()) {
        return JSON.parse(inline) as ServiceAccount;
    }
    const file = process.env.GOOGLE_SHEETS_CREDENTIALS;
    if (!file) {
        throw new Error(
            'Set GOOGLE_SHEETS_CREDENTIALS (path to the service-account JSON) or ' +
                'GOOGLE_SHEETS_CREDENTIALS_JSON (raw JSON, for CI).',
        );
    }
    return JSON.parse(readFileSync(file, 'utf8')) as ServiceAccount;
}

async function client(): Promise<sheets_v4.Sheets> {
    const creds = loadCredentials();
    const auth = new google.auth.JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    await auth.authorize();
    return google.sheets({ version: 'v4', auth });
}

/** Pure: keep only rows whose symbol is not already in `existing` (case-insensitive). */
export function selectNewRows(existing: Set<string>, rows: UniverseRow[]): UniverseRow[] {
    return rows.filter((r) => !existing.has(r.symbol.toUpperCase()));
}

/** Build an uppercase symbol set from a sheet's column-A values (skips the header). */
export function existingSymbolSet(colA: string[][]): Set<string> {
    const set = new Set<string>();
    for (let i = 0; i < colA.length; i++) {
        const v = (colA[i]?.[0] ?? '').trim();
        if (!v) continue;
        if (i === 0 && v.toLowerCase() === 'symbol') continue; // header
        set.add(v.toUpperCase());
    }
    return set;
}

/**
 * Pure: plan Sector-column rewrites so every sheet row whose symbol appears in `rows`
 * carries that row's sector (the source watchlist name). Rows for symbols not in `rows`
 * are left alone, an empty desired sector never overwrites anything, and duplicate sheet
 * rows for the same symbol are all updated.
 */
export function planSectorUpdates(grid: string[][], rows: UniverseRow[]): SectorUpdate[] {
    const desired = new Map<string, string>();
    for (const r of rows) {
        const sector = r.sector.trim();
        if (!sector) continue;
        const key = r.symbol.toUpperCase();
        if (!desired.has(key)) desired.set(key, sector);
    }

    const updates: SectorUpdate[] = [];
    for (let i = 0; i < grid.length; i++) {
        const symbol = (grid[i]?.[0] ?? '').trim();
        if (!symbol) continue;
        if (i === 0 && symbol.toLowerCase() === 'symbol') continue; // header
        const to = desired.get(symbol.toUpperCase());
        if (!to) continue;
        const from = (grid[i]?.[1] ?? '').trim();
        if (from === to) continue;
        updates.push({ rowNumber: i + 1, symbol, from, to });
    }
    return updates;
}

/**
 * Append the symbols not already in the first tab and align the Sector column of existing
 * rows to the current source watchlists. Never clears or deletes rows.
 */
export async function mergeUniverseSheet(sheetId: string, rows: UniverseRow[]): Promise<MergeResult> {
    const api = await client();
    const meta = await api.spreadsheets.get({ spreadsheetId: sheetId });
    const firstTab = meta.data.sheets?.[0]?.properties?.title;
    if (!firstTab) throw new Error('universe sheet: no tabs found');

    const existingRes = await api.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${firstTab}'!A:B`,
    });
    const grid = (existingRes.data.values ?? []) as string[][];
    const existing = existingSymbolSet(grid);
    const sheetEmpty = grid.length === 0;

    const updated = planSectorUpdates(grid, rows);
    if (updated.length > 0) {
        await api.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetId,
            requestBody: {
                valueInputOption: 'RAW',
                data: updated.map((u) => ({
                    range: `'${firstTab}'!B${u.rowNumber}`,
                    values: [[u.to]],
                })),
            },
        });
    }

    const added = selectNewRows(existing, rows);
    if (added.length === 0) {
        return { added: [], updated, alreadyPresent: rows.length };
    }

    const values = added.map((r) => [r.symbol, r.sector]);
    if (sheetEmpty) values.unshift(['Symbol', 'Sector']); // seed header on a blank sheet

    await api.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: `'${firstTab}'!A:B`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
    });
    return { added, updated, alreadyPresent: rows.length - added.length };
}
