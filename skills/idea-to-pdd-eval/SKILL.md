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
   - Source material — read all of these as the "source idea pack":
     - `ACE/<opp-name>/runs/<run-id>/inputs-manifest.yaml`, then each
       `file_id` it lists (the orchestrator's frozen evidence-pack
       pointer-set, captured at run start)
     - `ACE/<opp-name>/runs/<run-id>/idea.md` if present (operator
       free-text seed via `--idea FILE|-`; absent on most runs)
   - PDD (the artifact under judgment): `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md`
   - Optionally the gate brief if present:
     `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd_gate-brief.md`.

   The "source idea" referenced throughout the rest of this skill is
   the union of the manifest's contents + `idea.md` (if present),
   treated as one synthesized seed. When grading dimensions that
   reference "idea.md" below, treat them as referencing the full
   source-idea pack — early-2026 versions of this rubric assumed a
   single `idea.md`; the multi-doc evidence-pack model arrived in the
   2026-05-05 idea-to-pdd refactor.

2. **Extract the source idea's reviewer-comment list.** Source-idea
   bodies (any file in the manifest, plus `idea.md` if present)
   generally include footnoted or sectioned reviewer comments
   (e.g. "[a] FLW safety risks…", "[b] vendor consent…"). Build a
   structured list across all source files.

   **Clean-source detection (added 0.10.9):** if the entire source
   pack contains zero reviewer comments — no `[a]/[b]` footnotes, no
   "Reviewer Comments" / "Comments" / "Feedback" section in any of
   the manifest entries or `idea.md` — set `clean_source = true` and
   skip step 3. The reviewer-comment-fidelity dimension will switch
   to the deferred-decision-discipline branch (see § Dimension
   below). Surfaced 0.9.11 cross-opp validation:
   `turmeric-dogfood-20260427`'s source idea was clean PM-authored
   with no review pass; the rubric's anchors at 9.5 ("all comments
   addressed") were a poor fit because there were no comments to
   address.

3. **Extract the PDD's promised dispositions** (skip if
   `clean_source = true`). PDDs include a "Reviewer Comments —
   Disposition" table mapping each comment to how the PDD addressed
   it. Build the matching list.

