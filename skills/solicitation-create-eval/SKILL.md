---
name: solicitation-create-eval
description: >
  Grade a published solicitation against its source PDD — scope
  fidelity, field completeness, deadline sensibility.
disable-model-invocation: true
---

# Solicitation Create — Eval

See `skills/_eval-template.md` for shared verdict / severity / stock-block
contracts. See `skills/_solicitation-template.md` for the labs-MCP atom
inventory. Calibrated per `skills/eval-calibration/SKILL.md` once 3+
real solicitations have shipped (provisional today).

Cross-artifact LLM-as-Judge eval. Reads the source PDD plus
`solicitation/draft.md` and `solicitation/published.md`, scores the
result, and writes a verdict YAML in the shared QA/eval shape so
`opp-eval` can aggregate it.

**Status:** Provisional. Calibration TBD until 3+ real solicitations have
shipped — see `skills/eval-calibration/SKILL.md`.

## Inputs

- `ACE/<opp-name>/inputs/pdd.md`
- `ACE/<opp-name>/runs/<run-id>/8-solicitation-management/solicitation-create_draft.md`
- `ACE/<opp-name>/runs/<run-id>/8-solicitation-management/solicitation-create_published.md`

## Rubric

Score each dimension 0-10. Hard-deduct rules listed inline.

1. **PDD-fidelity (weight 0.4).** Does the solicitation's `description`
   and `scope_of_work` actually carry the PDD's intervention summary,
   target FLW profile, and visit structure forward? Hard-deduct -3 if
   either field paraphrases away a PDD constraint (e.g. PDD says "weekly
   visits" and solicitation says "regular visits"). Hard-deduct -5 if a
   key PDD element (visit cadence, target population, archetype-specific
   capability requirements) is missing entirely.

2. **Field completeness (weight 0.2).** All required fields present?
   `evaluation_criteria` non-empty (or marked `needs-review`)?
   `response_template` non-empty (default 6-question set or PDD-supplied)?
   `program_id` and `budget` populated from `opp.yaml`/PDD?

3. **Deadline sanity (weight 0.1).** Deadline is `now + 7..30 days`. Hard-
   deduct -5 if deadline is in the past or > 90 days out.

4. **Criteria alignment (weight 0.3).** Do the evaluation criteria reflect
   what the PDD actually cares about (e.g. archetype-specific capabilities,
   geographic fit, language capacity)? Penalize generic criteria like
   "demonstrate experience" when the PDD has specific archetype demands.
   Score 9-10 if every PDD-declared criterion has a matching rubric entry;
   5-7 if criteria are partially aligned; 0-3 if rubric is generic and
   doesn't reflect the PDD.

## Hard-deduct triggers

- `[BLOCKER]` if any dimension scores ≤ 3.
- `[BLOCKER]` if deadline is in the past or > 90 days out.
- `[BLOCKER]` if `published.md` lacks a `solicitation_id` or `public_url`
  (publish silently failed and was not caught upstream).
- `[WARN]` per generic criterion (lacks archetype-specific signal).
- `[WARN]` if `evaluation_criteria` is marked `needs-review` (degenerate
  generate_criteria output that the operator should revisit).

## Verdict shape

Write `8-solicitation-management/solicitation-create-eval_verdict.yaml` per `lib/verdict-schema.ts`:

```yaml
schema_version: 1
skill: solicitation-create-eval
target: <opp-name>
mode: deep
ran_at: <ISO timestamp>
capture_path: solicitation/published.md

overall_score: <weighted mean>
overall_score_pre_cap: <weighted mean before any cap>
verdict: pass | warn | fail

dimensions:
  pdd_fidelity:        { score: <0-10>, weight: 0.4 }
  field_completeness:  { score: <0-10>, weight: 0.2 }
  deadline_sanity:     { score: <0-10>, weight: 0.1 }
  criteria_alignment:  { score: <0-10>, weight: 0.3 }

hard_deduct_triggered: [ ... ]
auto_surfaced: [ ... ]
gate:
  threshold: 7.0
  disposition: approve | iterate | reject
```

## LLM-as-Judge calibration

Provisional. Once 3+ real solicitations have shipped:
- Build a ground-truth catalogue at
  `eval-calibration/known-issues.md § Solicitation create`.
- Target detection rate ≥ 80% on catalogued issues.
- Inter-run variance ≤ 0.5 across 3 same-model runs.
- Cross-model variance ≤ 1.0 for strong calibration.

See `skills/eval-calibration/SKILL.md` for the methodology.
