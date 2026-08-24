/**
 * Breadth over the radar's own scanned universe (2026-08-24).
 *
 * Lives in utils/ rather than beside the rest of the Market Context code
 * because it is pure — and because marketContext.ts imports `p-limit`, whose
 * ESM-only build the Jest CJS transform cannot parse. A test that reaches into
 * that module for a runtime function fails to load the whole suite.
 */

/** Minimum tickers before a reading is reported at all. */
export const MIN_UNIVERSE_TICKERS = 200;

/** Only the two fields this needs — callers pass full StockData objects. */
export interface BreadthInput {
    lastPrice?: number;
    sma50?: number;
}

/**
 * % of the scanned universe closing above its own SMA50, plus how many tickers
 * actually answered.
 *
 * Costs nothing: `sma50` is already computed for every fetched ticker, so this
 * is a reduce over an array the scan is holding anyway.
 *
 * **This is NOT a substitute for S5FI and must never be presented as one.**
 * Measured 2026-08-22 against a real S5FI series over 70 overlapping days, the
 * LEVEL correlation is negative in all four variants tried (all-universe
 * -0.457, US-only -0.425, fixed-cohort-all -0.621, fixed-cohort-US -0.564), and
 * the offset drifted from +18pp in May to -20pp in July. The fixed cohort scored
 * WORST, which rules out the watchlist's 366→634 growth as the cause: it is a
 * real momentum-vs-broad-market divergence, not a composition artifact.
 *
 * That divergence is exactly why the number is worth having. It measures the
 * health of the stocks this radar actually trades, not the S&P — and the gap
 * between the two is the "index fine, your names rolling over" reading that
 * neither number gives on its own.
 */
export function computeUniverseBreadth(
    stocks: ReadonlyArray<BreadthInput>
): { value: number | null; n: number | null } {
    const valid = stocks.filter(
        (s) => s.sma50 != null && s.sma50 > 0 && s.lastPrice != null && Number.isFinite(s.lastPrice)
    );
    if (valid.length < MIN_UNIVERSE_TICKERS) {
        return { value: null, n: valid.length };
    }
    const above = valid.filter((s) => s.lastPrice! > s.sma50!).length;
    return { value: (above / valid.length) * 100, n: valid.length };
}