4. **Grade across 5 dimensions.** Each dimension is 0–10. Overall
   score is the weighted mean.

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Stress-test agreement** | 25% | Independently re-run the 5-question rubric from `skills/idea-to-pdd/SKILL.md § LLM-as-Judge Rubric` against the PDD without reading the PDD's own self-evaluation first. Then compare. **Hard ceiling 7.5 (raised from 7 in 0.9.4) if the self-eval graded 5/5 but you grade ≤4/5 on any check** — a self-eval inflation gap that big means the PDD-writing model didn't notice a real flaw. **Composition rule (clarified 0.9.4):** when the ceiling binds, ignore the per-check disagreement formula below — the ceiling is the answer. The formula only applies when the ceiling does NOT bind. Per-check disagreement scores (formula): full agreement = 10; one check off by one tier (pass → partial) = 8; one check off by two tiers (pass → fail) = 5; ≥2 checks disagreed = 3. |
   | **Reviewer-comment fidelity** | 20% | **Two branches by source type.** If `clean_source = false` (idea.md contains reviewer comments): every reviewer comment from idea.md must have a concrete disposition in the PDD (addressed via §X / scoped out / out-of-scope-for-this-opp). **Scoring anchors (tightened 0.9.4):** all comments addressed with concrete section citation = **9.5**; addressed plus one comment that's "addressed via § X" where § X is mentioned but light = **9.0**; one comment missing disposition = **7.5**; ≥2 missing = **5.0**; one false-disposition claim ("addressed via § X" but X doesn't exist) = **4.0** (3-point deduction floor); ≥2 false claims = **fail (≤3)**. ── **Clean-source branch (added 0.10.9, when `clean_source = true`):** the dimension grades **deferred-decision discipline** instead. Look for a PDD section explicitly handling uncertainty (Open Questions / Deferred Decisions / TBD-per-LLO / Phase-1-Discovery). Anchors: every deferred decision is concrete (named question, named owner phase, named resolution mechanism) = **9.5**; section present, decisions concrete but owner phase implicit = **8.5**; section present but decisions vague ("TBD per LLO" with no question) = **7.0**; section absent AND PDD silently spec'd things that should have been deferred to LLO discovery = **5.0**; section claims to defer something that should have been Phase-1-speccable (e.g. archetype, primary metric) = **4.0**. Surface `[INFO] clean-source branch active: graded on deferred-decision discipline` in `auto_surfaced` so the verdict is auditable. The branch swap is automatic, not an opt-out. |
   | **Structural completeness** | 15% | Required sections present: Archetype, Problem Statement, Intervention Design, Learn App Specification, Deliver App Specification, Target Population, FLW Requirements, LLO Preference, Success Metrics, Evidence Model, Timeline. Missing section is a 1-point deduction per gap. Empty/placeholder sections (a heading with TBD content) score same as missing. |
   | **Archetype coherence** | 15% | (Reduced from 20% in 0.9.4 to make room for the Numbers split + Feasibility dimension.) The spec must follow the declared archetype's pattern: `atomic-visit` shouldn't introduce inter-visit stages or multi-visit case lifecycles; `focus-group` shouldn't have a single-vendor-style Deliver form; `multi-stage` should have a Stage Gate section between stages. Pattern violations are 2-point deductions per violation. |
   | **Numbers present** | 10% | (Split out from Concreteness in 0.9.4.) Operational specs must include concrete numbers and named entities, not placeholders. Look for: FLW count (or count range), market/site count, sample target, success-metric thresholds, active-window duration, LLO scope criteria. Vague "some FLWs in a region" scores ≤4. Each missing concrete spec is a 1-point deduction. |
   | **Numbers consistent** | 10% | (Split out from Concreteness in 0.9.4.) Cross-section numerical agreement. **Severity-tiered deductions (added 0.9.4):** load-bearing inconsistencies that change downstream behavior (LLO recruiting filter, FLW certification gates, payment thresholds) are **2-point deductions** per occurrence. Doc-level inconsistencies (different number presentations of the same value, ordering differences) are **0.5-point deductions**. Default tier is 1.0 (mid). The previous flat-deduction rule scored a comma typo the same as a recruiting-filter mismatch — wrong signal. |
   | **Feasibility of headline metrics** | 5% | (Added 0.9.4 as a 6th dimension to fill the gap surfaced in 0.9.2 calibration.) Each Primary success metric must be measurable today, not aspirational. Specifically: the PDD's Layer B verification claims must reference concrete checks (file-format validations, deterministic field rules), not future capabilities (e.g. "AI-assisted photo content check" without naming the model, threshold, or expected pass rate). 1.5-point deduction per metric that depends on unspeccable Layer B. |

   **Deduction rules:**
   - Any single dimension ≤3 → suite verdict `fail`, regardless of
     overall mean.
   - **Inflation guard (raised 7.5 → 8.0 in 0.9.4):** if PDD
     self-eval is 5/5 and this rubric's overall is ≤8.0, that's a
     calibration signal that the `idea-to-pdd` self-eval rubric is
     loose. Cap overall at 8.0 and surface `[WARN]` recommending
     tightening `skills/idea-to-pdd/SKILL.md § LLM-as-Judge Rubric`
     next iteration. The threshold was raised because the 0.9.2
     calibration produced overalls of 8.48–8.52 against a PDD that
     self-graded 5/5 — the original 7.5 threshold was non-binding.
     8.0 is the new threshold; if a PDD self-grades 5/5 and this
     rubric scores 8.1+, no inflation. 8.0 or below = inflation
     signal binds.
   - **Pre-cap and post-cap reporting (added 0.9.4, mirrors OCS
     and Learn rubrics):** verdict YAML's `overall_score` is
     post-cap; sibling `overall_score_pre_cap` is the raw
     weighted mean.

5. **Write the verdict YAML** to
   `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd-eval_verdict.yaml` using the shared shape.
   The filename uses the **producer** skill name (`idea-to-pdd`), NOT
   this skill's name — see `agents/ace-orchestrator.md § Per-Step Eval
   Hook` for the naming rule (the Workbench attributes verdicts by
   filename stem to the producer skill row):

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
     reviewer_comment_fidelity:    { score: 9.5, weight: 0.20 }
     structural_completeness:      { score: 9.5, weight: 0.15 }
     archetype_coherence:          { score: 9.0, weight: 0.15 }
     numbers_present:              { score: 9.0, weight: 0.10 }
     numbers_consistent:           { score: 6.5, weight: 0.10 }  # cross-section inconsistencies caught
     feasibility_headline_metrics: { score: 8.0, weight: 0.05 }

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
     disposition or with a false disposition claim (only when
     `clean_source = false`).
   - `[WARN]` for each cross-section numerical inconsistency.
   - `[INFO]` for each reviewer comment scoped out without rationale
     (PDD says "out of scope" but the idea reviewer flagged it as
     critical).
   - `[INFO]` `clean-source branch active: graded on deferred-decision
     discipline` (when `clean_source = true` — auditability for
     why the dimension scored on a different rubric than usual).
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
| 2026-04-29 | Clean-source branch added to reviewer_comment_fidelity dimension. When idea.md has zero reviewer comments (set `clean_source = true` in step 2), the dimension switches from comment-disposition grading to deferred-decision-discipline grading: looks for an explicit Open Questions / Deferred Decisions / TBD-per-LLO section with concrete questions, owner phases, and resolution mechanisms. New anchors (9.5 → 4.0). Surfaces `[INFO] clean-source branch active` in `auto_surfaced` for auditability. Surfaced 0.9.11 cross-opp validation: `turmeric-dogfood-20260427`'s clean PM-authored idea.md scored gracefully at 9.78 by treating PDD's Open Questions as analog, but the original 9.5 anchors were a poor fit (the dimension was effectively measuring something different from what the rubric claimed). | ACE team (0.10.9) |
