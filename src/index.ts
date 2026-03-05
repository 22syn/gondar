/**
 * Smart Volume Radar - Main Entry Point
 * Orchestrates the daily stock volume scan and reporting
 */

import { loadWatchlist, validateConfig, config, getSectorForTicker, fetchAndCacheWatchlist, getInvalidTickersFromWatchlist, getIndexSkippedFromWatchlist } from './config/index.js';
import { classifyTickersWithGroq } from './services/llmSummary.js';
import { fetchAllStocks } from './services/marketData.js';
import { calculateRVOL } from './services/rvolCalculator.js';
import { enrichWithNews } from './services/newsService.js';
import { sendDailyReport, sendTelegramMessage } from './services/telegramBot.js';
import { RVOLResult, MarketStatus } from './types/index.js';
import logger from './utils/logger.js';
import { formatErrorForTelegram } from './utils/errorHandler.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Check if US market is open/closed for the day
 * Returns true if we should run the scan
 */
function checkMarketStatus(): MarketStatus {
    const now = new Date();
    // Get time in New York (EST/EDT)
    const nyTime = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        hour12: false,
        weekday: 'long',
    }).formatToParts(now);

    const weekday = nyTime.find(p => p.type === 'weekday')?.value;
    const hour = parseInt(nyTime.find(p => p.type === 'hour')?.value || '0', 10);

    // Skip weekends (Saturday, Sunday)
    if (weekday === 'Saturday' || weekday === 'Sunday') {
        return {
            isOpen: false,
            exchange: 'NYSE/NASDAQ',
            currentTime: now,
            message: `Market closed (it is ${weekday} in NY)`,
        };
    }

    // US markets close at 16:00 (4 PM) EST. 
    // We ideally run after close for final daily volume.
    if (hour < 16) {
        const msg = `Market is still open (it is ${hour}:00 in NY). Data will be intraday.`;
        logger.warn(msg);
        return {
            isOpen: true,
            exchange: 'NYSE/NASDAQ',
            currentTime: now,
            message: msg
        };
    }

    return {
        isOpen: true,
        exchange: 'NYSE/NASDAQ',
        currentTime: now,
    };
}

/**
 * Main execution function
 */
