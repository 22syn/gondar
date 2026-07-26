import { extractSymbols, extractName, assertAllowedUrl } from '../src/services/sharedWatchlist';

const FIXTURE =
    '<script>window.initData = {"name":"Semis",' +
    '"symbols":["###SEMI - CAP","NASDAQ:NVDA","NASDAQ:AMD","KRX:000660","NYSE:BRK.B"],' +
    '"x":1};</script>';

describe('extractSymbols', () => {
    it('returns the symbols and drops section headers', () => {
        expect(extractSymbols(FIXTURE)).toEqual([
            'NASDAQ:NVDA',
            'NASDAQ:AMD',
            'KRX:000660',
            'NYSE:BRK.B',
        ]);
    });

    it('throws when symbols are absent', () => {
        expect(() => extractSymbols('<html>nope</html>')).toThrow(/could not find symbols/i);
    });
});

describe('extractName', () => {
    it('reads the watchlist name that precedes the symbols array', () => {
        expect(extractName(FIXTURE)).toBe('Semis');
    });

    it('returns null when no name is present', () => {
        expect(extractName('<html>nope</html>')).toBeNull();
    });
});

describe('assertAllowedUrl', () => {
    it('allows https tradingview.com and subdomains', () => {
        expect(() => assertAllowedUrl('https://www.tradingview.com/watchlists/123/')).not.toThrow();
        expect(() => assertAllowedUrl('https://tradingview.com/watchlists/123/')).not.toThrow();
    });

    it('rejects non-tradingview hosts', () => {
        expect(() => assertAllowedUrl('https://evil.com/x')).toThrow(/non-TradingView/i);
    });

    it('rejects a lookalike host that only ends with the domain as a substring', () => {
        expect(() => assertAllowedUrl('https://tradingview.com.evil.com/x')).toThrow(/non-TradingView/i);
    });

    it('rejects non-https schemes and SSRF vectors', () => {
        expect(() => assertAllowedUrl('http://www.tradingview.com/x')).toThrow(/non-TradingView/i);
        expect(() => assertAllowedUrl('file:///etc/passwd')).toThrow(/non-TradingView/i);
        expect(() => assertAllowedUrl('http://localhost/x')).toThrow(/non-TradingView/i);
    });

    it('rejects a malformed URL', () => {
        expect(() => assertAllowedUrl('not a url')).toThrow(/invalid URL/i);
    });
});
