# Fragility calibration study — 2026-07-27

Evidence base for restricting the 🟡 Watch **Telegram** path to the `core3` arm
(`watchAlertable` in `src/services/purpleFragility.ts`). The `climax` arm keeps
firing `watchTrigger`, keeps being persisted to D1, and keeps being drawn on the
dashboard — it just no longer sends a message.

## Data

- **Fragility series** — Cloudflare D1 `lean-radar` (`393d2493-8bc6-4c8b-aa89-d09fe214f889`),
  table `fragility_daily`, 252 rows, `2025-07-16` → `2026-07-23`. Snapshot: `fragility.json`.
- **Benchmarks** — Yahoo Finance daily closes, `range=2y`: `QQQ.json`, `SPY.json`,
  `IWM.json`, `idx_IXIC.json` (^IXIC), `idx_GSPC.json` (^GSPC).

Alert/Watch rules were reconstructed and verified line-by-line against
`src/services/purpleFragility.ts` (`redFires`, `watchTrigger`), not inferred.
The reconstruction reproduces the known 10 🔴 Alert dates exactly.

## Scripts

| Script | Answers |
|---|---|
| `analyze.py` | First pass — raw hit rates per index. **Superseded**: no base rate, no clustering control. Kept because its conclusion was wrong and the correction is the point. |
| `deep.py` | Circularity, state-matching, circular-shift permutation significance, incremental value over `drawdown_pct` |
| `arms.py` | Watch decomposed by arm; Alert score-threshold sweep; the misses |
| `basket.py` | Re-tests both arms against the **basket's own** >=7% tops — the target PR #82 actually calibrated on |
| `recall.py` | The recall/precision tradeoff of dropping the climax arm |

Run from this directory: `python3 deep.py` (no dependencies beyond the stdlib).

## Headline results

**🔴 Alert validates.** vs QQQ −5%/20d: 7/10 = 70% against a 21% base rate (3.39x),
circular-shift permutation **p = 0.0078**. Against the basket's own >=7% tops:
8/10 = 80% vs 31% base (2.61x, p = 0.0193). The score is not a repackaged
drawdown reading — partial correlation controlling for `drawdown_pct` (−0.148)
is essentially the raw correlation (−0.152).

**The `1.0` threshold is not a tuned artifact.** Sweep at QQQ −5%/20d: 0.9 → 3.08x,
1.0 → 3.39x, 1.1 → 4.24x, 1.2 → 3.88x, all p < 0.01. A broad plateau. 1.1 scores
best on 8 events vs 10 — chasing it would be overfitting to two events. Left alone.

**The Watch tier's two arms behave oppositely**, against the basket's own tops
(10-day lookahead, >=7% episodes, n=11 episodes):

| Rule | Recall | Precision | Firings |
|---|---|---|---|
| alert + core3 + climax (before) | 11/11 = 100% | 58% | 31 |
| alert + core3 (**message path now**) | 7/11 = 64% | **81%** | 16 |
| alert only | 6/11 = 55% | 90% | 10 |
| climax only | 5/11 = 45% | **33%** | 15 |

The 33% precision of the climax arm sits *below* the 31% unconditional base rate.

## Reconciling with PR #82

PR #82 reported the combined Watch rule catching "94%/92% of >7% tops at ~39%
precision" across a 2023-24 / 2025-26 split-half. **That replicates here** — the
combined rule scores 100% recall on this window. The two studies do not conflict;
they measure different things. PR #82 optimised recall; this study decomposed the
precision behind it and found it concentrated entirely in `core3`.

Note the asymmetry that motivated the split: recall is cheap on a chart you
choose to look at, and expensive on a message that interrupts you. Hence climax
stays on the dashboard and leaves the Telegram path.

## Limitations

- **252 sessions.** A strict subset of PR #82's calibration span — this cannot
  refute that study on its own terms, only show recent behaviour.
