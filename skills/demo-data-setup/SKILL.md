---
name: demo-data-setup
description: >
  Stand up the initial dataset + live labs dashboard for a standalone demo,
  parameterized on data source. Returns the realized ${var} map (par_url) that
  a DDD narrative's setup block consumes. Plan A implements the `denovo`
  provider; `clone` and `ace-run` are documented but land in Plan B / Phase 7
  convergence.
disable-model-invocation: false
---

# Demo Data Setup

The **data + dashboard** half of the ACE demo workflow. Given a short demo
brief, it generates synthetic data and authors a live labs dashboard
dynamically (no production traffic, no ACE-built Connect opp required), then
hands the downstream `demo-narrative` skill a single artifact: the **realized
`${var}` map** — a flat JSON containing `par_url` (the polished dashboard
deep-link) plus any drill URLs.

This skill is the standalone/`denovo` sibling of the Phase 7 pair
`synthetic-data-generate` (data) + `synthetic-workflow-seed` (dashboard). It
composes the same connect-labs atom sequence those skills use, but decoupled
from `opp.yaml` / the PDD / a Phase 4 Connect opportunity — that decoupling is
the whole point of the demo entry point. For the detailed atom mechanics and
labs-side gotchas it does not repeat inline, it cites those two skills by
section.

## Providers (the data-source seam)

| provider | source | status |
|---|---|---|
| `denovo` | a short demo brief (this skill) | **implemented (Plan A)** |
| `clone` | a real Connect opportunity id | **implemented (Plan B)** — `synthetic_profile_from_prod`(mirror) → `synthetic_generate_from_manifest` → the SAME dashboard-authoring spine as denovo, + a fidelity gate |
| `ace-run` | the Phase 4 opp of a full `/ace:run` | Phase 7 convergence (Plan C) — Phase 7 becomes this provider |

All three converge on the **same handoff**: the realized `${var}` map. Only the
front half (how the labs-only opp + its data come to exist) differs.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Operator (CLI) | `--brief <text or drive-path>` | the demo story: program, KPI focus, named FLWs, the anomaly to surface, the coaching beat |
| Operator (CLI) | `--name <demo-name>` | the demo folder `ACE/<demo-name>/` |
| Procedure | demo `run_id` | the current demo run folder (scaffolded by `agents/demo.md` via `buildDemoRunState`) |
| Operator (CLI, optional) | `--pin-monday <YYYY-MM-DD>` | fixed timeline anchor; if omitted, compute a recent Monday and **record it** — never a sliding window (see Gotchas) |

## Products

