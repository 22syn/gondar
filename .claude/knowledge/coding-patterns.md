# Gondar — Coding Patterns

> Extends `base-coding-standards.md`. Base = universal rules; this = project-specific patterns.
> Node CLI context exempts base React/state/folder sections.
> Updated: 2026-03-02 (post refactor: O(1) sectorMap, getIsraeliNames getter, split formatDailyReport/sendDailyReport)

---

## 1. Naming Conventions

### Data Fetching Verb Prefix

- `fetch` — remote/network: `fetchAllStocks`, `fetchWatchlistCsv`, `fetchAndCacheWatchlist`, `fetchNewsForStock`, `fetchFromYahooChart`, `fetchFromTwelveData`, `fetchIndicatorsFromTwelveData`
- `load` — in-memory/cache: `loadWatchlist`
- `get` — synchronous access or cached data: `getSectorForTicker`, `getTickers`, `getCodeSetup`, `getIsraeliNames`, `getReportSummary`, `getPerStockAnalyses`

### Booleans

- `is` prefix: `isOpen`, `isHeaderRow`, `isFull`, `isClose`, `isIsraeli`, `isFullSetup`, `isCloseSetup`, `isBullish`, `isNearSMA`
- `has` prefix: `hasKey`, `hasSetup`
- Config flags: `useFetchedIndicators`, `enableLlmSummary`, `llmPerStock`, `llmSignalsOnly`, `forceScan`, `debug`

### Constants

- `SCREAMING_SNAKE_CASE` for true constants: `TICKER_REGEX`, `TELEGRAM_MAX_LENGTH`, `VOLUME_RVOL_LOOKBACK`, `TRADING_DAYS_PER_MONTH`, `TRADING_DAYS_52W`
- `camelCase` for config keys: `minRVOL`, `topN`

### Utils

Verb prefixes: `calculate`, `format`, `validate`, `parse`, `escape`, `build`, `is`

---

## 2. Data Patterns

### Normalization at API Boundary

Yahoo/Finnhub/Twelve Data responses → typed interfaces (`StockData`, `NewsItem`) in the same module that fetches. Never pass raw API shapes further.

```ts
// Finnhub → NewsItem
items.map(item => ({
  headline: item.headline,
  url: item.url,
  source: item.source,
  publishedAt: new Date(item.datetime * 1000),
}))
```

Array guard when API may return single item:
```ts
Array.isArray(items) ? items : [items]
```

### Async Data Handling

- Return `null` or `[]` on failure — log with `logger.warn`/`logger.error`, then continue
- `Promise.all` for parallelism; `pLimit` for concurrency (never `sleep()`)
- Caller checks emptiness: `if (stocks.length === 0) return`
- No loading-state objects — this is a CLI pipeline

---

## 3. Complexity Patterns

### Lookup Complexity

- `Map` for O(1) keyed lookups: `sectorMap.get(symbol.toUpperCase()) ?? 'Other'` (Map built once after watchlist load)
- `Set` for O(1) dedup: `new Set<string>()` in `getSetupRowsFromData`
- `Record<string, T[]>` for grouping: sectors grouping in `telegramBot.ts`
- Arrays for ordered sequences: tickers, stocks, signals

---

## 4. Function Design

### Parameters

- Individual params for ≤3 related args
- Object when 4+ related params: `calculateRVOL(stocks, rvolConfig)`, `sendDailyReport(date, topSignals, volumeWithoutPrice, failedTickers, scope?)`
- Config always passed from `config` singleton

### Side Effects

- I/O and network only in service functions
- Caches wrapped in getters with lazy init: `getIsraeliNames()` — never expose mutable module state directly
- `logger.*` for all output, never `console.log`

---

## 5. Error Handling

### Pattern

```ts
// In async fetchers:
try {
  const data = await fetchSomething()
  return normalize(data)
} catch (err) {
  logger.warn('fetchSomething failed', { ticker, error: err })
  return null  // or []
}

// Top-level in main():
try {
  await runPipeline()
} catch (err) {
  const msg = formatErrorForTelegram(err)
  logger.error('Fatal error', { error: err })
  await sendTelegramMessage(msg)
  process.exit(1)
}
```

### Error Format

```ts
// formatErrorForTelegram:
err instanceof Error
  ? `${err.name}: ${err.message}`
  : String(err)
```

Thrown error messages are descriptive and include hints: `"Check GOOGLE_SHEET_ID..."`

---

## 6. State Management

- **Module-level singletons**: `tickerCache`, `sectorMap` (config); `_israeliNamesCache` (newsService, via `getIsraeliNames()` getter)
- **Config**: single `config` object from `config/index.ts`, imported where needed
- **No global mutable store**: data flows top-down `main()` → services via function args
- **Pipeline**: `fetchAllStocks` → `calculateRVOL` → `enrichWithNews` → `sendDailyReport`

---

## 7. Concise Ruleset for New Code

### Naming
1. `fetch` = network; `load` = cache/file; `get` = sync access
2. Booleans: `is` / `has` / `can` / `use` / `enable`
3. Constants: `SCREAMING_SNAKE_CASE`; config keys: `camelCase`
4. Utils: verb prefixes — `calculate`, `format`, `validate`, `parse`, `escape`, `build`

### Data
5. Normalize at API boundary in the fetching service
6. `Array.isArray(x) ? x : [x]` guard when API may return single item
7. Async: return `null`/`[]` on failure; log; no loading-state objects

### Structure
8. `Map` for O(1) keyed lookups; `Set` for dedup; `Record` for keyed groups; arrays for ordered data
9. Object params when 4+ related args; otherwise individual
10. Side effects in services only; keep utils pure
11. Caches: getter with lazy init; never expose mutable module state

### Error Handling
12. Catch in async fetchers; return `null`/`[]` or rethrow for critical failures
13. Format for user-facing: `error.name + ': ' + error.message`
14. Top-level in `main()`: catch → format → log → Telegram notify → `process.exit(1)`

### State
15. Module-level cache where needed; pass data as function arguments
16. Single `config` object; validate with `validateConfig()` at startup

### Files
17. Layout: `config/`, `services/`, `utils/`, `types/`; tests mirror `src` structure
