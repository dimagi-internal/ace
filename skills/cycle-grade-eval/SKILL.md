---
name: cycle-grade-eval
description: >
  Independently re-grade a closed cycle's cycle-grade output. Detects
  self-eval inflation, missing learnings, vague recommendations.
disable-model-invocation: true
---

# Cycle-Grade Eval

`cycle-grade` is the Phase 9 skill that produces a final cycle
scorecard with recommendations for next steps. Like every other
self-evaluating skill in ACE, it has a structural generosity bias —
the same model that ran the cycle is grading whether the cycle went
well. This skill is the independent grader.

This is the closeout-category companion to `idea-to-pdd-eval` (which
grades the design-side self-eval). Same family: independent re-grade
of an already-self-graded artifact, with explicit attention to the
self-eval-inflation gap.

See `skills/eval-calibration/SKILL.md` for the methodology and
`docs/eval-calibration-learnings.md` for patterns observed across
the first 4 strongly-calibrated rubrics.

## Process

1. **Read inputs from GDrive:**
   - `cycle-grade.md` — the artifact under judgment.
   - `learnings-summary.md` — Phase 9 learnings doc.
   - `pdd.md` and `run_state.yaml` — for cycle-arc context.
   - `comms-log/observations.md` — the per-opp evidence log
     `cycle-grade` should have synthesized.
   - `verdicts/*.yaml` — every per-skill verdict from the cycle.
     `cycle-grade` should reference the trajectory; if it didn't,
     that's a defect.

2. **Detect "cycle didn't close" mode.** If `run_state.yaml` shows Phase 9
   incomplete (no `closeout.cycle-grade: done`, no
   `cycle-grade.md`), emit `verdict: incomplete` immediately with
   `[INFO] Phase 9 not run; cycle-grade-eval not gradable yet`. Do
   not score zero — it's a structural state, not a defect.

3. **Grade across 5 dimensions.** Each dimension is 0–10. Overall
   score is the weighted mean.

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Self-eval agreement** | 25% | Independently judge whether the cycle did what the PDD set out to do. Compare to `cycle-grade`'s own grade. **Hard ceiling 7.5 if `cycle-grade` claims overall PASS but this rubric finds ≥1 cycle-level failure mode** the producing skill missed (Phase 5 LLO drop-off, FLW data-quality drift, OCS bot quality regression mid-cycle, missed closeout deliverables). |
   | **Learnings concreteness** | 25% | The cycle's learnings must be actionable in a future opp. "We learned to communicate better" = ≤4. "Phase 5 UAT must include a calibration recheck before live deployment because 30% of FLWs drifted in week 1" = 9. Vague aphorisms that can't drive a future PDD are 1-point deductions per occurrence. |
   | **Recommendation specificity** | 20% | Recommendations must point at a concrete artifact change (skill rubric, PDD template section, gate-brief content) for the next cycle. Generic recommendations ("improve the bot") = ≤4. Specific ones ("add a refusal-correctness dimension to ocs-chatbot-eval") = 9–10. Each vague recommendation is a 1-point deduction. |
   | **Evidence-citation discipline** | 15% | Every cycle-level claim must cite the per-skill verdict, observation log entry, or state-yaml event that supports it. Uncited claims are 0.5-point deductions per occurrence. The `cycle-grade` skill is supposed to synthesize evidence, not improvise; uncited claims are improvisation. |
   | **Trajectory framing** | 15% | The cycle's score trajectory across versions/iterations must be acknowledged. If opp-eval went from incomplete to PASS over rubric calibration iterations (as in this session), `cycle-grade` should note that the "PASS" represents calibrated grading, not artifact perfection. Failure to acknowledge calibration history = 1.5-point deduction. |

   **Deduction rules:**
   - Any single dimension ≤3 → suite verdict `fail`, regardless of
     overall mean.
   - **Inflation guard (mirrors OCS / deliver-app / learn-app /
     idea-to-pdd / connect-setup rubrics):** if the rubric surfaces
     ≥2 `[WARN]`-tier `auto_surfaced` entries, overall is capped at
     **8.5**.
   - **Pre-cap and post-cap reporting** per `eval-calibration` § 0.9.4
     guidance.

