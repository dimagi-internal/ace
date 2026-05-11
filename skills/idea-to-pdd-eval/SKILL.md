---
name: idea-to-pdd-eval
description: >
  Independently grade a PDD against the source idea pack — re-runs the
  stress test from outside and cross-checks reviewer-comment fidelity.
disable-model-invocation: true
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

Cross-artifact eval — see `skills/_eval-template.md` for shared
contracts (verdict YAML shape, severity rules, inflation guard,
stock blocks). See `skills/eval-calibration/SKILL.md` for the
calibration methodology.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 source | `inputs-manifest.yaml` + each `file_id` in it | source idea pack (the full pack is what the PDD is graded against) |
| Phase 1 source (optional) | `runs/<run-id>/idea.md` | operator free-text seed if present |
| Phase 1 producer | `1-design/idea-to-pdd.md` | the PDD under judgment |
| Phase 1 producer (optional) | `1-design/idea-to-pdd_gate-brief.md` | gate brief if present |

## Products

- `1-design/idea-to-pdd-eval_verdict.yaml` — verdict YAML per `_eval-template.md § Verdict YAML contract`

Note: the verdict filename uses `idea-to-pdd-eval` (this skill's name)
not `idea-to-pdd` (the producer) — see `_eval-template.md` for the
filename rule.

## Process

1. **Use inputs already in context (preferred) or read from Drive.**
   When invoked from the `design-review` subagent (the common
   `/ace:run` path), all inputs below are already loaded by the
   parent — do NOT re-issue `drive_read_file`. See
   `agents/design-review.md` § Performance conventions: the parent
   subagent reads the source material in Step 1 and the PDD lands in
   context via Step 1's producer call; both are then trusted across
   all downstream steps. Re-reading wastes ~5–10s per file. Only
   re-read when invoked standalone (e.g. `/ace:step idea-to-pdd-eval
   <opp>/<run-id>`) where the parent context isn't pre-warmed.

   The inputs this skill reasons about (location for standalone reads):
   - Source material — the "source idea pack":
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

4. **Grade across 9 dimensions.** Each dimension is 0–10. Overall
   score is the weighted mean.

   Per the QA/Eval split principle (PR #146), this rubric is **quality-only**. Structural correctness (sections present, weights sum, archetype valid in enum, etc.) is now checked by `idea-to-pdd-qa` and gates this eval — if QA failed irrecoverably, this skill emits `verdict: incomplete` without grading. Quality dimensions: 4 doc/fidelity (40% weight) + 5 program viability (60% weight).

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Reviewer-comment fidelity** | 10% | **Two branches by source type.** If `clean_source = false` (idea.md contains reviewer comments): every reviewer comment from idea.md must have a concrete disposition in the PDD (addressed via §X / scoped out / out-of-scope-for-this-opp). **Scoring anchors (tightened 0.9.4):** all comments addressed with concrete section citation = **9.5**; addressed plus one comment that's "addressed via § X" where § X is mentioned but light = **9.0**; one comment missing disposition = **7.5**; ≥2 missing = **5.0**; one false-disposition claim ("addressed via § X" but X doesn't exist) = **4.0** (3-point deduction floor); ≥2 false claims = **fail (≤3)**. (QA verifies the table EXISTS with rows when reviewer comments are referenced; this dimension grades whether each disposition is *concrete*, not whether the table is populated.) ── **Clean-source branch (added 0.10.9, when `clean_source = true`):** the dimension grades **deferred-decision discipline** instead. Anchors: every deferred decision is concrete (named question, named owner phase, named resolution mechanism) = **9.5**; section present, decisions concrete but owner phase implicit = **8.5**; section present but decisions vague ("TBD per LLO" with no question) = **7.0**; section absent AND PDD silently spec'd things that should have been deferred to LLO discovery = **5.0**; section claims to defer something that should have been Phase-1-speccable = **4.0**. |
   | **Archetype coherence** | 10% | The spec must follow the declared archetype's pattern *in spirit*: `atomic-visit` shouldn't introduce inter-visit stages or multi-visit case lifecycles; `focus-group` shouldn't have a single-vendor-style Deliver form; `multi-stage` should have a Stage Gate section between stages. Pattern violations are 2-point deductions per violation. (QA verifies the archetype is *declared and in the valid enum*; this dimension grades whether the structure *matches* the declared archetype.) |
   | **Numbers consistent** | 10% | Cross-section numerical agreement (semantic — the *meaning* of the numbers, not just regex same-value-twice). **Severity-tiered deductions:** load-bearing inconsistencies that change downstream behavior (LLO recruiting filter, FLW certification gates, payment thresholds) are **2-point deductions** per occurrence. Doc-level inconsistencies (different number presentations of the same value, ordering differences) are **0.5-point deductions**. Default tier is 1.0 (mid). |
   | **Feasibility of headline metrics** | 10% | Each Primary success metric must be measurable today, not aspirational. Specifically: the PDD's Layer B verification claims must reference concrete checks (file-format validations, deterministic field rules), not future capabilities (e.g. "AI-assisted photo content check" without naming the model, threshold, or expected pass rate). 1.5-point deduction per metric that depends on unspeccable Layer B. |
   | **Demand reality** | 22% | (Increased from 20% in 0.13.88 after redistributing the removed `structural_completeness` weight to viability.) Is there a NAMED downstream consumer of the PDD's output, with a documented commitment to act on it? **Anchors:** named entity (regulator, lab, partner org) WITH explicit pre-committed action ("output X triggers test/policy step Y by entity Z by date D") = **9.5**; named entity WITH implicit/scoped commitment = **8.0**; passive references to "analysts" / "downstream consumers" / "lab testing" without a named entity = **6.0**; no named consumer; data collection in search of a buyer = **4.0**; data collection with explicit "future use TBD" = **2.0**. A PDD can be structurally complete and internally consistent while producing an orphan dataset; this dimension catches that. |
   | **Resource realism** | 17% | (Increased from 15% in 0.13.88.) Does the budget cover the implied labor + overhead at recruitment-realistic rates in the named geography? Walk through: budget ÷ visits = per-visit gross; subtract LLO management overhead (typically 25–40%), analyst review costs, AI inference costs, FLW transport/airtime; arrive at per-FLW daily rate. Compare to local market floor for the named region. **Anchors:** per-FLW daily rate clears local market floor with ≥30% buffer = **9.0**; clears the floor with little buffer = **7.0**; below local market floor — LLO must subsidize silently or FLWs churn = **5.0**; budget doesn't cover named work even at minimum rates = **3.0**; budget appears intentionally fictional / placeholder = **1.0**. |
   | **Mission alignment** | 12% | (Increased from 10% in 0.13.88.) Does each Primary metric measure the program's stated goal, or an upstream proxy? **Anchors:** every Primary metric directly measures the program's stated outcome = **9.0**; Primary metrics measure proximate proxies but the inferential chain is documented = **7.0**; ≥1 Primary metric measures something the program *does* (process metric: "form submitted, photo present") rather than what the program is trying to *learn* (outcome metric: "adulteration detected") = **5.0**; ≥1 Primary metric is structurally disconnected from the stated mission = **3.0**. The chain "Primary metric passes → mission outcome achieved" must hold without unstated steps. |
   | **Fallback validates primary** | 9% | (Increased from 5% in 0.13.88.) When the PDD names a fallback for a primary verification mechanism (typically Layer B AI checks), does the fallback function as a TRUE validation harness or as a parallel sampling alternative? **Anchors:** fallback is a stratified sample of primary's output (positive + negative cases reviewed, computes confusion-matrix metrics validating per-decision accuracy) = **9.0**; uniform sample of primary's output (validates aggregate not per-class) = **7.0**; random N% of submissions independent of primary's classifications (parallel sampling, not validation) = **5.0**; no fallback OR re-implements primary without independent ground truth = **2.0**. |

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
   `1-design/idea-to-pdd-eval_verdict.yaml` using the shape defined in
   `skills/_eval-template.md § Verdict YAML contract`. Dimensions for
   this rubric (sum to 1.0):

   ```yaml
   dimensions:
     # Document quality + fidelity (40%) — quality-only after 0.13.88;
     # structural completeness moved to idea-to-pdd-qa
     reviewer_comment_fidelity:    { weight: 0.10 }
     archetype_coherence:          { weight: 0.10 }
     numbers_consistent:           { weight: 0.10 }
     feasibility_headline_metrics: { weight: 0.10 }
     # Program viability (60%, redistribution of removed structural weight)
     demand_reality:               { weight: 0.22 }
     resource_realism:             { weight: 0.17 }
     mission_alignment:            { weight: 0.12 }
     fallback_validates_primary:   { weight: 0.09 }
   ```

6. **Auto-surfaced concerns.** Severity rules per
   `skills/_eval-template.md § Auto-surfaced severity rules`. Skill-
   specific surfaces beyond the standard contract:
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

See `skills/_eval-template.md § MCP Tools Used (stock)`.

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior (stock)`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-28 | Initial version. 5 dimensions: stress_test_agreement (0.25), reviewer_comment_fidelity (0.20), structural_completeness (0.15), archetype_coherence (0.20), concreteness (0.20). Inflation guard at 7.5 when self-eval is 5/5 but this rubric is ≤7.5. Companion to `pdd-to-deliver-app-eval`; covers the design category for `opp-eval` aggregation. | ACE team (eval system buildout — 0.9.2) |
| 2026-04-29 | Clean-source branch added to reviewer_comment_fidelity dimension. When idea.md has zero reviewer comments (set `clean_source = true` in step 2), the dimension switches from comment-disposition grading to deferred-decision-discipline grading: looks for an explicit Open Questions / Deferred Decisions / TBD-per-LLO section with concrete questions, owner phases, and resolution mechanisms. New anchors (9.5 → 4.0). Surfaces `[INFO] clean-source branch active` in `auto_surfaced` for auditability. Surfaced 0.9.11 cross-opp validation: `turmeric-dogfood-20260427`'s clean PM-authored idea.md scored gracefully at 9.78 by treating PDD's Open Questions as analog, but the original 9.5 anchors were a poor fit (the dimension was effectively measuring something different from what the rubric claimed). | ACE team (0.10.9) |
| 2026-05-08 | **Rubric expansion: 7 → 11 dimensions, viability axis added (40% weight).** Surfaced by canopy's holistic_adversarial probe on turmeric run 20260507-1733: rubric scored 8.65/10 on a PDD an adversarial PM-style read scored 3/10 viability (3-to-1 against on the $10K bet). 5.65-point gap = rubric was grading document quality almost exclusively. Added 4 viability dimensions: `demand_reality` (15%, named downstream consumer with pre-committed action — biggest single gap), `resource_realism` (10%, budget vs labor at recruitment-realistic rates), `mission_alignment` (5%, do Primary metrics measure the goal or a process proxy), `fallback_validates_primary` (5%, is the named fallback a real validation harness or a parallel sampling system). Reweighted: stress_test_agreement 25→10%, reviewer_comment_fidelity 20→10%, structural_completeness 15→10%, archetype_coherence 15→10%, numbers_present 10→5%; numbers_consistent + feasibility_headline_metrics held. Pairs with canopy PR #38 (lens-types/judge.md adds rubric_blind_spot signal that drove this expansion). | ACE team (0.13.81) |
| 2026-05-08 | **Rubric cleanup: 11 → 10 dimensions; weight-sum bug fix; viability rebalanced to 50%.** Three fixes in one edit: (1) Removed `stress_test_agreement` (10%) — it was structurally tautological (same model applies same rubric twice; cross-model probe confirmed it doesn't discriminate, scoring 8-10 on every grade with variance from rubric ambiguity not from real artifact differences). (2) Folded `numbers_present` (5%) into `numbers_consistent` (10%) since they cover the same axis and `numbers_present` was already a soft check most PDDs trivially pass. (3) Fixed the 0.13.81 weight-sum bug: weights summed to 0.95 not 1.0. New weights cleanly total 1.00 with viability at 50%: `demand_reality` 15→20%, `resource_realism` 10→15%, `mission_alignment` 5→10%, `fallback_validates_primary` held at 5%, `feasibility_headline_metrics` 5→10%. Verification (independent re-grade on turmeric PDD with the new 11-dim rubric scored 7.55 vs old rubric's 8.65 — confirming the viability axis discriminates). | ACE team (0.13.84) |
| 2026-05-08 | **QA/Eval split: removed `structural_completeness` (10%) — now lives in new `idea-to-pdd-qa` skill.** First migration of the QA/Eval split principle (PR #146). Structural completeness was a static check (regex over `## Heading` lines for the 11 required sections); moved to `skills/idea-to-pdd-qa/checks.ts` as `checkAllRequiredSectionsPresent`. The eval rubric is now quality-only: 4 doc/fidelity dimensions (40%) + 5 viability dimensions (60%). Removed weight (10%) was redistributed to viability dimensions: `demand_reality` 20→22%, `resource_realism` 15→17%, `mission_alignment` 10→12%, `fallback_validates_primary` 5→9%. QA gates eval — eval is skipped (`verdict: incomplete`) if QA fails irrecoverably. Updated dimension descriptions to clarify which structural concerns moved to QA (annotated inline). | ACE team (0.13.88) |