- **Clustering.** The 10 Alerts fall into two episodes (2025-10-24→11-12,
  2026-05-21→06-18). The permutation test preserves that structure exactly, but
  two regimes remain two regimes.
- **Multiple comparisons.** ~20 index × threshold × tier cells with no correction;
  no single cell survives strict Bonferroni. Direction-consistency across cells is
  the load-bearing evidence, not any one p-value.
- **Regime.** An unusually volatile window (basket ends −21.9% from peak; QQQ 3%-dip
  base rate 41%). Base rates would differ in a calm year — recompute, don't hardcode.
- **Small arms.** n=15 climax, n=6 core3 events.

## Re-run cadence

Re-run after 2–3 more independent **episodes** (not alerts). The frozen OOS log
(`src/utils/oosLog.ts`, PR #91) is the accumulating instrument for that.

## Addendum (2026-08-25) — does the Alert `indexNearHigh` gate deserve loosening?

Prompted by Kobi reading a 🟡 Watch marker (2026-08-17/18, the bounce off the
July low) and expecting 🔴 Alert instead. `nearhigh.py` — full live 4.4y engine
history (`fragility-full.json`, 1130 aligned days, 2022-01-27..2026-08-21,
generated via `computePurpleFragility`), not just the 252-day D1 snapshot.

**The premise doesn't hold.** On 2026-08-17/18, `score` (mean6 — Alert's own
condition) topped at 0.81/0.58, never reaching 1.0. Only `core3` was elevated
(1.16/1.36) — that's the Watch condition, a different signal. The
`indexNearHigh` gate was never what blocked Alert here; mean6 itself didn't
qualify, gate or no gate.

**Tested loosening the gate anyway**, sweeping the near-high threshold 2%
(current) → 4/6/8/10/15/20%/unlimited, against the basket's own top episodes
(same method as `basket.py`):

| Gate | Alert events | Hit rate (≤-8%/20d) | Lift | p |
|---|---|---|---|---|
| 2% (current) | 10 | **80%** | **2.53x** | 0.05 |
| 4% | 7 | 71% | 2.26x | 0.12 |
| 6% | 5 | 60% | 1.89x | 0.27 |
| 8% | 6 | 50% | 1.58x | 0.36 |
| 10% | 6 | 50% | 1.58x | 0.36 |
| 15% | 5 | 40% | 1.26x | 0.53 |
| 20% | 5 | 40% | 1.26x | 0.54 |
| off (score-only) | 5 | 40% | 1.26x | 0.54 |

Precision, lift, and significance degrade **monotonically** as the gate
loosens. Event count doesn't even rise — a looser gate stays "satisfied"
through a whole episode instead of re-triggering, so it fires less often, not
more. Only 12 of 1130 scored days ever have score≥1.0 while nearHigh(2%) is
false — the entire population a looser gate could touch — and none of the
candidates that add days improve on the current rule.

**Conclusion: the 2% gate is not an arbitrary restriction, it is carrying the
signal. Left unchanged.** Consistent with [[radar-fragility-watch-calibration]]'s
prior finding that 🔴 Alert (3.4x lift, p=0.0078) must not change — this is a
second, independent test arriving at the same answer via a different lever
(the gate, not the threshold) and a longer window (4.4y vs 252d).

## Addendum (2026-08-25, same day) — basket swap study: SEDG / AMKR replacement

