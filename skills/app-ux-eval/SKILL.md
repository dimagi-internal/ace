---
name: app-ux-eval
description: >
  Grade the FLW experience of the built apps via LLM-as-Judge over
  captured screenshots. Deep-only — runs from /ace:qa-deep.
disable-model-invocation: true
---

# App UX Eval

Grades the FLW experience of the built apps. Asks: "would this be a
good experience for the user?" and pins each judgment to concrete
PDD-derived ground truth (the journey's stated goal, time budget, edge
cases) so the rubric isn't unmoored.

This skill is the **eval** half of the app deep-QA pair — it does not
drive the AVD or capture screenshots. For the capture half, see
`app-screenshot-capture` (run as part of `/ace:qa-deep`). See
`skills/_eval-template.md` for shared verdict / severity / stock-block
contracts.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `2-scenarios/pdd-to-app-journeys.md` | UX-intent ground truth (goal, happy-path narrative, edge cases, pass criteria, `pdd_time_budget_seconds`) |
| Phase 3 | `3-commcare/app-test-cases.yaml` | journey↔recipe bindings, smoke flag, forms exercised |
| Phase 6 | `6-qa-and-training/screenshots/<journey>/` + `6-qa-and-training/app-screenshot-capture_manifest.yaml` | captured PNGs to grade |

## Products

- `6-qa-and-training/app-ux-eval_verdict-deep.yaml` — per-journey verdict on UX dimensions (clarity, flow_predictability, error_recovery, time_budget, journey_completion, capture_robustness)

## Process

### Step 1: Read inputs

- `2-scenarios/pdd-to-app-journeys.md` — ground truth (UX-intent:
  per-journey goal, happy-path narrative, edge cases, pass criteria,
  `pdd_time_budget_seconds`)
- `3-commcare/app-test-cases.yaml` — journey↔recipe bindings (which
  Maestro recipe corresponds to which journey, smoke flag, forms
  exercised)
- The captured screenshots from the recent execution run — look up by
  the `--run-id` argument passed in. Paths:
  `ACE/<opp>/runs/<run-id>/6-qa-and-training/screenshots/` plus
  `ACE/<opp>/runs/<run-id>/6-qa-and-training/app-screenshot-capture_manifest.yaml`
  (which step → which PNG)
- `inputs/pdd.md` — for persona context (the FLW the rubric is judging
  "good experience" against; pulled from the "Target FLW" section)
- `3-commcare/app-deploy_summary.md` — for the `learn_build_id` and
  `deliver_build_id` that go into `artifact_refs` so the Phase 9 gate
  can compare verdict freshness against the latest released CommCare
  build

### Step 2: For each journey, score 6 dimensions (1–3)

Each dimension scores 1, 2, or 3 (1 = fail, 2 = warn, 3 = pass) on the
journey's screenshot sequence. The hard-deduction column is the
single-rule that clamps the dimension to 1 (fail) regardless of how
the rest of the journey looks.

