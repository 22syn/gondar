# Plan: Two-Radar Improvement — duplication, comparison refresh, live backlog

**Overall Progress:** `70%` — 7/10 done (T2.3, T3.1, T3.2 open)

> Created 2026-07-26 via `/plan` (`~/cabinet/agent-library/workflows/plan.md`).
> **Successor to** `docs/plans/svr-improvement-2026-05.md` — that plan is NOT
> restarted here. Its Track A/B items stay there; Task 0.2 below reconciles its
> tracker so the two files do not fork into competing backlogs.

## Overview

**What:** Produce the improvement document for the two radars that was asked
for, and act on the structural findings behind it.

**Why:** Three things are simultaneously true and none are written down:

1. **The real duplication is cross-branch, not intra-file.** Smart lives on
   `main`, Lean on `stable`, and both carry their own copies of `src/services/`
   and `src/utils/`. Every fix to `marketData.ts`, `logger.ts` or
   `technicalAnalysis.ts` is applied twice, by hand, indefinitely. No graph
   flagged this because a graph only ever sees one branch.
2. **The graph report's "duplication signal" was a misread.**
   `fetchAndCacheWatchlist()` (46 edges) and `loadWatchlist()` (41 edges) are a
   deliberate fetch-once/read-many pair — `src/config/index.ts:281` throws if
   the accessor is called before the fetcher. Merging them would break the
   caching contract. **No refactor is warranted there**; this plan records that
   conclusion so it is not rediscovered as a "finding" a third time.
3. **The only Smart-vs-Lean comparison we have is invalid.**
   `~/cabinet/outputs/2026-05-24-svr-6mo-comparison.md` measured 369 tickers over
   126 days and predates `momentumGate`, the `lowRiskEntry` removal, RS ranking,
   the `creep` tier and the near-tier 21d gates. Its headline verdict describes
   two radars that no longer exist.

**Project Type:** **BACKEND** (Node/TypeScript CLI + GitHub Actions). The
dashboard is a thin static frontend on `stable` and is out of scope here — no
`frontend-specialist` staffed.

## Success Criteria

| # | Criterion | Measurable |
|---|---|---|
| S1 | The improvement doc exists in the cabinet | `~/cabinet/outputs/2026-07-26-two-radar-improvement.md` readable, linked from the architecture reference |
| S2 | Cross-branch duplication is quantified, not asserted | A table of every file present on both branches, marked identical / drifted, with drift diff size |
| S3 | A decision exists on how to handle it | CTO task produces a chosen strategy + rejected alternatives with reasons |
| S4 | The stale comparison is either refreshed or explicitly retired | Either new numbers exist, or the May file carries a "superseded, do not cite" header |
| S5 | One live backlog, not two | `svr-improvement-2026-05.md` items are marked done / superseded / still-open |
| S6 | The health-prune question is answered | Verdict recorded: the ≥8% prune path either fires in CI or is documented as inert |

## Tech Stack

| Choice | Rationale |
|---|---|
| Markdown in `~/cabinet/outputs/` | Global CLAUDE.md routes final outputs there; keeps research out of the app repo |
| Existing `scripts/compare-radars-6mo.ts` | The May comparison's own harness — reusing it makes old vs new numbers directly comparable rather than a new methodology |
| `git diff main:path stable:path` | Cheapest possible cross-branch drift measurement; no tooling to build |
| No new dependencies | Every task is analysis, docs, or git — nothing to install |

## File Structure

```
smart-volume-radar-engine/
├── docs/plans/
│   ├── two-radar-improvement.md        # THIS FILE (tracker)
│   └── svr-improvement-2026-05.md      # predecessor — reconciled by T0.2
├── .gitignore                          # + graphify-out/  (T0.1)
└── scripts/compare-radars-6mo.ts       # re-run by T3.1

~/cabinet/
├── outputs/2026-07-26-two-radar-improvement.md      # THE DELIVERABLE (T1.2)
├── outputs/2026-05-24-svr-6mo-comparison.md         # headed as superseded (T3.2)
└── knowledge/reference/smart-volume-radar-architecture.md   # linked (T1.2)
```

