---
name: semantic-registry-author
description: >
  Internal /ace:run step — Author the labs semantic registry (entity, one indicator per PDD
  metric) from the PDD.
user-invocable: false
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
| Phase 3 | `3-commcare/pdd-to-deliver-app_summary.md` + the Nova app (`get_form` — `mcp__nova__get_form` via ACE's user-scope PAT entry, or `mcp__plugin_nova_nova__get_form` on the plugin's OAuth connection; accept either) | the REAL form paths of the paid form — the registry reads what the app submits, nothing else |
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
- **Read form dates as dates** — `MIN(CAST(enrolment_date AS DATE))`, not
  `MIN(enrolment_date)`. A pipeline field with no `transform` arrives as TEXT;
  only `visit_date` is a real date. `semantic_registry_validate` does not
  type-check, so `COALESCE(<text aggregate>, first_visit)` validates and then
  fails on the first live read with *"COALESCE types text and date cannot be
  matched"* (ace#2656, spark-facilitator/20261004-1706). `demo-data-setup` § C4
  step 3's preview is where it surfaces — run it before writing history.
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

**No PDD? Anchor on the released app, and use the programme's real partners.**
Not every opp run starts from a PDD. A programme ACE builds from a real Connect
opportunity (the chlorine demo, 2026-10-02) has a released Deliver app and no PDD.
In that case:
- **The app is the menu.** Each indicator's `scope_note` reads `Deliver app — <form
  name>, <field> <rule>`, and the rule is the app's own: its calculate or its
  threshold, e.g. `FCR Test, last_waterpoint_fcr_pass_fail: pass = result >= 0.2
  mg/L`. Run QA with `--app <get_opportunity_apps JSON>` instead of `--pdd`. It
  fails any anchor that names no released form.
- **Set no target.** An app defines pass rules, not programme targets.
- **Use the real partner count.** Pass `--partner-source programme`. Two partners
  is the programme's shape, not a thin story, so the floor is 2. Fewer than 3 is
  only a warning: the benchmark cohort then needs `min_peers` below 3, which shows
  each partner its peer's exact figures.

  Invented partners keep this check's floor of 3; the story plan that follows
  floors them at 5 (`demo-data-setup` § C0, ace#2727), because ACE can always
  make five and three was too few to show why sorting partners matters.

**No inferred backstory.** A metric, threshold, target or noun with no PDD anchor
does not go in. If a partner-org name is needed it comes from the caller's
`partners[]` — an invented, realistic organisation name with a trailing
`(example)` marker (`Tiyende Community Trust (example)`, `demo-data-setup` § C0),
never a placeholder like "Partner A" and never a real organisation's name.

### 3. The display contract

`display: {title, entity, worker, organisation, categories, headline_count,
case_fields, reading, targets_note}` — nouns from the PDD (Spark: community /
facilitator / partner). `case_fields` name columns the case index carries
(`first_visit_date`, `last_visit_date`, `total_visits`, or any entity-pipeline
field); `reading` names a numeric per-visit column worth charting per case.
Title ends `(synthetic)` for Phase 7.

**Reader-facing text is plain language for a programme manager.** The cascade
prints `display.title`, `targets_note`, the entity / worker / organisation nouns,
`categories`, `reading.label`, the `case_fields` and `visit_fields` labels, the
`visit_flags` labels **and descriptions**, and every indicator's `meta.label` and
`meta.plain` on screen, to someone who has never seen the PDD. So in those fields:
no design-document references (`PDD`, `§`, section numbers like `8.1`), no
internal indicator codes (`P1`, `S-1`, `SF_P1`), no comparison symbols standing in
for words (write "at least", not `≥`), and no column names (`enrolled_households`).
Say where a target comes from in words — "the pilot design". The citation still
belongs in the registry: `scope_note`, `means` and a measure's `description` are
author-facing and SHOULD cite the PDD (`pdd-anchor` reads `scope_note`).

| | `display.targets_note` (spark-facilitator/20261004-1706, registry 7748) |
|---|---|
| before | Targets are the PDD's own (§8.1 P1 ≥ 80%, P3 ≥ 75%). … |
| after | Targets come from the pilot design: a meeting in at least 80% of each community's weeks, and at least 75% of communities finishing Step 7 within 15 weeks. The design sets no target for participation or for the review flags, so none is shown. |

The "before" alone capped that run's DDD demo at clarity 2 after every build fix
(ace#2748). The same registry's `visit_flags[].description` read `(PDD §5.4)` and
`(PDD §7.2 S-1)` — the worker review prints those, so they fail too. *Enforced:*
`lib/registry-display-text.ts`, run by `semantic-registry-author-qa`
(`display-text`) and `demo-data-setup-qa` (check 28).

Two more keys turn ids into things a reader can use (connect-labs #2243, #2251):
- `entity.label_field: entity_name` — the case table and the worker review head a
  case by its name instead of its id. Set it whenever the data carries case
  names (Phase 7 always does: `demo-data-setup` § C3 supplies `entity_names`).
- `visit_flags: [{column, label, value?}]` / `visit_fields: [{field, label, format}]`
  — when an indicator counts flagged visits (a repeat-count rate, a location
  review rate), declare the per-visit flag column so the worker review marks
  WHICH visits, and the columns the flag compares so the reader sees why.

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

**A rebuild mints NEW run ids — relink, or the run's links die (ace#2700).**
Labs builds each period's replacement run before deleting the old one, so every
period of the programme report AND every opp report's hand-down gets a fresh
id; the old id then renders "not found". Before the rebuild, record
`workflow_history_runs({…, generated_only: false})` for the programme report and
each opp report as `[{workflowId, runs: [{run_id, period_end}]}]`; after it,
record the same again. Then build the old→new map from those two listings —
never from id arithmetic — with `scripts/relink-rebuilt-history.ts` (`lib/history-relink.ts`):

```bash
node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/relink-rebuilt-history.ts" \
  --before before.json --after after.json --map-out map.json [--in FILE --out FILE [--bare]]
