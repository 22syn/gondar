# Improvement plan — 2026-07-23

## Context
This plan covers the whole smart-volume-radar system (engine + sync + tools + dashboard), placed here since `engine` is being retired in favor of `sync` per today's own graph-audit decision — see task 1. Two real features shipped this week (Fragility Score live, Capitulation Score merged today, deliberately display-only per a rigorous internal backtest showing weak 35%/29% recall/precision). No n8n/Trigger.dev anywhere — scheduling is GitHub Actions + macOS launchd throughout, and that's working as designed. No tooling-adoption review exists for this project (unlike SoMedia) — worth writing one if external tools are ever considered here.

## Tasks
- [ ] **Execute the engine→sync consolidation** — already decided today (`docs/plans/2026-07-23-graph-audit-followup.md`: sync becomes canonical, engine gets archived) but not yet done. Steps per that doc: tag HEAD, reconcile the 2 drifted files (`championScore.ts` newer in engine, `marketData.ts` newer in sync), archive engine with a README redirect, move the cron cutover to sync, parity-check `scan-now` output — **Verify:** engine tagged/archived, sync running the cron, output matches
- [ ] Resolve `aiCommentary.ts`'s blocked status — needs `ANTHROPIC_API_KEY` in GitHub Actions secrets and a per-cron cost decision, explicitly "Kobi's call" — **Verify:** decision made, feature either enabled or explicitly deferred with a reason
- [ ] Verify whether `lowRiskEntry` was actually dropped from the Full Setup gate — a 2026-05-11 decision said "action pending," validated by the `radar-criteria-tester` subagent, but no later confirmation was found — **Verify:** check directly rather than assume either way
- [ ] Quarterly basket review flagged by the Fragility goal-charter: IFNNY (thin ADR, noisy volume-z) vs switching to IFX.DE; SNDK (short history) as a replacement candidate next cycle — **Verify:** review happens on schedule
- [ ] Fix the documented tv-sync MCP PATH issue (GUI-launched clients under nvm/fnm may not inherit shell PATH) — **Verify:** MCP client launches cleanly regardless of launch method
- [ ] No urgency on Industry Group Ranking or Climax-as-sell-gate — both already rejected after backtesting, closed decisions