## Agent staffing (HR)

> Vault root is `~/cabinet/agent-library/` (the workflow's `03-agents/` prefix is
> a legacy alias for the same tree). Paths below are the real ones on disk.

| Agent | Vault path | Tasks covered |
|-------|------------|----------------|
| explorer-agent | `agent-library/specialists/explorer-agent.md` | T1.1, T2.1 |
| cto (persona) | `agent-library/workflows/brainstorm.md` | T2.2 |
| documentation-writer | `agent-library/specialists/documentation-writer.md` | T1.2, T3.2, T0.2 |
| backend-specialist | `agent-library/specialists/backend-specialist.md` | T2.3, T3.1 |
| devops-engineer | `agent-library/specialists/devops-engineer.md` | T0.1, T4.1 |

**Orchestrator not required** — this is a single-domain plan (backend + docs)
with a strictly serial spine; no parallel tracks needing coordination.

**Staffing risk:** `radar-criteria-tester` is *not* staffed. It was built by
Phase 4 of the May plan but has since been moved to
`agent-library/specialists/_to_delete/` and is staged for deletion in the cabinet
working tree. If T2.3 ends up touching criteria, that gap needs resolving first —
see Open Questions.

## Task Breakdown

### Phase 0: Housekeeping — *no behaviour change*

- 🟩 **T0.1 — Gitignore the graph output**
  `agent`: devops-engineer · `agent_path`: `agent-library/specialists/devops-engineer.md` · `parallel_ok`: yes
  **INPUT:** `graphify-out/` showing as `??` in `git status`; 2.7MB of generated
  `graph.json` + `graph.html`, built from commit `6e1cce27` (12 commits stale).
  **OUTPUT:** `graphify-out/` added to `.gitignore`.
  **VERIFY:** `git status --short` no longer lists `graphify-out`.
  **WHY:** Generated artifacts belong in `.gitignore`, not in git. Regenerate on
  demand with `graphify update .` (no API cost).
  **ROLLBACK:** Revert the one-line `.gitignore` change.

- 🟩 **T0.2 — Reconcile the May plan's tracker**
  `agent`: documentation-writer · `agent_path`: `agent-library/specialists/documentation-writer.md`
  **INPUT:** `docs/plans/svr-improvement-2026-05.md` — 55 open checkboxes, 0
  ticked, despite several phases being demonstrably shipped (Phase 1 spam fix →
  `NOTABLE_MAX_PER_BUCKET`/`NOTABLE_MIN_RS` exist; Phase 2 → `llmSummary` reduced
  to `classifyTickersWithGroq`; Phase 4 → subagent built then retired; Phase 6 →
  `rsPercentile.ts` exists).
  **OUTPUT:** Each item marked `[x]` done / `~~superseded~~` / left open, with a
  one-line note where the evidence lives.
  **VERIFY:** Count of open items drops and matches what is genuinely unbuilt;
  every remaining `[ ]` is defensible against current `main`.
  **WHY:** Two plan files with overlapping scope and one stale tracker is how
  `/execute` ends up re-doing finished work.
  **ROLLBACK:** `git checkout -- docs/plans/svr-improvement-2026-05.md`.

### Phase 1: The improvement document — *the actual ask*

- 🟩 **T1.1 — Structural review of both radars**
  `agent`: explorer-agent · `agent_path`: `agent-library/specialists/explorer-agent.md`
  **DEPENDS ON:** — (none)
  **INPUT:** `origin/main` and `origin/stable` side by side; the code audit
  already captured in `~/cabinet/knowledge/reference/smart-volume-radar-architecture.md`.
  **OUTPUT:** Findings list — where the two radars overlap, where a Lean finding
  should propagate to Smart (or back), what is dead or inconsistent, ranked by
  cost-to-carry.
  **VERIFY:** Every finding cites a file and line on a named branch; no finding
  rests on the graph report alone.
  **WHY:** The doc must be grounded in code, not in the 2026-07-23 graph, which
  is 12 commits stale and already produced one false positive.