4. **Write the verdict YAML** to
   `ACE/<opp-name>/runs/<run-id>/8-closeout/cycle-grade-eval_verdict.yaml`. The filename uses the
   **producer** skill name (`cycle-grade`), NOT this skill's name —
   see `agents/ace-orchestrator.md § Per-Step Eval Hook` for the
   naming rule:

   ```yaml
   skill: cycle-grade-eval
   target: <opp-name>
   mode: deep
   ran_at: <ISO timestamp>
   capture_path: cycle-grade.md

   overall_score: 8.0
   overall_score_pre_cap: 8.0
   verdict: pass | warn | fail | incomplete

   dimensions:
     self_eval_agreement:        { score: 8.5, weight: 0.25 }
     learnings_concreteness:     { score: 8.5, weight: 0.25 }
     recommendation_specificity: { score: 7.5, weight: 0.20 }
     evidence_citation_discipline: { score: 8.5, weight: 0.15 }
     trajectory_framing:         { score: 8.0, weight: 0.15 }

   per_item:
     - ref: "Cycle PASS claim re-grade"
       score: 8.5
       verdict: pass
       note: "Independent re-grade agreed cycle was PASS-eligible — Phase 5 LLO drop-off was 8% (target ≤15%); FLW data quality held at week-4 calibration recheck; OCS bot deep-eval held at PASS in monitor mode."
     # ... per check

   auto_surfaced:
     - severity: WARN
       message: "2 of 5 recommendations are vague ('improve the bot quality') — flag for tightening before next-cycle PDD draft."

   gate:
     threshold: 7.5
     disposition: approve | reject | iterate
   ```

5. **Auto-surfaced concerns:**
   - `[BLOCKER]` for any dimension scoring ≤ 3.
   - `[BLOCKER]` if overall score is below 7.0.
   - `[BLOCKER]` if `cycle-grade` PASSed a cycle that this rubric
     finds ≥1 cycle-level failure mode in (the canonical
     self-eval-inflation case).
   - `[WARN]` per vague recommendation (lacks a concrete artifact
     target).
   - `[WARN]` per uncited cycle-level claim.
   - `[INFO]` if the cycle was the first iteration of a new
     `learnings-summary` → next-cycle PDD pipeline (no prior cycle
     to compare against, so trajectory framing is trivially weak).

## LLM-as-Judge Rubric

Calibration target on a closed cycle:

- **Detection rate:** ≥ 80% of catalogued cycle-grade issues from
  `eval-calibration/known-issues.md § Cycle grade`.
- **Inter-run variance:** ≤ 0.5 across 3 same-model runs.
- **Cross-model variance:** ≤ 1.0 for strong calibration.

This rubric ships at **provisional** until a real closed cycle
provides ground truth. Until then, it correctly emits `incomplete`
on opps where Phase 9 hasn't run.

## Archetypes

| Archetype | What this skill does |
|---|---|
| `atomic-visit` | Default. Grades cycle-level data-collection outcomes (records collected vs target, photo pass-rate, calibration drift). |
| `focus-group` | Grades FGD outcomes (sessions completed, transcript quality, theme synthesis depth). Adds a "qualitative-claim grounding" sub-check under `evidence_citation_discipline` (qualitative claims must cite session transcripts, not be improvised). |
| `multi-stage` | Grades stage-by-stage outcomes against the Stage Gate. Adds a "stage-transition-rationale" sub-check (the cycle-grade must explain why each stage transition fired or didn't). |

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_list_folder`,
  `drive_create_file`
- No external API calls

## Mode Behavior

- **Auto:** Grade, write verdict + report.
- **Review:** Pause after grading.

## Dry-Run Behavior

When `--dry-run` is active:
- Read inputs normally — read-only.
- Write verdict + report (human-facing artifacts).
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-28 | Initial version. 5 dimensions: self_eval_agreement (0.25), learnings_concreteness (0.25), recommendation_specificity (0.20), evidence_citation_discipline (0.15), trajectory_framing (0.15). Inflation guard at 8.5. Explicit `incomplete` verdict for opps where Phase 9 hasn't run. Ships at provisional calibration until a closed cycle produces ground truth. Together with connect-program-setup-eval (0.9.8), gives the eval framework rubrics ready for all 6 opp-eval categories — once a cycle runs end-to-end through Phase 9, opp-eval can produce a fully-covered verdict (4+ tier). | ACE team (eval system buildout — 0.9.8) |