```

and rewrite every place the run names an old id: `realized.json`,
`run_state.yaml` `products.synthetic.cascade` (`programme_report`,
`opp_reports[]` — arrays are replaced whole — `history.run_ids`) and
`products.synthetic.workflows.*.run_url` (`update_yaml_file`, `merge: deep`),
the Phase 7 summaries, `why_brief.yaml` and the narrative spec (Docs:
`replaceAllText`), in every workspace the run was cloned into. `--in` exits 1
while any old id is left. Then re-publish the benchmark (next paragraph — it reuses
the same before/after listings, and must name the NEW run ids) and re-capture the
dashboard previews (`output-preview-capture`): the frames on file show the old
definitions. Worked example:
spark-facilitator/20261004-1706, 2026-10-05 (7198..7254 → 7261..7317,
hand-downs 7256/7257/7258 → 7319/7320/7321).

**After the relink, re-publish the benchmark — REQUIRED, or every Benchmarks tab stays on the
old registry (ace#2717).** A rebuild publishes nothing, and an opp report's
Benchmarks tab shows the most recently PUBLISHED as-of, not the latest period
(`demo-data-setup` § C5). Measured on spark-facilitator/20261004-1706 (registry
7185 v3): partner C's Benchmarks tab read "as of 9 Aug" with the 3–9 Aug figures
while the Report tab beside it was as of 4 Oct. So, after the rebuild is `done`:

1. Read the programme report's `workflow_history_runs({definition_id, program_id,
   generated_only: false})` before AND after the rebuild, as
   `[{run_id, period_end}]` (the relink step above already recorded both).
2. Plan the publishes with `lib/benchmark-republish.ts` `planBenchmarkRepublish`
   (CLI: `scripts/plan-benchmark-republish.ts --cohort <id> --workflow <prog
   report> --program <id> --before before.json --after after.json`). It orders
   every rebuilt run OLDEST FIRST and **refuses** — exit 1, nothing to publish —
   if a period from before has no run after, two runs share a period, or a week
   is missing from the series. A refusal means finish the rebuild (re-call with
   `start=<next_start>`), never publish a partial series.
3. Make each planned call in order: `benchmarks_publish({cohort_id, workflow_id,
   run_id, program_id})`. Order matters — the last publish is what the tab shows.
4. Verify: open an opp report's Benchmarks tab; its "as of" must equal the plan's
   `expectedAsOf` (the latest week). A tab still on an earlier date means a
   publish is missing or ran out of order — do not report the step done.

**`benchmarks_publish` is a shared write the operator's permission classifier may
refuse.** If it is refused, stop and surface it to the operator (the cohort, the
ordered run ids, and that the Benchmarks tab is stale until they land) — never work
around the refusal by another route, and never record the step as done.

## Change Log

| Date | Change |
|---|---|
| 2026-10-06 | § 3: reader-facing registry text is plain language for a programme manager (no PDD/§/section numbers, indicator codes, `≥`/`≤`, or column names); the Spark `targets_note` before/after. Enforced by `lib/registry-display-text.ts` in both QA gates (ace#2748). The worked example's `targets_note` is rewritten to match. | ACE team |
| 2026-10-05 | § After a registry edit: re-publish the benchmark per rebuilt run, oldest first, planned by `lib/benchmark-republish.ts`; verify the Benchmarks tab's as-of is the latest week; a classifier refusal is surfaced, never worked around (ace#2717). | ACE team |
| 2026-10-05 | § After a registry edit: a rebuild mints new run ids; relink every artifact from before/after `workflow_history_runs` listings via `scripts/relink-rebuilt-history.ts` (ace#2700). Proved on spark-facilitator/20261004-1706 (registry 7185 v3). | ACE team |
| 2026-09-28 | The Nova `get_form` read accepts either tool namespace: since nova plugin v2 (voidcraft-labs/commcare-nova#693, voidcraft-labs/nova-plugin#64) ACE's PAT connection is the user-scope entry (`mcp__nova__*`), the plugin's own namespace is OAuth. | ACE team |
| 2026-09-26 | Created (ace#2510). Proved on `spark-facilitator/20260926-1800`: registry 6369, 10 indicators from PDD §8.1/§8.2 and the §5.4/§5.6/§7.2 review flags; P2 and P4 recorded as not computable. |