- 🟩 **T1.2 — Write the improvement doc + prioritized backlog**
  `agent`: documentation-writer · `agent_path`: `agent-library/specialists/documentation-writer.md`
  **DEPENDS ON:** T1.1, T2.1 *(needs the duplication inventory to lead with)*
  **INPUT:** T1.1 findings + T2.1 inventory.
  **OUTPUT:** `~/cabinet/outputs/2026-07-26-two-radar-improvement.md` — structural
  review, the three framing facts from Overview, and a prioritized backlog that
  replaces the May TD list. Questions needing a replay are written as explicit
  **hypotheses**, never as guessed numbers.
  **VERIFY:** File exists; linked from the architecture reference; every claim
  traceable to a file/branch or flagged unverified.
  **ROLLBACK:** Delete the file; nothing depends on it yet.

### Phase 2: Cross-branch duplication — *the real finding*

- 🟩 **T2.1 — Quantify the drift**
  `agent`: explorer-agent · `agent_path`: `agent-library/specialists/explorer-agent.md` · `parallel_ok`: yes (with T1.1)
  **INPUT:** `git diff origin/main origin/stable -- src/services src/utils src/config src/types`.
  **OUTPUT:** Table of every file present on both branches: identical / drifted,
  drift size, and which branch is ahead.
  **VERIFY:** Table totals reconcile with `git diff --stat` output.
  **WHY:** "We duplicate code across branches" is an assertion until it has a
  number. The number decides whether Phase 2 is worth doing at all.

- 🟩 **T2.2 — SOLUTIONING: decide the strategy**
  `agent`: cto · `agent_path`: `agent-library/workflows/brainstorm.md` (CTO persona)
  **DEPENDS ON:** T2.1
  **INPUT:** The drift table.
  **OUTPUT:** A chosen strategy with rejected alternatives and reasons. Candidates:
  extract a shared package · restructure so both radars run from one branch ·
  formalise cherry-pick discipline · **accept the duplication and do nothing**.
  **VERIFY:** Decision recorded in `~/cabinet/projects/smart-volume-radar/decisions-log.md`
  with the drift number that justified it.
  **WHY:** The two-branch split is load-bearing — `daily-scan-lean.yml` runs from
  `stable`, the dashboard and D1 exist only there, GitHub only schedules crons
  from the default branch. Any merge strategy has to survive all three. This is
  explicitly a CTO decision, not an implementation detail.
  **ROLLBACK:** N/A — decision only, no code.

- 🟥 **T2.3 — Implement the chosen strategy**
  `agent`: backend-specialist · `agent_path`: `agent-library/specialists/backend-specialist.md`
  **DEPENDS ON:** T2.2 · **BLOCKED until the CTO decision exists**
  **INPUT:** T2.2's decision.
  **OUTPUT:** Deliberately unspecified — scope is whatever T2.2 chooses, including
  "no change".
  **VERIFY:** Both scans run green (`daily-scan.yml`, `daily-scan-lean.yml`) and
  Telegram output is unchanged for a control day.
  **ROLLBACK:** Single revertable PR per branch; no cross-branch force pushes.

### Phase 3: Comparison refresh — *retire or replace the May numbers*

- 🟥 **T3.1 — Re-run the 6-month comparison on current criteria**
  `agent`: backend-specialist · `agent_path`: `agent-library/specialists/backend-specialist.md`
  **INPUT:** `scripts/compare-radars-6mo.ts` (the May harness, still on `main`).
  **OUTPUT:** Fresh signal counts, overlap, and win rates for both radars under
  current gates.
  **VERIFY:** Run completes; ticker universe and date range are stated in the
  output; methodology matches the May run or the delta is documented.
  **WHY:** Reusing the original harness keeps old and new numbers comparable —
  a new methodology would confound "the radars changed" with "the measurement changed".
  **RISK:** If the harness itself assumes pre-July criteria it may need repair
  first; if repair is non-trivial, fall back to T3.2's retirement path.

