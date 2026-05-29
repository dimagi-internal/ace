---
name: learnings-summary-eval
description: >
  Independently grade the Phase 10 learnings-summary synthesis. Detects
  gaps in opp-lifecycle coverage, vague recommendations, and tone drift
  vs the cycle-grade.
disable-model-invocation: true
---

# Learnings Summary Eval

`learnings-summary` is the Phase 10 skill that synthesizes a
LLM-authored summary of an opp's full lifecycle, optionally seeding
the next cycle's PDD. Like `cycle-grade`, the same model that ran the
cycle is writing the synthesis — structural generosity bias applies.
This skill is the independent grader: did the synthesis actually walk
the full Phase 1–10 arc, name actionable changes, and stay calibrated
to the cycle's actual grade?

Closeout-category sibling of `cycle-grade-eval`. `cycle-grade-eval`
re-grades the *meta-grade* (the score and its supporting reasoning);
this rubric grades the *narrative synthesis* (the lifecycle
walk-through and the follow-up recommendations the next cycle will
read). They run on adjacent artifacts and surface different defects.

See `skills/_eval-template.md` for shared contracts and
`skills/eval-calibration/SKILL.md` for calibration methodology.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 10 | `10-closeout/learnings-summary.md` | the synthesis under judgment |
| Phase 10 | `10-closeout/cycle-grade.md` | secondary cross-check for tone-calibration (NOT the anchor — see Process step 4) |
| Phase 9 | `9-execution-manager/llo-uat_results.md` + `phases.execution-management.products.*` | **independent outcome anchor** for tone calibration (did the opp actually deliver) |
| Phase 1 | `1-design/idea-to-pdd.md` | original PDD; lifecycle baseline |
| All phases | `runs/<run-id>/run_state.yaml` | which phases ran, gate dispositions |
| All phases | `runs/<run-id>/verdicts/*.yaml` | per-skill trajectory the synthesis should have traversed |
| All phases | `comms-log/observations.md` | per-opp evidence log |

## Products

- `10-closeout/learnings-summary-eval_verdict.yaml` — verdict YAML per `_eval-template.md § Verdict YAML contract`. Filename uses the **producer** skill name (`learnings-summary`).

## Process

1. **Read inputs from GDrive** (paths in `## Inputs` above).

2. **Detect "phase not run" mode.** If `run_state.yaml` shows Phase 10
   incomplete (no `closeout.learnings-summary: done`) or
   `learnings-summary.md` is missing, emit `verdict: incomplete`
   immediately with `[INFO] Phase 10 learnings-summary not run; not
   gradable yet`. Do not score zero.

3. **Build the lifecycle expectation.** Enumerate which phases ran from
   `run_state.yaml`. Every phase that *ran* should be touched by the
   synthesis; every phase that was *skipped* should be acknowledged
   explicitly (skipping is information, not absence).

4. **Establish the independent outcome anchor for tone calibration.**
   The tone the synthesis *should* carry is set by **what the opp actually
   delivered**, not by `cycle-grade`'s own number. `cycle-grade.md` is part
   of the same AI authoring chain as `learnings-summary` — anchoring tone to
   it would let an inflated cycle-grade *and* an inflated, celebratory
   synthesis agree with each other and both pass (the amplification failure
   mode this dimension exists to catch). So derive the outcome anchor from
   evidence *outside* the cycle-grade number:
   - Real Phase-9 telemetry / UAT outcome: did the Success Metrics actually
     clear their thresholds (`9-execution-manager/llo-uat_results.md`,
     `phases.execution-management.products.*`)?
   - Did the opp actually reach launch / award, or stall (run-state
     terminal phase, `selected_llo`, launch verdict)?
   - Raw delivery / quality evidence in `comms-log/observations.md`.

   Build a one-line **observed-outcome verdict** (delivered-well /
   delivered-with-issues / did-not-deliver) from that evidence. Read
   `cycle-grade.md`'s number too, but only as a *secondary* cross-check —
   if cycle-grade's number and the observed outcome disagree, the observed
   outcome wins as the tone anchor and the disagreement is itself a finding.

