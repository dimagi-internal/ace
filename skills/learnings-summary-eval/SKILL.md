---
name: learnings-summary-eval
description: >
  Independently grade the Phase 9 learnings-summary synthesis. Detects
  gaps in opp-lifecycle coverage, vague recommendations, and tone drift
  vs the cycle-grade.
disable-model-invocation: true
---

# Learnings Summary Eval

`learnings-summary` is the Phase 9 skill that synthesizes a
LLM-authored summary of an opp's full lifecycle, optionally seeding
the next cycle's PDD. Like `cycle-grade`, the same model that ran the
cycle is writing the synthesis — structural generosity bias applies.
This skill is the independent grader: did the synthesis actually walk
the full Phase 1–9 arc, name actionable changes, and stay calibrated
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
| Phase 9 | `9-closeout/learnings-summary.md` | the synthesis under judgment |
| Phase 9 | `9-closeout/cycle-grade.md` | meta-grade for tone-calibration check |
| Phase 1 | `1-design/idea-to-pdd.md` | original PDD; lifecycle baseline |
| All phases | `runs/<run-id>/run_state.yaml` | which phases ran, gate dispositions |
| All phases | `runs/<run-id>/verdicts/*.yaml` | per-skill trajectory the synthesis should have traversed |
| All phases | `comms-log/observations.md` | per-opp evidence log |

## Outputs

- `9-closeout/learnings-summary-eval_verdict.yaml` — verdict YAML per `_eval-template.md § Verdict YAML contract`. Filename uses the **producer** skill name (`learnings-summary`).

## Process

1. **Read inputs from GDrive** (paths in `## Inputs` above).

2. **Detect "phase not run" mode.** If `run_state.yaml` shows Phase 9
   incomplete (no `closeout.learnings-summary: done`) or
   `learnings-summary.md` is missing, emit `verdict: incomplete`
   immediately with `[INFO] Phase 9 learnings-summary not run; not
   gradable yet`. Do not score zero.

3. **Build the lifecycle expectation.** Enumerate which phases ran from
   `run_state.yaml`. Every phase that *ran* should be touched by the
   synthesis; every phase that was *skipped* should be acknowledged
   explicitly (skipping is information, not absence).

4. **Read the cycle-grade meta-grade** from `cycle-grade.md` — the
   overall score and its disposition. This is the calibration anchor:
   a 7/10 opp shouldn't read like a victory lap, a 4/10 opp shouldn't
   read like a routine close.

5. **Grade across 5 dimensions.** Each dimension is 0–10. Overall
   score is the weighted mean.

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Opp-lifecycle coverage** | 0.30 | The synthesis must touch every phase that ran (Phase 1 design through whatever phase was last). Phases that ran but aren't mentioned = 1.5-point deduction per phase. Phases skipped intentionally must be acknowledged as skipped (vs silent omission) = 0.5-point deduction per silent skip. **Hard block:** synthesis covers ≤ 3 of N phases that ran = fail (≤ 3) — that's a partial summary, not a lifecycle synthesis. |
   | **Recommendation actionability** | 0.30 | Each recommendation must name a specific change to a specific artifact: a skill rubric line, a SKILL.md section, a PDD template field, an MCP atom, a registry decision. "Improve communication" = ≤ 3. "Tighten `idea-to-pdd-eval` recommendation_specificity dimension's anchors so 'improve the bot' grades ≤ 3 not ≤ 5" = 9–10. Each vague recommendation = 1.5-point deduction. The recommendation block is the highest-leverage output of the synthesis — generic ones waste the next cycle's PDD seed slot. |
   | **Tone calibration vs cycle-grade** | 0.20 | The narrative tone must match the meta-grade. Anchors: cycle-grade ≥ 8 + synthesis tone confident-and-celebratory = **9.5**; cycle-grade 6–7.9 + synthesis tone honest-with-mixed-results = **9.5**; cycle-grade < 6 + synthesis tone sober-with-clear-issue-naming = **9.5**. Mismatches: 7/10 reads as victory lap = **5.0**; 4/10 reads as routine close = **3.0**; 9/10 reads as bleak = **5.0**. The synthesis is the next cycle's first read — wrong tone gives the next cycle the wrong starting frame. |
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
   - `incomplete` — Phase 9 `learnings-summary` not run, or artifact
     missing entirely.

   **Severity tiers** for `auto_surfaced` entries:
   - `[BLOCKER]` — must-fix before closeout sign-off.
   - `[WARN]` — should-fix; counts toward inflation guard.
   - `[INFO]` — observational, no action required.

6. **Write the verdict YAML** to
   `9-closeout/learnings-summary-eval_verdict.yaml` using the shape
   from `skills/_eval-template.md § Verdict YAML contract`. Dimensions:

   ```yaml
   dimensions:
     opp_lifecycle_coverage:        { weight: 0.30 }
     recommendation_actionability:  { weight: 0.30 }
     tone_calibration_vs_cycle_grade: { weight: 0.20 }
     evidence_citation_discipline:  { weight: 0.10 }
     forward_seeding_clarity:       { weight: 0.10 }
   ```

7. **Auto-surfaced concerns** (per `_eval-template.md § Auto-surfaced
   severity rules`, plus skill-specific surfaces):
   - `[BLOCKER]` for any dimension scoring ≤ 3.
   - `[BLOCKER]` if overall score is below 7.0.
   - `[BLOCKER]` if synthesis tone clearly contradicts cycle-grade
     (the canonical inflation case for closeout: low grade, victory
     lap synthesis).
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
emits `incomplete` on opps where Phase 9 hasn't run.

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
