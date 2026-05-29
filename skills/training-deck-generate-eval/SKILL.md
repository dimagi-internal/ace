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

**Fitness axis (out-of-chain anchor).** Most of this rubric grades the
deck's *shape* — does the arc trace Intro → Reference → Walkthrough →
Recap, are sections weighted right, do screenshots resolve. Those are
conformance signals that a faithful build of a thin PDD passes trivially.
The load-bearing fitness dimension is `content_substance`: not whether
the buckets exist, but whether a named-but-naive reader (an FLW about to
do their first visit, an LLO about to run the cohort) could actually
*perform the workflow* from the slide BODIES. It anchors on real-world
"would this teach the job?" rather than fidelity to the PDD skeleton, and
it carries a hard-gate so a structurally-perfect deck with vacuous slide
prose cannot pass. See `skills/_eval-template.md § The out-of-chain
fitness requirement`.

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
5. **Read the slide BODIES** (speaker notes + on-slide prose), not just
   the section titles. For the Walkthrough section especially, simulate a
   naive reader: could they execute the visit from what each slide
   actually says, or do the slides name a topic and stop? Score
   `content_substance` against that simulation.
6. Apply the rubric and write the verdict YAML.
7. Surface concerns per `_eval-template.md § Auto-surfaced severity rules`.

## LLM-as-Judge Rubric

Score each dimension 0–10. Weights sum to 1.0.

| Dimension | Weight | Anchored criteria |
|---|---|---|
| **Content substance** (fitness — out-of-chain) | 0.28 | Judge the slide BODIES, not the arc. Could a named-but-naive reader actually perform the workflow from what the slides *say* — the actual instructions, the actual decision logic, the actual "do this then that"? Anchor on the real-world job, NOT on whether the PDD declared the topic. 10 = a first-time FLW/LLO could execute the workflow end-to-end from the slide prose alone; instructions are specific, correct, and complete. 6 = the spine is teachable but key steps are gestured at ("review the case") rather than spelled out; reader would stumble on edges. 3 = slides name topics and stop ("Daily caps", "Escalation") with no actionable body — a deck-shaped table of contents. **Hard-gate: if Walkthrough slide bodies are vacuous (topic headers without performable instructions), score ≤ 3 → suite verdict `fail`, regardless of how clean the arc is.** PDD silence is a finding here, never a free pass — judge what a deployable teaching deck *should* contain. |
| **Pedagogical flow** (conformance) | 0.20 | Does the outline trace Intro → Reference → Walkthrough → Recap (or a deliberate variant)? 10 = each phase present, transitions are explicit, walkthrough builds on reference. 6 = phases present but ordering wobbles or one phase is thin. 3 = no recognizable arc; sections are a flat list. Hard-deduct -3 if Walkthrough phase is missing entirely (the deck's load-bearing section). |
| **Screenshot integration** | 0.20 | Walkthrough sections name a screenshot per step; reference sections include the relevant UI/data screenshots. 10 = full grounding, all Drive IDs resolve. 6 = main flow grounded, edges thin. 3 = < 50% screenshot coverage on Walkthrough OR ≥ 1 dead Drive-ID reference. Hard-deduct -3 per dead Drive-ID reference. |
| **Anticipated-question coverage** | 0.15 | Does the deck address the questions the audience will actually have (LLO ops + FLW first-visit Qs catalogued from PDD + FAQ)? 10 = ≥ 80% addressed somewhere in the deck. 6 = 50–80%; visible gaps. 3 = < 50%; deck doesn't anticipate audience reality. |
| **Recap effectiveness** | 0.10 | Does the recap consolidate the must-remember items (key numbers, escalation path, where-to-find-help)? 10 = explicit recap slide(s) listing 3–7 takeaways. 6 = recap exists but is generic ("any questions?"). 3 = no recap. |
| **Section weight balance** (conformance) | 0.07 | Walkthrough is the most slide-heavy section, followed by reference, then intro/recap. 10 = balanced (e.g., 30% walkthrough, 25% reference, 20% intro, 15% recap, 10% misc). 6 = imbalanced but workable. 3 = walkthrough is < 20% of slides (deck under-teaches the actual workflow). |

Weights sum to 1.0: 0.28 + 0.20 + 0.20 + 0.15 + 0.10 + 0.07 = 1.00.

**Hard-deduct rules:**
- Walkthrough phase missing → BLOCKER.
- Vacuous Walkthrough slide bodies (`content_substance` ≤ 3) → BLOCKER; suite verdict `fail`. A faithful build of a thin PDD does not earn a pass here.
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
| 2026-05-29 | Added out-of-chain fitness dimension `content_substance` (0.28, hard-gate on vacuous Walkthrough slide bodies) — judges whether a naive reader could perform the workflow from slide PROSE, not bucket placement. Reweighted conformance dims down: pedagogical_flow 0.30→0.20, screenshot_integration 0.25→0.20, anticipated_question_coverage 0.20→0.15, recap_effectiveness 0.15→0.10, section_weight_balance 0.10→0.07. Sum = 1.00. Per `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`. | ACE team (eval-fitness-gap) |
