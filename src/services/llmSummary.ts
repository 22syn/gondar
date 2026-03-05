/**
 * Smart Volume Radar - LLM Summary Service
 * Optional: asks an LLM to summarize the daily scan report for analyst-style commentary.
 * Supports OpenAI, Perplexity, Google Gemini, and Groq via LLM_PROVIDER and corresponding API keys.
 * Per-stock mode: each signal sent to LLM separately (parallel).
 */

import pLimit from 'p-limit';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { escapeHtml } from '../utils/escapeHtml.js';
import { isFullSetup, isCloseSetup } from '../utils/setup.js';
import { formatRVOL, formatPriceChange } from '../utils/formatters.js';
import type { StockData } from '../types/index.js';

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const SYSTEM_PROMPT =
    'You are a concise market analyst. The Data table below is produced by the system. You MUST interpret it correctly: 🎯 = full setup, 👀 = close setup. Only refer to tickers and facts that appear in the table. Reply in plain text only, no markdown.';

const SINGLE_STOCK_PROMPT =
    'You are a market analyst. You CALCULATE setup params from raw data using given formulas. Output in the exact format requested.';

/** Scope for LLM prompt – helps LLM understand full scan coverage */
export interface LlmScope {
    watchlistCount?: number;
    setupCount?: number;
}

/**
 * Build prompt for the LLM using the EXACT same parameters the code uses.
 * SMA21, High, Base – same thresholds and values as formatSetupIndicator.
 */
function buildPrompt(stocks: StockData[], date: string, scope?: LlmScope): string {
    const {
        sma21TouchThresholdPct,
        athThresholdPct,
        consolidationMinMonths,
        consolidationMaxMonths,
    } = config;

    const signalRows = stocks.map(formatStockForLlm);
    const dataTable =
        stocks.length > 0 ? signalRows.join('\n') : "(No high-RVOL stocks in today's scan)";

    const scopeLine =
        scope?.watchlistCount != null
            ? `\nScan scope: ${scope.watchlistCount} tickers. This table has ${stocks.length} stocks. ✓=met, ~=close. ${scope.setupCount ?? 0} have setup (🎯/👀).\n`
            : `\n${stocks.length} high-RVOL stocks.\n`;

    return `You are a concise market analyst. Data below from Smart Volume Radar (${date}) – SAME parameters the code uses. Each row: SMA21%, High (52w), Base (mo). ✓ met, ~ close, ✗ far. 🎯 full setup, 👀 close setup.${scopeLine}

SETUP (same as code): Full 🎯 = SMA21 ≤${sma21TouchThresholdPct}%, High ≤${athThresholdPct}%, Base ${consolidationMinMonths}–${consolidationMaxMonths}mo.

Data (code output):
---
${dataTable}
---

Analyst commentary based on these exact params. Mention 🎯 and 👀 tickers. 2–3 sentences max. Plain text.`;
}

/** OpenAI-style response shape (OpenAI + Perplexity) */
interface ChatChoice {
    message?: { content?: string };
    finish_reason?: string;
}

/** Token limits: enough for 2–3 sentences with headroom to avoid truncation */
const MAX_LLM_TOKENS = 8192;

