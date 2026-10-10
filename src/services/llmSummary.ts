/**
 * Smart Volume Radar — Ticker Classification Service
 *
 * Originally housed the daily LLM commentary feature (4 providers: OpenAI,
 * Perplexity, Gemini, Groq + per-stock analysis + summary). That feature
 * was REMOVED 2026-05-22 because the Gemini API key was missing in production
 * — the daily commentary block had been silently failing for ~weeks. See
 * `~/cabinet/projects/smart-volume-radar/decisions-log.md`.
 *
 * What remains: `classifyTickers` — a small utility that classifies
 * ticker symbols as STOCK / INDEX / ETF / BOND / OTHER. Used by `index.ts`
 * to decide which "failed" tickers are actually unsupported instrument types
 * (e.g. ^TNX is an INDEX with no volume, so RVOL is not computable — not a
 * real "failed fetch" worth reporting).
 *
 * File name is retained for backwards-compat with the import path; consider
 * renaming to `tickerClassifier.ts` in a future refactor.
 */

import { CLASSIFY_MODEL, completeText } from './claude.js';

const MAX_TOKENS = 2048;

export type TickerType = 'STOCK' | 'INDEX' | 'ETF' | 'BOND' | 'OTHER';

const TICKER_CLASSIFY_PROMPT = `You are a financial data expert. Classify each ticker symbol as exactly one of: STOCK, INDEX, ETF, BOND, OTHER.
- STOCK: individual equity (e.g. AAPL, ALMA.TA)
- INDEX: market index (e.g. ^TNX, ^GSPC, TABANKS5.TA, TA25)
- ETF: exchange-traded fund (e.g. SPY, QQQ)
- BOND: bond yield or bond index (e.g. ^TNX, ^IRX)
- OTHER: unknown or mixed

Reply with exactly one line per ticker in format: SYMBOL: TYPE
No other text. Case-sensitive symbols.`;

/**
 * Classify tickers as STOCK/INDEX/ETF/BOND/OTHER using Claude.
 *
 * Used to filter "failed" tickers — indices and bonds don't have volume,
 * so RVOL can't be computed for them. They show up as fetch failures, but
 * they're not real failures.
 *
 * Returns empty Map on missing API key or API error (degrades gracefully).
 */
export async function classifyTickers(tickers: string[]): Promise<Map<string, TickerType>> {
    if (tickers.length === 0) return new Map();

    const list = tickers.join('\n');
    const prompt = `Classify these ticker symbols:\n${list}`;
    const text = await completeText({
        model: CLASSIFY_MODEL,
        system: TICKER_CLASSIFY_PROMPT,
        prompt,
        maxTokens: MAX_TOKENS,
        effort: 'low',
    });
    if (!text) return new Map();

    const result = new Map<string, TickerType>();
    const validTypes: TickerType[] = ['STOCK', 'INDEX', 'ETF', 'BOND', 'OTHER'];
    for (const line of text.split('\n')) {
        const m = line.match(/^(.+?):\s*(STOCK|INDEX|ETF|BOND|OTHER)$/i);
        if (!m) continue;
        const sym = m[1].trim();
        const type = validTypes.find((t) => t === m[2].toUpperCase()) ?? 'OTHER';
        result.set(sym, type);
    }
    return result;
}
