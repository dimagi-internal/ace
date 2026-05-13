---
name: training-quick-reference-eval
description: >
  Grade the Phase 6 quick-reference card for mid-visit scannability,
  coverage of key numbers (daily caps, payment per visit, support
  contact), and printability.
disable-model-invocation: true
---

# Training Quick Reference — Eval

Grades `6-qa-and-training/training-quick-reference.md`. The
quick-reference is the one-pager an FLW glances at mid-visit (often
printed and folded into a notebook). The rubric optimizes for
scannability and number-coverage rather than depth — depth is the FAQ's
job.

See `skills/_eval-template.md` for shared contracts. Provisional rubric —
calibration TBD until 3+ shipped quick-references produce ground truth.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 6 | `6-qa-and-training/training-quick-reference.md` | artifact under judgment |
| Phase 1 | `1-design/idea-to-pdd.md` | anchors numeric caps + archetype + support contact |
| Phase 3 | `3-commcare/app-deploy_summary.md` | confirms numeric values match deployed reality |

## Products

- `6-qa-and-training/training-quick-reference-eval_verdict.yaml` — verdict
  YAML per `_eval-template.md § Verdict YAML contract`.

## Process

1. Read inputs from Drive.
2. Build a "must-include numbers" checklist from the PDD: daily-visit
   cap, payment per visit (or per session/stage by archetype), payment
   timing, support contact, any Layer A numeric thresholds (GPS
   accuracy, photo minimum size).
3. Check each item is present, accurate, and visually surfaced (not
   buried in prose).
4. Apply the rubric and write the verdict YAML.
5. Surface concerns per `_eval-template.md § Auto-surfaced severity rules`.

## LLM-as-Judge Rubric

Score each dimension 0–10. Weights sum to 1.0.

| Dimension | Weight | Anchored criteria |
|---|---|---|
| **Scannability** | 0.30 | Can an FLW glancing at the printed page find what they need in ≤ 5 seconds? 10 = visually structured (table, bulleted list with bolded keys, or labeled boxes); information density tuned for glance. 6 = readable but prose-heavy in places. 3 = wall of paragraphs; user must read sentence-by-sentence. |
| **Key-number coverage** | 0.30 | Does the card surface every must-include number from the checklist? 10 = ≥ 90% covered, all visually prominent (not buried mid-sentence). 6 = 60–90%; some missing or de-emphasized. 3 = < 60%; the card fails its core job. Hard-deduct -3 per missing must-include number (daily cap, payment per visit, support contact). |
| **Numeric accuracy** | 0.15 | Numbers match PDD verbatim. 10 = no drift. 6 = 1 minor drift. 3 = any contradicted cap or payment. Hard-deduct -5 for any contradicted operational number. |
| **Printability** | 0.15 | Will the card render usefully on a single A4/Letter page when printed? 10 = explicit single-page structure (no unbounded screenshot floods, no 12-section nested headings). 6 = likely fits but ambiguous. 3 = clearly multi-page; defeats the form factor. |
| **Glance-priority ordering** | 0.10 | Are the most-needed numbers (daily cap, payment, support) at the top, not buried below preamble? 10 = top-of-page priority. 6 = mid-page. 3 = below introduction prose; user must scroll/scan past filler. |

**Hard-deduct rules:**
- More than one missing must-include number → BLOCKER (cap overall ≤ 5).
- Quick-reference contradicts a PDD operational cap → BLOCKER.
- Any single dimension ≤ 3 → suite verdict `fail`.

**Inflation guard.** If `training-quick-reference` self-eval graded
itself top-tier and this rubric's overall ≤ 8.0, cap overall at 8.0
and surface a `[WARN]`. Default no-op until the producer ships a
self-eval.

**Calibration target** (per `_eval-template.md § Calibration target boilerplate`):
- Detection rate ≥ 80% of catalogued quick-reference issues from
  `eval-calibration/known-issues.md § Training quick reference` (catalogue TBD).
- Inter-run variance ≤ 0.5 across 3 same-model runs.
- Agreement with self-eval within ±1.5 points.

Provisional until first real run produces ground truth.

## Archetypes

| Archetype | Rubric tweak |
|---|---|
| `atomic-visit` | Default. Must-include set is daily-cap, payment-per-visit, payment-timing, support-contact, GPS/photo thresholds. |
| `focus-group` | Must-include set swaps "payment-per-visit" for "payment-per-session" + adds attendance-minimum threshold. |
| `multi-stage` | Must-include set adds per-stage-payment + Stage-Gate-trigger summary. Printability dimension's per-page check looks at per-stage condensation. |

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)`.

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior (stock)`.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-09 | Initial version. 5 dimensions: scannability (0.30), key_number_coverage (0.30), numeric_accuracy (0.15), printability (0.15), glance_priority_ordering (0.10). Provisional rubric — calibration TBD until first real run grades the artifact. | ACE team (qa-eval-registry initial buildout) |