async function main(): Promise<void> {
    logger.info('🚀 Smart Volume Radar starting...');
    const startTime = Date.now();

    try {
        // 1. Check market status
        const marketStatus = checkMarketStatus();
        if (!marketStatus.isOpen && marketStatus.message && process.env.FORCE_SCAN !== 'true') {
            logger.info(marketStatus.message);
            await sendTelegramMessage(`📊 Smart Volume Radar\n\n${marketStatus.message}\nNo scan performed.`);
            return;
        } else if (process.env.FORCE_SCAN === 'true') {
            logger.info(`${marketStatus.message} - FORCING scan using last available data.`);
        }

        // 2. Validate configuration
        try {
            validateConfig();
        } catch (error) {
            // Don't fail completely if config is missing, just warn
            logger.warn('Config validation warning: ' + (error as Error).message);
            logger.info('Continuing with available configuration...');
        }

        // 3. Log LLM summary config (helps debug when summary doesn't appear)
        const llmProvider = config.llmProvider;
        const llmKey =
            llmProvider === 'gemini'
                ? config.geminiApiKey
                : llmProvider === 'perplexity'
                  ? config.perplexityApiKey
                  : llmProvider === 'groq'
                    ? config.groqApiKey
                    : config.openaiApiKey;
        logger.info(`LLM Summary: ${config.enableLlmSummary ? 'enabled' : 'DISABLED'} | provider=${llmProvider} | key=${llmKey ? '✓ set' : '✗ missing'}`);

        // 4. Fetch watchlist from Google Sheet and load symbols
        await fetchAndCacheWatchlist();
        const tickers = loadWatchlist();
        logger.info(`📋 Loaded ${tickers.length} tickers to scan`);

        // 5. Fetch market data
        logger.info('📊 Fetching market data...');
        const { stocks, failedTickers } = await fetchAllStocks(tickers);
        logger.info(`✅ Fetched data for ${stocks.length}/${tickers.length} stocks`);

        if (stocks.length === 0) {
            await sendTelegramMessage('❌ Smart Volume Radar: No stock data available. Check API status.');
            return;
        }

        // 6. Calculate RVOL and filter
        logger.info('🔢 Calculating RVOL...');
        const { topSignals, volumeWithoutPrice } = calculateRVOL(stocks, {
            minRVOL: config.minRVOL,
            topN: config.topN,
            priceChangeThreshold: config.priceChangeThreshold,
        });
        logger.info(`🎯 Found ${topSignals.length} signals (RVOL ≥ ${config.minRVOL})`);

        // 7. Enrich with news
        logger.info('📰 Enriching with news...');
        const enrichedSignals = await enrichWithNews(topSignals);

        // Mark volume without price stocks and add sector
        const finalSignals: RVOLResult[] = enrichedSignals.map((s) => {
            return {
                ...s,
                sector: getSectorForTicker(s.ticker),
                isVolumeWithoutPrice: volumeWithoutPrice.some((v) => v.ticker === s.ticker),
            };
        });

        // 8. Classify problematic tickers (invalid + failed) with Groq – INDEX/BOND excluded from Jules
        const today = new Date().toISOString().split('T')[0];
        const invalidTickers = getInvalidTickersFromWatchlist();
        let indexTickers = [...getIndexSkippedFromWatchlist()];
        const combined = [...new Set([...invalidTickers, ...failedTickers])];

        if (combined.length > 0 && config.groqApiKey) {
            logger.info(`🔍 Classifying ${combined.length} problematic tickers with Groq...`);
            const classified = await classifyTickersWithGroq(combined);
            for (const [sym, type] of classified) {
                if (type === 'INDEX' || type === 'BOND') {
                    if (!indexTickers.includes(sym)) indexTickers.push(sym);
                }
            }
        }

        const llmIndicesSet = new Set(indexTickers);
        const fixableInvalid = invalidTickers.filter((t) => !llmIndicesSet.has(t));
        const fixableFailed = failedTickers.filter((t) => !llmIndicesSet.has(t));

        const totalInSheet = tickers.length + invalidTickers.length + getIndexSkippedFromWatchlist().length;
        const notAnalyzed = fixableInvalid.length + indexTickers.length + fixableFailed.length;
        await sendDailyReport(today, finalSignals, volumeWithoutPrice, fixableFailed, {
            watchlistCount: tickers.length,
            invalidTickers: fixableInvalid,
            indexTickers,
            watchlistStats: {
                totalInSheet,
                analyzed: stocks.length,
                notAnalyzed,
                reasonInvalid: fixableInvalid.length,
                reasonIndex: indexTickers.length,
                reasonFetchFailed: fixableFailed.length,
            },
        });

        // 9. Write run-issues for Jules – only fixable tickers; skip if same issues as last Jules run (one fix attempt)
        const hasFixable = fixableInvalid.length > 0 || fixableFailed.length > 0;
        if (hasFixable) {
            const issuesHash = [...fixableInvalid, ...fixableFailed].sort().join('|');
            const lastPath = path.join(__dirname, '..', '.jules-last-issues.json');
            let skipJules = false;
            if (fs.existsSync(lastPath)) {
                try {
                    const last = JSON.parse(fs.readFileSync(lastPath, 'utf-8')) as {
                        hash?: string;
                        invalidTickers?: string[];
                        failedTickers?: string[];
                    };
                    const lastHash = [...(last.invalidTickers ?? []), ...(last.failedTickers ?? [])].sort().join('|');
                    if (lastHash === issuesHash) {
                        skipJules = true;
                        logger.info(
                            '⏭️ Same issues as last Jules run – skipping .scan-issues.json (one fix attempt)'
                        );
                    }
                } catch {
                    // ignore
                }
            }

            if (!skipJules) {
                const issuesFile = process.env.SCAN_ISSUES_FILE || '.scan-issues.json';
                const payload = {
                    date: today,
                    invalidTickers: fixableInvalid,
                    failedTickers: fixableFailed,
                    summary: `Invalid format: ${fixableInvalid.length} | Fetch failed: ${fixableFailed.length}`,
                };
                fs.writeFileSync(issuesFile, JSON.stringify(payload, null, 2), 'utf-8');
                logger.info(`📝 Wrote ${issuesFile} for Jules auto-fix`);

                const lastPayload = {
                    hash: issuesHash,
                    invalidTickers: fixableInvalid,
                    failedTickers: fixableFailed,
                    date: today,
                };
                fs.writeFileSync(
                    path.join(__dirname, '..', '.jules-last-issues.json'),
                    JSON.stringify(lastPayload, null, 2),
                    'utf-8'
                );
            }
        }

        // 10. Log completion
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        logger.info(`\n✅ Report sent successfully in ${duration}s`);
        logger.info(`   Scanned: ${stocks.length} | Signals: ${topSignals.length} | Silent: ${volumeWithoutPrice.length}`);

    } catch (error) {
        const errorMessage = formatErrorForTelegram(error);
        logger.error('❌ Fatal error:', error);

        // Try to notify via Telegram
        try {
            await sendTelegramMessage(`❌ Smart Volume Radar failed:\n\n${errorMessage}`);
        } catch {
            logger.error('Failed to send error notification to Telegram');
        }

        process.exit(1);
    }
}

// Run
main();
