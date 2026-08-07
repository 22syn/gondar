# Gondar — Complete Message Guide

Reference for everything shown in the daily Telegram report.

---

## 1. Entry Conditions

### Main Signals (Top Section)
A stock appears only if:
- **RVOL ≥ MIN_RVOL** (default: 2.0)
- It's among the **top TOP_N** stocks by RVOL (default: 15)
- Sorting: RVOL descending; consolidation setups ranked higher when RVOL is similar

### Silent Activity Watchlist (Bottom Section)
A stock appears here only if:
- Meets main signal conditions above, **and**
- **|Price Change| < PRICE_CHANGE_THRESHOLD** (default: 2%)
- Up to 5 stocks shown

---

## 2. Per-Stock Message Format

```
↗️ TICKER (link to TV)
├ 📊 RVOL X.XXx
├ Price ±X.XX%
├ 📈 RSI XX
├ Above/Below SMA50
├ 🎯 Setup [🎯/👀]
│   SMA21  X.X% ✓ (req ≤3%)   or  X.X% ~ (X.X% over 3%, under 5% close)   or  ✗
│   High   -X% from 52w ✓ (req ≤20%)   or  ~   or  ✗
│   Base   Xmo base ✓ (req 6–36mo)   or  ~   or  ✗
├ ⛓ TV  YF  BIZ/X
└ 📑 News or link
```

Each setup indicator shows:
- **✓** — Met the condition
- **~** — Close (within flexible threshold); shows how far from meeting
- **✗** — Not met; shows how far from the threshold

### Fields

| Field | Meaning | Source |
|-------|---------|--------|
| **RVOL** | Relative Volume = today's volume ÷ 63-day SMA of volume | Calculated |
| **Price** | Daily % change (vs previous close) | Calculated |
| **RSI** | Relative Strength Index (0–100) | Twelve Data API or calculated |
| **Trend** | Price above or below 50-day SMA | Calculated (SMA50) |
| **Setup** | Consolidation / pre-breakout metrics | See section 3 |

---

## 3. Setup Indicators (Pre-Breakout)

| Indicator | ✓ Met | ~ Close | ✗ Not Met |
|-----------|-------|---------|-----------|
| **SMA21** | Distance ≤3% from SMA21 | 3–5% from SMA21 | >5% |
| **High** | Within 20% of 52-week high | 20–25% from high | >25% |
| **Base** | 6–36 months in consolidation | 4–6 months (1–2mo short) | <4mo or >36mo |

**Label:** `52w` = 52-week high (last 252 trading days)

---

## 4. Symbols & Emojis

### Status
| Emoji | Meaning |
|-------|---------|
| ↗️ | Price up today |
| ↘️ | Price down today |
| 🔥 | RVOL > 2x |
| ⚡️ | RVOL > 4x |
| 🟢 | Bullish (positive price change) |
| 🔴 | Bearish (negative price change) |

### Setup Quality
| Emoji | Meaning |
|-------|---------|
| 🎯 | Full consolidation setup (near SMA21 + near ATH + 6mo–3y base) |
| 👀 | Close to full setup (flexible thresholds) |

### Technical
| Emoji | Meaning |
|-------|---------|
| 📈 | Price above SMA50 |
| 📉 | Price below SMA50 |
| ⚠️ | RSI > 70 (overbought) |
| ✅ | RSI < 30 (oversold) |

---

## 5. Config Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MIN_RVOL` | 2.0 | Minimum RVOL to appear in the report |
| `TOP_N` | 15 | Maximum stocks in main signals |
| `PRICE_CHANGE_THRESHOLD` | 2 | Max \|price change\| % for Silent Activity list |
| `CONSOLIDATION_MIN_MONTHS` | 6 | Minimum months in base for full setup |
| `CONSOLIDATION_MAX_MONTHS` | 36 | Maximum months in base for full setup |
| `CONSOLIDATION_CLOSE_MIN_MONTHS` | 4 | Min months for "close" setup (4–6mo) |
| `ATH_THRESHOLD_PCT` | 20 | Within X% of ATH = full setup |
| `ATH_CLOSE_THRESHOLD_PCT` | 25 | 20–25% from ATH = close setup |
| `SMA21_TOUCH_THRESHOLD_PCT` | 3 | Within X% of SMA21 = touching |
| `SMA21_CLOSE_THRESHOLD_PCT` | 5 | 3–5% from SMA21 = close |
| `GOOGLE_SHEET_ID` | — | Watchlist source |
| `TWELVE_DATA_API_KEY` | — | Optional; fetch RSI/SMA instead of calculating |
| `USE_FETCHED_INDICATORS` | true | `false` = always calculate RSI/SMA locally |

---

## 6. Data Sources

### From APIs
- **Price, Volume** — Yahoo Finance (primary) or Twelve Data (fallback)
- **RSI, SMA21** — Twelve Data (when API key is set), otherwise calculated
- **52w high** — Twelve Data (fallback only)
- **News** — Finnhub

### Calculated Locally
- **RVOL** = today's volume ÷ 63-day SMA of volume
- **Price Change %** = (close − previous close) ÷ previous close × 100
- **SMA50, SMA200** = simple moving average of last 50/200 closes
- **52w high** = max of last 252 trading days
- **pctFromAth** = (price − ATH) ÷ ATH × 100
- **monthsInConsolidation** = trading days since last ATH touch ÷ 21
- **nearSMA21, nearAth, inConsolidationWindow** = comparisons vs thresholds above
- **Setup (🎯/👀)** = RVOL ≥ minRVOL + all three setup conditions

---

## 7. Links

| Link | Target |
|------|--------|
| **TV** | TradingView chart |
| **YF** | Yahoo Finance quote |
| **X** | X (Twitter) search for ticker (US stocks) |
| **BIZ** | BizPortal (Israeli stocks, `.TA` suffix) |

---

## 8. Tips

- **🎯** Full setup: RVOL ≥ minRVOL + near SMA21 + near ATH + base in 6–36mo window
- **Silent Activity** — High volume with little price change can indicate accumulation or distribution
- Stocks with `.TA` suffix are Israeli (TASE); news links go to BizPortal
- Long reports are split into multiple Telegram messages (max 4096 chars per message)

---

## 9. Related

- Exact formulas: `knowledge/calculations.md`
- Indicator sources: `knowledge/indicator-sources.md`
- Setup criteria source of truth: `src/utils/setup.ts`
