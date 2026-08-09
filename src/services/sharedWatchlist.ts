/**
 * Read a friend's shared/public TradingView watchlist over plain HTTP (no login).
 * The share page (https://www.tradingview.com/watchlists/<id>/) embeds the symbols in
 * `window.initData` as `"symbols":[ "NASDAQ:NVDA", ... ]`. No browser required.
 */
import logger from '../utils/logger.js';

/** Parse the `symbols` array out of a shared-watchlist page's HTML. */
export function extractSymbols(html: string): string[] {
    const key = html.indexOf('"symbols":[');
    if (key === -1) {
        throw new Error(
            'shared watchlist: could not find symbols in the page (layout changed, or the list is no longer public)',
        );
    }
    const start = html.indexOf('[', key);
    let depth = 0;
    let end = -1;
    for (let i = start; i < html.length; i++) {
        const c = html[i];
        if (c === '[') depth++;
        else if (c === ']') {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    if (end === -1) throw new Error('shared watchlist: malformed symbols array');
    const arr = JSON.parse(html.slice(start, end + 1)) as unknown[];
    // Keep EXCHANGE:SYMBOL rows; drop section headers ("###...") and non-strings.
    return arr.filter(
        (s): s is string => typeof s === 'string' && s.includes(':') && !s.startsWith('###'),
    );
}

/** Parse the watchlist's own name from the page HTML (used as the default sector). */
export function extractName(html: string): string | null {
    const m = html.match(/"name":"((?:[^"\\]|\\.)*)","symbols"/);
    if (!m) return null;
    try {
        return JSON.parse(`"${m[1]}"`); // unescape JSON string escapes
    } catch {
        return m[1];
    }
}

export interface SharedWatchlist {
    name: string | null;
    symbols: string[];
}

/**
 * Only https TradingView share URLs may be fetched. `shareUrl` comes from config
 * (`watchlist-sources.json` / the `WATCHLIST_SOURCES_JSON` CI secret); this allowlist
 * closes the SSRF angle — no `file://`, `http://localhost`, or internal addresses.
 */
export function assertAllowedUrl(url: string): void {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`shared watchlist: invalid URL: ${url}`);
    }
    const host = parsed.hostname.toLowerCase();
    const allowed =
        parsed.protocol === 'https:' && (host === 'tradingview.com' || host.endsWith('.tradingview.com'));
    if (!allowed) {
        throw new Error(`shared watchlist: refusing to fetch non-TradingView URL: ${url}`);
    }
}

/**
 * Per-attempt timeout. Node's fetch has NO default timeout, so a TradingView
 * request that never answers hangs until the OS gives up. On 2026-08-09 that
 * stalled the weekly sync for 32 MINUTES on a single source — a run that
 * normally finishes in about 3 seconds — before failing and exiting non-zero.
 */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * One retry. The observed failures are transient, not dead links: four sources
 * failed across the 2026-08-02 and 2026-08-09 runs, all DIFFERENT urls, and each
 * one returns HTTP 200 when checked by hand afterwards. A single cheap retry is
 * the difference between "24/25 sources, exit 1" and a clean run.
 */
const FETCH_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url: string): Promise<string> {
    assertAllowedUrl(url);

    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (!res.ok) {
                // A non-OK status is a real answer about the link itself (private,
                // deleted, moved) — retrying will not change it, so fail straight away
                // rather than doubling the wait on a permanent condition.
                throw new Error(
                    `shared watchlist fetch HTTP ${res.status} — check the link is shared/public: ${url}`,
                );
            }
            return await res.text();
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            if (error.message.startsWith('shared watchlist fetch HTTP')) throw error;
            lastError = error;
            if (attempt < FETCH_ATTEMPTS) {
                logger.warn(
                    `Shared watchlist fetch attempt ${attempt}/${FETCH_ATTEMPTS} failed for ${url} ` +
                        `(${error.name === 'TimeoutError' ? `timeout after ${FETCH_TIMEOUT_MS}ms` : error.message}) — retrying`,
                );
                await sleep(RETRY_DELAY_MS);
            }
        }
    }
    throw new Error(
        `shared watchlist fetch failed after ${FETCH_ATTEMPTS} attempts: ${url} (${lastError?.message ?? 'unknown'})`,
    );
}

/** Fetch a shared watchlist URL and return its TradingView symbols. */
export async function fetchSharedWatchlist(url: string): Promise<string[]> {
    return extractSymbols(await fetchHtml(url));
}

/** Fetch a shared watchlist URL and return both its name and symbols. */
export async function fetchSharedWatchlistDetailed(url: string): Promise<SharedWatchlist> {
    const html = await fetchHtml(url);
    return { name: extractName(html), symbols: extractSymbols(html) };
}
