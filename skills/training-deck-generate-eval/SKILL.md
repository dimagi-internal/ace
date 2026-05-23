---
name: training-deck-generate-eval
description: >
  Grade the Phase 6 training-deck spec for module coverage, content
  concreteness, image ref validity, and slide count.
disable-model-invocation: true
---

# Training Deck Generate — Eval

Grades `6-qa-and-training/training-deck-spec.yaml`. The deck spec
drives `training-deck-render` (which renders spec → Slides via
the Slides API). The spec is therefore where pedagogical
quality lives — `training-deck-render` is graded by template, not by
content. This rubric is the upstream gate.

See `skills/_eval-template.md` for shared contracts. Provisional rubric —
calibration TBD until 3+ shipped deck specs produce ground truth.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 6 | `6-qa-and-training/training-deck-spec.yaml` | artifact under judgment |
| Phase 1 | `1-design/idea-to-pdd.md` | anchors archetype, intervention design, anticipated audience questions |
| Phase 3 | `3-commcare/app-deploy_summary.md` | walkthrough must match deployed app screens |
| Phase 6 | `6-qa-and-training/training-faq.md` (if present) | anticipated-question coverage cross-reference |

## Products

- `6-qa-and-training/training-deck-generate-eval_verdict.yaml` — verdict YAML
  per `_eval-template.md § Verdict YAML contract`.

## Process

1. Read inputs from Drive.
2. Map the spec's module list to the canonical pedagogical arc
   (Intro / Reference / Walkthrough / Recap). Note missing or
   misordered phases.
3. Build the anticipated-question catalogue from PDD + (if present) FAQ
   and check each is addressed somewhere in the deck.
4. Resolve every screenshot reference's Drive ID; flag dead links.
5. Apply the rubric and write the verdict YAML.
6. Surface concerns per `_eval-template.md § Auto-surfaced severity rules`.

## LLM-as-Judge Rubric

Score each dimension 0–10. Weights sum to 1.0.

| Dimension | Weight | Anchored criteria |
|---|---|---|
| **Pedagogical flow** | 0.30 | Does the outline trace Intro → Reference → Walkthrough → Recap (or a deliberate variant)? 10 = each phase present, transitions are explicit, walkthrough builds on reference. 6 = phases present but ordering wobbles or one phase is thin. 3 = no recognizable arc; sections are a flat list. Hard-deduct -3 if Walkthrough phase is missing entirely (the deck's load-bearing section). |
| **Screenshot integration** | 0.25 | Walkthrough sections name a screenshot per step; reference sections include the relevant UI/data screenshots. 10 = full grounding, all Drive IDs resolve. 6 = main flow grounded, edges thin. 3 = < 50% screenshot coverage on Walkthrough OR ≥ 1 dead Drive-ID reference. Hard-deduct -3 per dead Drive-ID reference. |
| **Anticipated-question coverage** | 0.20 | Does the deck address the questions the audience will actually have (LLO ops + FLW first-visit Qs catalogued from PDD + FAQ)? 10 = ≥ 80% addressed somewhere in the deck. 6 = 50–80%; visible gaps. 3 = < 50%; deck doesn't anticipate audience reality. |
| **Recap effectiveness** | 0.15 | Does the recap consolidate the must-remember items (key numbers, escalation path, where-to-find-help)? 10 = explicit recap slide(s) listing 3–7 takeaways. 6 = recap exists but is generic ("any questions?"). 3 = no recap. |
| **Section weight balance** | 0.10 | Walkthrough is the most slide-heavy section, followed by reference, then intro/recap. 10 = balanced (e.g., 30% walkthrough, 25% reference, 20% intro, 15% recap, 10% misc). 6 = imbalanced but workable. 3 = walkthrough is < 20% of slides (deck under-teaches the actual workflow). |

**Hard-deduct rules:**
- Walkthrough phase missing → BLOCKER.
- Dead screenshot Drive ID → BLOCKER (cap overall ≤ 5).
- Any single dimension ≤ 3 → suite verdict `fail`.

**Inflation guard.** If `training-deck-generate` self-eval graded itself
top-tier and this rubric's overall ≤ 8.0, cap overall at 8.0 and surface
a `[WARN]`. Default no-op until the producer ships a self-eval.

**Calibration target** (per `_eval-template.md § Calibration target boilerplate`):
- Detection rate ≥ 80% of catalogued deck-spec issues from
  `eval-calibration/known-issues.md § Training deck spec` (catalogue TBD).
- Inter-run variance ≤ 0.5 across 3 same-model runs.
- Agreement with self-eval within ±1.5 points.

Provisional until first real run produces ground truth.

## Archetypes

| Archetype | Rubric tweak |
|---|---|
| `atomic-visit` | Default. Walkthrough section centers on a single end-to-end visit; recap consolidates per-visit numbers. |
| `focus-group` | Walkthrough section adds session-facilitation arc; pedagogical-flow dimension expects an attendance/per-domain-summary teaching beat. |
| `multi-stage` | Walkthrough section is per-stage; section-weight-balance dimension expects walkthrough to be even more slide-heavy (additional stages). Recap consolidates stage-gate triggers. |

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
| 2026-05-09 | Initial version. 5 dimensions: pedagogical_flow (0.30), screenshot_integration (0.25), anticipated_question_coverage (0.20), recap_effectiveness (0.15), section_weight_balance (0.10). Provisional rubric — calibration TBD until first real run grades the artifact. | ACE team (qa-eval-registry initial buildout) |
