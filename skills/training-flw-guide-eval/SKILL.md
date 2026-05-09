---
name: training-flw-guide-eval
description: >
  Grade the Phase 5 FLW guide for step-by-step concreteness (a worker
  with no prior context can follow), screenshot completeness, and
  language accessibility.
disable-model-invocation: true
---

# Training FLW Guide — Eval

Grades `5-qa-and-training/training-flw-guide.md`. The FLW guide is the
ground-truth onboarding artifact for the field worker. Unlike the FAQ
(reference) or quick-reference (glance), this is the linear walkthrough
they read once before their first visit. If steps are abstract or
screenshots are missing, the first visit fails.

See `skills/_eval-template.md` for shared contracts. Provisional rubric —
calibration TBD until 3+ shipped FLW guides produce ground truth.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 5 | `5-qa-and-training/training-flw-guide.md` | artifact under judgment |
| Phase 1 | `1-design/idea-to-pdd.md` | anchors archetype + worker-flow expectations + accessibility constraints (language, literacy assumption) |
| Phase 2 | `2-commcare/app-deploy_summary.md` | learn/deliver app flow — guide steps must match form-by-form what the FLW sees |

## Outputs

- `5-qa-and-training/training-flw-guide-eval_verdict.yaml` — verdict YAML per
  `_eval-template.md § Verdict YAML contract`.

## Process

1. Read inputs from Drive.
2. Walk the deliver-app flow from `app-deploy_summary.md` (form by form,
   field by field). Build the expected step sequence.
3. For each expected step, check the guide has (a) an explicit step,
   (b) a screenshot or screen anchor, (c) imperative-voice action that
   names the visible UI control.
4. Apply the rubric and write the verdict YAML.
5. Surface concerns per `_eval-template.md § Auto-surfaced severity rules`.

## LLM-as-Judge Rubric

Score each dimension 0–10. Weights sum to 1.0.

| Dimension | Weight | Anchored criteria |
|---|---|---|
| **Step-by-step concreteness** | 0.35 | Can a worker who has never seen the app follow the guide and complete a visit without asking? 10 = every form-screen has a numbered step naming the visible UI control ("Tap **Submit visit**"). 6 = ≥ 70% concrete; some steps are abstract ("complete the form"). 3 = guide is mostly descriptive; FLW must improvise. Hard-deduct -3 if a deliver-app form is skipped entirely. |
| **Screenshot completeness** | 0.25 | Every step that involves a non-trivial UI choice has a screenshot. 10 = full coverage of forms + decision points + error recovery, all Drive IDs resolve. 6 = main flow covered, edge cases (retake photo, retry GPS) missing. 3 = < 50% of steps have screenshots OR ≥ 1 dead Drive-ID reference. Hard-deduct -3 per dead Drive-ID reference. |
| **Language accessibility** | 0.15 | Reading level matches the PDD's stated FLW literacy/language constraint. 10 = short sentences, no jargon, names UI controls in the deployed language. 6 = mostly accessible; occasional jargon. 3 = English-only when PDD specifies local language, or developer-jargon throughout. Hard-deduct -5 if guide is in the wrong language entirely. |
| **Error-recovery coverage** | 0.15 | What happens when GPS fails, photo blurs, consent is refused, market is closed? 10 = explicit recovery path for each Layer A failure mode. 6 = recovery for the common cases (photo retake) but not edges. 3 = no error-recovery section; FLW will be stuck. |
| **Flow ordering fidelity** | 0.10 | Step ordering matches the actual deliver-app form order. 10 = exact match. 6 = ≤ 1 swap. 3 = ≥ 2 ordering errors; FLW reads steps that don't match what they see on-screen. |

**Hard-deduct rules:**
- Dead screenshot Drive ID → BLOCKER (cap overall ≤ 5).
- Guide is in the wrong language vs PDD constraint → BLOCKER.
- Any single dimension ≤ 3 → suite verdict `fail`.

**Inflation guard.** If `training-flw-guide` self-eval graded itself
top-tier and this rubric's overall ≤ 8.0, cap overall at 8.0 and surface
a `[WARN]`. Default no-op until the producer ships a self-eval.

**Calibration target** (per `_eval-template.md § Calibration target boilerplate`):
- Detection rate ≥ 80% of catalogued FLW-guide issues from
  `eval-calibration/known-issues.md § Training FLW guide` (catalogue TBD).
- Inter-run variance ≤ 0.5 across 3 same-model runs.
- Agreement with self-eval within ±1.5 points.

Provisional until first real run produces ground truth.

## Archetypes

| Archetype | Rubric tweak |
|---|---|
| `atomic-visit` | Default. Expected step sequence is single-form-flow per visit; error recovery centers on photo/GPS/consent. |
| `focus-group` | Step sequence covers attendance roster, per-domain summary capture, end-of-session sign-off. Concreteness dimension expects FGD facilitation cues. |
| `multi-stage` | Step sequence covers per-stage handoff and Stage-Gate-pending state. Flow-ordering dimension expects stage-aware sequencing. |

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)`. Plus optional
`drive_read_file` per referenced screenshot Drive ID to detect dead
references.

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior (stock)`.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-09 | Initial version. 5 dimensions: step_concreteness (0.35), screenshot_completeness (0.25), language_accessibility (0.15), error_recovery_coverage (0.15), flow_ordering_fidelity (0.10). Provisional rubric — calibration TBD until first real run grades the artifact. | ACE team (qa-eval-registry initial buildout) |
