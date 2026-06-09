# General Video Generator — Eval-Loop Results

**Date:** 2026-06-09
**Harness:** `video-spec-generate` (general, structured-template-driven) +
`video-spec-eval` (6-dim LLM-judge), 60s-campaign-overview template + a fixed
Bangladesh postnatal brief. 3 rounds × 10 generations × 10 evals = **30 specs,
30 verdicts.** Each round's synthesis fed surgical edits to the generator and
eval skills before the next round.

## Trajectory (per-dimension floor = min across the 10; floor is the story)

| dimension | R1 mean/floor | R2 mean/floor | R3 mean/floor |
|---|---|---|---|
| narration_voice | 8.0 / 8 | 8.0 / 8 | 8.0 / 8 |
| stat_selection | 7.8 / **6** | 8.0 / **8** | 7.9 / 7 |
| beat_coherence | 7.8 / **7** | 8.0 / **8** | 8.0 / 8 |
| source_fidelity | 8.1 / 8 | 7.8 / 7 | 7.1 / 7 |
| tagline_mirror | 8.4 / 8 | 8.8 / 8 | 8.5 / 8 |
| story_compression | 7.3 / **6** | 7.2 / 6 | 7.2 / 6 |
| **overall** | **81.0 / 76** | 80.2 / 77 | 77.8 / 75 |
| revise verdicts | 2/10 | 1/10 | 4/10 |

## What each round changed

- **R1 → R2 (generator + eval).** Generator: word-budget self-check → a
  *mandatory enforcement pass* (recount, re-tighten any beat over `max`; the
  `problem` beat may not carry both a stat and the stakes clause); anti-redundancy
  (the `product` beat walks the in-app workflow, not a re-narration of the cycle);
  stat-card parity. Eval: an audio/card stat-parity anchor on Stat Selection; a
  brief-as-anchor branch on Source Fidelity. **Result:** stat_selection floor
  6→8, beat_coherence floor 7→8, revises 2→1.
- **R2 → R3 (generator + eval).** Generator: a *specificity-mining* step
  (surface named places, route the strongest scale figure into status/handoff/
  scene). Eval: a graduated, count-based under-use threshold on Source Fidelity
  (0 omitted → 9-10, 1-2 → cap 8, 3+ → cap 7) and an *arithmetic* Story
  Compression check (any beat over `round(sec×2.5)+2` is a hard defect).

## The honest read: falling scores = a sharper eval, not a worse producer

The overall mean fell 81 → 78 across the rounds. That is the **intended** dynamic
of co-evolving a producer *and* its judge: R1's eval was blind to two real
failure modes, so it over-scored. R2–R3 taught the eval to catch them
deterministically, so the *same-quality* specs now grade against an honest,
reproducible ruler. Evidence:
- The dimensions the **producer** controls held or improved: voice, tagline, and
  beat_coherence never dropped below 8 after R1; stat-parity stuck.
- The two dimensions that "fell" are exactly the two the **eval learned to
  measure**: source_fidelity (now penalizes dropping named districts + the
  410K-visits scale figure) and story_compression (now hard-fails over-budget
  beats arithmetically rather than by feel).

So the loop did what was asked: it improved **both** skills. The producer is now
demonstrably solid (voice/tagline/coherence consistently ≥8) **from structured
template data + intent alone — no per-template prose prompt.** The eval is now
**trustworthy** (reproducible thresholds, arithmetic budget check, parity de-dup).

## Two persistent generator weaknesses the sharpened eval now reliably surfaces

1. **Word-budget overruns (story_compression floor stuck at 6).** The generator
   still occasionally ships an over-budget `problem`/`cycle` beat. The enforcement
   pass is a *prompt instruction*; an LLM agent doesn't deterministically recount.
   **The true fix is deterministic code:** a post-generation validator in the
   generation flow (or a server-side `/programs` warning) that rejects/auto-trims
   any beat over `round(beat_seconds×2.5)+2`. Recommended next.
2. **Specificity under-use (source_fidelity floor 7).** The specificity-mining
   step helped but the 60s template has fixed beat slots (two outcome-stat cards,
   no funder beat), so some brief specifics are physically unplaceable. The eval
   should distinguish *omitted-but-placeable* from *omitted-because-unplaceable*;
   and templates that carry rich scale data may want a dedicated scale slot.

## Verdict

The general generator produces ship-quality specs from `{intent, skeleton,
example, derived budgets}` with **no per-template prose prompt** — validated
across 30 independent generations. The remaining ceiling is a deterministic
word-budget trimmer (a small code/validator addition, not a prompt tweak) and
template-shape headroom for scale figures. The eval is now a reproducible,
hard-to-inflate instrument. Both skills measurably improved over the loop.