async function callOpenAI(prompt: string, _systemPrompt: string = SYSTEM_PROMPT): Promise<string | null> {
    const apiKey = config.openaiApiKey;
    if (!apiKey) {
        logger.warn('LLM summary skipped: OPENAI_API_KEY not set');
        return null;
    }
    try {
        const response = await fetch(OPENAI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: prompt },
                ],
                max_tokens: MAX_LLM_TOKENS,
                temperature: 0.3,
            }),
        });
        if (!response.ok) {
            logger.warn(`LLM summary (OpenAI) failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
            return null;
        }
        const data = (await response.json()) as { choices?: ChatChoice[] };
        const choice = data?.choices?.[0];
        const text = choice?.message?.content?.trim() ?? null;
        if (choice?.finish_reason === 'length' && text) {
            logger.warn('LLM summary (OpenAI) was truncated (finish_reason=length). Consider increasing max_tokens.');
        }
        return text;
    } catch (error) {
        logger.warn('LLM summary (OpenAI) error', (error as Error).message);
        return null;
    }
}

/** Perplexity uses OpenAI-compatible chat completions. */
async function callPerplexity(prompt: string, systemPrompt: string = SYSTEM_PROMPT): Promise<string | null> {
    const apiKey = config.perplexityApiKey;
    if (!apiKey) {
        logger.warn('LLM summary skipped: PERPLEXITY_API_KEY not set');
        return null;
    }
    try {
        const response = await fetch(PERPLEXITY_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: 'sonar',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: prompt },
                ],
                max_tokens: MAX_LLM_TOKENS,
                temperature: 0.3,
            }),
        });
        if (!response.ok) {
            logger.warn(`LLM summary (Perplexity) failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
            return null;
        }
        const data = (await response.json()) as { choices?: ChatChoice[] };
        const choice = data?.choices?.[0];
        const text = choice?.message?.content?.trim() ?? null;
        if (choice?.finish_reason === 'length' && text) {
            logger.warn('LLM summary (Perplexity) was truncated (finish_reason=length). Consider increasing max_tokens.');
        }
        return text;
    } catch (error) {
        logger.warn('LLM summary (Perplexity) error', (error as Error).message);
        return null;
    }
}

/** Google Gemini generateContent API. */
async function callGemini(prompt: string, systemPrompt: string = SYSTEM_PROMPT): Promise<string | null> {
    const apiKey = config.geminiApiKey;
    if (!apiKey) {
        logger.warn('LLM summary skipped: GEMINI_API_KEY not set');
        return null;
    }
    const model = 'gemini-3-flash-preview';
    const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: systemPrompt }] },
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    maxOutputTokens: MAX_LLM_TOKENS,
                    temperature: 0.2,
                },
            }),
        });
        if (!response.ok) {
            logger.warn(`LLM summary (Gemini) failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
            return null;
        }
        const data = (await response.json()) as {
            candidates?: Array<{
                content?: { parts?: Array<{ text?: string }> };
                finishReason?: string;
            }>;
        };
        const candidate = data?.candidates?.[0];
        const text = candidate?.content?.parts?.[0]?.text?.trim() ?? null;
        const finishReason = candidate?.finishReason;
        if (finishReason === 'MAX_TOKENS' || finishReason === 'STOP_REASON_MAX_TOKENS') {
            logger.warn(
                `LLM summary (Gemini) was truncated (finishReason=${finishReason}). Consider increasing maxOutputTokens.`
            );
        }
        return text;
    } catch (error) {
        logger.warn('LLM summary (Gemini) error', (error as Error).message);
        return null;
    }
}

/** Groq: OpenAI-compatible API (free tier; llama-3.3-70b-versatile). */
async function callGroq(prompt: string, systemPrompt: string = SYSTEM_PROMPT): Promise<string | null> {
    const apiKey = config.groqApiKey;
    if (!apiKey) {
        logger.warn('LLM summary skipped: GROQ_API_KEY not set');
        return null;
    }
    const model = config.llmModel || 'llama-3.3-70b-versatile';
    try {
        const response = await fetch(GROQ_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: prompt },
                ],
                max_tokens: MAX_LLM_TOKENS,
                temperature: 0.3,
            }),
        });
        if (!response.ok) {
            logger.warn(`LLM summary (Groq) failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
            return null;
        }
        const data = (await response.json()) as { choices?: ChatChoice[] };
        const choice = data?.choices?.[0];
        const text = choice?.message?.content?.trim() ?? null;
        if (choice?.finish_reason === 'length' && text) {
            logger.warn('LLM summary (Groq) was truncated (finish_reason=length). Consider increasing max_tokens.');
        }
        return text;
    } catch (error) {
        logger.warn('LLM summary (Groq) error', (error as Error).message);
        return null;
    }
}

