/**
 * Error Handler utility tests
 */
import { sleep, formatErrorForTelegram } from '../src/utils/errorHandler.js';

describe('sleep', () => {
    it('resolves after specified ms', async () => {
        const start = Date.now();
        await sleep(50);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(45);
    });
});

describe('formatErrorForTelegram', () => {
    it('formats Error instance', () => {
        const err = new Error('Something went wrong');
        expect(formatErrorForTelegram(err)).toBe('Error: Something went wrong');
    });

    it('formats TypeError', () => {
        const err = new TypeError('Invalid type');
        expect(formatErrorForTelegram(err)).toBe('TypeError: Invalid type');
    });

    it('handles non-Error values', () => {
        expect(formatErrorForTelegram('string error')).toBe('string error');
        expect(formatErrorForTelegram(42)).toBe('42');
    });
});
