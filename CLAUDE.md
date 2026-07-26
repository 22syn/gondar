# CLAUDE.md — smart-volume-radar-engine
> 📋 **Active plan (2026-07-23):** [docs/plans/2026-07-23-graph-audit-followup.md](docs/plans/2026-07-23-graph-audit-followup.md) — graph-audit follow-up; review before structural changes.
> 📋 **Improvement plan (2026-07-23):** [docs/plans/2026-07-23-improvement-plan.md](docs/plans/2026-07-23-improvement-plan.md) — **execute the already-decided engine→sync consolidation**, plus a few open verifications.

**Purpose**
Automated stock volume monitoring system. Calculates Relative Volume (RVOL = today's volume / 63-day average), detects signals (RVOL ≥ 2.0, configurable), enriches with news + technical context (RSI, SMA, pre-breakout setup), and delivers daily intelligence reports to Telegram. Runs daily via GitHub Actions.

**Stack**
- Node.js ≥20, TypeScript 5.9, ESM
- Runtime: `tsx`; build: `tsc`
- Key deps: `yahoo-finance2` (market data), `rss-parser` + `fast-xml-parser` (news feeds), `p-limit` (concurrency), `dotenv`
- Optional LLM summary via OpenAI / Perplexity / Gemini
- Tooling: Jest (+ ts-jest), ESLint, Prettier, Playwright (TradingView cookie/sync utilities)

**Structure**
- `src/index.ts` — main orchestration / entry point
- `src/config/` — env, Google Sheet watchlist loader, `validateConfig`
- `src/services/` — `marketData.ts` (Yahoo, Twelve Data fallback), `rvolCalculator.ts`, `newsService.ts` (Finnhub), `telegramBot.ts`, `llmSummary`
- `src/types/`, `src/utils/` — interfaces, technical-analysis helpers, error handling
- `scripts/` — many `tsx` utilities (backtests, retro evaluation, scan-now, TV sync, report preview)
- `tests/` — Jest unit tests
- `.github/workflows/` — daily scan + Jules auto-fix automation
- `results/`, `outputs/` — scan history and generated reports

**Run / dev**
- `npm run start` — run once (`tsx src/index.ts`); `npm run dev` — watch mode
- `npm run build` — `tsc`; `npm run lint`; `npm run format`
- `npm test` / `npm run test:coverage`
- `npm run scan-now`, `npm run backtest-momentum`, `npm run evaluate-retro`, `npm run tv-sync` (see `package.json` for the full script list)

**Conventions / notes**
- Required env vars: `FINNHUB_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GOOGLE_SHEET_ID`. Copy `.env.example` → `.env`. Many optional tuning vars (`MIN_RVOL`, consolidation/ATH/SMA thresholds, LLM provider) — see README config table.
- Watchlist is loaded from a **Google Sheet** at each run (Col A = symbol, Col B = sector); no code change needed to edit symbols.
- Source of truth for docs is the Obsidian "Maestro" vault, not this repo.
- CI/agent standards (`agents.md`, `docs/standards-for-ci.md`): no `console.log`, no bare `any`, always `escapeHtml` for user/API content rendered in Telegram HTML. Jules AI auto-fixes failed daily scans via `.github/` workflows.
- `mcp-tv-sync/` holds a local MCP wrapper around the TradingView sync script.