- 🟥 **T3.2 — Publish or retire**
  `agent`: documentation-writer · `agent_path`: `agent-library/specialists/documentation-writer.md`
  **DEPENDS ON:** T3.1
  **INPUT:** T3.1 results, or its failure.
  **OUTPUT:** Either a refreshed comparison in `~/cabinet/outputs/`, **or** a
  "⚠️ Superseded — do not cite" header on the May file naming what invalidated it.
  **VERIFY:** No path leaves a reader able to cite the May numbers as current.

### Phase 4: Close the open question

- 🟩 **T4.1 — Is the ≥8% health-prune path actually live?**
  `agent`: devops-engineer · `agent_path`: `agent-library/specialists/devops-engineer.md` · `parallel_ok`: yes
  **INPUT:** `tv-sync.yml` restores `~/.cache/svr-tv-sync/` from the
  `tv-sync-state` artifact that the job itself uploads; `prune-queue.json` is
  written by telegram-mcp's watchlist-health, which may only run locally.
  **OUTPUT:** Verdict — the queue reaches CI, or it does not.
  **VERIFY:** Either observe a queued ticker consumed by a CI sync run, or
  confirm from the artifact contents that the file never arrives.
  **WHY:** Documented as live in two places (dashboard explainer + architecture
  reference). If inert, the 14-day staleness prune is the *only* removal path and
  both docs need a correction.

## Dependency graph

```
T0.1 ─┐ (independent)
T0.2 ─┘
T1.1 ──┐
T2.1 ──┴──► T1.2                    ← the deliverable
T2.1 ─────► T2.2 (CTO) ─► T2.3
T3.1 ─────► T3.2
T4.1 ─ (independent)
```

**Parallel-safe:** T0.1, T0.2, T1.1, T2.1, T4.1 — different files, no shared state.
**Serial:** T2.1→T2.2→T2.3 (decision gates implementation); T3.1→T3.2.

## Risks, assumptions, open questions

| # | Item | Handling |
|---|---|---|
| R1 | T2.2 may conclude "accept the duplication" | That is a legitimate outcome. T2.3 becomes a no-op and the reasoning is still recorded — a documented decision beats an undocumented ache |
| R2 | `compare-radars-6mo.ts` may assume pre-July criteria | T3.1 states this risk; T3.2 has a retirement path that does not depend on the harness working |
| R3 | `radar-criteria-tester` is staged for deletion | If criteria work resurfaces, decide whether to restore it from `_to_delete/` before staffing it. **Open question for the user** |
| A1 | The two-branch split must survive any change | Assumed load-bearing (crons, dashboard, D1). T2.2 must not propose anything that breaks it |
| Q1 | Is a data-backed comparison worth the compute at all? | If T2.2 and T1.2 already justify the roadmap, T3 may be deferrable. Decide after T1.2 |

## Sync note

`~/cabinet/projects/smart-volume-radar/` has **no** `plans-and-tasks.md` — the
project's long-lived record is `decisions-log.md` plus
`project.smart-volume-radar.md`. T2.2's decision syncs to `decisions-log.md`.
No `plans-and-tasks.md` is created here; this file plus the reconciled May plan
are the two trackers, and T0.2 keeps them from overlapping.

## Phase X: Final Verification (MANDATORY)

- [ ] **Lint & types:** `npm run lint && npx tsc --noEmit`
- [ ] **Tests:** `npm test` on both branches touched
- [ ] **Build/scan smoke:** both `daily-scan.yml` and `daily-scan-lean.yml` complete green
- [ ] **Docs consistency:** no doc claims the ≥8% prune is live if T4.1 found it inert
- [ ] **No competing backlogs:** `svr-improvement-2026-05.md` reconciled (T0.2)
- [ ] **Success criteria S1–S6** each checked off explicitly
- [ ] **Decision logged:** T2.2 present in `decisions-log.md`

> 🔴 Do not mark any box without actually running the check.
