# Plan — Fragility Signal Calibration

**Overall Progress:** `85%` — both PRs open, awaiting merge + deploy.

**PRD:** `~/cabinet/projects/smart-volume-radar/PRD-fragility-calibration.md`
**Created:** 2026-07-27
**PRs:** [#99 engine (`main`)](https://github.com/22syn/smart-volume-radar/pull/99) · PR-B dashboard (`stable`)

---

## ⚠️ Design changed mid-flight — read this first

This plan originally said **"remove the climax arm everywhere."** That was based on
an incomplete reading, and it was corrected before any code was written.

**What was missed:** PR #82 validated the climax arm against **>7% basket tops**
using a **recall** metric, over a longer span (2023-24 + 2025-26 split-half) than
this study's 252 sessions. The first analysis measured QQQ drawdowns and something
closer to precision — a different target *and* a different metric.

**What re-testing on PR #82's own target showed:** the climax arm fails on
precision there too (33% vs a 31% base rate) — **but its recall contribution is
real and replicates PR #82 exactly**:

| Rule | Recall (11 top episodes) | Precision | Firings |
|---|---|---|---|
| alert + core3 + climax | **11/11 = 100%** | 58% | 31 |
| alert + core3 | 7/11 = 64% | **81%** | 16 |
| climax only | 5/11 = 45% | 33% | 15 |

So this is not a defect to remove — it is a **recall/precision tradeoff**, and the
right resolution differs per channel:

- **Telegram** interrupts → precision matters → **core3 only**
- **Dashboard chart** is passive → recall is cheap → **keep climax**, styled as descriptive

**Decision (Kobi, 2026-07-27): split the channels.** Zero recall lost on the chart;
🟡 Telegram precision 58% → 81%, volume 31 → 16.

---

## Overview

**What:** Gate the 🟡 Telegram send on a new `watchAlertable` flag (core3 arm only);
keep climax computed, persisted, charted, and in the message body. Add base-rate
context to the dashboard explainer. Record the "QQQ stays" decision.

**Project Type:** BACKEND (`main`) + WEB (`stable`) — two branches, two PRs.

---

## Success Criteria

| # | Criterion | Status |
|---|---|---|
| M1 | Climax-only days produce no Telegram message | 🟩 `watchAlertable === false`, unit-tested |
| M2 | All 10 historical 🔴 Alert dates unchanged | 🟩 verified byte-identical, engine + dashboard |
| M3 | Every hit-rate figure in the UI carries its base rate | 🟩 explainer rewritten |
| M4 | Full suites green both branches | 🟩 388/388 (main), 35/35 (stable) |
| M5 | Study committed and reproducible | 🟩 `docs/research/fragility-calibration/` |

---

## Task Breakdown

### 🟩 T0 — SOLUTIONING: confirm the mechanism
Resolved without a separate CTO pass — the two open questions were answered directly:
- **Does 🟡 reach Telegram?** Yes — `src/index.ts:413`. Verified in source, not assumed.
- **Hard-remove vs flag?** Neither, once the recall data landed: **split by channel.**

### 🟩 T1 — Baseline capture
10 🔴 Alert dates and the 21 🟡 split by arm (15 climax / 6 core3) frozen from D1
before any edit. Reconstruction reproduces the known alert list exactly.

### 🟩 T2 — Engine: `watchAlertable` (`main`, PR #99)
`src/services/purpleFragility.ts` — new derived flag, true only when the core3 arm
fired. `src/index.ts` — 🟡 send gated on it. `src/services/telegramBot.ts` — climax
relabelled descriptive; message footer states 81% vs 31% base. `watchTrigger`,
D1 persistence and the 🔴 rule all untouched.

### 🟩 T3 — Tests (`main`, PR #99)
Three new assertions: climax-only ⇒ `watchAlertable === false`; `both` ⇒ `true`;
core3-only ⇒ `true`. Suite: 388 pass / 24 suites. tsc + eslint clean.

### 🟩 T4 — Dashboard marker split (`stable`, PR-B)
`isWatch` decomposed into `isCore3` / `isClimax`. Three marker weights: 🔴 solid red,
🟡 solid amber (messaged), ⚪ small hollow grey (chart-only). Verified against the
real 252 rows: **10 alert / 6 watch / 15 soft** — alert set byte-identical.

### 🟩 T5 — Explainer copy (`stable`, PR-B)
Base rates beside every figure; the two-arm decomposition table; QQQ rationale
(r=0.821, 3.4x, p=0.008) with the 41%-base-rate warning about the loose threshold;
limitations (two episodes, ~20 uncorrected cells, 252-day subset).

### 🟩 T6 — Study committed (`main`, PR #99)
`docs/research/fragility-calibration/` — 5 scripts, 6 data files, README with
method, headline results, the PR #82 reconciliation, and limitations.

### 🟥 T7 — Merge + deploy
PR #99 → `main`; PR-B → `stable`; deploy via `deploy-dashboard.yml`
(`--branch=production`), verify on the **wrangler deployment URL** (root is a 302
Access SSO page).

### 🟥 T8 — Post-deploy verification
Confirm the chart shows three marker weights and the alert dots are unmoved.

### 🟥 T9 — Docs + memory
`decisions-log.md` entry (Decision / Why / Impact / Verification) recording **both**
the withdrawn "switch to ^IXIC" recommendation and the withdrawn "remove climax
everywhere" plan; PRD status → shipped; update `radar-purple-fragility` memory.

---

## Deliberate non-changes

Do not let follow-up work drift into these — each was tested and rejected:

- **`FRAGILITY_THRESHOLD` stays 1.0.** Sweep at QQQ −5%/20d: 0.9→3.08x, 1.0→3.39x,
  1.1→4.24x, 1.2→3.88x, all p<0.01. A plateau, not a knife-edge. 1.1 wins on 8
  events vs 10 — overfitting to two events.
- **🔴 Alert rule unchanged** — it validated (p=0.0078).
- **No Alert sub-conditioning.** Splitting by climax level: 4/5 vs 3/5 (n=5/side).
  An apparent "low climax → miss" pattern in two events vanished on the full split.
- **Benchmark stays QQQ** — closest to the basket (r=0.821) and best lift + p.
- **Basket composition locked** (2026-07-20 decision).

## Notes

- No `plans-and-tasks.md` for this project — `decisions-log.md` is the long-lived
  record. T9 syncs there; no competing backlog created.
- The alert rule is encoded twice (engine + `app.js`). T4 verified parity by hand;
  a shared constant would be the durable fix, deliberately out of scope here.
- **Re-run cadence:** after 2–3 more independent *episodes*, not alerts. The frozen
  OOS log (PR #91) is the accumulating instrument.
