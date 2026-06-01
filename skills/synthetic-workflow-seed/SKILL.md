---
name: synthetic-workflow-seed
description: >
  Instantiate the LLO weekly review + program admin audit workflows —
  examine the labs template registry and adapt the best-fit template, or
  build from scratch via workflow_create (following the live authoring
  guide) — then wire them to the manifest's KPIs + coaching arcs.
disable-model-invocation: true
---

# Synthetic Workflow Seed

Stage 3 of ACE Phase 7 (Plan B). Creates the two demonstrative workflows
on top of the synthetic data: an operational LLO weekly review (FLW KPI
scorecard + coaching-task spawning) and a meta-level program admin audit
(week-over-week review of the LLO's process). For each, the skill examines
the labs template registry for a good fit and either **adapts** the closest
template (`workflow_create_from_template`) or **builds from scratch**
(`workflow_create`, following the live `workflow_authoring_guide`). It then
wires up opp-specific config + KPIs from the manifest.

The output is two workflow IDs registered in labs, one or more
synthetic OCS coaching tasks attached to underperforming FLWs, and the
pipeline schemas populated with KPI fields. The polish step
(`synthetic-workflow-polish`) layers per-opp visual edits on top.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 7 | `7-synthetic/synthetic-narrative-plan.yaml` (preferred) or `synthetic-data-generate_manifest.yaml` (fallback) | `kpi_config`, `coaching_arcs`, `flw_personas` |
| Current run's `run_state.yaml` | `phases.synthetic-data-and-workflows.products.synthetic.labs_opp_id` (required) | `synthetic_generate_from_manifest` opp scope |
| Drive | `ACE/<opp>/opp.yaml` | `display_name` |

## Products

- `7-synthetic/synthetic-workflow-seed.md` — run summary (workflow IDs, task IDs, KPI count, polish-suitability flag)
- `run_state.yaml.phases.synthetic-data-and-workflows.products.synthetic.workflows` populated (read-modify-write to preserve sibling sub-keys from `synthetic-data-generate` and `synthetic-walkthrough-run`):
  ```yaml
  workflows:
    llo_weekly_review_id: <int>
    program_admin_audit_id: <int>
  ```
  Per-run only — no opp.yaml mirror.
- `run_state.yaml.phases.synthetic-data-and-workflows.steps.synthetic-workflow-seed.status: done`
- Side effects in labs:
  - 1 `llo_weekly_review` workflow with the manifest's KPIs + coaching template wired into `definition.config`
  - 1 `program_admin_audit` workflow watching the above
  - 1 task per `coaching_arcs[]` entry (synthetic OCS conversation embedded as `data.ocs_conversation`)

## Process

1. **Read inputs.** Load the active manifest (prefer
   `synthetic-narrative-plan.yaml` over the Stage 1 default manifest).
   Resolve `labs_opp_id` from the current run's
   `phases.synthetic-data-and-workflows.products.synthetic.labs_opp_id`.
   Halt if missing — this skill needs synthetic mode enabled
   (`synthetic-data-generate` should have run first in this same run).

### Build-path decision — examine templates, then adapt or author (do this before steps 2 and 7)

ACE produces two demonstrative workflows per opp — an operational **LLO
weekly review** and a meta-level **program admin audit**. The two roles
and the count are fixed; the *build path* is decided per workflow, not
hardcoded to a template:

1. **Examine the registry.** Call `mcp__connect-labs__list_templates` and
   read each entry (`key`, `name`, `description`, `supports_saved_runs`,
   `multi_opp`). Treat these as ideas / starting points, not a fixed menu.
2. **Score fit** against this opp: the PDD archetype, the manifest's
   `kpi_config` shape (per-FLW aggregates? rates? facilitation-quality?),
   and the demonstrative intent (operational scorecard vs week-over-week
   oversight). A template *fits* when its data contract + saved-runs
   behavior need only config/render tailoring — NOT when you'd be working
   around its structure or a known defect.
3. **Decide per workflow** and record the choice + a one-line rationale
   for the run summary:
   - **ADAPT** — a registered template fits. Instantiate it with
     `workflow_create_from_template` and tailor it (the ADAPT branch in
     steps 2–4 / 7).
   - **BUILD FROM SCRATCH** — no template fits, or the closest one has a
     structure/defect you'd fight. Author the workflow with
     `workflow_create` (no template) per the SCRATCH branch.

**Before authoring anything from scratch, fetch the current best
practices:** call `mcp__connect-labs__workflow_authoring_guide` and follow
it (Template Anatomy, Render Code Contract, Actions API, Pipeline Schema,
Saved-runs). It is the constantly-improving source of truth served live by
labs — re-fetch every run; never author `render_code` from memory.

**Alias-consistency guardrail (load-bearing — applies to BOTH build
paths).** The pipeline's `pipeline_sources[].alias`, the key the
`render_code` reads (`view.pipelines.<alias>`), and the key in the
saved-run `snapshot_inputs.pipelines` MUST be the **same string**. A
mismatch (e.g. alias `data` while the render/snapshot read `flw_kpis`)
passes every create + run call yet renders blank KPIs in saved-run views
and an empty audit rollup.

- **SCRATCH:** you own the alias — pick one string and use it in all
  three places.
- **ADAPT:** the alias is **owned by the template**, not yours to
  choose. For `llo_weekly_review` the live template alias is **`data`**.
  READ the actual alias from the `workflow_create_from_template`
  response's pipelines list (or `get_workflow`) — do NOT assume
  `flw_kpis` or re-author the `render_code` against a guessed key. Any
  render edit you make (the Polish step's `workflow_patch_render_code` /
  `workflow_update_render_code`) **and** the saved-run
  `snapshot_inputs.pipelines` MUST use that exact template alias.
  Re-authoring the render against a guessed alias is the
  blank-KPI-in-saved-run failure: the `llo_weekly_review` template ships
  alias `data`, ACE assumed `flw_kpis`, and every saved-run view
  rendered all-zero (`bednet-spot-check/20260528-0556` and
  /20260601-0651; jjackson/ace#633).

Either way: confirm the three strings match before you ship the
workflow — a blank-KPI render passes all create/run calls and only
surfaces in the saved-run screenshot.

2. **Create the LLO weekly review workflow — via the path decided above.**

   **ADAPT branch** (a template fits):

   ```
   mcp__connect-labs__workflow_create_from_template(
     template_key: "<chosen key from list_templates, e.g. llo_weekly_review>",
     opportunity_id: <synthetic.labs_opp_id>,
     name: "<opp.yaml.display_name> — LLO Weekly Review"  // optional
   )
   ```

   Capture the returned `workflow_id`. The response also lists the
   pipelines created from `pipeline_sources` (the scaffold's
   `flw_kpi_aggregates` pipeline); capture each `pipeline_id` for step 4.
   Then continue to steps 3–4 to wire config + pipeline.

   **SCRATCH branch** (no template fits / closest has a defect): author it
   with `workflow_create`, following the `workflow_authoring_guide` you
   fetched. Build the operational FLW-scorecard `render_code`, the `config`
   (`kpi_config` from the manifest + `coaching_task_template` +
   `showSummaryCards`/`showFilters`), and the `pipeline_sources` — honoring
   the alias-consistency guardrail above.

   ```
   mcp__connect-labs__workflow_create(
     opportunity_id: <synthetic.labs_opp_id>,
     name: "<opp.yaml.display_name> — LLO Weekly Review",
     config: {
       kpi_config: <manifest.kpi_config verbatim>,
       coaching_task_template: { subject_template: "...", ocs_persona: "..." },
       showSummaryCards: true, showFilters: true,
     },
     pipeline_sources: [ { pipeline_id: <linked/created>, alias: "<stable key>" } ],
     render_code: "<authored per the guide; reads view.pipelines.<same alias>>",
   )
   ```

   `workflow_create` returns `{workflow_id, render_code_version}`. Because
   the SCRATCH branch already authored `config` + `render_code` in this
   call, **skip step 3** (config is set) and run **step 4** only if the
   pipeline schema still needs its `fields` populated.

3. **Wire the workflow's config from the manifest.**

   The SEED template ships `config.kpi_config: []` and a placeholder
   `coaching_task_template`. Both get filled now via:

   ```
   mcp__connect-labs__workflow_update_definition(
     workflow_id: <from step 2>,
     opportunity_id: <synthetic.labs_opp_id>,
     expected_version: 1,    // first edit since template instantiation
     patch: {
       config: {
         kpi_config: <manifest.kpi_config verbatim>,
         coaching_task_template: {
           subject_template: "Coaching feedback — week {week} for {flw_name}",
           ocs_persona: "<from manifest.coaching_arcs[0].persona, default 'supportive_coach'>",
         },
       }
     }
   )
   ```

   `config` shallow-merges, so this preserves `showSummaryCards` /
   `showFilters` from the template default. On `VERSION_CONFLICT`,
   re-fetch via `workflow_get` and retry once.

4. **Populate the pipeline schema.**

   The SEED template's pipeline schema ships with `fields: []` because
   real fields depend on the opp's form schema. Build the field list
   from `kpi_config`:

   ```python
   fields = [
     {
       "id": kpi.kpi,
       "field_path": kpi.field_path,
       "aggregation": kpi.aggregation,   // 'validated_rate', 'non_null_rate', 'distinct_count', etc.
     }
     for kpi in manifest.kpi_config
   ]
   ```

   Then call:

   ```
   mcp__connect-labs__pipeline_update_schema(
     pipeline_id: <from step 2>,
     opportunity_id: <synthetic.labs_opp_id>,
     expected_version: 1,
     schema: { ...existing schema, fields: <built above> },
   )
   ```

   On `VERSION_CONFLICT`, re-fetch via `pipeline_get` and retry once.

   **Shared-path guardrail (jjackson/ace#595).** Do NOT emit a bare
   `last`/`first`/`list` aggregation field on the **same `field_path`** as
   one or more `count` fields that carry a `filter_path`/`filter_value` on
   that path. The labs pipeline SQL generator collapses the JSONB column
   extraction for a shared path and the bare extraction wins, so the
   *filtered* `count` fields after the first one silently compute **0**
   (not null — all-zero, so `fields_all_null` does NOT catch it). This
   under-reports headline KPIs in the demo with no error surfaced (live on
   malaria-rdt 20260531-0739: a `last_visit_channel` (`last` on
   `form.channel_type`) zeroed the `pmv_samples`/`public_phc_samples`
   filtered counts on the same path). When building `fields`: if two or
   more fields share a `field_path` and at least one is a `filter_path`
   `count`, drop the bare `last`/`first`/`list` on that path (derive that
   value a different way, e.g. a separate filtered field or in render code).
   **Then assert it held:** after the schema save, run `pipeline_preview`
   (`sample_size` ≥ 10) and check that no `filter_path` `count` field on a
   shared path is uniformly 0 across rows that have data — if one is, a
   shared-path collision slipped through; surface a `[WARN]` and remove the
   colliding bare aggregation. (Upstream fix tracked at jjackson/ace#595 —
   give each field its own filtered extraction expression.)

5. **Spawn coaching tasks.**

   This is the **authoritative path for coaching arcs.** `synthetic-data-generate`
   deliberately strips `coaching_arcs` from the manifest it sends to
   `synthetic_generate_from_manifest` (that in-generate Task path 500s —
   jjackson/ace#594), so the arcs are created here via the standalone
   `task_create_synthetic` atom, which is reliable. Do NOT move arc creation
   back into the generate call until #594 is fixed upstream.

   For each entry in `manifest.coaching_arcs`:

   ```
   mcp__connect-labs__task_create_synthetic(
     opportunity_id: <synthetic.labs_opp_id>,
     assigned_to: <coaching_arcs[].flw_id>,
     subject: "<coaching_task_template.subject_template formatted with the arc>",
     ocs_conversation: <coaching_arcs[].transcript verbatim>,
     status: "completed",
   )
   ```

   `transcript` is the array of `{role: bot|flw, text, ts}` the
   manifest's narrative-plan authored. Capture each task's returned ID
   for the run summary.

   **Per-arc try/except:** if one task creation fails (e.g.
   `assigned_to` doesn't match a real FLW the synthetic data minted),
   record the failure in the run summary and continue with the next
   arc. Other tasks proceed.

6. **Suitability check.**

   The seeded workflow's render_code is opp-agnostic. Decide whether
   `synthetic-workflow-polish` (Stage 3.2) can apply surgical patches
   on top, or whether a full L2-mode rewrite is needed. Heuristic:

   - **`scaffold_unsuitable: false`** (default) — the manifest's
     `flw_personas[].archetype` matches the standard rockstar/steady/
     struggling/new_hire mix, and the KPIs are per-FLW aggregates.
     Polish skill will do `workflow_patch_render_code` edits.
   - **`scaffold_unsuitable: true`** — the manifest's KPIs are not
     per-FLW aggregates (e.g., a focus-group archetype with
     facilitation-quality KPIs that aren't worker-rollable), or the
     archetype mix is exotic. Polish skill will rewrite the render
     code from scratch (`workflow_update_render_code`).

   For the canonical atomic-visit archetype with per-FLW KPIs, this is
   always `false`. Record the flag in step 8.

7. **Create the program admin audit workflow — via the path decided above.**

   **ADAPT branch** (a template fits — usually `program_admin_report`, the
   live registry key for the cross-opp SOP-compliance rollup; confirm the
   exact key from `list_templates` rather than assuming):

   ```
   mcp__connect-labs__workflow_create_from_template(
     template_key: "<chosen audit key from list_templates>",
     opportunity_id: <synthetic.labs_opp_id>,
     name: "<opp.yaml.display_name> — Program Admin Audit"
   )
   ```

   **SCRATCH branch** (no audit template fits): author with
   `workflow_create` per the `workflow_authoring_guide` — a meta-level
   workflow whose render reads the watched LLO weekly review's saved-run
   snapshots (it has no pipeline of its own).

   Either way, wire the watched workflow:

   ```
   mcp__connect-labs__workflow_update_definition(
     workflow_id: <from step 7>,
     opportunity_id: <synthetic.labs_opp_id>,
     expected_version: 1,
     patch: {
       config: { watched_workflow_id: <llo_weekly_review_id from step 2> }
     }
   )
   ```

   The audit workflow renders a week-over-week compliance dashboard from
   its snapshot's `watched_summary`. **Note:** this `config` wiring is
   definition-level metadata only — the `build_snapshot` hook does NOT read
   watched sources from the config. The functional requirement is the
   per-run `initial_state` set in step 8b (and the hook's key is
   `workflow_definition_id`, whereas the config field is `watched_workflow_id`
   / `watched_sources[].workflow_id` — don't assume they're the same name).

8. **Saved-runs progression — Week 1 + Week 2 snapshots.**

   Plan B's Task 3.1 calls for a Week 1 + Week 2 saved-runs progression
   to make the demo show week-over-week deltas. The connect-labs MCP
   shipped `workflow_create_run` + a fixed `workflow_save_snapshot`
   (with `opportunity_id` scope) to support this loop programmatically.

   Derive Week 1 and Week 2 windows from the manifest's `timeline`:

   ```python
   start = manifest.timeline.start_date            # ISO date
   week_1_end = start + 7 days
   week_2_start = start + 7 days
   week_2_end = start + 14 days
   ```

   Then for each week, do create-then-snapshot against the LLO weekly
   review workflow. **The audit's rollup is NOT free** — despite the old
   "it just reads the LLO review's snapshots" assumption, the audit's
   `watched_summary` is built by a server-side hook that fires only when an
   *audit* run is snapshotted, and reads its inputs from that run's own
   state. Step 8b below creates it. (Root-caused live 2026-05-31 against
   workflow 3448 — jjackson/ace#596.)

   ```
   # Week 1
   r1 = mcp__connect-labs__workflow_create_run(
     definition_id: <llo_weekly_review_id>,
     opportunity_id: <synthetic.labs_opp_id>,
     period_start: <start>,
     period_end:   <week_1_end>,
   )
   mcp__connect-labs__workflow_save_snapshot(
     run_id:         r1.run_id,
     opportunity_id: <synthetic.labs_opp_id>,    # required since labs PR #168
     snapshot_name:  "Week 1",
     captured_at:    "<week_1_end>T23:59:59Z",
   )

   # Week 2 — same shape with bumped dates
   ```

   Capture both run IDs and snapshot timestamps for the run summary.

   **Per-week try/except:** if Week 1 succeeds but Week 2's create or
   snapshot fails (e.g. transient labs error), surface the partial
   completion in the run summary and continue. Operator can re-run
   `/ace:step synthetic-workflow-seed` to retry — but note that re-runs
   create NEW workflows + duplicate runs (no idempotency on labs side
   yet); operator should use `workflow_delete` to retire stale ones
   before retrying.

   **Why Week 1 + Week 2 specifically:** the program admin audit
   workflow renders week-over-week LLO-process compliance from
   *multiple* snapshots. Two weeks is the minimum for a "trend"; more
   weeks add noise to the demo without meaningful narrative gain.
   Operators wanting a longer run can edit the manifest's timeline to
   N weeks, then call `workflow_create_run` + `workflow_save_snapshot`
   N times via direct MCP calls.

8b. **Snapshot the program admin audit run (REQUIRED — without this the
    audit renders "0 opportunities watched" + an empty WINDOW AGGREGATE).**

    The audit's `watched_summary` is built by the `program_admin_report`
    template's `build_snapshot` hook. That hook fires **only when an
    *audit* run is snapshotted**, and it reads its inputs from the audit
    run's **own `state`** (`run.data.state`) — NOT from the definition
    config, and NOT "for free" from the LLO review snapshots. So after the
    LLO-review weeks are seeded, create + snapshot exactly **one** audit run
    whose `initial_state` carries the window + watched sources in the exact
    shape the hook reads (verified live 2026-05-31, jjackson/ace#596):

    ```
    # Mondays covered by the window, one ISO date each (drives the grid columns)
    expected_weeks = [ <Monday ISO> for each week in the window ]

    audit_run = mcp__connect-labs__workflow_create_run(
      definition_id: <program_admin_audit_id>,
      opportunity_id: <synthetic.labs_opp_id>,
      period_start:   <window_start date>,
      period_end:     <window_end date>,
      initial_state: {
        # Window the hook FILTERS watched runs by. Must be END-OF-DAY
        # inclusive: the LLO-review snapshots you just saved have
        # completed_at = NOW (wall-clock), and a date-only window_end
        # parses to MIDNIGHT, which excludes same-day snapshots — the
        # exact "empty aggregate" trap. Use a T23:59:59Z upper bound that
        # is >= the latest snapshot's completed_at.
        window_start: "<window_start>T00:00:00Z",
        window_end:   "<today>T23:59:59Z",
        # Calendar strings the render shows verbatim (keep these date-only).
        display_window_start: "<window_start>",
        display_window_end:   "<window_end>",
        expected_weeks: expected_weeks,
        # One entry per watched workflow. The hook does
        # source["workflow_definition_id"] — the key MUST be
        # workflow_definition_id, NOT workflow_id (the config field name).
        watched_sources: [
          { name: "<llo review display name>",
            workflow_definition_id: <llo_weekly_review_id>,
            opportunity_id: <synthetic.labs_opp_id> }
        ],
      },
    )
    mcp__connect-labs__workflow_save_snapshot(
      run_id:         audit_run.run_id,
      opportunity_id: <synthetic.labs_opp_id>,
      snapshot_name:  "Audit rollup",
      captured_at:    "<now ISO>",
    )
    ```

    **Verify it populated** (don't trust the save's 200): GET
    `${LABS_BASE_URL}/labs/workflow/api/run/<audit_run_id>/snapshot/?opportunity_id=<opp>`
    and assert `snapshot.state.watched_summary` is non-empty with `runs` per
    source. Diagnostics if it isn't:
    - `snapshot.error == "missing_window"` → `window_start`/`window_end`
      missing from `initial_state`.
    - sources present but every `runs: []` → `window_end` was date-only
      (midnight) and excluded the same-day snapshots, OR a `watched_sources`
      entry used `workflow_id` instead of `workflow_definition_id`.

    Record the `audit_run_id` for the run summary.

    **Known residuals (NOT fixed by this step — labs-side; see
    jjackson/ace#596 + the connect-labs cadence-backdating issue):**
    - The cadence **grid** can't show a real week-over-week trend yet:
      `workflow_save_snapshot` has no `completed_at` override, so every
      synthetic watched snapshot lands at wall-clock-now (the current week),
      and the rollup/render group by `completed_at`, not run `period`. The
      window AGGREGATE populates correctly; the per-week columns will show
      the runs only in the current week.
    - `flw_rows` (per-FLW flags/audits/tasks drill-down) are empty unless the
      governance artifacts are seeded for the watched runs via
      `program_admin_demo_seed`.

9. **Write the run summary** to
   `7-synthetic/synthetic-workflow-seed.md` via `drive_create_file`
   (find-or-update — re-runs overwrite). Body:

   - Workflow IDs: `llo_weekly_review_id`, `program_admin_audit_id`
   - Public labs URLs: `${LABS_BASE_URL}/labs/workflow/<id>/`
   - KPI count, coaching-task count, scaffold-suitability flag
   - Saved-runs: `Week 1 run_id=<int>`, `Week 2 run_id=<int>`,
     `<n>/2 snapshots saved` (when both land cleanly), or partial-week
     failures with the labs error verbatim
   - Any per-arc failures from step 5

10. **Update `phases.synthetic-data-and-workflows.products.synthetic.workflows`**
    in the current run's `run_state.yaml`. Read-modify-write to
    preserve sibling sub-keys (`synthetic-data-generate` owns
    `enabled` / `current_*` / `labs_opp_id` / `fixture_record_counts`;
    `synthetic-walkthrough-run` owns `walkthroughs[]`):

    1. `drive_read_file` on the current run's `run_state.yaml`;
       extract the existing `products.synthetic` block.
    2. Merge in this skill's contribution:
       ```yaml
       synthetic:
         # preserved siblings:
         enabled: true
         current_folder_id: ...
         labs_opp_id: ...
         # this skill's keys:
         workflows:
           llo_weekly_review_id: <int>
           program_admin_audit_id: <int>
       ```
    3. `update_yaml_file` with `merge: 'deep'` on the
       `phases.synthetic-data-and-workflows.products.synthetic.workflows`
       payload (`deep` preserves sibling sub-keys + the phase's
       `status`/`steps`; `two-level` would replace the whole phase block,
       #572/#587).

    **No write to `opp.yaml.synthetic` — synthetic state is per-run only.**

11. **Update `run_state.yaml`** via the read-merge-write pattern (NOT
    `update_yaml_file` — same caveat as `synthetic-data-generate`
    step 6 on the phases-block clobber risk):

    ```yaml
    phases:
      synthetic-data-and-workflows:
        steps:
          synthetic-workflow-seed:
            status: done
            workflow_ids:
              llo_weekly_review: <int>
              program_admin_audit: <int>
            kpi_count: <int>
            coaching_task_count: <int>
            scaffold_unsuitable: <bool>
            saved_runs_status: deferred-to-labs-pr
            artifacts:
              summary: <Drive ID>
    ```

## MCP Tools Used

- `mcp__connect-labs__list_templates` (build-path decision — examine the registry)
- `mcp__connect-labs__workflow_authoring_guide` (fetch before any from-scratch authoring)
- `mcp__connect-labs__workflow_create_from_template` (ADAPT branch)
- `mcp__connect-labs__workflow_create` (SCRATCH branch — author without a template)
- `mcp__connect-labs__workflow_update_definition`
- `mcp__connect-labs__workflow_update_render_code` (SCRATCH branch — if render is authored after create)
- `mcp__connect-labs__workflow_get` (on `VERSION_CONFLICT` retry)
- `mcp__connect-labs__pipeline_update_schema`
- `mcp__connect-labs__pipeline_get` (on `VERSION_CONFLICT` retry)
- `mcp__connect-labs__task_create_synthetic`
- `mcp__connect-labs__workflow_create_run` (step 8 — Week 1 + Week 2 saved-runs)
- `mcp__connect-labs__workflow_save_snapshot` (step 8 — completes each week)
- `mcp__plugin_ace_ace-gdrive__drive_read_file`
- `mcp__plugin_ace_ace-gdrive__drive_create_file` (find-or-update)
- `mcp__plugin_ace_ace-gdrive__drive_update_file` (run_state read-merge-write)
- `mcp__plugin_ace_ace-gdrive__update_yaml_file` — writes `phases.synthetic-data-and-workflows.products.synthetic.workflows` to `run_state.yaml` (`merge: 'deep'` — preserves sibling sub-keys + the phase's status/steps; #572/#587)

## Mode Behavior

- **Default:** create both workflows, wire config, spawn coaching tasks,
  skip saved-runs, write summary. The ~30s end-to-end produces a labs
  state ready for the polish step.
- **`--skip-coaching-tasks`:** create workflows + wire config but skip
  step 5. Useful when iterating on the workflow definition without
  re-spawning task records.
- **`--llo-only` / `--audit-only`:** create only one of the two
  workflows. Mostly for debugging — the demo story needs both.

## Dry-Run Behavior

`--dry-run` writes the run summary describing what *would* be created
(workflow IDs marked `<TBD>`) and skips all labs MCP mutations. State
tracks as `dry-run-success`.

## Failure Modes

| Failure | Detection | Recovery |
|---|---|---|
| `synthetic.labs_opp_id` missing in `opp.yaml` | step 1 halt | Run `synthetic-data-generate` first to enable synthetic mode for this opp. |
| `workflow_create_from_template` returns 4xx | step 2 halt | Surface the labs error verbatim. Common cases: caller not a member of the opp's organization (check `labs_context`); template_key typo. |
| `kpi_config` empty in manifest | step 3 warn | The workflow gets created with no KPIs and the per-FLW table renders empty. Edit the manifest to add at least one KPI then re-run. |
| One coaching arc fails | step 5 partial | Other arcs proceed; failure recorded in run summary. Re-run with `--skip-coaching-tasks` then create individually via `task_create_synthetic` if desired. |
| `workflow_create_run` or `workflow_save_snapshot` returns transport error | step 8 partial | Capture the labs error in the run summary; re-run `/ace:step synthetic-workflow-seed` after the transient resolves. Idempotency caveat: re-runs create NEW workflow definitions; use `workflow_delete` to retire stale ones first OR open the just-failed workflow in labs UI and finish the snapshot manually. |
| `workflow_save_snapshot` returns INVALID_SCHEMA cross-check error | step 8 halt | The run's `opportunity_id` doesn't match the param. Should never fire if step 8's loop is built correctly (uses the same `synthetic.labs_opp_id` for both create and snapshot). If it does, the run record was created against a different opp than the skill thinks — investigate via `workflow_get`. |
| Re-run on existing workflows | step 2 idempotency | `workflow_create_from_template` always creates a NEW workflow (no find-or-create on labs side). Re-runs append to opp.yaml; old workflow_ids are orphaned in labs and need manual cleanup. Use `workflow_delete` directly if you need to retire a stale instance. |
| Saved-run views render blank KPIs (`—` tiles) — either build path | post-build smoke (walkthrough screenshot) shows `—` for KPI tiles | The `pipeline_sources[].alias`, the render's `view.pipelines.<alias>` read, and `snapshot_inputs.pipelines` disagree. SCRATCH: pick one alias for all three. ADAPT: the alias is the template's (`llo_weekly_review` → `data`) — read it from the create-from-template response, don't assume `flw_kpis`. See the alias-consistency guardrail before step 2 (jjackson/ace#633). |

## Related skills

- `synthetic-data-generate` — produces the synthetic data this skill's
  workflows render against.
- `synthetic-narrative-plan` — produces the manifest with `kpi_config`
  and `coaching_arcs` this skill consumes.
- `synthetic-workflow-polish` — Stage 3.2 sibling that applies per-opp
  visual edits on top of the seeded workflows. Run after this skill.
- `synthetic-summary` — links to the workflow URLs once they exist.

## Removal criteria

This skill is permanent. Saved-runs creation (step 8) was deferred to a
labs PR at first ship; that gap closed in 0.13.64 once labs shipped
`workflow_create_run` + the `workflow_save_snapshot` opp-scope fix
(connect-labs PR #168). No remaining `[WAITING ON LABS]` items.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-06 | Initial Stage 3a skill — workflow seeding via SEED templates + config wiring + coaching tasks. Saved-runs deferred to labs PR. | ACE team (Plan B Stage 3) |
| 2026-05-07 | Step 8 wires the full Week 1 + Week 2 saved-runs loop via `workflow_create_run` + `workflow_save_snapshot` (now scoped to `opportunity_id` per labs PR #168). Removes the last `[WAITING ON LABS]` deferral in Phase 7. Live-smoked against turmeric (workflow 2847, run_ids 2859 + 2860, both snapshots saved cleanly). | ACE team (Plan B Stage 3b) |
| 2026-05-28 | **Adapt-or-author build path.** Added the Build-path decision step (examine `list_templates` → ADAPT closest template or BUILD FROM SCRATCH via `workflow_create`), ADAPT/SCRATCH branches on steps 2 + 7, the fetch-`workflow_authoring_guide`-before-scratch rule, and the alias-consistency guardrail (pipeline alias == render key == `snapshot_inputs` key — the blank-KPI failure from `bednet-spot-check/20260528-0556`). Unblocked by connect-labs#300 (`workflow_create` + `workflow_authoring_guide`). Also resolves the stale `program_admin_audit` template_key — the live key is `program_admin_report`, and the examine step now reads live keys. | ACE team |

