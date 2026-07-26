/**
 * Read a friend's shared/public TradingView watchlist over plain HTTP (no login).
 * The share page (https://www.tradingview.com/watchlists/<id>/) embeds the symbols in
 * `window.initData` as `"symbols":[ "NASDAQ:NVDA", ... ]`. No browser required.
 */

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

async function fetchHtml(url: string): Promise<string> {
    assertAllowedUrl(url);
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) {
        throw new Error(
            `shared watchlist fetch HTTP ${res.status} — check the link is shared/public: ${url}`,
        );
    }
    return res.text();
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
