#!/usr/bin/env npx tsx
/**
 * Evaluate full setup (🎯) signals from last 7 days.
 * Downloads artifacts via gh CLI, fetches current prices, outputs for Telegram.
 * Run: npm run evaluate-setups
 * Env: GITHUB_TOKEN (or GH_TOKEN), plus FINNHUB/TELEGRAM etc for fetch
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { StoredScanResult } from '../src/types/index.js';
import { fetchAllStocks } from '../src/services/marketData.js';

const LOOKBACK_DAYS = 7;

interface FullSignal {
    ticker: string;
    date: string;
    priceThen: number;
}

interface OutputRow {
    ticker: string;
    date: string;
    priceThen: number;
    priceNow: number | null;
    changePct: number | null;
    days: number;
}

function findScanJsonFiles(resultsDir: string): Array<{ path: string; date: string }> {
    const pairs: Array<{ path: string; date: string }> = [];
    const seen = new Set<string>();

    function add(date: string, filePath: string): void {
        if (seen.has(date)) return;
        seen.add(date);
        pairs.push({ path: filePath, date });
    }

    const entries = fs.readdirSync(resultsDir, { withFileTypes: true });
    for (const e of entries) {
        if (e.isFile() && /^scan-\d{4}-\d{2}-\d{2}\.json$/.test(e.name)) {
            const date = e.name.replace(/^scan-/, '').replace(/\.json$/, '');
            add(date, path.join(resultsDir, e.name));
        }
        if (e.isDirectory() && /^scan-\d{4}-\d{2}-\d{2}$/.test(e.name)) {
            const date = e.name.replace(/^scan-/, '');
            const nested = path.join(resultsDir, e.name, `scan-${date}.json`);
            if (fs.existsSync(nested)) {
                add(date, nested);
            }
        }
    }
    return pairs;
}

function formatTelegramMessage(data: {
    rows: OutputRow[];
    avgChange: number;
    total: number;
}): string {
    if (data.total === 0) {
        return '📊 הערכת Setup מלא (7 ימים)\n\nלא נמצאו Setup מלא (🎯) ב־7 הימים האחרונים.';
    }
    const lines = [
        '📊 הערכת Setup מלא (7 ימים)',
        '',
        'TICKER | תאריך | מחיר אז | מחיר עכשיו | Δ% | ימים',
        ...data.rows.map((r) => {
            const now = r.priceNow != null ? r.priceNow.toFixed(2) : 'N/A';
            const ch =
                r.changePct != null
                    ? `${r.changePct >= 0 ? '+' : ''}${r.changePct.toFixed(1)}%`
                    : 'N/A';
            return `${r.ticker} | ${r.date} | ${r.priceThen.toFixed(2)} | ${now} | ${ch} | ${r.days}`;
        }),
        '',
        `סה"כ: ${data.total} אותות | ממוצע: ${data.avgChange.toFixed(1)}%`,
    ];
    return lines.join('\n');
}

async function main(): Promise<void> {
    const resultsDir = path.join(process.cwd(), 'results');

    // Clean and recreate results dir for fresh downloads
    if (fs.existsSync(resultsDir)) {
        fs.rmSync(resultsDir, { recursive: true });
    }
    fs.mkdirSync(resultsDir, { recursive: true });

    // 1. Get last 7 successful daily-scan runs
    const runsJson = execSync(
        `gh run list --workflow daily-scan.yml --limit 15 --json databaseId,conclusion,createdAt`,
        { encoding: 'utf-8' }
    );
    const runs = JSON.parse(runsJson) as Array<{
        databaseId: number;
        conclusion: string;
        createdAt: string;
    }>;
    const successful = runs.filter((r) => r.conclusion === 'success').slice(0, LOOKBACK_DAYS);

    for (const run of successful) {
        try {
            execSync(`gh run download ${run.databaseId} -D ${resultsDir}`, { stdio: 'pipe' });
        } catch {
            // Skip if artifact missing for this run
        }
    }

    // 2. Load JSONs, extract full setups, filter by date
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);

    const fullSignals: FullSignal[] = [];
    const jsonFiles = findScanJsonFiles(resultsDir);

    for (const { path: filePath, date } of jsonFiles) {
        if (new Date(date) < cutoff) continue;
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as StoredScanResult;
        for (const s of data.signals) {
            fullSignals.push({ ticker: s.ticker, date, priceThen: s.lastPrice });
        }
    }

    // 3. No full setups → output Hebrew message and exit
    if (fullSignals.length === 0) {
        const formatted = formatTelegramMessage({ rows: [], avgChange: 0, total: 0 });
        console.log(formatted);
        return;
    }

    // 4. Fetch current prices
    const uniqueTickers = [...new Set(fullSignals.map((s) => s.ticker))];
    const { stocks } = await fetchAllStocks(uniqueTickers);
    const priceMap = new Map(stocks.map((s) => [s.ticker, s.lastPrice]));

    // 5. Build output rows
    const now = new Date();
    const rows: OutputRow[] = fullSignals.map((s) => {
        const priceNow = priceMap.get(s.ticker) ?? null;
        const changePct =
            priceNow != null ? ((priceNow - s.priceThen) / s.priceThen) * 100 : null;
        const days = Math.floor(
            (now.getTime() - new Date(s.date).getTime()) / (24 * 60 * 60 * 1000)
        );
        return {
            ticker: s.ticker,
            date: s.date,
            priceThen: s.priceThen,
            priceNow,
            changePct,
            days,
        };
    });

    const validChanges = rows.filter((r) => r.changePct != null);
    const avgChange =
        validChanges.length > 0
            ? validChanges.reduce((a, r) => a + (r.changePct ?? 0), 0) / validChanges.length
            : 0;

    const formatted = formatTelegramMessage({ rows, avgChange, total: rows.length });
    console.log(formatted);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
