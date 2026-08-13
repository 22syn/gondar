#!/usr/bin/env npx tsx
/**
 * Weekly TradingView reference snapshot for the dashboard's Williams %R
 * panel — SPY + QQQ, 1W, the saved TradingView layout (which must have the
 * plain "Williams %R" indicator added — see chat 2026-08-03).
 *
 * CI-side twin of the LaunchAgent script that lived on `main`. The local one
 * needed two checkouts — `main` carried the script, `stable` carried
 * dashboard/ — and bridged them with a permanent worktree plus a cross-branch
 * push. On `stable` both halves are already in one tree, so all of that goes
 * away: capture, crop, write into dashboard/public/assets/, done. The workflow
 * owns the commit (same split as tv-sync.yml).
 *
 * Best-effort by design (matches every other sync script here): a failure logs
 * and exits non-zero, but a missed weekly snapshot is a stale image, not a
 * broken dashboard — so one symbol failing still publishes the other.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const ASSETS_DIR = path.join(REPO_ROOT, 'dashboard', 'public', 'assets');

const SYMBOLS: Array<{ symbol: string; targetFile: string }> = [
    { symbol: 'SPY', targetFile: 'williams-r-spy-weekly.png' },
    { symbol: 'QQQ', targetFile: 'williams-r-qqq-weekly.png' },
];

function log(msg: string): void {
    console.error(`${new Date().toISOString()} ${msg}`);
}

function run(cmd: string, args: string[], cwd: string): string {
    return execFileSync(cmd, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] });
}

/**
 * Crop off everything below the Williams %R pane. The saved TradingView layout
 * also has RSI added (kept there for manual viewing) — the dashboard only wants
 * price+volume+Williams %R.
 *
 * CROP_HEIGHT_PX was measured against the chart-only clip at the fixed 1400×900
 * capture viewport, and sync-tv-watchlist.ts uses that same viewport on its CI
 * path (`newContext({ viewport: { width: 1400, height: 900 } })`), so the
 * constant carries over unchanged. It holds as long as the saved layout's pane
 * order stays price+volume → Williams %R → RSI (top to bottom) — reorder or
 * add/remove a pane and this must be re-measured.
 */
const CROP_HEIGHT_PX = 637;

function cropOutRsiPane(pngPath: string): void {
    execFileSync(
        'python3',
        ['-c', `from PIL import Image
im = Image.open("${pngPath}")
im.crop((0, 0, im.width, min(${CROP_HEIGHT_PX}, im.height))).save("${pngPath}")
`],
        { stdio: 'inherit' }
    );
}

async function captureOne(symbol: string, targetFile: string): Promise<boolean> {
    log(`📸 Capturing ${symbol} 1W TradingView snapshot...`);
    const raw = run('npx', ['tsx', 'scripts/sync-tv-watchlist.ts', '--screenshot', symbol, '--interval', '1W'], REPO_ROOT);
    const lastLine = raw.trim().split('\n').pop() ?? '';
    let parsed: { mode: string; symbol: string; shots: Array<{ interval: string | null; path: string }> };
    try {
        parsed = JSON.parse(lastLine);
    } catch {
        log(`❌ [${symbol}] Could not parse screenshot output: ${lastLine.slice(0, 300)}`);
        return false;
    }
    const shot = parsed.shots?.[0];
    if (!shot?.path || !fs.existsSync(shot.path)) {
        log(`❌ [${symbol}] Screenshot capture failed — no shot in output: ${JSON.stringify(parsed)}`);
        return false;
    }

    try {
        cropOutRsiPane(shot.path);
        log(`✓ [${symbol}] Cropped out RSI pane`);
    } catch (err) {
        log(`⚠️ [${symbol}] Crop failed, publishing uncropped screenshot: ${(err as Error).message}`);
    }

    const targetPng = path.join(ASSETS_DIR, targetFile);
    fs.mkdirSync(path.dirname(targetPng), { recursive: true });
    fs.copyFileSync(shot.path, targetPng);
    fs.unlinkSync(shot.path);
    log(`✓ [${symbol}] Wrote ${path.relative(REPO_ROOT, targetPng)}`);
    return true;
}

async function main(): Promise<number> {
    let anyOk = false;
    for (const { symbol, targetFile } of SYMBOLS) {
        const ok = await captureOne(symbol, targetFile);
        anyOk = anyOk || ok;
    }
    if (!anyOk) {
        log('❌ All symbol captures failed — nothing to publish.');
        return 1;
    }
    log('✓ Snapshot capture complete — workflow will commit any change.');
    return 0;
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        log(`❌ Unhandled failure: ${(err as Error).message}`);
        process.exit(1);
    });
