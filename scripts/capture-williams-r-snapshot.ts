#!/usr/bin/env npx tsx
/**
 * Weekly TradingView reference snapshot for the dashboard's Williams %R
 * panel — SPY + QQQ, 1W, the saved TradingView layout (which must have the
 * plain "Williams %R" indicator added — see chat 2026-08-03; QQQ added
 * 2026-08-03 too, same layout applied to a second symbol).
 *
 * Sunday mornings (a new weekly candle closed Friday close, so Sunday
 * already has it). Reuses sync-tv-watchlist.ts's `--screenshot` mode to
 * capture each chart, then copies the PNGs into a checkout of the `stable`
 * branch — dashboard/ exists only there, while this script and the capture
 * engine live only on `main`.
 *
 * That two-tree split is load-bearing, not incidental. `stable`'s copy of
 * sync-tv-watchlist.ts is an older 699-line fork with neither `--screenshot`
 * nor the CI cookie path (main's is 1227 lines and has both), so a job that
 * runs entirely on `stable` silently falls through to normal sync mode and
 * captures nothing. That is exactly how the first cloud attempt failed on
 * 2026-08-14. Capture tooling comes from main; only the assets come from
 * stable.
 *
 * Runs two ways off that same split:
 *   - LaunchAgent (local): STABLE_DIR defaults to the permanent worktree at
 *     ~/dev/smart-volume-radar-engine-stable, and this script commits+pushes.
 *   - GitHub Actions: williams-r-snapshot.yml checks stable out beside main
 *     and points WILLIAMS_STABLE_DIR at it. The workflow owns the commit, so
 *     the git block here is skipped — see the CI guard in main().
 *
 * Best-effort by design (matches every other sync script in this repo):
 * any failure logs and exits non-zero, but never throws past main() —
 * a missed weekly snapshot is a stale image, not a broken dashboard.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IS_CI = process.env.CI === 'true';

const ENGINE_ROOT = path.resolve(import.meta.dirname, '..');
// Where `stable` is checked out. Locally: the permanent worktree created
// 2026-08-03 — NOT a Claude Code worktree under .claude/worktrees/, which are
// ephemeral and get cleaned up. In CI: the sibling checkout the workflow makes.
const STABLE_WORKTREE = process.env.WILLIAMS_STABLE_DIR
    ? path.resolve(process.env.WILLIAMS_STABLE_DIR)
    : path.join(os.homedir(), 'dev', 'smart-volume-radar-engine-stable');
const ASSETS_DIR = path.join(STABLE_WORKTREE, 'dashboard', 'public', 'assets');
const LOG_PATH = path.join(os.homedir(), 'Library', 'Logs', 'williams-r-snapshot.log');

const SYMBOLS: Array<{ symbol: string; targetFile: string }> = [
    { symbol: 'SPY', targetFile: 'williams-r-spy-weekly.png' },
    { symbol: 'QQQ', targetFile: 'williams-r-qqq-weekly.png' },
];

function log(msg: string): void {
    const line = `${new Date().toISOString()} ${msg}`;
    console.error(line);
    // The log file is a macOS convenience for the LaunchAgent, which has no
    // other console. In CI the step log IS the record, and ~/Library/Logs does
    // not exist on the runner — appending there would throw from inside the
    // logger, turning any ordinary message into a crash.
    if (!IS_CI) fs.appendFileSync(LOG_PATH, line + '\n');
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
    // week's actually-published versions, not stale local state. A fresh CI
    // checkout is already at the tip, and a hard reset there would be a
    // destructive no-op, so this only runs for the long-lived local worktree.
    if (!IS_CI) {
        try {
            run('git', ['fetch', 'origin', 'stable'], STABLE_WORKTREE);
            run('git', ['reset', '--hard', 'origin/stable'], STABLE_WORKTREE);
        } catch (err) {
            log(`⚠️ git fetch/reset failed, continuing with local state: ${(err as Error).message}`);
        }
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

    // In CI the workflow owns the commit — it already has the checkout's push
    // credentials and the gate that dispatches the Pages deploy only when the
    // images actually changed. Committing from here too would be a second,
    // competing writer of the same two files.
    if (IS_CI) {
        log('✓ Capture complete — the workflow will commit and publish any change.');
        return 0;
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