| Dimension | What to look for | Hard deduction → fail |
|---|---|---|
| `clarity` | Field labels and prompts unambiguous to the persona from PDD's "Target FLW" section. The FLW should know what's being asked without guessing. | Any field name only a developer would understand (e.g., `q3_v2_optional`, `field_3a`) appears in a screenshot |
| `flow_predictability` | Conditional branches go where the FLW expects; skip patterns don't surprise. The next screen follows from the current one. | A screen appears or disappears with no apparent cause from the user's perspective (e.g., a question shows in run 1 but not run 2 with no visible trigger) |
| `error_recovery` | Validation errors tell the FLW what's wrong and how to fix. The FLW can recover without losing prior input. | Dead-end errors with no recovery path (FLW gets stuck, or has to restart the form to retry) |
| `time_budget` | Step count + estimated input time vs. journey's `pdd_time_budget_seconds`. Recipe step count × 5s is the heuristic estimate (5s per tap/type). **Being far UNDER budget is NOT a win** (fixed 2026-05-29): a recipe whose step count × 5s is < 50% of the budget is *suspiciously thin* for its declared scope — score this dimension ≤2 and surface `[WARN] time_budget: recipe far under budget — likely under-built form, not efficiency`. Do NOT award a high score for being fast because the form is thin (the old rule only penalized "too slow," which rewarded the ITN-style skeletal build). The ideal is *near* budget. | Recipe step count × 5s exceeds 2× the budget |
| `journey_completion` | Recipe accomplishes the journey's stated goal end-to-end. Final screenshot shows confirmation / submission success / explicit completion state. | Recipe ends without confirmation / stuck screen / mid-form (the journey didn't finish) |
| `capture_robustness` | **Fitness dimension (added 2026-05-29).** Does the instrument *refuse bad data*? Graded on the **negative-path** journeys (blank required field, out-of-range value, low-accuracy GPS, "Other" selection) — does the form reject the bad input with a clear, recoverable error, or silently accept garbage? This is the screenshot-side complement to `pdd-to-deliver-app-eval § data_quality_validation`. **Coverage cap (mirrors `ocs-chatbot-eval`'s adversarial-coverage cap):** if `app-test-cases.yaml` contains ZERO negative-path journeys, this dimension is *unmeasured* — score it ≤2 (NOT pass) and surface `[WARN] capture_robustness: no negative-path journey in the test suite — the instrument's data-quality enforcement is untested`. An app whose test suite never feeds it a bad input has unproven robustness; that absence must not read as success. (Forcing function: `app-test-cases` should emit ≥1 negative-path recipe per credit-bearing form.) | Form accepts a known-bad input (blank required / out-of-range / low-GPS) with no error, OR zero negative-path journeys exist to test it |

For each dimension, write a one-sentence reason citing the specific
screenshot(s) that drove the score (e.g.
`"journey-deliver-step-04 shows field labelled q3_v2_optional"`).

After scoring 1–3 per dimension, convert to a 0–10 score via
`(score - 1) / 2 * 10` for the verdict YAML — see Step 4 for the
exact shape. Hard-deduction triggers set the dimension's converted
score to 0.

### Step 3: Aggregate

- **Per-journey verdict:** weighted average of dimensions. Weights
  (updated 2026-05-29 to seat the fitness dimension): `clarity` 0.15,
  `flow_predictability` 0.15, `error_recovery` 0.15, `time_budget`
  0.10, `journey_completion` 0.15, `capture_robustness` 0.30. Hard-
  deduction on any single dimension clamps the journey to **fail**
  regardless of weighted-average math —
  surface the triggering rule in the per-item `note`. Per-journey
  verdict is binary (`pass | fail`) for this skill — no warn tier.
  The verdict-schema permits `warn`, but app-ux-eval's rubric is
  pass-or-fail; gate decisions need an unambiguous green/red signal.
- **Hard-deduction effect on dimension scores:** when a dimension's
  hard-deduction triggers, that dimension's score is set to 0 in the
  YAML output AND the per-journey verdict is clamped to fail.
  `overall_score_pre_cap` retains the un-clamped weighted mean for
  calibration analysis.
- **Phase verdict:**
  - `pass` = all journeys pass
  - `fail` = any journey fails. Summary lists which journeys failed
    which dimensions, including the smoke journey vs. non-smoke
    distinction (smoke failure = blocker; non-smoke failure may
    iterate)

### Step 4: Write verdict

Write
`ACE/<opp>/runs/<run-id>/6-qa-and-training/app-ux-eval_verdict-deep.yaml`
per the uniform verdict shape (see `skills/README.md § Eval verdict
shape` or `lib/verdict-schema.ts`):

```yaml
skill: app-ux-eval
target: <opp-name>
mode: deep
ran_at: <ISO timestamp with timezone>
capture_path: 6-qa-and-training/app-screenshot-capture_manifest.yaml

artifact_refs:
  learn_build_id: <from 3-commcare/app-deploy_summary.md>
  deliver_build_id: <from 3-commcare/app-deploy_summary.md>

overall_score: 7.0             # 0–10 scale; convert per-dimension 1–3 to 0–10 via (avg-1)/2*10
overall_score_pre_cap: 7.7     # raw weighted mean before any hard-deduction clamp
verdict: fail                  # pass | fail

dimensions:
  clarity:              { score: 9.0, weight: 0.15 }
  flow_predictability:  { score: 8.5, weight: 0.15 }
  error_recovery:       { score: 7.0, weight: 0.15 }
  time_budget:          { score: 7.0, weight: 0.10 }   # near-budget is ideal; far-under is a thinness WARN, not a 9.5
  journey_completion:   { score: 8.5, weight: 0.15 }
  capture_robustness:   { score: 6.0, weight: 0.30 }   # fitness: does the form refuse bad data on negative-path journeys

per_item:                # per-journey verdicts; key matches pdd-to-app-journeys.md
  - ref: "J1 — visit-flow"
    journey: "J1 — visit-flow"
    is_smoke: true
    score: 9.0
    verdict: pass
    note: "Final screenshot shows submission confirmation; all dimensions clear"
  - ref: "J2 — duplicate-handling"
    journey: "J2 — duplicate-handling"
    is_smoke: false
    score: 5.0
    verdict: fail
    note: "Hard-deduction on error_recovery: dead-end error in journey-deliver-step-07 with no recovery path (FLW must restart form). error_recovery dimension clamped to 0."
  # ... one entry per journey in app-test-cases.yaml

auto_surfaced:
  - severity: BLOCKER | WARN | INFO
    message: <one-line concern>

gate:
  threshold: 7.0
  disposition: approve | reject | iterate
```

Required top-level fields:

- `skill: app-ux-eval`
- `mode: deep`
- `ran_at` — ISO timestamp with timezone
- `artifact_refs: { learn_build_id, deliver_build_id }` — read from
  `3-commcare/app-deploy_summary.md` so the Phase 9 gate can
  timestamp-compare against the currently released builds
- `dimensions` — per-dimension scores + reasons (5 dimensions, equal
  0.20 weights)
- `per_item` — per-journey verdicts (canonical key per
  `skills/README.md § QA vs Eval`); each entry includes a `journey`
  domain-specific subkey
- `overall_score`, `verdict` (`pass | fail`)

Also append a row to
`ACE/<opp>/eval-calibration/app-ux-eval-runs.md` (opp-level, not
run-scoped — calibration audit trails accumulate across runs) so
calibration metrics keep growing per
`skills/eval-calibration/SKILL.md`.

### Step 5: Apply the gate

- `overall_score ≥ 7.0` AND zero failing journeys = `approve`
- Any smoke-journey failure = `reject` (smoke journey is the
  primary submission flow; if that fails, the app is not launchable)
- Any non-smoke failure with overall ≥ 7.0 = `iterate` (the operator
  can decide whether to fix and re-run vs. proceed)

The Phase 9 gate (`llo-launch`) reads this verdict and adds its own
freshness check (verdict's `artifact_refs` must match the latest
released build IDs — see Task 7 in the shallow/deep split plan).

## Mode behavior

- **Deep only.** There is no `--quick` mode. The shallow Phase 6
  smoke (`app-screenshot-capture` running just the `is_smoke: true`
  recipes) does NOT invoke this skill — it's structural-only.
  This skill is invoked exclusively by `/ace:qa-deep` and the Phase 9
  go-live gate.

## Failure modes

- **Screenshots missing for a journey marked in
  `app-test-cases.yaml`** → halt with a `[BLOCKER]` saying which
  recipe didn't run. Don't grade partial coverage; the missing
  screenshots are upstream signal that `/ace:qa-deep`'s capture step
  failed.
- **`2-scenarios/pdd-to-app-journeys.md` missing** → upstream Phase 1 or
  migration gap; halt with pointer to `pdd-to-app-journeys`.
- **`3-commcare/app-test-cases.yaml` missing** → upstream Phase 3 gap;
  halt with pointer to `app-test-cases`.
- **Nova builds older than the screenshots** (i.e., a CommCare build
  released after the screenshots were captured) → screenshots are
  stale; halt with `[BLOCKER]` and instruct the operator to re-run
  `/ace:qa-deep` against the current build.
- **`3-commcare/app-deploy_summary.md` missing the build IDs** → halt;
  the Phase 9 gate needs `artifact_refs` to compare freshness, and
  partial verdicts can't be timestamp-checked.

## MCP tools used

- ace-gdrive: `drive_read_file`, `drive_list_folder`,
  `drive_create_file`
- (No mobile / Nova / OCS — this is pure judging over already-captured
  artifacts)

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-04 | Initial version. Deep-only LLM-as-Judge for app UX. Five dimensions (clarity, flow_predictability, error_recovery, time_budget, journey_completion) with hard-deductions. Used by /ace:qa-deep and the Phase 8 gate. Introduced as part of the shallow/deep QA split (spec: `docs/superpowers/specs/2026-05-04-shallow-deep-qa-split-design.md`). | ACE team |
| 2026-05-05 | **Path-scheme migration.** Inputs repointed to `2-scenarios/pdd-to-app-journeys.md`, `3-commcare/app-test-cases.yaml`, `6-qa-and-training/screenshots/` + `6-qa-and-training/app-screenshot-capture_manifest.yaml`, `3-commcare/app-deploy_summary.md`. Verdict output is now `6-qa-and-training/app-ux-eval_verdict-deep.yaml` (per manifest). Calibration audit trail at `ACE/<opp>/eval-calibration/app-ux-eval-runs.md` corrected to opp-level (was incorrectly under `runs/<run-id>/`). Phase references updated 6 → 7 to match the 8-phase topology. No behavior change beyond paths. | ACE team |
| 2026-05-29 | **Fitness dim + time_budget fix (ITN post-mortem).** Added `capture_robustness` (0.30) — grades negative-path journeys (blank-required / out-of-range / low-GPS / "Other") for whether the form *refuses bad data*, with an adversarial-coverage cap (zero negative-path journeys → ≤2, not pass). Fixed `time_budget`: being far UNDER budget is now a thinness WARN (≤2), not a 9.5 — the old rule only penalized "too slow," which rewarded the ITN-style skeletal build. Reweighted to 6 dims (capture_robustness heaviest at 0.30). Per `_eval-template.md § out-of-chain fitness requirement` + `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`. Note: in-`/ace:run` build-fitness gating is handled cheaply (no AVD) by the revised `pdd-to-*-app-eval` blueprint checks; this deep screenshot check is complementary. | ACE team |
