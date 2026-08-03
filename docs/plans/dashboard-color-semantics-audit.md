# Plan — Dashboard Color Semantics Audit

**Overall Progress:** `0%` — audit complete, no code changed yet. Written so a
**separate conversation** (applying the Xsheva design system / rebrand) can pick
this up as the semantic spec for what each color should mean, independent of the
actual palette it lands on.

**Created:** 2026-08-03
**Trigger:** Kobi flagged that in the signals table, colors don't track signal
quality — e.g. Breakout (weak) reads as "good" (green) while stronger signals
read as neutral (blue).
**Scope:** whole dashboard (`dashboard/public/{index.html,app.js,styles.css}`),
not just the signals table.

---

## TL;DR

The dashboard already has a **correct, working color language** — it's just not
applied consistently. The Score column, the RS column, and price-change cells all
correctly use green = strong / amber = caution / red = weak. But the **signal-type
badges** (Breakout / High Volume / Pullback / Creep / Setup Full / Setup Close /
Setup Recovery) and the **top stat cards** were colored by *category* (which of 4
CSS buckets a signal falls into) instead of by *backtested quality* — and the
dashboard's own "how it works" tab already states, in writing, which signals are
strong and which are weak. The colors just don't listen to that text.

This is not a "redesign the palette" problem. It's "make the badges obey the
color rule the rest of the dashboard already follows."

---

## The reference model (already correct — copy this logic, don't reinvent it)

`dashboard/public/app.js`:

```js
function scoreBg(s) {
  if (s >= 85)  return 'rgba(63,185,80,0.32)';   // strong green
  if (s >= 70)  return 'rgba(63,185,80,0.18)';   // green
  if (s >= 55)  return 'rgba(210,153,34,0.22)';  // amber
  return 'rgba(248,81,73,0.20)';                 // red
}
```

Same pattern for RS (`rs >= 90` → green `num-up` + 🔥) and for day%/ATH%
(`num-up`/`num-down`, green/red by sign). This is the right model: **color
encodes validated quality, not category.** Everything below should follow it.

---

## The mismatch — badges colored by category, not by evidence

`dashboard/public/styles.css:697-700`:

```css
.badge--breakout    { color: var(--up);     }  /* green  */
.badge--highVolume  { color: var(--amber);  }  /* amber  */
.badge--pullback    { color: var(--accent); }  /* blue   */
.badge--near        { color: var(--muted);  }  /* gray   */
```