- `<demo-run>/7-synthetic/demo-data-setup_manifest.yaml` — the per-opp generator manifest sent to labs
- `<demo-run>/7-synthetic/realized.json` — **the handoff**: a **FLAT** `${var}` map (DDD substitutes `${var}` verbatim — keep it flat, no nesting). One `<key>_par_url` per dashboard the demo builds, plus `primary_par_url` (the dashboard the walkthrough opens on) and any `<name>_url` drills. E.g. `{ "primary_par_url": ..., "program_admin_par_url": ..., "child_recovery_par_url": ..., "audit_good_url": ... }`
- `<demo-run>/7-synthetic/demo-data-setup.md` — run summary (labs opp id, record counts, one par_url per dashboard, warnings)
- `<demo-run>/7-synthetic/branch-scrub_report.yaml` — the step-2c ledger, so
  the numbers survive the run rather than living in a claim (ace#1658):
  ```yaml
  derivation:
    source: deliver-app            # or `none` (+ `reason:` — the denovo provider)
    opportunity_id: <connect opp id>
    questions_seen: <int>
    gates_parsed: <int>
    unparsed:                      # gates/bounds NOT audited — never silently dropped
      - kind: relevant             # relevant | constraint
        field: <leaf name>
        path: /data/<group>/<question>
        expression: "<verbatim>"
        reason: "<why it could not be derived>"
    additions:                     # hand-declared, merged via mergeDatasetSpecs
      whole_currency_fields: []
      cross_field_rules: []
      unique_pairs: []
  scrub:
    applied: true                  # false = report only; say why in `note`
    write_back: drive_update_file  # drive_update_file | synthetic_register | none
    records: <int>
    total_cleared: <int>
    fields:
      - field: <leaf name>
        records_scrubbed: <int>
        records_gate_missing: <int>
    unresolved_fields: []
  audit:                           # auditDataset AFTER the scrub
    total: <int>
    violations: [{kind, field, count}]
  ```
- `run_state.yaml.phases.synthetic-data-and-workflows.products.synthetic.source` — the seam contract, populated:
  ```yaml
  source:
    provider: denovo
    labs_synthetic_opp_id: <int ≥ 10000>
    deliver_units: [{slug, name}]
    narrative_context_ref: <drive path to the manifest>
    record_counts:                     # VERBATIM from synthetic_generate_from_manifest (ace#1670)
      opportunity: 1
      user_visits: 276
      user_data: 5                     # the worker cohort — the row count a filter scene acts on
      completed_works: 0
      completed_module: 0
    data_shape:                        # the three axes demo-narrative's cardinality check reads
      rows: 5                          # entities the dashboards enumerate one line per
      periods: 4                       # distinct time buckets the timeline spans (manifest weeks)
      groups: 1                        # distinct comparison groups (LLOs / sites / opportunities)
    dashboards:                        # one per dashboard the Step-0 plan selected
      - key: program_admin             # → ${program_admin_par_url} in realized.json
        template: program_admin_report
        role: overview
        shape: run                     # saved run_id (env-ensure / workflow_save_snapshot)
        par_url: <url>
      - key: child_recovery
        template: sam_followup
        role: recovery
        shape: action                  # no saved run → mint run_id via workflow_create_run; SAME /run/?run_id= URL
        par_url: <url>
      - key: llo_review
        template: llo_weekly_review
        role: review-action            # INTERACTIVE — its run stays in_progress (see step 3)
        shape: action
        interactive: true              # set iff role is review-action / review / decision
        par_url: <url>
    primary_dashboard: program_admin
    realized_vars_ref: 7-synthetic/realized.json
    dataset_constraints:               # step 2c, counts not claims (ace#1658)
      spec_source: deliver-app         # deliver-app | none
      unparsed_expressions: <int>      # >0 means gates this run did not audit
      off_branch_cleared: <int>        # branch scrub, 0 is a MEASURED zero
      scrub_applied: true
      violations: <int>
      report_ref: 7-synthetic/branch-scrub_report.yaml
  ```
- `run_state.yaml.phases.synthetic-data-and-workflows.steps.demo-data-setup.status: done` (+ `artifact` path)

## Process (denovo)

0. **Plan the demo from the ask (interpret + select templates).** Turn the raw
   brief/ask (which may be a forwarded email) into a concrete plan BEFORE
   generating anything:
   - **Enumerate the dashboards the ask needs.** A narrative like "program
     management across LLOs AND individual children getting better" is **two**
     dashboards, not one. Give each a `key` (e.g. `program_admin`,
     `child_recovery`) and a `role`. **At most one dashboard may take an
     INTERACTIVE role** (`review-action`, `review`, `decision`) — the one whose
     scene shows a stakeholder *taking* a decision rather than reading a
     figure. That role decides step 3's run handling, so choose it in the plan,
     not at render time.
   - **Select a checked-in template per dashboard — reuse over scratch.** Survey
     the palette with `mcp__connect-labs__list_templates` plus the labs
     `connect_labs/workflow/templates/` library, and map each dashboard to the
     best fit. Known fits (MUAC-only nutrition):
     - multi-LLO / FLW oversight → `program_admin_report` (+ `chc_nutrition_analysis` for the FLW aggregate).
     - per-child recovery over follow-up visits → `sam_followup` (MUAC + recovery-status timeline). **Not** `kmc_longitudinal` — it keys on weight, unusable when CHWs have no scales.
     Only `workflow_create` from SCRATCH when nothing in the palette fits, and say
     so explicitly in the summary.
   - **Record each dashboard's `shape` from `list_templates.supports_saved_runs`.**
     BOTH shapes render at `/labs/workflow/<def>/run/?run_id=<id>&opportunity_id=<opp>`
     (verified live 2026-07-21). Shape only decides where `run_id` comes from:
     **run-shaped** (`true`, e.g. `program_admin_report`, `chc_nutrition_analysis`)
     reuses a saved run_id; **action-shaped** (`false`, e.g. `sam_followup`,
     `kmc_longitudinal`) has no saved run, so step 3 **mints** one with
     `mcp__connect-labs__workflow_create_run`. This decides step 4's URL build.
   - **Derive the data story per dashboard** — personas, the anomaly/recovery
     arcs (MUAC recovery = children moving red[SAM]→yellow[MAM]→green across
     follow-up weeks), timeline. This becomes the manifest (step 1) and the
     narrative context `demo-narrative` reads.
   Record the plan (`dashboards[]` with key/template/role) — it drives steps 1–5
   and the `source.dashboards` write-back.

1. **Author the per-opp generator manifest from the brief.**

   Write `demo-data-setup_manifest.yaml`. Structure + field rules are identical
   to the Phase 7 manifest — follow `skills/synthetic-data-generate/SKILL.md
   § Process` (manifest schema) and its manifest-schema gotchas rather than
   re-deriving them. Demo-specific requirements:
   - `opportunity_id`: a labs-only id **≥ 10000** (see Gotchas).
   - `flw_personas`: first persona is the **network manager** (`flag_rate: 0`);
     the rest carry `accuracy_distribution` reflecting the brief's quality
     spread.
   - `anomalies`: **0-based** `week` indices; only anomalies with
     `reviewer_visible_in: [audit]` mint audits. Put the brief's headline
     anomaly on a completed week.
   - `coaching_arcs`: **1-based** `week_triggered`; transcripts are authored
     verbatim from the brief's coaching beat.
   - `timeline.start_date`: the pinned Monday (from `--pin-monday` or computed);
     it MUST equal the env timeline anchor.

2. **Generate the synthetic data — pick the mode per dashboard `shape`/kind.**

   There are TWO generation paths; a demo may use both:
   - **realize-env** (composite multi-opp rollups — `program_admin_report`,
     `audit_par`, and their `chc_nutrition_analysis` weeklies): the data is
     produced by the ensurer chain (weekly_runs→run_audits→rollup), which only
     runs via `mcp__connect-labs__synthetic_env_ensure env=<name>`. Reuse the
     checked-in `program-admin-report` env (already synthetic MUAC nutrition,
     opps 10000/10001) or a new committed env. The realized `${var}` map it
     returns (`par_url`, `wk4_url`, `*_good_url`, `*_incomplete_url`) IS the
     handoff for those dashboards. **`generate_from_manifest` alone does NOT
     populate a rollup** (dry-run finding 2026-07-20).
     **Program ownership:** the env's `kind: rollup` resource MUST set a
     `program_id` (labs-only, ≥ 10000) so the cross-opp rollup is **program-owned**
     — its realized `par_url` then comes back scoped with `&program_id` (the only
     scope that renders a cross-opp rollup; `&opportunity_id` 404s it). See
     connect-labs #946. Omitting `program_id` gives the legacy opp-owned rollup
     that 404s from any other opp context.
   - **from-manifest** (FLW-level or per-child dashboards — `sam_followup`,
     `llo_weekly_review`): `mcp__connect-labs__synthetic_create_labs_only` then
     `mcp__connect-labs__synthetic_generate_from_manifest` with a manifest whose
     `beneficiary_cohorts` (with `progression: improvement_curve` for recovery
     arcs) + `field_distributions` (keyed by the template's exact form paths)
     produce the records the template reads. Mechanics + payment-unit pre-flight:
     `skills/synthetic-data-generate/SKILL.md § Process` steps 1a–3.

   Capture `labs_opp_id` + `deliver_units`.

2b. **Capture the realized dataset's SHAPE, not just its URLs (ace#1670).**

   Keep `synthetic_generate_from_manifest`'s `record_counts` VERBATIM — it is the
   only place the generated cardinality is ever stated, and it is discarded today.
   Then resolve the two axes `record_counts` cannot answer, from the manifest you
   authored in step 1:

   - `periods` — the number of distinct time buckets `timeline` spans (weeks
     between `start_date` and the last generated week). `record_counts` carries no
     dates.
   - `groups` — the number of distinct groups a comparison could contrast (LLOs /
     sites / opportunities in the set). `record_counts` carries no grouping.
   - `rows` — defaults to `record_counts.user_data` (the worker cohort). Override
     it if the dashboards you planned in step 0 enumerate a different population
     (a visit-level table has `user_visits` rows, not `user_data` rows) — you are
     the only one who knows which, and `demo-narrative` cannot re-derive it.

   Write all of it into `source.record_counts` + `source.data_shape` (step 5).
   Without it `demo-narrative` has no cardinality input at all and cannot tell a
   filter over 5 rows from one over 500 — which is how
   `bednet-check-2-visit/20260825-1310` authored a filter demonstration against a
   five-worker cohort and burned four render iterations before the concept judge
   caught it.

2c. **Derive the constraint spec from the APP, scrub the off-branch values,
    then audit — in that order (ace#1346, ace#1658).**

    The generated set is the substrate every dashboard reads, so it is checked
    and repaired here — **before** step 3 mints a single run, not after step 4
    has built the URLs. (This step used to run as `4b`, after the dashboards
    were already reading the fixture; it moved so the scrub can land first.)

    1. **Derive the spec from the deliver app, don't assert it from prose.**
       `mcp__connect-labs__get_opportunity_apps(<connect opp id>, 'deliver')`
       → `specFromDeliverApp(appJson)` in `lib/dataset-constraints.ts`. It
       reads every question's own `relevant` — plus any group-level `relevant`
       above it — into `conditionalFields`, and every `Int`/`Long` question's
       `constraint` into `integerFields` bounds.

       **Never hand-declare `conditionalFields: []` off the PDD's prose.**
       `bednet-check-2-visit/20260817-1720` did exactly that and recorded
       check 9 `pass` on the justification "no conditional blocks", while
       `get_opportunity_apps(2214, 'deliver')` returned
       `"relevant": "/data/agree_again/consent_confirmed = 'yes'"` on two
       fields verbatim. `20260825-1310` — same opp, same app, same generator —
       declared them and measured **18 of 276** off-branch on each. The spec
       decided the verdict, not the data (ace#1658).

       - Hand-declared entries are **ADDITIONS**:
         `mergeDatasetSpecs(derived.spec, additions)`. Currency fields,
         cross-field rules, and PDD premises (`uniquePairs`, e.g. "1 CBF per
         community") have no representation in the app JSON, so they still
         come from the PDD — as additions on top of the derived spec, never as
         a replacement for it.
       - `derived.unparsed[]` is a RESULT, not debris. Each entry is a gate or
         bound this run did **not** audit; hand-declare it as an addition, and
         report what remains. `demo-data-setup-qa` check 9 fails on a
         non-empty `unparsed[]` rather than passing quietly.
       - Under the **`denovo`** provider there is no deliver app to read.
         Record the reason verbatim (`noDeliverAppReason`) so the gate can
         tell "nothing to derive from" apart from "nobody derived it".

    2. **Scrub the off-branch values, then write the fixture back.**
       `scrubOffBranchFields(records, spec.conditionalFields)` removes every
       value the form's own `relevant` says cannot exist on that record's
       branch, and returns a per-field report. It is idempotent and pure.

       This is a declared, reproducible generator post-step — not hand-patching
       records — and on this path it is the only remedy that works.

       **The manifest DOES carry a relevance primitive; it is inert here.**
       `BeneficiaryCohort.relevance_groups: dict[str, RelevanceRule]`
       (`connect_labs/labs/synthetic/generator/fixtures/manifest.py:300`) shipped
       in `dimagi-internal/connect-labs#1331`, merged 2026-08-27. Declare it —
       but do not expect it to do anything on a labs-only opp, and never let it
       stand in for the scrub. Relevance is applied only to questions present in
       the HQ `FormSchema`: the schema loop consults the gate per question
       (`fixtures/fields.py:417-422`), but the trailing orphan-write loop is
       gated by a set computed **once, before it runs** (`fields.py:484`), out of
       the record built so far. A labs-only opportunity has no Connect
       `app_structure`, so `parse_form_schema_from_app_json` returns
       `FormSchema(questions=[])`, every declared path is orphan-written, and the
       controller is not in the record when line 484 evaluates the gate — it can
       never fire. Measured on `bednet-check-2-visit/20260828-0629` (labs opp
       10052): `relevance_groups` was declared and the generator still emitted
       **36** off-branch values, which the scrub then cleared (ace#1833).
       `FieldDistribution.null_rate` is unconditional and `CorrelationSpec` can
       make two fields co-vary but cannot make one ABSENT on a branch, so neither
       substitutes either. On a schema-backed opp (`clone`, or an `ace-run` opp
       whose deliver app resolves) `relevance_groups` does work — declare it
       there, and still scrub (ace#1658).

       Write the scrubbed `user_visits.json` back to the opp's fixture folder
       (the `folder_id` `synthetic_generate_from_manifest` returned) with
       `mcp__plugin_ace_ace-gdrive__drive_update_file`, **before step 3**. That
       file IS what labs serves: `connect_labs/labs/synthetic/fixture_store.py`
       loads `user_visits.json` from the registered Drive folder on every
       labs-only opp read and caches it per `(opp_id, folder_id, endpoint_key)`
       on FIRST read.

       **Then DROP that cache — the write-back is invisible until you do
       (ace#1860).** There is no safe window to write inside: the
       `synthetic_generate_from_manifest` call PRIMES the fixture cache as part
       of generating, so it is already populated when the atom returns, and an
       in-place edit changes a file nobody re-reads. One call fixes it:

       ```
       mcp__connect-labs__synthetic_reload_fixtures(opportunity_id: <labs_opp_id>)
       ```

       It drops the fixture store across every worker process plus the raw and
       computed analysis rows a pipeline reads, and it REPORTS what it dropped —
       `{invalidated: {registry, fixture_store, sql_cache: {raw, computed_visit,
       computed_flw, computed_entity}}, visit_count}` — so "the scrub landed" is
       observed rather than assumed. Re-run `pipeline_preview` after it and
       confirm the numbers match the scrubbed fixture.

       Skipping it fails SILENTLY and green: on
       `spark-facilitator/20260828-0703` the first `pipeline_preview` after a
       correctly-written scrub still returned `records: 0` (a field the scrub
       adds), `avg_attendance: null`, and `community_meetings` counting the
       not-held records — the exact off-branch value the scrub had already
       removed on Drive. Nothing errored, and no gate could see it: check 9
       audits the producer's LOCAL scrubbed copy, and checks 7 and 11 pass
       because both dashboards read the same stale cache and therefore agree
       with each other.

       - **If ACE's service account cannot write that folder** — the grant in
         `skills/synthetic-data-generate/SKILL.md` step 3a asks for *Reader* —
         copy the five fixture JSONs into an ACE-owned folder, apply the scrub
         there, share it with the labs fixture service account, and re-point
         the opp with `mcp__connect-labs__synthetic_register(opportunity_id,
         gdrive_folder_id)`. The cache key includes `folder_id`, so a folder
         change misses in every worker and re-pulls. This is the heavier path,
         and it is for a PERMISSIONS failure only — when ACE can write the
         folder, `synthetic_reload_fixtures` above is the one-call remedy.
       - **If neither write lands this run**, still run the scrub in memory,
         write the report with `applied: false`, and carry the counts into the
         summary and `run_state`. What is forbidden is narrowing the spec until
         the count disappears.

    3. **Audit what now stands, and report COUNTS not claims.**
       `auditDataset(records, spec)` over the records as they now are. Put the
       per-class counts in the summary. The labs manifest is a **distribution
       language**: it draws every field independently, and integers are
       enforced only where the HQ form schema types the question `Int` — so a
       legal-looking set can be arithmetically impossible.
       `spark-facilitator/20260813-2126` wrote *"0 constraint violations, all
       hand-checked"* into `run_state.yaml` for a set with 251 fractional
       people-counts, 242 fractional Kwacha amounts, 34 off-branch reasons, 22
       did-not-happen meetings carrying full attendance blocks, and
       facilitators roaming 190 distinct (facilitator, community) pairs against
       a stated 1 CBF per community. A measured zero and an asserted zero read
       the same in `run_state.yaml`; only one of them is true (ace#1346).

    Products: `7-synthetic/branch-scrub_report.yaml` (the derivation +
    scrub + audit ledger, schema in § Products) and the
    `source.dataset_constraints` block written in step 5.

3. **Author each planned dashboard dynamically.** Loop over the Step-0
   `dashboards[]`; for **each**, run the ADAPT-or-SCRATCH flow from
   `skills/synthetic-workflow-seed/SKILL.md § Process`:
   `mcp__connect-labs__workflow_create_from_template` (ADAPT — the default; pass
   the dashboard's selected template) *or* `mcp__connect-labs__workflow_create`
   (SCRATCH — only when nothing fit) →
   `mcp__connect-labs__pipeline_update_schema` →
   `mcp__connect-labs__workflow_update_render_code` /
   `mcp__connect-labs__workflow_patch_render_code` →
   `mcp__connect-labs__workflow_create_run` →
   `mcp__connect-labs__workflow_save_snapshot` — **except for the INTERACTIVE
   dashboard, where you STOP after `workflow_create_run` and never call
   `workflow_save_snapshot`** (see § The interactive run stays live). Reuse that skill's
   alias-consistency, period-scoping, and snapshot-hook guidance by reference —
   they are the difference between a populated dashboard and a blank one. Capture
   each dashboard's `<def_id>` + saved `<run_id>`.

   **`period_end` is an EXCLUSIVE bound — pass `timeline.end_date + 1 day`, never
   `timeline.end_date` itself (ace#1683).**

   A run's window is half-open. `_date_window_where` in
   `connect_labs/labs/analysis/backends/sql/query_builder.py` emits
   `visit_date >= '{date_from}' AND visit_date < '{date_to}'`, and its own
   docstring says why: *"The window is half-open — `>= date_from AND < date_to` —
   so back-to-back periods (week N ending == week N+1 starting) do not
   double-count the boundary day."* Correct for consecutive weekly slices, and a
   trap for a whole-timeline window: the natural authoring move is to pass the
   manifest's own `timeline.start_date` / `timeline.end_date`, and a fixture whose
   last `visit_date` IS `timeline.end_date` then loses its entire final day.

   So, when minting a run that a `workflow_save_snapshot` will freeze:

   ```
   period_start = <manifest timeline.start_date>          # inclusive, as authored
   period_end   = <manifest timeline.end_date + 1 day>    # EXCLUSIVE — add the day
   ```

   The manifest already carries `timeline.end_date`, so this is derived, not
   guessed. State the derivation (`period_end = end_date + 1d`) in the run summary
   so the next reader does not "correct" it back.

   Two things that make this silent rather than self-announcing:

   - **The scoping only bites on the SNAPSHOT path.** `period_scoped` is consulted
     in `WorkflowDataAccess.get_snapshot_pipeline_data`
     (`connect_labs/workflow/data_access.py`, *"re-aggregated to that half-open
     `[period_start, period_end)` visit-date window"*), so an `in_progress` run
     reads the all-time cache and shows the full fixture. A snapshotted dashboard
     and its live sibling over one dataset therefore disagree while both report
     `status: completed`/`in_progress` cleanly and both render. Measured on
     `hh-poverty-targeting/20260824-1404` (labs opp 10047), from each page's own
     `#workflow-data`: run 5245 snapshot (`period_end 2026-08-30`) `total=2186
     completed=1563 non_payable=623`; run 5249 live `total=2237 completed=1592`;
     the Drive fixture `total=2237 completed=1592 non_payable=645`; re-minted as
     run 5250 with `period_end 2026-08-31` → `2237 / 1592 / 645`, exact match.
     Same definition, same pipeline, same fixture — only `period_end` moved.
   - **Omitting the period is NOT "no window", it is an EMPTY one.**
     `connect_labs/mcp/tools/workflow_create_run.py` does
     `period_start = period_start or today` / `period_end = period_end or today`,
     so an unqualified `workflow_create_run(definition_id, opportunity_id)` mints
     `[today, today)` — zero-width. Harmless while the run is live (no scoping),
     and zero rows the moment a `period_scoped` pipeline is snapshotted. Always
     pass both bounds explicitly for a run you intend to snapshot.

   `demo-data-setup-qa` check 11 (`cross_dashboard_totals_agree`) is the
   backstop — it compares the shared visit total across every dashboard on one
   `labs_opp_id`, which is the only signal that surfaced this without an LLM judge.

   **Nutrition note:** `program_admin_report` / `chc_nutrition_analysis` /
   `sam_followup` are checked-in templates — ADAPT via
   `workflow_create_from_template`, never build render_code from scratch.

   **ADAPT means RE-POINT — a template-instantiated pipeline is not wired
   until you change its schema (ace#1160).** Run
   `checkDashboardBindings` from `lib/dashboard-bindings.ts` over each
   authored workflow before minting its run. Three things it decides, all
   from the definition alone:

   - **`stock-template-path`** — the pipeline still extracts `form.meta.*`.
     The synthetic generator writes the run's REAL Deliver-app form paths
     (`form.visit_summary.*`, `form.ppi_indicators.*`) and NEVER
     `form.meta.instanceID` / `timeEnd` / `appVersion`, so every stock field
     resolves null or zero. Re-point the schema at the same paths the
     scorecard pipeline already resolves.
   - **`snapshot-missing-alias`** — `snapshot_inputs.pipelines` must cover
     every alias in `pipeline_sources`, or a completed run snapshots no rows
     for it.
   - **`pipeline-declared-but-unread` / `unbackfilled-counter`** — the render
     must actually read the pipeline. Binding a denormalized
     `worker.visit_count` instead reads **0**, because the generator writes
     UserVisit fixtures without back-filling that counter.

   Live: `hh-poverty-targeting/20260730-2210` workflow 5069 hit all three at
   once. Every worker row showed **`VISITS 0`** beside a chip reading
   **`visits: 835`**, while the sibling scorecard (5065, correctly authored)
   credited the same 8 people with 31–125 visits. **The data was fine** —
   `total_visits` in the same pipeline summed to exactly 835. Three truthful
   reads of three different stores; the bindings were wrong. Downstream the
   DDD render+judge scored concept 2.0/5, user 1.0/5, arc 1.0/5.

3b. **Lint every `render_code` against the deployed stylesheet BEFORE you
   upload it (ace#1662). A non-resolving Tailwind utility is a pre-upload
   FAILURE, not a silent no-op.**

   labs purges its Tailwind bundle against its OWN Django templates. A
   workflow's `render_code` lives in the labs DATABASE and is never scanned,
   so any utility labs does not itself use is dropped from the shipped
   bundle — and then degrades to the unstyled baseline rather than erroring:
   a missing `bg-*` is transparent, a missing `text-*` is the inherited
   near-black, a missing `border-*` is the default grey, a missing `h-*`
   collapses the element to 0px. Nothing in the render, the page console, or
   `demo-data-setup-qa` observes it — that gate checks the dashboard is a
   live deep-link and paints content, not that it painted in the colours the
   code asked for.

   Run the check on the FULL post-edit source, before every
   `workflow_update_render_code` / `workflow_patch_render_code`:

   ```bash
   ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
   npx --prefix "$ACE_ROOT" tsx "$ACE_ROOT/scripts/check-render-code-utilities.ts" <render-code-path> --substitute
   # exit 0 = every utility resolves · exit 1 = MISSING, do NOT upload
   # exit 2 = could not read the stylesheet — fix that first; do NOT proceed
   ```

   - **Lint the whole source, never just the patch hunk.** On
     `bednet-check-2-visit/20260825-1310`, three of the five misses on
     workflow 5230 were PRE-EXISTING — not introduced by the edit that found
     them. For a patch: `workflow_get` → apply locally → lint → upload.
   - **On MISSING, substitute.** `--substitute` names the resolving
     near-neighbours. The repair that shipped: `text-rose-700` →
     `text-red-700`, `text-rose-800` → `text-red-800`, `border-rose-300` →
     `border-red-300`, `bg-emerald-600` → `bg-emerald-500`,
     `border-slate-300` → `border-gray-300` (card) / `border-slate-200`
     (panels). `text-rose-700` styled `consent 89.7% · below the 90% floor`
     — the only pay-affecting figure on that dashboard.
   - **A geometric or arbitrary-value miss has no near-neighbour** — a
     different value is a different design. Drop the class and set the
     property inline: `className="relative h-28 w-full"` →
     `className="relative w-full" style={{ height: 112 }}`; `min-w-[52px]` →
     `style={{ minWidth: 52 }}`. The missing `h-28` on workflow 5227 left all
     12 weekly bars at **0px** — a whole invisible chart panel, no error.
   - **The purge is per-UTILITY, not per-family, and nothing mirrors.**
     `text-slate-700` ships while `bg-slate-400` and `border-slate-400` do
     not. Arbitrary values are not categorically blocked either
     (`text-[11px]` ships, `min-w-[52px]` does not). The rule is the exact
     string — never reason from a resolving sibling.
   - **Leave every PRESENT utility alone.** Swapping a working class for
     another working class is unforced churn.

   Root cause tracked upstream as connect-labs#1294 (reject a non-resolving
   utility at labs' `render_code` write boundary). This gate earns its keep
   regardless: the available set drifts whenever labs changes its own UI.

3c. **Check every authored string — dashboard copy AND the narrative
   artifacts — against the why-brief's declared gaps (ace#1750, ace#1759).** A
   `why_brief.yaml` declares typed `gaps[]` — what the build cannot support.
   `demo-narrative` gates the NARRATIVE against them and nothing gated the
   dashboard's own on-screen prose, so a demo can render a page asserting
   exactly what its gap list says is unsupported. The brief and the spec can
   do it too: on the same run the brief's own `decisions-are-recorded` spine
   item asserted the disposition is recorded *"with its reason"* while the gap
   two screens down declared there is no durable register and no reason field.

   Run `checkGapCopy(gaps, sources)` from `lib/gap-copy-check.ts` before
   uploading anything, where `sources` is:
   - `{name, code}` per dashboard — the `render_code` as it will be uploaded.
     Prose is extracted from the JSX.
   - `...narrativeSources(whyBrief, unifiedSpec)` — the already-prose fields,
     each labelled by where it came from
     (`why_brief:spine[decisions-are-recorded].claim`,
     `unified_spec:scenes[<id>].concept_claim`). It reads
     `why_brief.spine[].{claim, rationale}` and
     `unified_spec.scenes[].{concept_claim, show, narrative}`. **`gaps[]` is
     deliberately not a source** — it is the one section whose job is to discuss
     unsupported things, and a `proposed_action` routinely names another gap's
     subject while proposing the fix, so scanning it makes the honest gap list
     the report's own worst source of findings (ace#1762).

   It derives each **CAPABILITY** gap's subject terms (the words the author used
   in BOTH the gap `id` and its `detail`, minus generic product vocabulary) and
   reports every prose line that repeats one. **RESEARCH and DECISION gaps do not
   constrain what a surface may name** — they forbid a *qualified* claim, not the
   subject: RESEARCH ("we don't know the real rate") forbids a quantified claim,
   DECISION ("the threshold values are unchosen") forbids asserting a value.
   Telling "named it" from "asserted the qualified thing" is a judgement no
   keyword match should make, and on the run below every DECISION hit was the
   gap's own proposed remedy ("recording the disposition is what makes a
   threshold tunable").

   **It FLAGS, it does not reject** — it cannot know which phrasings are
   load-bearing, and refusing legal copy on a keyword match would be the
   ace#1238 guard-predicts-a-rejection failure. Resolve each finding: reword the
   copy, or record why the line is legitimate.

   Measured on `hh-poverty-targeting/20260827-0323`, whose why-brief declared
   `area-register-does-not-exist` (`area_ref` present on **0 of 2,237** records)
   and `adjudication-log-is-run-state-not-a-register`. Four instances shipped
   into two dashboards — "outside the normal range **for this area**",
   "colleagues working **comparable areas**", "**area** composition drives it",
   "written to the **adjudication log with its reason**" — and one of them
   contradicted the same page's own leave-one-out definition two lines above it.
   **In every case the narration was clean and the UI copy was the offender**, so
   only a judge reading rendered pixels caught them, after a full render.

   **Known limitation, stated so it is not mistaken for coverage:** this matches
   subject-term repetition, not semantic equivalence. Two shapes still slip, both
   observed on that run's iteration-2 judge pass. A coverage claim phrased
   without the gap's own nouns — "that is what makes census saturation auditable"
   — is NOT caught. Neither is an INVERTED claim: scene 4's payoff line said low
   variance → fabrication where the page says fabrication → low variance, the
   converse, and exactly what the `detection-rates-are-not-evidenced` RESEARCH
   gap calls unevidenced. Both sentences carry the same nouns in the same
   proportions, so no term match can separate them. The check narrows the class;
   it does not close it, and the post-render judge is still the backstop.

4. **Build a URL per dashboard — the run deep-link, scoped by OWNERSHIP.**
   `https://labs.connect.dimagi.com/labs/workflow/<def_id>/run/?run_id=<run_id>&<scope>`
   where `<scope>` is the dashboard's OWNING scope:
   - **program-owned** cross-opp rollups (`program_admin_report`, `audit_par`) →
     **`&program_id=<program_id>`**. A cross-opp rollup is a program-owned workflow
     (`definition.program_id` set, no owning opp); `&opportunity_id=<any-opp>` 404s it
     with "definition N not found" from any other opp context. The realize-env realized
     map already emits `par_url` with `&program_id` (connect-labs #946) — use it as-is.
   - **opp-owned** per-opp dashboards (`chc_nutrition_analysis`, `sam_followup`,
     `llo_weekly_review`) → **`&opportunity_id=<opp_id>`**.
   Name each `${key}_par_url`; set `primary_par_url` to the `primary_dashboard`'s.
   The `run_id` source still depends on `shape`:
   - **run-shaped** → the saved run_id (env-ensure realized map or `workflow_save_snapshot`).
   - **action-shaped** → mint one with
     `mcp__connect-labs__workflow_create_run(definition_id, opportunity_id,
     period_start, period_end)` and use the returned `run_id` — with the same
     exclusive-`period_end` derivation as step 3 (`timeline.end_date + 1 day`).
     Omitting the bounds defaults BOTH to today, i.e. a zero-width window.
   Two traps, both verified to BOUNCE: `/workflow/<def>/run/?<scope>` with **no**
   `run_id` → the workflow *list*; `/workflow/<def>/?<scope>` (no `/run/`) → the
   *definition* page. Only `/run/?run_id=<id>&<scope>` renders the dashboard
   (supersedes the earlier `docs/learnings/2026-06-13` picker note; the fix is a real
   run_id, minted if needed).

5. **Emit the handoff + write back.**

   Write `realized.json` — the **flat** multi-var map (`{ primary_par_url,
   <key>_par_url per dashboard, <name>_url drills }`) — the summary `.md`, and
   the `source` block above (including `dashboards[]` + `primary_dashboard`) into
   the demo `run_state.yaml` via
   `mcp__plugin_ace_ace-gdrive__update_yaml_file` (`merge: 'deep'` — never
   `two-level`, which would drop sibling sub-keys; see CLAUDE.md gotcha). Set
   the `steps.demo-data-setup` block to `status: done` with the `realized.json`
   artifact path.

   Write `branch-scrub_report.yaml` (step 2c) alongside it, and mirror its
   headline numbers into `source.dataset_constraints`. **Surface them in the
   summary `.md` too** — the off-branch count and any `unparsed[]` gate belong
   in the run summary a reader actually opens, not only in a YAML the gate
   reads (ace#1658).

5b. **Archive the manifest as the SAME BYTES you sent, then round-trip parse it
   (ace#1737).** The archived `demo-data-setup_manifest.yaml` is the run's
   source-of-truth narrative artifact and the input a later fork replays. It is
   only either of those if it is the manifest that actually ran and it loads.

   - **Author once, to a local file.** Send that file's contents to
     `synthetic_generate_from_manifest`, and publish that identical string as the
     artifact (`drive_create_file` a placeholder, then
     `drive_update_file({localFilePath})` — which uploads the bytes off disk
     rather than through a second emission). Do NOT type the manifest a second
     time for the archive.
   - **Then read it back and parse it.** `drive_read_file` → `yaml.safe_load`, and
     re-validate against the labs `Manifest` model if a connect-labs checkout is
     reachable. Fail the step if it does not parse.

   Why: on `hh-poverty-targeting/20260824-1404` the archived manifest **did not
   parse at all** — the flow mappings were column-aligned, so the single longest
   key (`…ppi_q6_sachet_water`) got zero spaces between its `:` and its `{`, and
   YAML requires whitespace there. The generation itself had succeeded (2,237
   visits), which is the tell: the string the atom received and the string that
   reached Drive were two different emissions of "the same" YAML. Nothing failed
   — the run was green, `demo-data-setup-qa` passed (it checks dashboards, not the
   manifest), and the break only surfaced when the next run tried to fork it.

   Drive is not the culprit and re-testing it is wasted effort: a round-trip probe
   of the exact pathological shape (`key:{ z: 3 }`) through
   `drive_create_file` → `drive_read_file` returns it byte-for-byte. The defect
   enters at authoring, on the second emission.

   Cheap and worth it beyond this class: the same round-trip check immediately
   caught an unrelated real break in a step-2c report on
   `20260827-0323` — a leading `>` line that YAML reads as a root block scalar.

Then gate on `demo-data-setup-qa` before `demo-narrative` consumes the map.

## Process (clone)

Clone reuses the denovo spine — **only the data source changes** (steps 1–2);
Step 0 (plan/template-select, now informed by the real opp's shape) and steps 3–5
(author dashboards, mint runs via `workflow_create_run`, build `/run/?run_id=` URLs,
emit the realized map) are IDENTICAL. Input: a real Connect `--opp <id>`.

1c. **Profile the real opp → a PII-free manifest.**
   `mcp__connect-labs__synthetic_profile_from_prod(opportunity_id, mirror=true)` —
   reads the opp's export endpoints server-side and returns a manifest reproducing
   the real statistical shape. **`mirror=true`** carries a de-identified per-entity
   transplant pool so per-case *trajectories* are reproduced (its own example is an
   infant growth curve — i.e. exactly a child's MUAC recovery arc), not just column
   means. Pass `form_json_paths` to pin the fields the chosen template reads (e.g.
   the `sam_followup` MUAC paths) when auto-discovery misses them.
   - **Multi-LLO variant:** for a program-admin clone spanning several sites, use
     the cohort path — `synthetic_clone_profile` (spec_yaml with all
     `opportunity_ids`, `bundle_root: 'gdrive:'`) → `synthetic_clone_generate` —
     which registers each as a labs-only opp; then author dashboards over them.
   - **Access note:** profiling keys on the **Connect** `opportunity_id` (delivery
     data is aggregated in Connect, independent of which HQ the deliver app lives
     on). If the opp isn't reachable with the labs caller's token, that access gap
     is the thing to close (multi-cluster / membership) — fail loud, don't fake it.

2c. **Generate into a fresh labs-only opp** — `synthetic_create_labs_only` then
   `synthetic_generate_from_manifest` with the profiled manifest (identical to
   denovo step 2, from-manifest mode). Capture `labs_opp_id` + `deliver_units`.

2c-fidelity. **Gate on `demo-fidelity-check`** (clone-only) — wraps
   `mcp__connect-labs__synthetic_fidelity_report(bundle_dir)` to confirm the clone
   reproduces the source's per-field distributions + correlations before it reaches
   a funder. Fail → regenerate (or fall back to denovo authoring) — never show a
   low-fidelity clone as if it were the real program.

Then run Step 0 (template selection, informed by the real opp) and steps 3–5 exactly
as denovo. A clone whose real data has no live activity yet → there's nothing to
profile; use `denovo` for that program until it has real delivery data.

## Process (ace-run)

The Phase 7 convergence provider — the data source is the **current `/ace:run`'s
Phase-4 Connect opportunity** and its PDD/app structure, not a brief or a real
external opp. Same spine as denovo; the manifest's provenance changes, and step
**1c is a REQUIRED authoring step this provider adds** — a denovo brief states its
own headline anomaly, a PDD does not hand you one.

1a. **Resolve the run's opp + app structure.** Read the run's
   `phases.connect-setup.products.connect.opportunity` (`connect_int_id`, apps) and
   the PDD (`inputs/pdd.md`) / deploy summaries — the KPI fields, deliver units,
   and personas come from the built apps, not invented.
1b. **Author the manifest from the PDD/apps** (the story-coherent per-opp manifest
   that today's `synthetic-narrative-plan` + `synthetic-data-generate` produce) —
   keyed on the real deliver-app form paths so the dashboards read real fields.

1c. **REQUIRED — give the demo something to detect, derived from the PDD's own
   declared evidence model.**

   A demo of detection needs something to detect. A manifest that ships
   `anomalies: []` and one undifferentiated `accuracy_distribution` across every
   persona produces a cohort with no signal in it, and then every dashboard is
   honest and every scene is inert. That is not a rendering problem the DDD loop
   can fix downstream — it is an authoring omission, and the loop's
   `use_case_soundness` finding is *"the scenario does not exercise the feature it
   demonstrates."* Measured on `hh-poverty-targeting/20260824-1404`: the ace-run
   manifest carried `anomalies: []` and no per-persona overrides; completion rates
   clustered 64–77%, mean PPI scores clustered ~34, the review queue ranked 15
   undifferentiated workers, and the payoff decision landed against an empty
   adjudication log. Phase 7 terminated `stopped_not_converged` at concept 2.0/5.

   Four obligations. All four are REQUIRED; **which** control you pick is yours.

   1. **Enumerate the PDD's declared controls, verbatim.** Read the PDD's
      verification / fraud / data-quality section and list every automated flag,
      threshold, and review rule it names, quoting each. This list is the ONLY
      menu you may author from.
   2. **Instantiate at least one of them in the manifest** as an `anomalies[]`
      entry and/or a per-persona divergence (`field_distributions` /
      `period_rates` / `accuracy_distribution` that separates the carrier from
      its peers). One well-formed signal a reviewer can actually find beats
      three vague ones.
   3. **Cite the clause each signal derives from** — a `# derived from PDD §N:
      "<quote>"` comment on the manifest entry, echoed in the run summary. An
      uncited anomaly is an invented one.
   4. **Make the carrier distinguishable.** State, before generating, what a
      reviewer would SEE that separates the carrier from the cohort (which
      column, which dashboard, roughly what magnitude). If the answer is "it
      would look like everyone else", the signal is not authored yet. A cohort
      whose metrics all cluster inside one band ranks fifteen workers nobody can
      choose between — which is what the measured run shipped.

   **Never invent a fraud pattern the design does not describe.** A demo that
   fabricates a detection story is worse than a boring one: it shows a funder a
   capability the program did not specify and cannot operate. If the PDD genuinely
   declares no verification controls, record
   `detectable_signal: none (PDD declares no verification rules)` with the quote
   that proves it, say so in the run summary, and let `demo-narrative` author a
   story that does not claim detection — do not fill the gap with a plausible
   invention.

   **Worked example (`hh-poverty-targeting`, the run this step exists because
   of).** Its PDD §6 "Verification and fraud rules" is `[FIXED]` and names five
   automated flags, including verbatim: *"Response patterns: flagged (not
   auto-rejected) if an FLW's score distribution is a statistical outlier vs.
   peers — e.g., implausibly uniform answers or a spike just below/above an
   eligibility threshold."* Two authorable signals fall straight out of it, both
   derived rather than invented:
   - **band-boundary clustering** — the instrument's own point table
     (`inputs/INSTRUMENT — Nigeria PPI 2020`, indicator 2 "How many members are
     there in the household?", response "A. 3 or less" = **31 points**, the
     largest single-answer jump in the scorecard) makes that one answer the
     obvious place a score gets pushed over a line. One persona's household-size
     responses skew to the 31-point band far harder than its peers'.
   - **response-pattern uniformity** — one persona's score distribution is
     implausibly tight versus the cohort spread.

   Both are the PDD's own words turned into distributions; neither adds a
   mechanism the design does not already claim to detect.

   **Two manifest mechanics that silently void this whole step** — get them
   wrong and you ship `anomalies: []` by a different route:
   - `anomalies[].week` / `weeks[]` are **1-based** on this path
     (`synthetic_generate_from_manifest`), matched against
     `VisitSlot.week_index`; **`week: 0` is falsy in `_anomalies_at` and matches
     nothing at all.** (The 0-based reading belongs to the `realize-env` audit
     ensurer, which this provider does not use.) `coaching_arcs[].week_triggered`
     and `field_distributions[].period_rates` keys are 1-based. See § Gotchas for
     the source lines.
   - Put the signal on a week the demo's dashboards actually render — a completed
     week, inside `timeline`. Out-of-window anomalies are skipped in silence.
   - `coaching_arcs` still ships EMPTY to the atom (step 2a below).

2a. **Generate into the run's labs SyntheticOpportunity** — `synthetic_create_labs_only`
   (or reuse the run's existing labs opp) + `synthetic_generate_from_manifest`.
   **Send `coaching_arcs: []`** — keep the authored arcs in the saved manifest as
   the source-of-truth narrative, but the in-generate Task-create path 500s at
   `POST /export/labs_record/` and a single entry aborts the ENTIRE generation, so
   no visits land either (jjackson/ace#594; the strip is spelled out in
   `skills/synthetic-data-generate/SKILL.md § Process` step 3). Arcs are created
   separately and reliably via `task_create_synthetic`.

Then Step 0 (template selection) and steps 3–5 (author dashboards, mint runs,
build `/run/?run_id=` URLs, emit the realized map) are EXACTLY the denovo spine,
and `demo-narrative` authors the DDD narrative — so Phase 7 becomes
`demo-data-setup(ace-run)` → `demo-narrative` → DDD, the same pipeline as
`/ace:demo`. Archetype branching (`atomic-visit` / `multi-stage`; `focus-group`
is a hard skip) is preserved at the Phase-7 agent level.

## The interactive run stays live

`workflow_save_snapshot` completes a run. That is how a `par_url` becomes a
**stable, idempotent deep-link** — reopen it next month and the page renders the
same figures — and it is what every dashboard a stakeholder keeps a link to
should have.

It also makes the page **read-only**. The run view's `completed` branch prints
*"This run is completed… Decisions are read-only"* and disables the status
control. So for the one dashboard whose scene shows a reviewer **taking** a
decision, completing the run is what makes that scene unperformable.

On `hh-poverty-targeting/20260730-2210` both runs were completed at
`2026-08-01T01:12Z`, ~14 minutes before the render at ~01:26Z. The result read
as several unrelated defects and was one: every one of the 10 spec actions
degraded to `wait_for`/`hold` because nothing was clickable, 7 scenes produced
only 2 distinct images (5 of 6 adjacent pairs differed by 0.00% of pixels), and
the arc scored 1.0/5 (dimagi-internal/ace#1162).

**The rule (Jon, 2026-08-14 — option 1 of three):**

- the dashboard whose `role` is `review-action` / `review` / `decision`:
  `workflow_create_run`, then **stop**. Its run stays `in_progress`, its
  `par_url` is built exactly as in step 4, and it is the only link that is not
  snapshot-stable. Mark it `interactive: true` in `source.dashboards[]`.
- every other dashboard: unchanged — `workflow_save_snapshot`, run completed.

Two alternatives were weighed and not taken: minting two runs for the review
workflow (one completed for framing, one live for the decision beat) doubles the
handoff for a gain only a longer narrative would use; completing every run
*after* the render makes link stability depend on a render that may fail or be
re-run. Revisit if a demo ever needs the review dashboard's link to outlive the
recording.

`demo-data-setup-qa` check 8 (`checkInteractiveRunsLive`) enforces both halves —
an interactive run found `completed` fails, and so does a non-interactive run
left `in_progress`.

## Hand-authoring a generator instead of the manifest DSL

Sometimes the manifest DSL cannot express a design and the data gets authored by
a hand-written Python script. That is allowed. What is not allowed is shipping
one whose determinism is *claimed* rather than *demonstrated* — the fixture is
the substrate of every rendered scene, so a dataset that cannot be regenerated
means any later fix is hand-editing JSON or re-authoring every narration number
against a different dataset (ace#1388).

**Three obligations, all three or use the DSL:**

1. **Never derive a persisted value from builtin `hash()`.** This is the one
   that actually shipped. `hash()` of a str — or of a tuple containing one — is
   randomised per process by design (PEP 456). It is perfectly stable *within* a
   process, which is exactly what makes `h = hash((user, week)) % 100` such an
   inviting way to derive a fixed per-key value, and it silently reshuffles on
   the next run. In the spark-facilitator generator it decided the record
   **count**. Use a stable digest:

   ```python
   def stable_hash(x):
       return int.from_bytes(hashlib.blake2b(repr(x).encode(), digest_size=8).digest(), "big")
   ```

2. **Sort every iteration that a draw is consumed inside** — `for k in sorted(d)`,
   never `for k in some_set`. Same symptom by a different route: the RNG is
   seeded correctly and the draw *order* is not.

3. **Run a CROSS-PROCESS determinism check before upload, and publish the
   generator alongside the fixture** with the assertion that it reproduces the
   uploaded bytes.

   > **The obvious check does not work.** "Generate twice in one process, assert
   > byte-identical" passes over both defects above: `PYTHONHASHSEED` is drawn
   > once per process, so both generations see the same `hash()` values and walk
   > any set in the same order. Measured — in-process identical `True` while
   > three processes gave three different digests. A green check over a live bug
   > is worse than no check.

   The check that catches it re-executes the generator under two different
   `PYTHONHASHSEED` values and compares output bytes. Take the exact snippet from
   `lib/generator-determinism.ts` (`CROSS_PROCESS_SELFCHECK`) rather than
   rewriting it.

**Before uploading, lint the generator:**

```bash
npx tsx -e "
import {checkGeneratorDeterminism} from './lib/generator-determinism';
import {readFileSync} from 'node:fs';
const r = checkGeneratorDeterminism(readFileSync(process.argv[1], 'utf8'));
for (const f of r.findings) console.log(\`[\${f.kind}] line \${f.line}: \${f.detail}\`);
process.exit(r.ok ? 0 : 1);
" <generator.py>
```

The lint catches the two known causes; the cross-process check catches the ones
nobody has enumerated yet. Run both — neither is a substitute for the other.

## Gotchas (encode every one — they are the difference between a live demo and a dead scene)

- [ ] **Labs-only opp ids ≥ 10,000 have no CommCare HQ app.** Anything needing a
  real HQ app (deliver-unit introspection, enabling "Create Review") can't be
  driven for a synthetic opp — the generator writes records directly. Pin the
  opp id ≥ 10000.
- [ ] **Pin the timeline** to a fixed Monday. An unpinned trailing window slides
  off "today" and strands already-seeded runs/flags/audits/tasks on the wrong
  week, breaking idempotency. `start_date` must be a Monday and must equal the
  env anchor.
- [ ] **Do NOT pre-seed the flagged current-week worker's audit/task.** The
  live-demo scene creates them on camera; pre-seeding leaves nothing to click.
  The flagged worker is the one on the in-progress current week.
- [ ] **First persona = network manager**, `flag_rate: 0`, across flags /
  task-creator / rollup label.
- [ ] **A "resolved" cluster needs every audit completed AND every task closed.**
  The rollup drill selector needs one fully-resolved cluster (the "good" drill)
  and one still-open cluster in a *different* opp — otherwise `good_*`/
  `incomplete_*` vars are omitted.
- [ ] **`period_end` is EXCLUSIVE (`visit_date < period_end`).** A run window is
  half-open, so a `period_end` equal to the manifest's `timeline.end_date` drops
  every record dated on it. Pass `timeline.end_date + 1 day`. Nothing fails:
  both runs report cleanly and both pages render — a snapshotted dashboard just
  silently disagrees with its live sibling over the same fixture. Omitting the
  bounds is worse, not safer: they default to `[today, today)`. Full mechanism,
  source quotes and the measured numbers in step 3 (ace#1683).
- [ ] **Anomaly weeks are read on TWO different bases by two different
  consumers — state which path you are on.** `coaching_arcs[].week_triggered`
  is 1-based (`PositiveInt`, `_week_start()` does `(week - 1) * 7` in
  `generator/fixtures/tasks.py`) and `field_distributions[].period_rates` keys
  are 1-based (`period_rates: {2: …}` = the SECOND week) on every path. But
  `anomalies[].week` / `weeks[]` are:
  - **1-based** under `synthetic_generate_from_manifest` (the `from-manifest`
    path, and the only path the `ace-run` provider uses). `_anomalies_at` in
    `generator/fixtures/engine.py` tests `if a.week and a.week == week_index`
    against `VisitSlot.week_index`, which `expand_visit_schedule` builds as
    `for week in range(1, timeline.weeks + 1)` — 1-based by declaration, same
    counter `period_rates` uses. Note the `if a.week` guard: **`week: 0` is
    falsy and matches NOTHING**, so a 0-based anomaly on the first week is a
    silent no-op, not an off-by-one.
  - **0-based** under `synthetic_env_ensure`'s audit ensurer (the
    `realize-env` path). `ensure/ensurers/run_audits.py` indexes the resolved
    week list directly — `if week_idx < 0 or week_idx >= len(weeks): continue`
    then `monday_iso = weeks[week_idx]`.

  Out-of-window anomalies are silently skipped on both paths, so a wrong base
  costs a demo its entire detectable signal with no error anywhere. See
  `playbook/integrations/connect-labs.md § binary distribution` for
  `period_rates`' source + live measurement (ace#1518).

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-08-27 | **Step 3c narrowed to CAPABILITY gaps, and gap prose is no longer scanned (ace#1762).** Measured against the real artifacts rather than its fixtures, the narrative pass ran at ~44% precision: 9 findings on `hh-poverty-targeting/20260827-0323`, of which 3 were a DECISION gap firing on claims that merely NAME thresholds (its own proposed remedy, not a contradiction) and 1 was one gap's `proposed_action` naming another gap's subject. Both are subtractions: `constraining` is now CAPABILITY only — the RESEARCH carve-out's reasoning covers DECISION verbatim, since both forbid a *qualified* claim and no keyword match can tell that from naming the subject — and `narrativeSources()` no longer emits `why_brief.gaps[]` at all, replacing the narrower self-exemption (`exemptGapId` removed as dead). Measured after: 9 → 5 findings over 4 distinct strings, all genuine `area` / `adjudication` CAPABILITY hits. Precision is the whole asset for a report-only check — a gate that cries wolf is how the real misses get waved through (ace#1744). | ACE team |
| 2026-08-27 | **Step 3c also reads the NARRATIVE artifacts, not just dashboard `render_code` (ace#1759).** The same run's why-brief contradicted a gap it itself declared — `decisions-are-recorded` asserts the disposition is recorded "with its reason" while `adjudication-log-is-run-state-not-a-register` declares no durable register and no reason field. Only a post-render judge caught it, on iteration 2. `checkGapCopy`'s `sources` now takes already-prose entries alongside render_code, and `narrativeSources()` builds them from `why_brief.spine[].{claim, rationale}`, `why_brief.gaps[].{detail, proposed_action}` and `unified_spec.scenes[].{concept_claim, show, narrative}`, each labelled by origin. A gap is exempt from its OWN detail/proposed_action. Still report-only; still term matching, so an inverted claim (scene 4's low-variance→fabrication converse) is not caught. | ACE team |
| 2026-08-27 | **Step 3c: check dashboard COPY against the why-brief's declared gaps (ace#1750).** The narrative was gated against `gaps[]` and the dashboard prose was not, so `hh-poverty-targeting/20260827-0323` shipped four on-screen assertions of exactly what its own gap list declared unsupported — across two dashboards, one contradicting the same page's leave-one-out definition two lines above it. In all four the narration was clean and the UI copy was the offender, so every instance had to be caught by a post-render LLM judge. New `checkGapCopy` in `lib/gap-copy-check.ts`, report-only. Catches subject-term repetition, not semantic equivalence — a coverage claim phrased without the gap's nouns still slips. | ACE team |
| 2026-08-27 | **Step 5b: the archived manifest must be the same bytes that were sent, and must round-trip parse (ace#1737).** `hh-poverty-targeting/20260824-1404` published a `demo-data-setup_manifest.yaml` that does not parse as YAML — flow mappings were column-aligned, so the longest key got zero spaces before its `{`. Generation had succeeded, so the archived copy was a SECOND emission rather than a capture of the wire payload; the break surfaced only when the next run tried to fork it. Drive was ruled out by direct probe (the pathological shape round-trips byte-for-byte). Fix: author once to a local file, send that, upload that file's bytes, then read back and `yaml.safe_load`. | ACE team |
| 2026-08-26 | **`period_end` is exclusive — derive it as `timeline.end_date + 1 day` (ace#1683).** A run window is half-open (`visit_date >= date_from AND visit_date < date_to`, `query_builder._date_window_where`), and the natural authoring move — pass the manifest's own `timeline.start_date`/`end_date` — drops the fixture's entire final day from any snapshotted dashboard while its live sibling keeps it. Measured on `hh-poverty-targeting/20260824-1404` (labs opp 10047): snapshot run 5245 `total=2186`, live run 5249 `total=2237`, fixture `2237`, re-mint at `period_end 2026-08-31` → `2237`, exact. Nothing failed; every existing check passed. Also documented: period scoping bites only on the SNAPSHOT path, and omitting the bounds defaults to `[today, today)`, a zero-width window. New backstop: `demo-data-setup-qa` check 11. | ACE team |
| 2026-08-26 | **Step 1c (ace-run): giving the demo something to detect is now a REQUIRED authoring step, derived from the PDD's own declared controls.** `hh-poverty-targeting/20260824-1404` shipped `anomalies: []` and no per-persona divergence, so the cohort had no signal in it — completion 64–77%, PPI ~34, 15 undifferentiated workers in the queue, one decision against an empty adjudication log — and the DDD loop ended `stopped_not_converged` at concept 2.0/5 on `use_case_soundness` ("the scenario does not exercise the feature it demonstrates"). Four obligations (enumerate the PDD's controls verbatim → instantiate ≥1 → cite the clause → state what a reviewer would SEE), an explicit ban on inventing a pattern the design does not declare, an honest `detectable_signal: none` escape, and the two manifest mechanics (1-based anomaly weeks with `week: 0` a silent no-op; `coaching_arcs: []` to the atom) that void the step by a different route. | ACE team |
| 2026-08-26 | Gotcha rewritten: `anomalies[].week` is read on **two different bases by two different consumers** — 1-based under `synthetic_generate_from_manifest` (`_anomalies_at` vs `VisitSlot.week_index`, and `if a.week` makes `week: 0` match nothing), 0-based under `synthetic_env_ensure`'s `run_audits` ensurer (direct index into the week list). The previous single-sentence "anomaly weeks are 0-based (audits)" was true only of the path the `ace-run` provider never takes. | ACE team |
| 2026-08-26 | Step 4b becomes step **2c** and grows two halves: the `DatasetSpec` is now DERIVED from the deliver app (`specFromDeliverApp`, hand-declared entries merged as ADDITIONS via `mergeDatasetSpecs`, `unparsed[]` reported), and a post-generation **branch scrub** (`scrubOffBranchFields`) removes the off-branch values the labs manifest has no primitive to avoid — written back to the fixture folder before any dashboard run is minted. It moved earlier in the process because the old position ran after the dashboards were already reading the fixture. New product `7-synthetic/branch-scrub_report.yaml` + `source.dataset_constraints`. ace#1658. | ACE team |
| 2026-08-26 | Persist the realized dataset's SHAPE into the handoff — `source.record_counts` (verbatim from `synthetic_generate_from_manifest`) + `source.data_shape` (`rows` / `periods` / `groups`), plus step 2b resolving the two axes `record_counts` cannot answer. `demo-narrative` had no cardinality input at all, so it could not tell a filter over 5 rows from one over 500; on `bednet-check-2-visit/20260825-1310` that authored a filter demonstration over a five-worker cohort and ended the DDD loop `stopped_not_converged` at concept 3.0 after four render iterations. ace#1670. | ACE team |
| 2026-08-26 | **Step 3b: utility-resolution gate before every `render_code` upload (ace#1662).** labs purges Tailwind against its own Django templates, so a utility used only in DB-stored `render_code` is dropped from the bundle and degrades silently to the unstyled baseline. `text-rose-700` styled `consent 89.7% · below the 90% floor` — the only pay-affecting figure on the LLO weekly-review dashboard — and rendered near-black for an unknown number of runs; a missing `h-28` left all 12 weekly bars at 0px. New pre-upload lint `scripts/check-render-code-utilities.ts` over `lib/tailwind-utility-resolution.ts`, with loud-failure semantics, substitution guidance, and the lint-the-whole-source rule (3 of 5 misses were pre-existing). Root cause tracked upstream as connect-labs#1294. | ACE team |

## Not in scope

- `ace-run` provider — Phase 7 convergence (Plan C); Phase 7 becomes this provider.
- Rendering / judging / video — owned by canopy DDD, invoked after
  `demo-narrative` by `agents/demo.md`.
