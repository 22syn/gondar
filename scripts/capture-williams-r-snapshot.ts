#!/usr/bin/env npx tsx
/**
 * Weekly TradingView reference snapshot for the dashboard's Williams %R
 * panel — SPY + QQQ, 1W, the saved TradingView layout (which must have the
 * plain "Williams %R" indicator added — see chat 2026-08-03; QQQ added
 * 2026-08-03 too, same layout applied to a second symbol).
 *
 * Runs via the com.smart-volume-radar.williams-r-snapshot LaunchAgent,
 * Sunday mornings (a new weekly candle closed Friday close, so Sunday
 * already has it). Reuses sync-tv-watchlist.ts's `--screenshot` mode
 * (same logged-in Playwright/Chromium profile as the tv-sync automation)
 * to capture each chart, then copies the PNGs into a SEPARATE permanent
 * local checkout of the `stable` branch (dashboard/ only exists there —
 * this repo's default checkout stays on `main`) and commits + pushes them
 * in one commit, so the deployed dashboard picks them up on the next
 * Cloudflare Pages build.
 *
 * Best-effort by design (matches every other sync script in this repo):
 * any failure logs and exits non-zero, but never throws past main() —
 * a missed weekly snapshot is a stale image, not a broken dashboard.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENGINE_ROOT = path.resolve(import.meta.dirname, '..');
// Permanent worktree of `stable` (created 2026-08-03) — NOT a Claude Code
// worktree under .claude/worktrees/, which are ephemeral and get cleaned up.
const STABLE_WORKTREE = path.join(os.homedir(), 'dev', 'smart-volume-radar-engine-stable');
const ASSETS_DIR = path.join(STABLE_WORKTREE, 'dashboard', 'public', 'assets');
const LOG_PATH = path.join(os.homedir(), 'Library', 'Logs', 'williams-r-snapshot.log');

const SYMBOLS: Array<{ symbol: string; targetFile: string }> = [
    { symbol: 'SPY', targetFile: 'williams-r-spy-weekly.png' },
    { symbol: 'QQQ', targetFile: 'williams-r-qqq-weekly.png' },
];

function log(msg: string): void {
    const line = `${new Date().toISOString()} ${msg}`;
    console.error(line);
    fs.appendFileSync(LOG_PATH, line + '\n');
}

function run(cmd: string, args: string[], cwd: string): string {
    return execFileSync(cmd, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] });
}

/**
 * Crop off everything below the Williams %R pane. The saved TradingView
 * layout also has RSI added (kept there for manual viewing) — the dashboard
 * only wants price+volume+Williams %R, not RSI. CROP_HEIGHT_PX was measured
 * against the chart-only clip at the fixed 1400×900 capture viewport
 * (sync-tv-watchlist.ts); it holds as long as the saved layout's pane order
 * stays price+volume → Williams %R → RSI (top to bottom) — if you reorder or
 * add/remove panes, re-measure and update this constant (2026-08-03).
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
    const raw = run('npx', ['tsx', 'scripts/sync-tv-watchlist.ts', '--screenshot', symbol, '--interval', '1W'], ENGINE_ROOT);
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
    log(`✓ [${symbol}] Copied snapshot to ${targetPng}`);
    return true;
}

async function main(): Promise<number> {
    if (!fs.existsSync(STABLE_WORKTREE)) {
        log(`❌ Stable worktree missing at ${STABLE_WORKTREE} — run: git worktree add ${STABLE_WORKTREE} stable`);
        return 1;
    }

    // Sync the worktree to the remote tip FIRST — before touching any target
    // file — so `git status` below diffs the new screenshots against last
    // week's actually-published versions, not stale local state.
    try {
        run('git', ['fetch', 'origin', 'stable'], STABLE_WORKTREE);
        run('git', ['reset', '--hard', 'origin/stable'], STABLE_WORKTREE);
    } catch (err) {
        log(`⚠️ git fetch/reset failed, continuing with local state: ${(err as Error).message}`);
    }

    let anyOk = false;
    for (const { symbol, targetFile } of SYMBOLS) {
        const ok = await captureOne(symbol, targetFile);
        anyOk = anyOk || ok;
    }
    if (!anyOk) {
        log('❌ All symbol captures failed — nothing to commit.');
        return 1;
    }

    const targetPaths = SYMBOLS.map(({ targetFile }) => `dashboard/public/assets/${targetFile}`);
    const status = run('git', ['status', '--porcelain', '--', ...targetPaths], STABLE_WORKTREE);
    if (!status.trim()) {
        log('ℹ️ No change vs. last week\'s snapshots — skipping commit.');
        return 0;
    }

    run('git', ['add', ...targetPaths], STABLE_WORKTREE);
    const dateStr = new Date().toISOString().slice(0, 10);
    const symbolList = SYMBOLS.map(({ symbol }) => symbol).join('/');
    run('git', ['commit', '-m', `chore: update Williams %R ${symbolList} snapshot (weekly, ${dateStr})`], STABLE_WORKTREE);
    run('git', ['push', 'origin', 'HEAD:stable'], STABLE_WORKTREE);
    log(`✓ Pushed snapshot update to stable (${dateStr})`);
    return 0;
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        log(`❌ Uncaught error: ${(err as Error).stack ?? err}`);
        process.exit(1);
    });