function callLlm(prompt: string, systemPrompt: string = SYSTEM_PROMPT): Promise<string | null> {
    const provider = config.llmProvider;
    if (provider === 'perplexity') return callPerplexity(prompt, systemPrompt);
    if (provider === 'gemini') return callGemini(prompt, systemPrompt);
    if (provider === 'groq') return callGroq(prompt, systemPrompt);
    return callOpenAI(prompt, systemPrompt);
}

/** Ticker classification from LLM: INDEX/BOND = not supported (no volume); rest = potentially fixable */
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
 * Classify tickers as STOCK/INDEX/ETF/BOND/OTHER using Groq.
 * INDEX and BOND are not supported (no volume for RVOL); do not trigger Jules for them.
 */
export async function classifyTickersWithGroq(tickers: string[]): Promise<Map<string, TickerType>> {
    const apiKey = config.groqApiKey;
    if (!apiKey || tickers.length === 0) return new Map();

    const list = tickers.join('\n');
    const prompt = `Classify these ticker symbols:\n${list}`;
    const text = await callGroq(prompt, TICKER_CLASSIFY_PROMPT);
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

/**
 * Format RAW stock data for LLM – so it can CALCULATE the params itself.
 * Same conditions as code, but LLM does the math.
 */
function formatRawStockForLlm(stock: StockData): string {
    const price = stock.lastPrice.toFixed(2);
    const sma21 = stock.sma21 != null && stock.sma21 > 0 ? stock.sma21.toFixed(2) : '—';
    const athVal =
        stock.ath != null
            ? stock.ath.toFixed(2)
            : stock.pctFromAth != null
              ? (stock.lastPrice / (1 + stock.pctFromAth / 100)).toFixed(2)
              : '—';
    const base = stock.monthsInConsolidation != null ? stock.monthsInConsolidation.toFixed(1) : '—';
    const rsi = stock.rsi != null ? stock.rsi.toFixed(0) : '—';
    return `Ticker: ${stock.ticker}
Price: ${price} | SMA21: ${sma21} | 52w High: ${athVal} | Base: ${base}mo
RVOL: ${formatRVOL(stock.rvol)} | Price chg: ${formatPriceChange(stock.priceChange)} | RSI: ${rsi}`;
}

/**
 * Format stock with pre-calculated params (for batch summary mode).
 */
function formatStockForLlm(stock: StockData): string {
    const {
        sma21TouchThresholdPct,
        athThresholdPct,
        consolidationMinMonths,
        consolidationMaxMonths,
        consolidationCloseMinMonths,
    } = config;

    const rsi = stock.rsi != null ? stock.rsi.toFixed(0) : '—';

    let sma21Line = 'SMA21: —';
    if (stock.sma21 != null && stock.sma21 > 0) {
        const pctFromSMA = (Math.abs(stock.lastPrice - stock.sma21) / stock.sma21) * 100;
        const met = pctFromSMA <= sma21TouchThresholdPct;
        sma21Line = `SMA21: ${pctFromSMA.toFixed(1)}% ${met ? '✓' : '~'} (req ≤${sma21TouchThresholdPct}%)`;
    }

    let highLine = 'High: —';
    if (stock.pctFromAth != null) {
        const absPct = Math.abs(stock.pctFromAth);
        const met = absPct <= athThresholdPct;
        highLine = `High: ${stock.pctFromAth.toFixed(0)}% from 52w ${met ? '✓' : '~'} (req ≤${athThresholdPct}%)`;
    }

    let baseLine = 'Base: —';
    if (stock.monthsInConsolidation != null) {
        const mo = Math.round(stock.monthsInConsolidation);
        const met =
            stock.monthsInConsolidation >= consolidationMinMonths &&
            stock.monthsInConsolidation <= consolidationMaxMonths;
        const close =
            stock.monthsInConsolidation >= consolidationCloseMinMonths &&
            stock.monthsInConsolidation < consolidationMinMonths;
        baseLine = `Base: ${mo}mo ${met ? '✓' : close ? '~' : '✗'} (req ${consolidationMinMonths}–${consolidationMaxMonths}mo)`;
    }

    const setup = isFullSetup(stock) ? '🎯' : isCloseSetup(stock) ? '👀' : '—';

    return `${stock.ticker} | RVOL ${formatRVOL(stock.rvol)} | Price ${formatPriceChange(stock.priceChange)} | RSI ${rsi} | ${sma21Line} | ${highLine} | ${baseLine} | Setup ${setup}`;
}

function getCodeSetup(stock: StockData): '🎯' | '👀' | '—' {
    return isFullSetup(stock) ? '🎯' : isCloseSetup(stock) ? '👀' : '—';
}

function buildSingleStockPrompt(rawData: string, codeSetup: string, date: string): string {
    const {
        sma21TouchThresholdPct,
        sma21CloseThresholdPct,
        athThresholdPct,
        athCloseThresholdPct,
        consolidationMinMonths,
        consolidationMaxMonths,
        consolidationCloseMinMonths,
    } = config;

    return `You are a market analyst. Below is RAW data for one stock. You must CALCULATE the setup params yourself using the SAME conditions as our code.

CONDITIONS (identical to code):
1. SMA21: |Price-SMA21|/SMA21 × 100 = distance %. ✓ if ≤${sma21TouchThresholdPct}%, ~ if ${sma21TouchThresholdPct}–${sma21CloseThresholdPct}%, ✗ otherwise
2. High: |(Price-52wHigh)/52wHigh| × 100 = distance %. ✓ if ≤${athThresholdPct}%, ~ if ${athThresholdPct}–${athCloseThresholdPct}%, ✗ otherwise
3. Base: months given. ✓ if ${consolidationMinMonths}–${consolidationMaxMonths}mo, ~ if ${consolidationCloseMinMonths}–${consolidationMinMonths}mo, ✗ otherwise

Setup verdict: 🎯 = all ✓, 👀 = all ~ (or mix ✓~), — = any ✗

RAW DATA (${date}):
${rawData}

CODE RESULT (for you to verify): ${codeSetup}

Reply in EXACT format:
SMA21: X.X% [✓/~/✗] | High: X% [✓/~/✗] | Base: Xmo [✓/~/✗] | My: [🎯/👀/—] | Match: [yes/no] | Analysis: one short sentence`;
}

/** Per-stock analysis result */
export interface PerStockAnalysis {
    ticker: string;
    codeSetup: '🎯' | '👀' | '—';
    analysis: string | null;
}

/** Parsed LLM reply: verdict (🎯/👀/—), match (code vs LLM), and optional reason */
export interface ParsedLlmReply {
    llmVerdict: '🎯' | '👀' | '—';
    match: boolean;
    reason?: string;
}

const LLM_REPLY_REGEX = /My:\s*([🎯👀—])\s*\|?\s*Match:\s*(yes|no)\s*\|?\s*Analysis:\s*(.+)/i;

/**
 * Parse LLM reply to extract verdict, match, and reason. Falls back gracefully if format varies.
 */
export function parseLlmReply(raw: string): ParsedLlmReply | null {
    const m = raw.match(LLM_REPLY_REGEX);
    if (!m) return null;
    const llmVerdict = (m[1] === '🎯' ? '🎯' : m[1] === '👀' ? '👀' : '—') as '🎯' | '👀' | '—';
    const match = m[2].toLowerCase() === 'yes';
    const reason = m[3]?.trim().slice(0, 80); // truncate long analysis
    return { llmVerdict, match, reason };
}

/**
 * Format per-stock analysis for display: clear comparison of Code vs LLM.
 */
export function formatCodeVsLlmLine(
    ticker: string,
    codeSetup: '🎯' | '👀' | '—',
    parsed: ParsedLlmReply | null,
    _rawAnalysis: string | null
): string {
    if (!parsed) {
        return `• <b>${escapeHtml(ticker)}</b> | קוד ${codeSetup} | <i>(לא ניתן לפרסר תשובת LLM)</i>`;
    }
    const matchStr = parsed.match ? '✓ תואמים' : '✗ חוסר התאמה';
    const base = `• <b>${escapeHtml(ticker)}</b> | קוד ${codeSetup} | LLM ${parsed.llmVerdict} | ${matchStr}`;
    if (!parsed.match && parsed.reason) {
        return `${base}\n  <i>${escapeHtml(parsed.reason)}</i>`;
    }
    return base;
}

/**
 * Send each signal to LLM with RAW data. LLM calculates params itself (same conditions as code).
 * Enables verification: compare Code vs LLM.
 */
export async function getPerStockAnalyses(stocks: StockData[], date: string): Promise<PerStockAnalysis[]> {
    if (!config.enableLlmSummary) return [];

    const provider = config.llmProvider;
    const hasKey =
        provider === 'gemini'
            ? !!config.geminiApiKey
            : provider === 'perplexity'
              ? !!config.perplexityApiKey
              : provider === 'groq'
                ? !!config.groqApiKey
                : !!config.openaiApiKey;
    if (!hasKey) return [];

    const limit = pLimit(3);
    logger.info(`Generating per-stock LLM analyses (${stocks.length} stocks, provider: ${provider})...`);

    const tasks = stocks.map((stock) =>
        limit(async () => {
            const rawData = formatRawStockForLlm(stock);
            const codeSetup = getCodeSetup(stock);
            const prompt = buildSingleStockPrompt(rawData, codeSetup, date);
            const analysis = await callLlm(prompt, SINGLE_STOCK_PROMPT);
            return { ticker: stock.ticker, codeSetup, analysis };
        })
    );

    const results = await Promise.all(tasks);
    const ok = results.filter((r) => r.analysis).length;
    logger.info(`Per-stock LLM: ${ok}/${results.length} analyses received`);
    return results;
}

/**
 * Get an LLM-generated summary from stock data.
 * Uses the SAME parameters the code calculated (SMA21, High, Base).
 * Returns null if disabled, no API key, or on any failure.
 *
 * @param stocks - StockData[] from getStocksForLlm()
 */
export async function getReportSummary(
    stocks: StockData[],
    date: string,
    scope?: LlmScope
): Promise<string | null> {
    if (!config.enableLlmSummary) {
        logger.info('LLM summary disabled. Set ENABLE_LLM_SUMMARY=true in .env to enable.');
        return null;
    }

    const provider = config.llmProvider;
    const hasKey =
        provider === 'gemini'
            ? !!config.geminiApiKey
            : provider === 'perplexity'
              ? !!config.perplexityApiKey
              : provider === 'groq'
                ? !!config.groqApiKey
                : !!config.openaiApiKey;
    if (!hasKey) {
        const keyName =
            provider === 'gemini'
                ? 'GEMINI_API_KEY'
                : provider === 'perplexity'
                  ? 'PERPLEXITY_API_KEY'
                  : provider === 'groq'
                    ? 'GROQ_API_KEY'
                    : 'OPENAI_API_KEY';
        logger.warn(`LLM summary skipped: ${keyName} not set (LLM_PROVIDER=${provider})`);
        return null;
    }

    logger.info(`Generating LLM summary (provider: ${provider})...`);
    if (process.env.DEBUG === 'true') {
        logger.info(`LLM receives ${stocks.length} stocks: ${stocks.map((s) => s.ticker).join(', ')}`);
    }
    const prompt = buildPrompt(stocks, date, scope);
    const summary = await callLlm(prompt);

    if (summary) {
        logger.info(`LLM summary generated (${provider})`);
    } else {
        logger.warn(`LLM summary not sent: no response from ${provider} (check logs above for API errors)`);
    }

    return summary;
}
