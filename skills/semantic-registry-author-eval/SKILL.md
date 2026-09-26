---
name: semantic-registry-author-eval
description: >
  Grade the PDD-authored semantic registry: fidelity, correctness, honest
  coverage, domain-expert fitness. Gated by its -qa. Provisional.
disable-model-invocation: false
---

# Semantic Registry Author — Eval

Grades whether the registry `semantic-registry-author` wrote says what the PDD
means. QA has already proved it compiles and cites the PDD; this asks whether
the definitions are **right** and whether a person who runs the programme would
recognise them as theirs. Shared contract: [`skills/_eval-template.md`](../_eval-template.md).
Skipped when `semantic-registry-author-qa` failed irrecoverably.

## Process

1. Read `7-synthetic/semantic-registry-author_registry.json`,
   `…_summary.md`, `…-qa_result.yaml` and the PDD (`writeToPath`).
2. For 3 indicators — the headline primary metric, the payment-adjacent one, and
   one review signal — call `mcp__connect-labs__semantic_registry_explain` and
   read the compiled chain against the PDD's own definition row.
3. Apply the rubric; write `7-synthetic/semantic-registry-author-eval_verdict.yaml`
   per the template's verdict contract.

## LLM-as-Judge Rubric

`provisional: true` — calibrated on one registry (Spark, ace#2510).

| dimension | weight | 10 | 5 | 0 |
|---|---|---|---|---|
| `pdd_fidelity` | 0.30 | every numerator/denominator matches the PDD's definition row, including its qualifiers (e.g. "Step 5 or later", "verified meetings only") | a qualifier dropped or a denominator widened | an indicator measures something the PDD does not define |
| `definition_correctness` | 0.25 | the compiled chain (`semantic_registry_explain`) computes what the label claims; entity key is the followed thing, not the deliver-unit key | one chain double-counts or mis-keys | the entity is wrong, so every figure is wrong |
| `coverage_honesty` | 0.20 | every PDD metric is an indicator or listed not-computable with a real reason; targets only where the PDD states them | a metric silently missing | a proxy presented as a PDD metric, or an invented target |
| `domain_expert_fitness` (out-of-chain) | 0.15 | the programme's M&E lead would accept these as their own indicators — the partner/worker/case levels are the ones they manage by | usable but framed in ACE's words | definitions a practitioner would not recognise as theirs |
| `legibility` | 0.10 | labels and `plain` sentences read to a funder with no ACE context | jargon in a few labels | unreadable |

**Hard deductions.** An indicator with no PDD anchor that QA somehow passed:
`coverage_honesty ≤ 3`. Entity keyed on Connect's deliver-unit `entity_id` when
the app's unit key is not the followed entity: `definition_correctness ≤ 2`.

**Inflation guard.** If the producer's summary claims "all PDD metrics covered"
and any PDD § Success Metrics row is neither an indicator nor listed
not-computable, cap overall at 6.0 and surface `WARN`.

Calibration targets: the standard block in `_eval-template.md § Calibration
target boilerplate`, with the negative control being a registry that keys the
entity on the deliver-unit `entity_id` (must score below pass).

## Archetypes

| archetype | what the entity must be |
|---|---|
| `longitudinal-visits` | the followed entity of § Entity Lifecycle |
| `atomic-visit`, `multi-stage` | the beneficiary a visit is delivered to |
| `focus-group` | not run — Phase 7 is skipped |

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used`, plus
`mcp__connect-labs__semantic_registry_explain`.

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior`.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior`.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-09-26 | Created, provisional (ace#2510). | ACE team |
