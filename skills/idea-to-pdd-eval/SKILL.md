---
name: idea-to-pdd-eval
description: >
  Judge a PDD against the source idea.md it was derived from.
  Cross-artifact LLM-as-Judge eval — checks structural completeness,
  archetype coherence, concreteness, reviewer-comment fidelity, and
  stress-test agreement (independent re-grade of the self-evaluation
  to catch over-confident self-grading). Writes a verdict YAML in the
  shared QA/eval shape so opp-eval can aggregate it.
---

# Idea-to-PDD Eval

The `idea-to-pdd` skill self-evaluates with a 5-question rubric and
ships a stress-test grade in the PDD itself. That self-eval has two
known weaknesses: (a) the same model that wrote the PDD also grades
it (over-generosity bias), and (b) the PDD checks itself against the
rubric but not against the source idea — so a PDD that addressed the
intervention but missed reviewer comments from idea.md can still
self-grade 5/5 if the rubric doesn't ask "did you address every
reviewer concern?"

This skill is the independent grader. It re-runs the stress test from
outside, cross-checks against the source idea, and surfaces
inconsistencies the self-eval missed.

This is a **cross-artifact eval** in the same family as
`pdd-to-deliver-app-eval`. See `skills/eval-calibration/SKILL.md` for
the calibration methodology.

## Process

1. **Read inputs from GDrive:**
   - Source idea: `ACE/<opp-name>/idea.md`
   - PDD (the artifact under judgment): `ACE/<opp-name>/pdd.md`
   - Optionally the gate brief if present:
     `ACE/<opp-name>/gate-briefs/idea-to-pdd.md`.

2. **Extract the source idea's reviewer-comment list.** idea.md
   bodies generally include footnoted or sectioned reviewer comments
   (e.g. "[a] FLW safety risks…", "[b] vendor consent…"). Build a
   structured list.

3. **Extract the PDD's promised dispositions.** PDDs include a
   "Reviewer Comments — Disposition" table mapping each comment to
   how the PDD addressed it. Build the matching list.