`dashboard/public/app.js:11-22` (`SIGNAL_META`) then reuses these 4 classes
across signals from **two different pipelines** (Lean's daily signals and the
Smart Radar's Setup tiers) — so "green" and "blue" each mean two unrelated
things depending on which signal you're looking at.

Every claim below is quoted from the dashboard's own **"❓ איך זה עובד"**
explainer tab — not an external source:

| Signal | Current color | What the dashboard's own text says (verbatim, `index.html`) | Real signal quality |
|---|---|---|---|
| **Breakout** | 🟢 green (`--up`) | *"Edge שלילי — תשואה מתחת ל-baseline, וכמעט אף פעם לא מהלך גדול"* ("negative edge, below baseline, almost never a big move") | **Weakest** — should not be green |
| **Setup Full** | 🟢 green (same class as Breakout) | *"החזק ביותר"* ("the strongest"), 78.8% success | **Strongest** — green is correct, but it's visually identical to the signal above it in this table, which is its opposite |
| **Pullback** | 🔵 blue (`--accent`) | *"הסיגנל המרכזי"* ("the central signal"), labeled `Alpha` | Strong — reads as neutral, should read as strong |
| **Setup Close** | 🔵 blue (same class as Pullback) | 80% success, median +35%, *"האיתות הראשון על מפלצות מגיע כמעט תמיד כאן"* ("the first signal on monsters almost always arrives here") | Arguably the single best-performing signal in the system — reads as neutral |
| **Creep** | 🔵 blue (same class as Pullback) | median +19%/3mo, "פי-4 מה-baseline" (4x baseline) | Strong — shares a color with Pullback despite being a distinct pattern with its own (also strong) numbers |
| **High Volume** | 🟠 amber | *"לא תמיד ברור מה"* ("not always clear what's happening") — no strength claim either way | Genuinely situational — amber is defensible here |
| **Setup Recovery** | 🟠 amber (same class as High Volume) | rare (~18/yr), caught NBIS +450%, WOLF +128% | Strong but low-sample — amber-as-"moderate" undersells it, but it's not wrong to flag it as different from the routine signals |
| **Near-*** | ⚪ gray (`--muted`) | *"פחות actionable... מוסתר כברירת מחדל"* (less actionable, hidden by default) | Correctly weak/preliminary — **no change needed** |

Stat cards (`app.js:416-423`) have the same issue:

| Stat card | Current color | Dashboard's own text | Real quality |
|---|---|---|---|
| 🎯 Setup Full | 🟢 green (`--up`, "highlight") | "strongest" | Correct |
| RS≥90 🔥 | 🔵 blue (`--accent`) | *"היחיד ששרד"* ("the only [metric] that survived" the 2-year study), 75% success | Should arguably outrank Setup Full visually, not read as neutral |

---

## Root cause

1. **Badges were built as a 4-way categorical palette** (breakout/highVolume/
   pullback/near), not a quality scale. There was never a 5th "this is bad"
   color, so a signal with a documented negative edge (Breakout) got slotted
   into "green" by default — nothing else was available.
2. **Two unrelated pipelines share one palette.** Lean's daily signals and the
   Smart Setup tiers are different systems with different backtests, but
   `SIGNAL_META` maps both onto the same 4 CSS classes. A green Setup Full and
   a (hypothetically) green Breakout would be visually indistinguishable even
   though the text next to them says opposite things.

---

## What was checked and found *already consistent* (no action needed)

- Score column background/foreground (`scoreBg`/`scoreColor`) — green/amber/red by
  threshold, correct.
- RS column (`num-up` + 🔥 at ≥90) — correct.
- Day% / ATH% (`num-up`/`num-down` by sign) — correct, standard finance
  convention.
- Score histogram bars — bucketed the same way as `scoreBg`, correct.
- Purple Fragility legend (🔴 Alert / 🟡 Watch / ⚪ climax-only) — correctly
  ordered worst→informational.
- Williams %R panic/overbought legend colors — correct directionally.

---

## Recommended semantic tiers (for the other conversation to skin)

Define the tiers by **meaning**, let the Xsheva design system supply the actual
hex values later:

| Tier | Meaning | Current dashboard equivalent |
|---|---|---|
| **Strong** | Backtested, positive edge, high win-rate/confidence | `--up` green |
| **Moderate / situational** | Real but context-dependent, mixed or unproven edge | `--amber` |
| **Weak / negative edge** | Documented underperformance vs baseline | `--down` red (currently unused for badges — needs to exist as a badge class) |
| **Neutral / informational** | Not a quality claim (e.g. a raw filter tag) | `--accent` blue |
| **Low-confidence / preliminary** | Not-yet-confirmed, hidden by default | `--muted` gray |

Proposed remap (semantics only — exact colors are the other conversation's call):

- Breakout → **Weak** (new red/negative-edge tier) — was green
- Setup Full → **Strong** — unchanged, but give it a visual marker that
  distinguishes "Setup" (Smart Radar) badges from "Lean" badges even within the
  same tier (e.g. a small pipeline icon or border style), so Strong-Setup and
  Strong-Lean never look pixel-identical
- Pullback → **Strong** — was neutral/blue
- Setup Close → **Strong** — was neutral/blue
- Creep → **Strong** — was neutral/blue (currently sharing Pullback's class)
- High Volume → **Moderate** — unchanged
- Setup Recovery → **Strong**, flagged low-sample (~18/yr) — was Moderate
- Near-* → **Low-confidence** — unchanged
- RS≥90 stat card → **Strong**, matching Setup Full's treatment — was neutral/blue

---

## Open questions for the next conversation

1. Does the Xsheva design system already define a 5-tier semantic scale, or does
   one need to be created as part of this work?
2. Should Lean-pipeline and Smart-Setup-pipeline badges be visually distinguished
   even when they land in the same quality tier (recommended above), or is
   tier-only encoding acceptable?
3. Setup Recovery's "strong" call rests on 2 named examples (NBIS, WOLF) over
   ~18/year — worth a quick backtest before committing to Strong vs Moderate.
4. Accessibility: current badges rely on color + text label together (not color
   alone), which is good — keep that pattern when re-skinning.

## Non-goals of this session

No code was changed. This is an audit + semantic remap proposal only, to be
implemented against whatever palette/tokens the Xsheva design system conversation
produces.
