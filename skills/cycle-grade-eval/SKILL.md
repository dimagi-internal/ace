---
name: cycle-grade-eval
description: >
  Independently re-grade a closed cycle's cycle-grade output. Detects
  self-eval inflation, missing learnings, vague recommendations.
disable-model-invocation: true
---

# Cycle-Grade Eval

`cycle-grade` is the Phase 10 skill that produces a final cycle
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
   - `learnings-summary.md` — Phase 10 learnings doc.
   - `pdd.md` and `run_state.yaml` — for cycle-arc context.
   - `comms-log/observations.md` — the per-opp evidence log
     `cycle-grade` should have synthesized. **Raw evidence source for
     the `self_eval_agreement` re-derivation (step 2.5).**
   - **Raw run data for independent re-derivation** (step 2.5): the actual
     per-phase artifacts under `runs/<run-id>/<N>-<phase>/` (FLW delivery
     records, app/OCS transcripts, photo/GPS logs, Connect visit counts),
     and live run-state product blocks (`phases.<phase>.products.*`). These
     are the out-of-chain anchors — distinct from the AI-authored verdicts.
   - `<N>-<phase>/<skill>-eval_verdict.yaml` — every per-skill verdict from
     the cycle. `cycle-grade` should reference the trajectory; if it didn't,
     that's a defect. **NOTE:** these verdicts are the SAME possibly-inflated
     AI chain `cycle-grade` already read — they are context, NOT the anchor
     for `self_eval_agreement`. That dimension must re-derive from raw data.

2. **Detect "cycle didn't close" mode.** If `run_state.yaml` shows Phase 10
   incomplete (no `closeout.cycle-grade: done`, no
   `cycle-grade.md`), emit `verdict: incomplete` immediately with
   `[INFO] Phase 10 not run; cycle-grade-eval not gradable yet`. Do
   not score zero — it's a structural state, not a defect.

2.5. **Independently re-derive ≥1 cycle outcome from RAW run data.**
   Before scoring `self_eval_agreement`, pick one load-bearing cycle claim
   from `cycle-grade.md` (FLW records delivered, photo pass rate, LLO
   drop-off, OCS bot quality, records-vs-target) and re-compute it yourself
   from the underlying raw evidence — the per-phase artifacts, observation
   log entries, and run-state product blocks — **not** from the per-skill
   `<skill>-eval_verdict.yaml` files. Record: which claim, which raw source,
   the number you independently got, and whether it agrees with what
   `cycle-grade` reported. This re-derivation is the out-of-chain anchor
   that the `self_eval_agreement` dimension scores against; a `cycle-grade`
   PASS that cannot be corroborated by any raw-data re-derivation is a
   hard block (≤ 3) on that dimension. Capture it in `per_item` as the
   `"Raw-data re-derivation"` row.

3. **Grade across 5 dimensions.** Each dimension is 0–10. Overall
   score is the weighted mean.

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Self-eval agreement** | 25% | **OUT-OF-CHAIN FITNESS — this dimension MUST anchor to raw run data, not to per-skill verdicts.** Independently judge whether the cycle did what the PDD set out to do. **Required step: independently re-derive at least ONE cycle outcome from the raw run evidence — not from the per-skill verdict files.** Pick a load-bearing cycle claim (e.g. "FLWs delivered N records", "photo pass rate cleared target", "LLO drop-off ≤ 15%", "OCS bot held quality") and re-compute it yourself from the underlying source: FLW delivery records / Connect visit counts, `comms-log/observations.md` raw entries, the actual app/OCS artifacts, or live run-state events — NOT from the `<skill>-eval_verdict.yaml` summaries (those are the same possibly-inflated AI chain `cycle-grade` already read). State the source you re-derived from and the number you got. If your independent re-derivation disagrees with what `cycle-grade` (or the per-skill verdicts) reported, that gap is the finding and caps this dimension. Then compare to `cycle-grade`'s own grade. **Hard ceiling 7.5 if `cycle-grade` claims overall PASS but this rubric finds ≥1 cycle-level failure mode** the producing skill missed (Phase 6 LLO drop-off, FLW data-quality drift, OCS bot quality regression mid-cycle, missed closeout deliverables). **Hard block (≤ 3) if `cycle-grade` cannot be corroborated by any raw-data re-derivation** — i.e. its PASS rests entirely on per-skill verdicts with no independent evidence backing, OR your re-derivation contradicts a primary cycle claim. |
   | **Learnings concreteness** | 25% | The cycle's learnings must be actionable in a future opp. "We learned to communicate better" = ≤4. "Phase 6 UAT must include a calibration recheck before live deployment because 30% of FLWs drifted in week 1" = 9. Vague aphorisms that can't drive a future PDD are 1-point deductions per occurrence. |
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
   `ACE/<opp-name>/runs/<run-id>/10-closeout/cycle-grade-eval_verdict.yaml`. The filename uses the
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
     - ref: "Raw-data re-derivation"
       score: 8.5
       verdict: pass
       note: "Re-derived LLO drop-off from raw run data (not per-skill verdicts): counted onboarding roster in 9-execution/llo-onboarding_* (13 LLOs) vs active at close in run_state.yaml phases.execution-management.products (12) = 7.7% drop-off; cycle-grade claimed 8%. Independent number corroborates the PASS claim."
     - ref: "Cycle PASS claim re-grade"
       score: 8.5
       verdict: pass
       note: "Independent re-grade agreed cycle was PASS-eligible — Phase 6 LLO drop-off was 8% (target ≤15%); FLW data quality held at week-4 calibration recheck; OCS bot deep-eval held at PASS in monitor mode."
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
   - `[BLOCKER]` if `cycle-grade`'s PASS cannot be corroborated by any
     independent raw-data re-derivation (rests entirely on per-skill
     verdicts), or the re-derivation contradicts a primary cycle claim.
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
on opps where Phase 10 hasn't run.

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
| 2026-04-28 | Initial version. 5 dimensions: self_eval_agreement (0.25), learnings_concreteness (0.25), recommendation_specificity (0.20), evidence_citation_discipline (0.15), trajectory_framing (0.15). Inflation guard at 8.5. Explicit `incomplete` verdict for opps where Phase 10 hasn't run. Ships at provisional calibration until a closed cycle produces ground truth. Together with connect-program-setup-eval (0.9.8), gives the eval framework rubrics ready for all 6 opp-eval categories — once a cycle runs end-to-end through Phase 10, opp-eval can produce a fully-covered verdict (4+ tier). | ACE team (eval system buildout — 0.9.8) |
| 2026-05-29 | Hardened `self_eval_agreement` (0.25) into a true out-of-chain dimension: added a required step (new Process step 2.5) to independently re-derive ≥1 cycle outcome from RAW run data (FLW records, observation log, per-phase artifacts, run-state product blocks) rather than from the per-skill `<skill>-eval_verdict.yaml` files — which are the same possibly-inflated AI chain `cycle-grade` already read. Added a hard block (≤ 3) when `cycle-grade`'s PASS cannot be corroborated by any raw-data re-derivation, plus a matching `[BLOCKER]` and a `per_item` "Raw-data re-derivation" row. No weight change (process/criteria only; weights remain 0.25/0.25/0.20/0.15/0.15 = 1.0). Per `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md` — the eval's failure-mode check was reading the same inflated verdicts the cycle-grade did, so it could only ever ratify them. | ACE team |