4. **Grade across 5 dimensions.** Each dimension is 0–10. Overall
   score is the weighted mean.

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Stress-test agreement** | 25% | Independently re-run the 5-question rubric from `skills/idea-to-pdd/SKILL.md § LLM-as-Judge Rubric` against the PDD without reading the PDD's own self-evaluation first. Then compare. **Hard ceiling 7 if the self-eval graded 5/5 but you grade ≤4/5 on any check** — a self-eval inflation gap that big means the PDD-writing model didn't notice a real flaw. Per-check disagreement scores: agreement = 10; one check off by one tier (pass → partial) = 8; one check off by two tiers (pass → fail) = 5; ≥2 checks disagreed = 3. |
   | **Reviewer-comment fidelity** | 20% | Every reviewer comment from idea.md must have a concrete disposition in the PDD (addressed via §X / scoped out / out-of-scope-for-this-opp). Missing disposition is a 2-point deduction per comment. Disposition that says "addressed" but the PDD doesn't actually contain the addressing content (e.g. claims "see § Safety Plan" but no Safety Plan section exists) is a 3-point deduction per false claim. |
   | **Structural completeness** | 15% | Required sections present: Archetype, Problem Statement, Intervention Design, Learn App Specification, Deliver App Specification, Target Population, FLW Requirements, LLO Preference, Success Metrics, Evidence Model, Timeline. Missing section is a 1-point deduction per gap. Empty/placeholder sections (a heading with TBD content) score same as missing. |
   | **Archetype coherence** | 20% | The spec must follow the declared archetype's pattern: `atomic-visit` shouldn't introduce inter-visit stages or multi-visit case lifecycles; `focus-group` shouldn't have a single-vendor-style Deliver form; `multi-stage` should have a Stage Gate section between stages. Pattern violations are 2-point deductions per violation. |
   | **Concreteness** | 20% | Operational specs must include concrete numbers and named entities, not placeholders. Look for: FLW count (or count range), market/site count, sample target, success-metric thresholds, active-window duration, LLO scope criteria. Vague "some FLWs in a region" scores ≤4 on this dimension. **Cross-section consistency check (added in this rubric):** internal numerical specs must agree (e.g. if FLW Requirements says 8 FLWs minimum and LLO Preference says ≥10 FLWs as the LLO scope criterion, that's a numeric inconsistency = 1.5-point deduction). |

   **Deduction rules:**
   - Any single dimension ≤3 → suite verdict `fail`, regardless of
     overall mean.
   - **Inflation guard:** if PDD self-eval is 5/5 and this rubric's
     overall is ≤7.5, that's a calibration signal that the
     `idea-to-pdd` self-eval rubric is loose. Cap overall at 7.5
     and surface `[WARN]` recommending tightening
     `skills/idea-to-pdd/SKILL.md § LLM-as-Judge Rubric` next
     iteration.

5. **Write the verdict YAML** to
   `ACE/<opp-name>/verdicts/idea-to-pdd-eval.yaml` using the shared
   shape:

   ```yaml
   skill: idea-to-pdd-eval
   target: <opp-name>
   mode: deep
   ran_at: <ISO timestamp>
   capture_path: pdd.md

   overall_score: 8.4
   verdict: pass | warn | fail | incomplete

   dimensions:
     stress_test_agreement:        { score: 9.0, weight: 0.25 }
     reviewer_comment_fidelity:    { score: 8.5, weight: 0.20 }
     structural_completeness:      { score: 9.5, weight: 0.15 }
     archetype_coherence:          { score: 9.0, weight: 0.20 }
     concreteness:                 { score: 7.0, weight: 0.20 }

   per_item:
     - ref: "Stress test re-grade"
       score: 9.0
       verdict: pass
       note: "Independent re-grade agreed on 4/5 checks; minor disagreement on Verifiability (PDD scored pass; this rubric scored partial — Layer B 'AI-assisted photo content check' is aspirational, not concretely speccable today)"
     - ref: "Reviewer comment: FLW safety"
       score: 9.0
       verdict: pass
       note: "Addressed via § FLW Safety Plan with concrete buddy-pair rule, go/no-go criteria, escalation lines"
     # ... one per check + comment

   auto_surfaced:
     - severity: WARN
       message: "Pre-deploy section mentions 10/12 calibration only; Learn App spec also gates on 8/10 final MCQ. Inconsistency."

   gate:
     threshold: 7.5
     disposition: approve | reject | iterate
   ```

6. **Auto-surfaced concerns** feed the gate brief (when invoked from
   the Phase 1→2 gate, alongside the producing skill's gate brief):
   - `[BLOCKER]` for any dimension scoring ≤ 3.
   - `[BLOCKER]` if overall score is below 7.0.
   - `[WARN]` for each dimension scoring 4.0–6.9.
   - `[WARN]` for each reviewer comment without a concrete
     disposition or with a false disposition claim.
   - `[WARN]` for each cross-section numerical inconsistency.
   - `[INFO]` for each reviewer comment scoped out without rationale
     (PDD says "out of scope" but the idea reviewer flagged it as
     critical).
   - `[INFO]` if PDD's self-eval and this rubric's overall differ by
     ≥ 1.5 points — signal that the `idea-to-pdd` self-eval rubric
     needs tightening.

## LLM-as-Judge Rubric

This rubric's calibration target on the smoke-20260428-1242 PDD:

- **Detection rate:** ≥ 80% of catalogued PDD issues from
  `eval-calibration/known-issues.md § PDD`.
- **Inter-run variance:** ≤ 0.5 across 3 same-model runs.
- **Agreement with self-eval:** within ±1.5 points of the PDD's
  own stress-test grade. Larger gap is itself a calibration signal
  for the upstream `idea-to-pdd` rubric.

## Archetypes

| Archetype | What this skill does |
|---|---|
| `atomic-visit` | Default. Grades the PDD's atomic-visit specification against the source idea. |
| `focus-group` | Adds a "facilitation craft" sub-check under archetype_coherence (does the PDD specify probing techniques, neutral framing, group dynamics — not just question lists?). |
| `multi-stage` | Adds a "stage gate" sub-check under archetype_coherence (every stage transition has explicit go/no-go criteria). |

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_create_file`,
  `drive_list_folder`
- No OCS calls

## Mode Behavior

- **Auto:** Grade, write verdict + report, return overall score and
  disposition.
- **Review:** Pause after grading to let a human eyeball the verdict
  before the gate brief propagates.

## Dry-Run Behavior

When `--dry-run` is active:
- Read PDD and idea.md normally — these are read-only inputs.
- Write the verdict + report to Drive (human-facing artifacts).
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-28 | Initial version. 5 dimensions: stress_test_agreement (0.25), reviewer_comment_fidelity (0.20), structural_completeness (0.15), archetype_coherence (0.20), concreteness (0.20). Inflation guard at 7.5 when self-eval is 5/5 but this rubric is ≤7.5. Companion to `pdd-to-deliver-app-eval`; covers the design category for `opp-eval` aggregation. | ACE team (eval system buildout — 0.9.2) |
