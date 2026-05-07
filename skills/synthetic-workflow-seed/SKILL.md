---
name: synthetic-workflow-seed
description: >
  Instantiate the LLO weekly review + program admin audit workflows from
  labs SEED templates, wire them to the manifest's KPIs + coaching arcs.
disable-model-invocation: true
---

# Synthetic Workflow Seed

Stage 3 of ACE Phase 6 (Plan B). Creates the two demonstrative workflows
on top of the synthetic data: an operational `llo_weekly_review` (FLW
KPI scorecard + coaching-task spawning) and a meta-level
`program_admin_audit` (week-over-week review of the LLO's process).
Both ship as SEED templates in connect-labs (Plan A); this skill
instantiates them and wires up opp-specific config from the manifest.

The output is two workflow IDs registered in labs, one or more
synthetic OCS coaching tasks attached to underperforming FLWs, and the
pipeline schemas populated with KPI fields. The polish step
(`synthetic-workflow-polish`) layers per-opp visual edits on top.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 6 | `6-synthetic/synthetic-narrative-plan.yaml` (preferred) or `synthetic-data-generate_manifest.yaml` (fallback) | `kpi_config`, `coaching_arcs`, `flw_personas` |
| Drive | `ACE/<opp>/opp.yaml` | `synthetic.labs_opp_id` (required), `display_name`, `last_run_id` |

## Outputs

- `6-synthetic/synthetic-workflow-seed.md` — run summary (workflow IDs, task IDs, KPI count, polish-suitability flag)
- `opp.yaml.synthetic.workflows` block populated:
  ```yaml
  synthetic:
    workflows:
      llo_weekly_review_id: <int>
      program_admin_audit_id: <int>
  ```
- `run_state.yaml.phases.synthetic-data-and-workflows.synthetic-workflow-seed: done`
- Side effects in labs:
  - 1 `llo_weekly_review` workflow with the manifest's KPIs + coaching template wired into `definition.config`
  - 1 `program_admin_audit` workflow watching the above
  - 1 task per `coaching_arcs[]` entry (synthetic OCS conversation embedded as `data.ocs_conversation`)

## Process

1. **Read inputs.** Load the active manifest (prefer
   `synthetic-narrative-plan.yaml` over the Stage 1 default manifest)
   and `opp.yaml`. Halt if `opp.yaml.synthetic.labs_opp_id` is missing —
   this skill needs synthetic mode enabled (`synthetic-data-generate`
   should have run first).

2. **Create the LLO weekly review workflow.**

   ```
   mcp__connect-labs__workflow_create_from_template(
     template_key: "llo_weekly_review",
     opportunity_id: <synthetic.labs_opp_id>,
     name: "<opp.yaml.display_name> — LLO Weekly Review"  // optional
   )
   ```

   Capture the returned `workflow_id`. The response also lists the
   pipelines created from `pipeline_sources` (the scaffold's
   `flw_kpi_aggregates` pipeline); capture each `pipeline_id` for step 4.

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

5. **Spawn coaching tasks.**

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

7. **Create the program admin audit workflow.**

   ```
   mcp__connect-labs__workflow_create_from_template(
     template_key: "program_admin_audit",
     opportunity_id: <synthetic.labs_opp_id>,
     name: "<opp.yaml.display_name> — Program Admin Audit"
   )
   ```

   Then wire the watched workflow:

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

   The audit workflow reads the watched workflow's saved runs and
   renders a week-over-week compliance dashboard.

8. **Skip the saved-runs progression — gated on labs PR.**

   Plan B's Task 3.1 calls for a Week 1 + Week 2 saved-runs progression
   to make the demo show week-over-week deltas. This requires
   `workflow_save_snapshot`, which takes a run_id (an integer
   identifying a specific workflow run). The connect-labs MCP
   **does not currently expose** a way to programmatically create a
   workflow run — the existing snapshot tool needs a pre-existing
   run_id, and runs are created via the labs UI today.

   This skill stops short of saved-runs creation. The two workflows
   exist and can be opened in labs; an operator can manually click
   "Run" + "Save snapshot" twice to get the week-over-week saved-runs
   progression. Stage 3b (a connect-labs PR) ships
   `workflow_create_run(definition_id, opportunity_id)`; once that
   atom exists, this skill can be extended with two extra steps:
   create run, save snapshot.

   Surface this in the run summary as `[WAITING ON LABS]
   workflow_create_run`.

9. **Write the run summary** to
   `6-synthetic/synthetic-workflow-seed.md` via `drive_create_file`
   (find-or-update — re-runs overwrite). Body:

   - Workflow IDs: `llo_weekly_review_id`, `program_admin_audit_id`
   - Public labs URLs: `${LABS_BASE_URL}/labs/workflow/<id>/`
   - KPI count, coaching-task count, scaffold-suitability flag
   - Saved-runs status: `[WAITING ON LABS] workflow_create_run`
   - Any per-arc failures from step 5

10. **Update `opp.yaml`** via `update_yaml_file`:

    ```yaml
    synthetic:
      workflows:
        llo_weekly_review_id: <int>
        program_admin_audit_id: <int>
    ```

    `update_yaml_file` shallow-merges top-level keys; the
    `synthetic.workflows` subtree replaces wholesale. That's fine —
    Stage 1's `synthetic` block stays except for this sub-key.

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

- `mcp__connect-labs__workflow_create_from_template`
- `mcp__connect-labs__workflow_update_definition`
- `mcp__connect-labs__workflow_get` (on `VERSION_CONFLICT` retry)
- `mcp__connect-labs__pipeline_update_schema`
- `mcp__connect-labs__pipeline_get` (on `VERSION_CONFLICT` retry)
- `mcp__connect-labs__task_create_synthetic`
- `mcp__plugin_ace_ace-gdrive__drive_read_file`
- `mcp__plugin_ace_ace-gdrive__drive_create_file` (find-or-update)
- `mcp__plugin_ace_ace-gdrive__drive_update_file` (run_state read-merge-write)
- `mcp__plugin_ace_ace-gdrive__update_yaml_file` (opp.yaml `synthetic.workflows` block)

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
| `workflow_save_snapshot` blocked on labs PR | step 8 [WAITING ON LABS] | Open the workflow in labs UI, click "Run" → "Save snapshot" manually for Week 1 + Week 2. Re-run this skill once labs ships `workflow_create_run` to automate. |
| Re-run on existing workflows | step 2 idempotency | `workflow_create_from_template` always creates a NEW workflow (no find-or-create on labs side). Re-runs append to opp.yaml; old workflow_ids are orphaned in labs and need manual cleanup. Use `workflow_delete` directly if you need to retire a stale instance. |

## Related skills

- `synthetic-data-generate` — produces the synthetic data this skill's
  workflows render against.
- `synthetic-narrative-plan` — produces the manifest with `kpi_config`
  and `coaching_arcs` this skill consumes.
- `synthetic-workflow-polish` — Stage 3.2 sibling that applies per-opp
  visual edits on top of the seeded workflows. Run after this skill.
- `synthetic-summary` — links to the workflow URLs once they exist.

## Removal criteria

This skill is permanent. The `[WAITING ON LABS]` deferral on saved-runs
is a small lift in connect-labs (~50 LoC + tests for a
`workflow_create_run` MCP tool); when that ships, extend step 8 here
with the run-create + snapshot-save loop. Don't delete the skill;
extend it.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-06 | Initial Stage 3a skill — workflow seeding via SEED templates + config wiring + coaching tasks. Saved-runs deferred to labs PR. | ACE team (Plan B Stage 3) |
