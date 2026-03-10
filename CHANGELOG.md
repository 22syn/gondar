# Changelog

## Unreleased

### Added
- **Newlogic tags:** Replaced Setup (🎯/👀) with independent tags: SMA21 Touch, Pullback 15%, 1M Breakout. Tags shown per stock; Silent Activity and Top Signals both receive tags.

### Changed
- **Report logic:** Entry has two paths: (1) Green: RVOL ≥ 2 AND |priceChange| ≥ 2%; (2) Blue: all three tags (SMA21 Touch, Pullback 15%, 1M Breakout). Stock enters if green OR blue.
- **Weekly report:** Now lists all signals (no tag filter).
- **Removed:** `setup.ts`, Full/Close Setup; `StoredSignal` uses `tags` array instead of `setupType`.

### Added 
- **Signal results persistence & weekly setup evaluation:** Save scan results as artifacts, evaluate full setup (🎯) performance, send summary to Telegram on Sundays
- **Jules run-issues auto-fix:** When daily scan has invalid tickers or fetch failures, writes `.scan-issues.json` and invokes Jules to fix (extend TICKER_REGEX, improve fetch). Jules opens `fix/daily-scan-run-issues-*` PR; merge triggers re-run via existing verify-and-merge flow
- **Run issues in Telegram:** Invalid tickers and failed-fetch list appear at top of first message for visibility
- **Jules improvements:** `docs/standards-for-ci.md` — SSoT export for CI (derived from Maestro vault)
- **Jules improvements:** `agents.md` extended with Jules context (scopes, guardrails, forbidden patterns)
- **Jules improvements:** `jules-fix-on-failure.yml` prompt now references `docs/standards-for-ci.md`, asks for PR summary
- **Jules improvements:** `jules-pr-labels.yml` — auto-label PRs from `fix/daily-scan-*` and `chore/standards-*` with `jules`, `jules/fix-daily`, `jules/standards`
- **Maestro:** Jules agent routing (`03-agents/specialists/jules.md`, trigger matrix row 39)
- `docs/jules-scheduled-task-setup.md` — instructions for creating weekly standards sweep (manual)

### Changed
- **refactor:** Extracted setup criteria (`isFullSetup`, `isCloseSetup`) to `src/utils/setup.ts`
- **refactor:** Extracted RVOL/price formatters to `src/utils/formatters.ts` (config-aware)
- **refactor:** rvolCalculator, telegramBot, llmSummary, marketData use shared setup and formatter utilities

### Added
- **Jules auto-fix:** On daily scan failure, `jules-fix-on-failure.yml` invokes Jules to analyze, fix, version bump, and open a PR. Merge triggers re-run via `re-run-scan-after-fix.yml`
- `agents.md` — setup hints for Jules and other AI agents

### Changed
- **perf:** O(1) sector lookup via `Map` (was `tickers.find()` per signal)
- **refactor:** `loadIsraeliNames` → `getIsraeliNames` with lazy-init getter
- **refactor:** Split `formatDailyReport` into `formatFailedSection`, `formatReportHeader`, `formatSingleStockBlock`, `formatVolumeWithoutPriceSection`
- **refactor:** Extract `buildLlmSummaryMessage` from `sendDailyReport`

### Fixed
- **Standards:** `scripts/send-legend.ts` — replaced `console.log`/`console.error` with `logger` (was documented but not applied)

- **LLM:** Configurable model (`LLM_MODEL`); Gemini default to `gemini-2.0-flash` (was invalid `gemini-3-flash-preview`)
- **LLM:** Escape output in Telegram HTML (security)
- **Config:** NaN guards for numeric env vars (`parseFloatEnv`/`parseIntEnv`)

### Added
- `LLM_SIGNALS_ONLY` — analyze only main signal stocks when true
- CI: `npm audit --audit-level=high` step
- daily-scan: optional `GEMINI_API_KEY`, `TWELVE_DATA_API_KEY`, `ENABLE_LLM_SUMMARY`, `LLM_PROVIDER`
- Clearer LLM skip logs when API key missing

### Added (March 2026)

- Config: twelveDataApiKey, forceScan, debug (replacing direct process.env)
- API response types in marketData, newsService (typed Yahoo/Twelve Data responses)
- Twelve Data throttling: p-limit(2) for RSI/SMA fetches
- Telegram failure notification in daily-scan workflow
- Tests: technicalAnalysis, errorHandler, marketData
- Coverage threshold 55% in jest.config

### Removed

- Dead code: withRetry, safeJsonParse from errorHandler
- Dead type: ScanResults from types
- Unused config: batchSize, batchDelayMs, maxRetries, retryDelayMs

### Security

- **Input validation:** Ticker symbols validated with regex; invalid tickers skipped with warning
- **URL encoding:** `encodeURIComponent()` for all tickers and Google Sheet ID in URLs
- **XSS prevention:** `escapeHtml()` for sector, headline, source, URL in Telegram HTML; only https URLs in news links
- **Google Sheet ID:** Format validation (20–60 alphanumeric/dash/underscore) before fetch
- **Dependencies:** Removed 3 vulnerabilities via `npm audit fix`; removed unused `yahoo-finance2`, `rss-parser`

### Added

- `.env.example` — template for all env vars
- `.github/workflows/ci.yml` — lint, build, test on push/PR
- `src/utils/escapeHtml.ts` — HTML entity escaping for Telegram
- `validateTicker()` and `validateGoogleSheetId()` in config
- Test: invalid ticker skip, invalid sheet ID format
- `concurrency` and `timeout-minutes` in daily-scan workflow
- Build step: copy `israeliNames.json` to `dist/config/`

### Changed

- `marketData`, `newsService`, `telegramBot` — explicit types, null-safety, Boolean() for setup predicates; lint 0 warnings
- `scripts/send-legend.ts` — uses `logger` instead of `console.log`
- `newsService` — cache `israeliNames.json` in memory (no per-stock file read)
- `package.json` — build copies JSON to dist
