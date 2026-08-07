/**
 * Gondar - Error Handler Utility
 * Graceful error handling with retry logic
 */

import logger from './logger.js';

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 * @param fn - Function to retry
 * @param maxRetries - Maximum number of retries
 * @param baseDelayMs - Base delay in milliseconds (doubles each retry)
 * @param context - Context string for logging
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    baseDelayMs: number = 1000,
    context: string = 'operation'
): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));

            if (attempt === maxRetries) {
                logger.error(`${context} failed after ${maxRetries} attempts`, lastError.message);
                throw lastError;
            }

            const delay = baseDelayMs * Math.pow(2, attempt - 1);
            logger.warn(`${context} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
            await sleep(delay);
        }
    }

    throw lastError;
}

/**
 * Safe JSON parse with fallback
 */
export function safeJsonParse<T>(json: string, fallback: T): T {
    try {
        return JSON.parse(json) as T;
    } catch {
        return fallback;
    }
}

/**
 * Format error for Telegram notification
 */
export function formatErrorForTelegram(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}`;
    }
    return String(error);
}
