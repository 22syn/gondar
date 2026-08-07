/**
 * Gondar — Monitor List persistence.
 *
 * Stores the active+historical monitor list as JSON in `results/monitor-list.json`.
 * Read once at scan start, mutated, write once at scan end.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MonitorState, MonitorEntry } from '../types/index.js';
import logger from './logger.js';

const FILENAME = 'monitor-list.json';

function emptyState(): MonitorState {
    return { lastUpdated: new Date().toISOString().slice(0, 10), entries: [] };
}

/**
 * Load the monitor state from disk. Returns an empty state if file doesn't exist.
 * Tolerant of malformed JSON — logs a warning and starts fresh.
 */
export function loadMonitorState(resultsDir: string): MonitorState {
    const filePath = path.join(resultsDir, FILENAME);
    if (!fs.existsSync(filePath)) {
        logger.info(`📁 Monitor list not found at ${filePath} — starting fresh`);
        return emptyState();
    }
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as MonitorState;
        if (!Array.isArray(parsed.entries)) {
            logger.warn(`⚠️ Monitor list malformed (no .entries array) — starting fresh`);
            return emptyState();
        }
        return parsed;
    } catch (err) {
        logger.warn(`⚠️ Failed to parse monitor list (${(err as Error).message}) — starting fresh`);
        return emptyState();
    }
}

/** Persist the monitor state to disk. */
export function saveMonitorState(state: MonitorState, resultsDir: string): void {
    const filePath = path.join(resultsDir, FILENAME);
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

/** Find a monitor entry by ticker (case-insensitive). Returns undefined if not found. */
export function findEntry(state: MonitorState, ticker: string): MonitorEntry | undefined {
    const upper = ticker.toUpperCase();
    return state.entries.find((e) => e.ticker.toUpperCase() === upper);
}
