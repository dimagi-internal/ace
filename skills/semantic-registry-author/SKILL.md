---
name: semantic-registry-author
description: >
  Author the labs semantic registry from the PDD (entity, one indicator per PDD
  metric, the programme's nouns) that Phase 7's indicator cascade binds to.
disable-model-invocation: false
---

# Semantic Registry Author

Phase 7 shows a programme running well through the labs **indicator cascade**
(`indicator_programme_report` → companion `indicator_worker_review` → hand-down to
`indicator_opp_report`). Those three templates have no programme-specific page
code: every indicator, target, noun, category and case-table column comes from a
**semantic registry**. This skill writes that registry from the PDD, so the
cascade reads in the programme's own language and grades the programme's own
metrics.

The registry is data labs compiles to SQL on every load. Labs checks its grammar
(`semantic_registry_validate`); it cannot check that the registry is faithful to
the PDD. That is this skill's job, and `semantic-registry-author-qa` enforces it.

Worked example — accepted live as labs registry 6369, rendered as programme report
6371 (ace#2510, `spark-facilitator/20260926-1800`):
`docs/examples/cascade/spark-facilitator/registry.py` and the fixture it produced,
`test/fixtures/cascade/spark-facilitator-registry.json`. Read them before authoring.

## Terminology

Every human-readable string you write — `display.title`, labels, `plain`
sentences, `targets_note` — follows [`skills/_terminology.md`](../_terminology.md).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | the PDD (`phases.idea-to-design.products.pdd`, read with `writeToPath`) | archetype, the followed entity, § Success Metrics, § Evidence Model, payment rule, state vocabulary |
| Phase 3 | `3-commcare/pdd-to-deliver-app_summary.md` + the Nova app (`mcp__nova__get_form`) | the REAL form paths of the paid form — the registry reads what the app submits, nothing else |
| Caller | `partners: [{label, opportunity_id}]` | the synthetic partner opportunities → `deployment.llo_map` (supplied by `demo-data-setup` § C1, which creates them) |
| Caller | `program_id` | the labs-only program the record lives in |

## Products

- `7-synthetic/semantic-registry-author_registry.json` — `{properties_doc, indicators_doc, deployment}` exactly as sent to labs
- `7-synthetic/semantic-registry-author_summary.md` — the indicator table (below) + the not-computable list
- labs registry record (`semantic_registry_create`, home = the synthetic program)
- `run_state.phases.synthetic-data-and-workflows.products.synthetic.cascade.registry` — `{registry_id, program_id, version, indicators[]}`, written **the moment the create returns** (ace#2412), `update_yaml_file({merge: 'deep'})`

## Process

### 1. Decide the model (Layer 1 → Layer 2)

- **Entity = the archetype's followed thing.** `longitudinal-visits`: the entity
  the PDD's § Entity Lifecycle names (a community, a child, a household).
  `atomic-visit` / `multi-stage`: the beneficiary each visit is delivered to.
  `entity: {name, plural, key, cohort_date: first_visit}`.
- **`key` is a Layer-1 column naming the entity, NOT Connect's `entity_id`
  unless the two coincide.** Connect's `entity_id` is the DELIVER UNIT key the
  app computes — Spark's is `concat(case_id, step, capped_index, kind)`, one per
  payable slot, so keying on it would make every meeting its own "community".
  For a followup form the followed case is `form.case.@case_id`; name that
  pipeline field (e.g. `community_case_id`) and key on it.
- **`pipelines.entity`** = `visits` (the alias the programme report template
  creates). `demo-data-setup` § C3 writes that pipeline's fields; list here
  exactly the columns your rules read, with their form paths, in the summary so
  C3 can transcribe them. Use the path Nova reports (`get_form` → group ids
  become path segments: `form.<group>.<field>`; hidden calculates sit at
  `form.<field>`).
- **`visit_columns`** for per-visit booleans. Prefer `sql` with `COALESCE(..., FALSE)`.
  **Read coded selects numerically** — `COALESCE(CAST(x AS DECIMAL) = 1, FALSE)`,
  not `x = '1'`: the labs generator formats a numeric-looking code as `"1.0"`
  when the opportunity has no form schema (every labs-only opp), and the cast
  reads real `"1"` and synthetic `"1.0"` alike (observed ace#2510, the
  `currently_saving` column).
- **aggregates / properties**: sums and counts per entity, filtered to the PDD's
  verification predicate where the metric is "over verified visits".

### 2. Derive the indicators — every one anchored in the PDD

Enumerate, verbatim, the PDD's § Success Metrics rows, the payment/verification
predicate (§ Intervention Design / Evidence Model Layer A) and the data-quality /
review signals it names (Evidence Model Layer B strata, in-form review flags).
**This list is the only menu.** For each row decide:

| Outcome | When | What you write |
|---|---|---|
| **indicator** | computable from submitted visit data | a value measure `100.0 * {x_numerator} / NULLIF({x_denominator}, 0)` + both measures |
| **not computable** | needs data visits do not carry (payment ledger, supervisor call log, external survey) | a row in the summary's `## Not computable from visit data` with the reason — never a proxy dressed as the metric |

Per indicator `meta`:

| key | rule |
|---|---|
| `indicator` | `<SERIES>_<pdd-id>` (`SF_P1` for PDD P1); `series: [<SERIES>]` in the doc |
| `label` | ≤ 3 words, the programme's words |
| `plain` | ONE sentence a funder reads in a tooltip |
| `category` | from the PDD's own grouping (Delivery / Progression / Participation / Data quality…); every category listed in `display.categories` |
| `direction` | `higher` / `lower` / `none` as the PDD implies |
| `bands` + `target` | **only when the PDD states a target**, in the bands' units (`80`, not `0.8`), `target` = the PDD number, `bands[0]` = the target. No target in the PDD → no bands, no target (labs would print `bands[0]` as a goal nobody set) and say so in `display.targets_note` |
| `scope_note` | `PDD §<section> <metric id> — <the target quote, if any>` — the citation QA resolves against the PDD's headings |
| `headline` | positions 1..5 for the PDD's primary metrics first, then the review signal the story turns on |
| `flw_applicable`, `benchmarkable` | true for rates that mean something per worker / across partners |

`defaults.min_denominator`: the smallest entity count at which the figure means
something **at the worker level**. When the PDD assigns one entity per worker
(Spark: one community per CBF) that is `1` — anything higher blanks every worker
cell.

**No inferred backstory.** A metric, threshold, target or noun with no PDD anchor
does not go in. If a partner-org name is needed it comes from the caller's
`partners[]` (synthetic labels such as "Partner A") — never an invented real
organisation.

### 3. The display contract

`display: {title, entity, worker, organisation, categories, headline_count,
case_fields, reading, targets_note}` — nouns from the PDD (Spark: community /
facilitator / partner). `case_fields` name columns the case index carries
(`first_visit_date`, `last_visit_date`, `total_visits`, or any entity-pipeline
field); `reading` names a numeric per-visit column worth charting per case.
Title ends `(synthetic)` for Phase 7.

### 4. Validate, then create — in that order

1. `semantic_registry_validate({properties_doc, indicators_doc, deployment})` —
   must return `valid: true`.
2. Run `semantic-registry-author-qa`. On `fail`, fix and repeat.
3. `semantic_registry_create({name, description, properties_doc, indicators_doc,
   deployment, program_id: <synthetic program>, is_shared: false})`. Name:
   `<Programme> indicators (synthetic, ace <opp>/<run-id>)` so `/ace:sweep` can
   find it — **registries have no delete atom**; the id recorded in run_state is
   the only handle.
4. Write the products block immediately.

**Binding gotcha (observed ace#2510):** when the programme report is created in
the SAME labs-only program that owns the record, bind with
`registry_source: {registry_id}` and NO home-scope key. Adding
`program_id: <labs-only program>` sends the read to Connect's `labs_record`
export, which has no labs-only programs, and 404s.

### 5. Summary

`7-synthetic/semantic-registry-author_summary.md`:

```markdown
| id | label | numerator ÷ denominator | direction | target (PDD quote) | PDD § |
|---|---|---|---|---|---|
| SF_P1 | Meeting regularity | weeks with a verified meeting ÷ active weeks | higher | ≥ 80% ("Target ≥ 80%") | §8.1 P1 |

## Not computable from visit data
- P2 Payment integrity — needs Connect's payment ledger, not visit submissions.

## Layer 1 fields (for demo-data-setup § C3)
| column | form path | transform |
```

## After a registry edit

An edit reaches every bound report on its next load, but saved runs keep the
definitions they were graded with. After changing definitions, re-run
`workflow_rebuild_history` on the programme report (`demo-data-setup` § C5) so
the trend is restated under one definition.

## Change Log

| Date | Change |
|---|---|
| 2026-09-26 | Created (ace#2510). Proved on `spark-facilitator/20260926-1800`: registry 6369, 10 indicators from PDD §8.1/§8.2 and the §5.4/§5.6/§7.2 review flags; P2 and P4 recorded as not computable. |
