# AVWAP reclaim, ATL mirror and overhead supply — 2026-10-06

Branch `claude/avwap-anchor-psychology-07f845`. Scripts: `scripts/research-avwap-event-study.py`
(`ath` and `atl` modes) and `scripts/research-overhead-supply.py`. Specs are pre-registered in each
script's docstring (written before any outcome was inspected).

## Question

Kobi's thesis: an anchored VWAP is the average cost basis of everyone who bought since the anchor.
After a long stretch below it, holders are underwater and sell at breakeven; a reclaim on strong volume
means the supply was absorbed ("the most bullish sign"). The earlier `above_AVWAP_from_peak` result
(Albert criteria study, 2026-08-07) was a **state** test; this tests the **event**, the mirror (ATL), and
an anchor-free version.

## Data

`results/research/replay-4y.sqlite` — 598 tickers, 2022-08-08..2026-08-07. QA: 7 tickers with a
+300% / -80% single-day move dropped (agorot break on `*.TA`, 2026-05-18). Universe is the curated 2026
watchlist, so survivorship flatters recoveries. Entry = event-day close. Controls: same date and same
RS decile (126d return), event ticker excluded; month-cluster bootstrap CIs.

Result files (gitignored): `results/research/avwap-event-study-ath.json`,
`avwap-event-study-atl.json`, `overhead-supply.json`. Reproduce with
`python3 scripts/research-avwap-event-study.py out.json [ath|atl]` and
`python3 scripts/research-overhead-supply.py out.json`.

## Results

**1. Reclaim after >=60 sessions below the anchored VWAP (ATH anchor = 52w-high day).**

| | n | 63d excess mean | 63d excess median | 90%-trimmed mean | 21d win (base 55.1%) |
|---|---|---|---|---|---|
| V1: cross + RVOL>=2 | 200 | +9.1% [+0.3, +20.2] | -4.1% | -1.2% | 47.4% |
| V3: +5% confirmation + RVOL>=2 | 133 | +11.2% [-0.8, +24.4] | -5.6% | -1.5% | 45.8% |

All right tail: the top-5 events (ASTS +670%, OPEN +413%, QBTS, AAOI ...) explain >100% of the excess
(111% / 123%). The "lottery" rate (+50% within 63d) is 8.7% (V1) / 10.6% (V3) vs 4.5% across all
ticker-days — about 2x — while the median trade lags same-RS peers.
Unstable by year (V1 63d: 2023 -5%, 2024 +20%, 2025 +2%). YTD and gap anchors: null (gap V3 n=62, no
conclusion). Unweighted-average placebo: same direction, weaker, overlapping CIs.

**2. ATL mirror (>=60 sessions above the 52w-low AVWAP, then a breakdown).** V1 n=266 / V3 n=154: excess
+0.2/-0.2 and +1.3/+1.2 (CIs span 0); down-rate at 63d 34%/30% vs 40% base; crash rate (fwd63 <= -30%)
2.0% vs 2.9% base. Breakdowns are **not** bearish. Confirmed (-5%) breakdowns are slightly positive
(+3.3% @63d, trimmed +1.4%), probably survivorship.

**3. Anchor-free overhead supply (share of trailing-252d volume traded above today's close).**
Univariate IC -0.08 (t -3.55 @63d), hit rate 65.6% -> 58.9% Q1->Q5 within an RS tercile — but
Fama-MacBeth controlling RS126, distance from the 52w high and 63d volatility gives +0.081 (NW t +2.14),
failing the pre-registered bar (|t| >= 3 and the thesis sign in >= 3 years; it appears in 1 of 4). 27-cell
double-sort: -0.3% [-1.0, +0.4]. High overhead supply is momentum plus dispersion, not an independent signal.

## Verification

- Plain-loop re-implementations match the vectorized code: 0 mismatches on 149 tickers (3 anchors,
  V0/V1/V2) for ATH/YTD/gap; 0 on kept tickers for ATL (4 mismatches, all in QA-dropped `*.TA`);
  overhead supply max diff ~1e-16 on 250 random ticker-days.
- `calculateAVWAP` (`src/utils/technicalAnalysis.ts`) reproduces the SPCX values (146.39 / 148.54 / 140.12).
- Reruns are deterministic (seeded bootstrap).

## What this does NOT cover

N-below sensitivity (30/90), true all-time anchors (only 52w proxies; data is 4y), earnings-date anchors,
overhead-supply window other than 252 sessions, intraday volume profile (MarketWebs-style), survivorship.
~50 looks in total across the programme — any single marginal CI should be read with that in mind.

## SPCX walk-through (NASDAQ:SPCX, IPO 2026-06-12)

ATH 225.64 on day 3; ATH-AVWAP collapsed ~207 -> ~145 and went flat; IPO/YTD AVWAP 148.5 (same level,
because the ATH was on day 3). 38 sessions below, then 5 up-crosses of which 4 failed (two on 1.5-1.7x
volume); the real break was 2026-10-02 / 10-05 (+8.9% / +16.9% above the level, 1.5-1.6x volume). It would
not have qualified under N=60. Yahoo returns hourly bars for `range=max&interval=1d` on a fresh IPO —
aggregate to daily before computing anything.

## Catch-rate check for a possible GONDAR signal (`scripts/research-avwap-catch-rate.py`)

987 "monster episodes" (fwd63 >= +50%) in 583 tickers x 4y. Spec frozen before the run; S4 was designed
after studying SPCX, so SPCX is a design example for it, not evidence.

| signal | n | precision (+50% @63d) | same-RS peers | recall of episodes | random placement |
|---|---|---|---|---|---|
| S1 reclaim after >=60 below, RVOL>=2 | 200 | 8.7% | 3.8% | 1.2% | 1.6% |
| S2 S1 + 5% confirmation | 133 | 10.6% | 4.1% | 0.6% | 1.0% |
| S4 base-on-the-level breakout (SPCX-shaped) | 751 | 4.8% | 4.7% | 4.9% | 5.7% |

S1/S2 enrich lottery outcomes about 2x but find ~1% of monsters (no better than random placement) and the
median trade lags. S4 has no lift. SPCX: S1/S2 do not fire (38 < 60 sessions below); S4 fires on 2026-10-05,
day two of the break. Base rate for +50% in 63d over all ticker-days is 4.5% (an earlier draft of this note
quoted 6%, which was the event-rows subset — wrong base).

## Decision

No score or gate from any AVWAP formulation; no new signal. RS remains the only signal that carries forward
returns here (see the Albert triple-confluence and RS-score studies).

Shipped as a **display-only column** instead: GONDAR "vs AVWAP" (price vs the AVWAP anchored at the 52w-high
bar, beside ATH%) — 22syn/gondar#234, merged to `stable` 2026-10-06 (e35dfb8), dashboard deployed the same
day; the first post-merge ingests filled 100% of rows. Nothing scores, ranks or gates on it, and it must
never be presented as an edge.