5. **Grade across 5 dimensions.** Each dimension is 0–10. Overall
   score is the weighted mean.

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Opp-lifecycle coverage** | 0.30 | The synthesis must touch every phase that ran (Phase 1 design through whatever phase was last). Phases that ran but aren't mentioned = 1.5-point deduction per phase. Phases skipped intentionally must be acknowledged as skipped (vs silent omission) = 0.5-point deduction per silent skip. **Hard block:** synthesis covers ≤ 3 of N phases that ran = fail (≤ 3) — that's a partial summary, not a lifecycle synthesis. |
   | **Recommendation actionability** | 0.30 | Each recommendation must name a specific change to a specific artifact: a skill rubric line, a SKILL.md section, a PDD template field, an MCP atom, a registry decision. "Improve communication" = ≤ 3. "Tighten `idea-to-pdd-eval` recommendation_specificity dimension's anchors so 'improve the bot' grades ≤ 3 not ≤ 5" = 9–10. Each vague recommendation = 1.5-point deduction. The recommendation block is the highest-leverage output of the synthesis — generic ones waste the next cycle's PDD seed slot. |
   | **Tone calibration vs outcome** | 0.20 | **OUT-OF-CHAIN FITNESS.** The narrative tone must match the **observed opp outcome** (the independent anchor from Process step 4 — did the Success Metrics clear thresholds, did the opp reach launch/award), NOT `cycle-grade`'s self-reported number. Anchoring to cycle-grade would amplify upstream inflation: an inflated cycle-grade plus a celebratory synthesis would agree and both pass. Anchors: opp delivered well (metrics cleared, reached launch) + synthesis tone confident-and-celebratory = **9.5**; delivered-with-issues (some metrics missed / partial) + synthesis tone honest-with-mixed-results = **9.5**; did-not-deliver (primary metrics missed / stalled before launch) + synthesis tone sober-with-clear-issue-naming = **9.5**. Mismatches against the *observed outcome*: a did-not-deliver opp reads as a victory lap = **3.0**; a delivered-with-issues opp reads as a routine clean close that buries the issues = **5.0**; a delivered-well opp reads as bleak = **5.0**. **Hard block (≤ 3):** synthesis tone is celebratory while the observed outcome shows a primary Success Metric missed or the opp did not reach launch. **Cross-check:** if `cycle-grade`'s number disagrees with the observed outcome, surface a `[WARN]` (cycle-grade itself may be inflated) and anchor tone to the observed outcome regardless. The synthesis is the next cycle's first read — wrong tone gives the next cycle the wrong starting frame. |
   | **Evidence-citation discipline** | 0.10 | Every cycle-level claim must cite a per-skill verdict, observation log entry, or run-state event. Uncited claims = 0.5-point deduction per occurrence. The synthesis is supposed to *integrate* evidence, not improvise. |
   | **Forward-seeding clarity** | 0.10 | If the synthesis claims to seed the next cycle's PDD, the seed material must be concrete enough that an `idea-to-pdd` re-run could ingest it without further interpretation: named domain, named LLO preference, named verification rules, success metrics with targets. Vague seed material = 2-point deduction. **No seed claimed** is fine (not all closeouts seed); claiming a seed but providing vapor is the failure mode this catches. |

   **Deduction rules:**
   - Any single dimension ≤ 3 → suite verdict `fail`, regardless of
     overall mean.
   - **Inflation guard (mirrors closeout-sibling rubric):** if the
     rubric surfaces ≥ 2 `[WARN]`-tier `auto_surfaced` entries,
     overall is capped at **8.5**.
   - **Pre-cap and post-cap reporting** per `eval-calibration` § 0.9.4
     guidance.

   **Verdict tiers:**
   - `pass` — overall ≥ 7.0, no dimension ≤ 3.
   - `warn` — overall ≥ 5.0 < 7.0, or any inflation cap binds.
   - `fail` — overall < 5.0 OR any dimension ≤ 3.
   - `incomplete` — Phase 10 `learnings-summary` not run, or artifact
     missing entirely.

   **Severity tiers** for `auto_surfaced` entries:
   - `[BLOCKER]` — must-fix before closeout sign-off.
   - `[WARN]` — should-fix; counts toward inflation guard.
   - `[INFO]` — observational, no action required.

