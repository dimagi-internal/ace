---
name: semantic-registry-author-qa
description: >
  Binary QA on the authored semantic registry before any labs write: live labs
  validation plus PDD-fidelity checks. Static; gates the -eval.
disable-model-invocation: false
---

# Semantic Registry Author — QA

Two gates, both must pass. Shared QA contract: [`skills/_qa-template.md`](../_qa-template.md).

1. **Labs grammar** — `mcp__connect-labs__semantic_registry_validate({properties_doc,
   indicators_doc, deployment})` → `valid: true`. Every reference resolves, every
   SQL fragment is on the allow-list, the registry compiles at every scope
   (programme, organisation, opportunity, worker, month, case). It does not run
   the SQL, so a wrong number passes it.
2. **PDD fidelity** — `checkRegistryAuthoring(registry, {pddSections:
   pddSectionIds(pdd), opportunityIds: partners.map(p => p.opportunity_id)})` from
   [`lib/semantic-registry-authoring.ts`](../../lib/semantic-registry-authoring.ts).

## Inputs

| Source | Artifact |
|---|---|
| `semantic-registry-author` | `7-synthetic/semantic-registry-author_registry.json` |
| Phase 1 | the PDD markdown (for `pddSectionIds`) |
| `demo-data-setup` § C1 | the partner opportunity ids |

## Products

- `7-synthetic/semantic-registry-author-qa_result.yaml` — per `lib/qa-types.ts`

## Checks (`checkRegistryAuthoring`)

| check | fails when | auto-fix |
|---|---|---|
| `model` | `entity.{name,plural,key}` or `pipelines.entity` missing | declare them — a registry with no model is read as KMC |
| `indicators` / `indicator-meta` | no indicator, or one lacks `label` / `plain` / `category` / `direction` / `scope_note` | fill from the PDD row |
| `measures` | an indicator's `_numerator` / `_denominator` measure is missing or unread by its value | add the measure / fix the value's `sql` |
| `pdd-anchor` | `scope_note` cites no `PDD §N`, or only sections the PDD lacks | cite the section, or drop the indicator |
| `target` | a target the `scope_note` does not quote, a % target outside 0–100, a target without higher/lower | cite the PDD's number, or remove the target |
| `bands` | % bands written as fractions (`0.8`) — every cell grades green | write `80` |
| `headline` | duplicate position, or beyond `display.headline_count` | renumber |
| `display` | missing title / entity / worker / organisation nouns, an unlisted category, a bad `case_fields` format | fill from the PDD vocabulary |
| `llo-map` | a partner opportunity missing from `deployment.llo_map`, or fewer than 3 organisations | map every opportunity |

`warn` findings (bands without a target, an over-long `plain`, no `case_fields`)
are reported and do not fail the gate.

## Result

```yaml
skill: semantic-registry-author-qa
verdict: pass | fail
labs_validate: {valid: true, errors: []}
indicators: [SF_P1, SF_P3, ...]
findings: [{check, severity, indicator?, detail}]
```

## Change Log

| Date | Change |
|---|---|
| 2026-09-26 | Created (ace#2510). Positive control: the live-accepted Spark registry (`test/fixtures/cascade/spark-facilitator-registry.json`); one negative control per check in `test/lib/semantic-registry-authoring.test.ts`. |
