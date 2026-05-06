---
name: flw-data-review-eval
description: >
  Grade an flw-data-review report — signal coverage, outlier rigor,
  recommendation actionability, evidence citation, trajectory awareness.
disable-model-invocation: true
---

# FLW Data Review Eval

`flw-data-review` is the recurring Phase 5 skill that runs weekly
during an active opp to surface FLW submission data quality issues
(outlier detection, calibration drift, refusal-rate flags, photo
pass-rate trends). It's the per-cycle quality signal that catches
problems early — before they accumulate into bad datasets.

This rubric grades each individual `flw-data-review` report. Because
the producing skill runs recurring (typically 4–8 times per opp),
this rubric naturally accumulates a trend signal: a calibration-drift
flag that gets caught early scores higher than one caught late.

## Process

1. **Read inputs from GDrive:**
   - PDD: `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md` (for opp-spec context)
   - The dated `flw-data-review-YYYY-MM-DD.md` report — the artifact
     under judgment.
   - Prior `flw-data-review-*.md` reports — for trajectory framing.
   - Submission data summary if available (the report should have
     synthesized this; cross-check claims against summary).

2. **Detect "phase not run" mode.** If no `flw-data-review-*.md`
   reports exist, emit `verdict: incomplete` immediately. Distinguish
   from "single review" mode (1 report, no trajectory yet — score
   normally but skip trajectory dimension).

3. **Grade across 5 dimensions.** Each dimension is 0–10.

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Signal coverage** | 25% | The report must surface every required quality signal: per-FLW calibration drift (vs Learn-app baseline), refusal-rate distribution, photo pass-rate trend, duplicate-detection trend, vendor-education delivery rate. Missing required signal = 2-point deduction per gap. |
   | **Outlier-detection rigor** | 20% | Outliers must be flagged with a concrete threshold rule (e.g. "FLWs whose color/shininess distribution deviates > 2σ from peer median trigger calibration recheck"), not vibes. Vague flagging ("FLW 3 seems off") = 2-point deduction per occurrence. The rule must match the PDD's Evidence Model § Layer C spec. |
   | **Recommendation actionability** | 20% | Each surfaced issue must have a concrete remediation: re-take Learn module N, recalibrate FLW pair, exclude record, supervisor follow-up. Vague recommendations ("monitor closely") = 1-point deduction. **Hard threshold:** a [BLOCKER]-severity issue without a concrete remediation = fail (≤3). |
   | **Evidence-citation discipline** | 15% | Every claim must cite the data: row counts, percentages, FLW IDs, market names. Uncited claims are 0.5-point deductions. (Mirrors `cycle-grade-eval`'s same dimension; same anti-improvisation principle.) |
   | **Trajectory awareness** | 20% | When prior reports exist, the current report must reference what changed since last review (improvement, new issue, recurring concern). First-review-of-cycle scores N/A and dimension contributes 0 weight (renormalize across other dims). Failure to reference prior reports when they exist = 2-point deduction. |

   **Deduction rules:**
   - Any single dimension ≤3 → suite verdict `fail`.
   - **Inflation guard (mirrors prior rubrics):** ≥2 `[WARN]`
     auto_surfaced → cap at **8.5**.
   - **Pre-cap and post-cap reporting** per `eval-calibration` § 0.9.4.

4. **Write the verdict YAML** to
   `ACE/<opp-name>/runs/<run-id>/7-execution-manager/flw-data-review-eval_verdict-monitor.yaml`. The filename
   uses the **producer** skill name (`flw-data-review`) plus the
   `-monitor` mode suffix (which the Workbench strips when attributing
   the score) — see `agents/ace-orchestrator.md § Per-Step Eval Hook`
   for the naming rule. Each recurring run overwrites the prior
   verdict; trend history lives in
   `runs/<run-id>/7-execution-manager/flw-data-review-eval_trend.md`
   (one row appended per run) alongside the latest human report at
   `runs/<run-id>/7-execution-manager/flw-data-review-eval_report-monitor.md`.

   ```yaml
   skill: flw-data-review-eval
   target: <flw-data-review-YYYY-MM-DD.md fileId>
   mode: deep
   ran_at: <ISO timestamp>
   capture_path: flw-data-review-YYYY-MM-DD.md

   overall_score: 8.2
   overall_score_pre_cap: 8.2
   verdict: pass | warn | fail | incomplete

   dimensions:
     signal_coverage:              { score: 9.0, weight: 0.25 }
     outlier_detection_rigor:      { score: 8.0, weight: 0.20 }
     recommendation_actionability: { score: 8.5, weight: 0.20 }
     evidence_citation_discipline: { score: 8.0, weight: 0.15 }
     trajectory_awareness:         { score: 7.0, weight: 0.20 }

   per_item:
     - ref: "Calibration drift flag for FLW 7"
       score: 9.0
       verdict: pass
       note: "Concrete σ-based threshold rule applied; FLW 7 flagged for Learn module 5 retake."

   auto_surfaced:
     - severity: WARN
       message: "1 vague recommendation ('monitor FLW 12 closely') without specific threshold."

   gate:
     threshold: 7.5
     disposition: approve | reject | iterate
   ```

5. **Auto-surfaced concerns:**
   - `[BLOCKER]` for any dimension ≤ 3.
   - `[BLOCKER]` if overall is below 7.0.
   - `[WARN]` per vague recommendation, missing signal, or uncited claim.
   - `[INFO]` if this is the first review of the cycle (trajectory
     dimension not graded).

## LLM-as-Judge Rubric

Calibration target on a real flw-data-review report:

- **Detection rate:** ≥ 80% of catalogued report issues from
  `eval-calibration/known-issues.md § FLW data review`.
- **Inter-run variance:** ≤ 0.5 across 3 same-model runs.
- **Cross-model variance:** ≤ 1.0 for strong calibration.

This rubric ships at **provisional** until real reports produce
ground truth. Because flw-data-review is recurring, calibration
gets cheap fast — every active opp produces 4–8 reports, each a
calibration target.

## Archetypes

| Archetype | What this skill does |
|---|---|
| `atomic-visit` | Default. Grades visit-level signals (calibration drift, photo pass-rate, refusal). |
| `focus-group` | Grades session-level signals (transcript completeness, theme depth, facilitator-quality drift). Replaces calibration-drift signal with facilitator-quality. |
| `multi-stage` | Grades per-stage signals plus a stage-transition-readiness check. |

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_create_file`,
  `drive_list_folder`
- No external API calls.

## Mode Behavior

- **Auto:** Grade, write dated verdict + report.
- **Review:** Pause after grading.

## Dry-Run Behavior

When `--dry-run` is active:
- Read inputs normally — read-only.
- Write verdict (human-facing artifact).
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-28 | Initial version. 5 dimensions: signal_coverage (0.25), outlier_detection_rigor (0.20), recommendation_actionability (0.20), evidence_citation_discipline (0.15), trajectory_awareness (0.20 with N/A handling for first-of-cycle). Inflation guard at 8.5. Recurring rubric — produces dated verdict YAMLs (`flw-data-review-eval-YYYY-MM-DD.yaml`). Provisional until real reports produce ground truth; calibration cheap because the producing skill runs 4–8 times per opp. | ACE team (eval system buildout — 0.9.9) |
