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