Kobi asked directly whether swapping SEDG (solar, flagged as an outlier back
in the 2026-07-20 study) and/or AMKR (OSAT/packaging) for other semis/AI names
would strengthen the signal — reopening the 2026-07-20 basket-composition lock
by his own initiative (see [[radar-purple-fragility]]'s "🔒 Locked decision").

**Method:** `basket-swap-fetch.ts` fetches 5y OHLCV (same `fetchPurpleOhlcv` as
production) for the current 10 + a 10-name candidate pool (`basket-swap-raw.json`)
spanning distinct semis/AI sub-sectors — equipment (LRCX, ASML, AMAT, KLAC,
TER, ENTG), OSAT peer (ASX — AMKR's direct Taiwan-ADR competitor), analog/power
(STM, ON), photonics (COHR). Deliberately excludes mega-caps (NVDA/AVGO/AMD/
SMCI) — already tested 2026-07-22 and rejected (chronic-euphoria Z, doesn't
spike, dilutes the cross-sectional features). `basket-swap-eval.ts` reruns
`buildFragilityDays` on each swapped basket, unchanged Alert/Watch rules, full
4.4y history. `basket-swap-deepdive.ts` adds permutation p and split-half IC
for the top cells.

**Headline numbers** (basket ≤-8%/20d, unchanged production rule):

| Config | Alert events | Hit rate | Lift | p |
|---|---|---|---|---|
| BASE (current 10) | 10 | 80% | 2.53x | 0.057 |
| drop SEDG | 9 | 56% | 1.78x | 0.174 |
| AMKR→KLAC | 9 | **89%** | **2.89x** | 0.026 |
| AMKR→ASX | 8 | 88% | 2.79x | 0.031 |
| AMKR→ENTG | 8 | 88% | 2.75x | 0.047 |
| AMKR→ASML | 7 | 86% | 2.71x | 0.052 |
| AMKR→STM | 7 | 86% | 2.68x | 0.058 |

**Why this doesn't clear the bar for a change, despite the numbers above:**

1. **All 10 Alert events — in every basket variant — fall in the same single
   ~9-month window** (Oct'25–Jun'26, per [[radar-purple-fragility]]'s 4yr
   review). Split-half by calendar puts every single event in H2; H1 has
   *zero* events for every config except drop-SEDG. The "improvement" from
   AMKR→KLAC etc. is measured entirely within the two known episodes (Nov'25,
   May-Jun'26) that already calibrated the current model — not new evidence.
2. **Multiple comparisons.** 20 single-swap cells were tested (10 candidates ×
   2 tickers); at nominal p<0.05 roughly 1 false positive is expected by
   chance alone. None of the AMKR-swap p-values survive any correction.
3. **The one metric with real data in both halves (IC, continuous, ~1000
   days) doesn't confirm the win.** Every AMKR-swap candidate's IC is *better*
   than baseline in H1 (the calm/no-crossing period) but *worse* than baseline
   in H2 (the exact period the Alert-precision "win" is measured in) — e.g.
   AMKR→KLAC: H1 IC -0.173 vs BASE -0.161 (better), H2 IC -0.091 vs BASE
   -0.103 (worse). That's the classic in-sample-optimization-to-the-only-
   regime-with-events pattern this basket's history has been flagged for
   repeatedly (see the 2026-07-20 leave-one-out study, superseded once core3/
   climax/nearHigh were added).
4. **SEDG doesn't replicate as harmful under the current locked model.** The
   2026-07-20 finding ("SEDG is a relic, hurts the signal") was IC-only, on
   the 2y pre-v2 model with no nearHigh gate. Under the current rule, dropping
   SEDG *does* improve IC in both halves (H1 -0.182, H2 -0.164, both better
   than baseline) but *costs* discrete Alert precision (56% vs 80%, one known
   hit turns into a miss). Continuous and discrete metrics disagree — not a
   clean case either way.

**Conclusion: no swap clears the bar.** The full-window Alert-precision table
looks attractive for several AMKR candidates, but it doesn't survive the same
scrutiny (regime independence, multiple-comparison correction, a second metric
with real out-of-sample data) that source the current model's own validation.
Composition stays as-is. Re-run cadence: same as the standing rule — 2–3 more
independent episodes (not alerts), tracked by the frozen OOS log. If Kobi
wants to force a decision without waiting, the honest framing is "this is the
same kind of call as the 2026-07-20 lock — weak in-sample edge on thin data,
not a demonstrated one" and should be treated as a judgment call, not a data
verdict.

Related: [[radar-purple-fragility]] (composition lock, 2026-07-20 leave-one-out)
