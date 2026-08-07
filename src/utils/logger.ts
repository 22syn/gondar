/**
 * Gondar - Logger Utility
 * Consistent logging with timestamps and levels
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const LOG_PREFIXES: Record<LogLevel, string> = {
    info: '📊',
    warn: '⚠️',
    error: '❌',
    debug: '🔍',
};

/**
 * Format timestamp for logs
 */
function getTimestamp(): string {
    return new Date().toISOString();
}

/**
 * Log a message with level and timestamp
 */
function log(level: LogLevel, message: string, data?: unknown): void {
    const prefix = LOG_PREFIXES[level];
    const timestamp = getTimestamp();
    const logMessage = `[${timestamp}] ${prefix} ${message}`;

    if (data !== undefined) {
        console[level === 'error' ? 'error' : 'log'](logMessage, data);
    } else {
        console[level === 'error' ? 'error' : 'log'](logMessage);
    }
}

export const logger = {
    info: (message: string, data?: unknown): void => log('info', message, data),
    warn: (message: string, data?: unknown): void => log('warn', message, data),
    error: (message: string, data?: unknown): void => log('error', message, data),
    debug: (message: string, data?: unknown): void => log('debug', message, data),
};

export default logger;