6. **Write the verdict YAML** to
   `10-closeout/learnings-summary-eval_verdict.yaml` using the shape
   from `skills/_eval-template.md § Verdict YAML contract`. Dimensions:

   ```yaml
   dimensions:
     opp_lifecycle_coverage:        { weight: 0.30 }
     recommendation_actionability:  { weight: 0.30 }
     tone_calibration_vs_outcome:   { weight: 0.20 }
     evidence_citation_discipline:  { weight: 0.10 }
     forward_seeding_clarity:       { weight: 0.10 }
   ```

   Weights sum: 0.30 + 0.30 + 0.20 + 0.10 + 0.10 = 1.00.

7. **Auto-surfaced concerns** (per `_eval-template.md § Auto-surfaced
   severity rules`, plus skill-specific surfaces):
   - `[BLOCKER]` for any dimension scoring ≤ 3.
   - `[BLOCKER]` if overall score is below 7.0.
   - `[BLOCKER]` if synthesis tone clearly contradicts the observed opp
     outcome (the canonical inflation case for closeout: opp missed
     primary metrics / didn't launch, but the synthesis reads as a
     victory lap).
   - `[WARN]` if `cycle-grade`'s number disagrees with the observed
     outcome (cycle-grade may itself be inflated; tone was anchored to
     the observed outcome regardless).
   - `[WARN]` per phase that ran but isn't covered.
   - `[WARN]` per vague recommendation.
   - `[WARN]` per uncited cycle-level claim.
   - `[INFO]` if no next-cycle seed is claimed (synthesis ends as
     pure summary; that's a valid mode, not a defect).

## LLM-as-Judge Rubric

Calibration target on a closed cycle's `learnings-summary`:

- **Detection rate:** ≥ 80% of catalogued learnings-summary issues
  from `eval-calibration/known-issues.md § Learnings summary`.
- **Inter-run variance:** ≤ 0.5 across 3 same-model runs.
- **Cross-model variance:** ≤ 1.0 for strong calibration.

This rubric ships at **provisional** until a real closed cycle's
`learnings-summary` produces ground truth. Until then, it correctly
emits `incomplete` on opps where Phase 10 hasn't run.

## Archetypes

| Archetype | What this skill does |
|---|---|
| `atomic-visit` | Default. Grades lifecycle coverage of per-visit metrics + Layer A delivery proof. |
| `focus-group` | Adds a "facilitator-vs-participant outcome split" sub-check under `opp_lifecycle_coverage` (FGD synthesis must distinguish facilitator-side and participant-side outcomes). |
| `multi-stage` | Adds a "stage-transition narrative" sub-check under `opp_lifecycle_coverage` (each stage transition that fired must be explained — why it fired, what triggered the next stage). |

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)`. No external
API calls beyond Drive.

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

## Dry-Run Behavior

Per `skills/_eval-template.md § Dry-Run Behavior (stock)`. Read-only,
verdict + report written to Drive.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-09 | Initial version. 5 dimensions: opp_lifecycle_coverage (0.30), recommendation_actionability (0.30 — paired-highest because the recommendation block is the next cycle's PDD seed), tone_calibration_vs_cycle_grade (0.20), evidence_citation_discipline (0.10), forward_seeding_clarity (0.10). Inflation guard at 8.5. Closeout-category sibling of `cycle-grade-eval`: that one re-grades the meta-grade, this one grades the narrative synthesis. Three hard-block rules / inflation cases: lifecycle coverage ≤ 3 of N phases; tone contradicts cycle-grade; ≥ 2 vague recommendations triggers inflation cap. Ships at provisional calibration until a real closed cycle produces ground truth. Closes the "not yet migrated" registry row for `learnings-summary`. | ACE team |
| 2026-05-29 | Re-anchored the 0.20 tone dimension from `cycle-grade`'s own number to an **independent outcome signal** — renamed `tone_calibration_vs_cycle_grade` → `tone_calibration_vs_outcome`. Tone is now graded against whether the opp actually delivered (real Phase-9 UAT outcome / launch-or-award reached / raw delivery evidence), with `cycle-grade.md` demoted to a secondary cross-check (a disagreement is now a `[WARN]` that cycle-grade may itself be inflated). Added a hard block (≤ 3) for a celebratory synthesis over a did-not-deliver outcome, and added Process step 4 building the observed-outcome anchor. No weight change (0.30/0.30/0.20/0.10/0.10 = 1.0). Per `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md` — anchoring tone to cycle-grade *amplified* upstream inflation: an inflated cycle-grade plus a celebratory synthesis agreed with each other and both passed. | ACE team |
