# Gondar — Agent Setup

For Jules and other AI agents working on this repo.

## Quick Setup (Jules VM / CI)

```bash
npm ci
npm run lint
npm run build
npm run test
```

## Run Locally (needs env vars)

```bash
# Copy .env.example to .env, fill required keys
cp .env.example .env
npm run start   # or: npm run dev
```

**Required env vars:** `FINNHUB_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GOOGLE_SHEET_ID`

## Project Structure

- **Entry:** `src/index.ts` — main orchestration
- **Config:** `src/config/` — env, watchlist, validateConfig
- **Services:** `src/services/` — marketData, rvolCalculator, newsService, telegramBot, llmSummary
- **Standards:** See `docs/standards-for-ci.md`; no `console.log`, use `escapeHtml` for user/API content in Telegram HTML.

## Stack

Node.js ≥20, TypeScript 5.9, ESM, tsx, Jest, ESLint, Prettier

## Jules Triggers

| Trigger | Branch | Action |
|---------|--------|--------|
| Daily scan **fails** (crash) | `fix/daily-scan-*` | `jules-fix-on-failure.yml` — analyze logs, fix, PR, merge → re-run |
| Daily scan **succeeds with run issues** (invalid tickers, fetch failures) | `fix/daily-scan-run-issues-*` | `daily-scan.yml` — writes `.scan-issues.json`, invokes Jules, PR, merge → re-run |

## Jules Context

- **Scopes:** Jules may touch: `src/`, `tests/`, `scripts/`, `package.json`, `.github/`, `docs/`, `CHANGELOG.md`
- **Guardrails:** Idempotent tasks; PR review is merge gate; no changes outside scopes
- **Standards:** Read `docs/standards-for-ci.md` (derived from Maestro `04-knowledge/standards/smart-volume-radar-standards.md`)
- **Forbidden:** `console.log`, bare `any`, missing `escapeHtml` for user/API content in HTML
