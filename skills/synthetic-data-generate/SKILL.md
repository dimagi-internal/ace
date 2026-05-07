---
name: synthetic-data-generate
description: >
  Generate a synthetic FLW + visit + payment dataset against an ACE-built opp
  via the connect-labs synthetic_generate_from_manifest atom.
disable-model-invocation: true
---

# Synthetic Data Generate

Stage 1 MVP for ACE Phase 6 (Synthetic Data and Workflows). Authors a manifest
for an opp, calls the deployed connect-labs synthetic generator, and registers
the resulting GDrive fixture folder as the `SyntheticOpportunity` for that opp
in labs.

The generated data lights up labs dashboards, pipelines, and workflows for the
opp without requiring any production traffic — Dimagi staff can forward the
labs URL to a stakeholder, prospective LLO, or funder before the opp has any
real activity.

The full Phase 6 design (narrative-plan, workflow-seed, walkthroughs, etc.) is
deferred to later stages. This skill is the data plumbing only.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Operator (CLI) | `--opp <slug>` | opp folder under `ACE/` |
| Operator (CLI) | `--opp-int-id <integer>` | labs-side integer opportunity ID (required for v1; UUID→int automation is deferred) |
| Operator (CLI, optional) | `--manifest <drive-path>` | pre-authored manifest YAML; if omitted, the skill writes a default and pauses |
| Operator (CLI, optional) | `--no-pause` | skip the manifest-review pause when accepting the default |
| Phase 1 | `inputs/pdd.md` | (default-manifest mode) primary measurement field for the KPI |
| Phase 3 | `3-connect/connect-opp-setup.md` | (default-manifest mode) payment unit + deliver unit hints |
| Drive | `ACE/<opp>/opp.yaml` | `program_id`, `last_run_id`, opp display name |

## Outputs

- `6-synthetic/synthetic-data-generate_manifest.yaml` — the manifest sent to labs (default or operator-edited)
- `6-synthetic/synthetic-data-generate.md` — run summary (folder ID, record counts, labs URL, warnings)
- `6-synthetic/synthetic-data-generate_error.md` — written instead of the summary on `INVALID_SCHEMA` failures
- `opp.yaml.synthetic` block populated with `enabled`, `current_folder_id`, `current_run_id`, `generated_at`, `fixture_record_counts`
- `run_state.yaml.phases.synthetic-data-and-workflows.synthetic-data-generate: done`

## Process

1. **Resolve opp identity.**

   Read `ACE/<opp>/opp.yaml` via `mcp__plugin_ace_ace-gdrive__drive_read_file`.
   Extract:

   - `program_id` (flat top-level, written by `connect-program-setup`) — informational
   - Connect opp UUID — try in order: `connect.opportunity.id`, flat
     `opportunity_id`, then `solicitation.connect_opportunity_id`
     (the path turmeric currently uses). Required for the payment-units
     pre-flight in step 1a; if none of these are present, skip 1a with a
     `[WARN]` instead of halting.
   - `organization_slug` — flat top-level, defaults to `ai-demo-space` if absent
   - `connect.opportunity.url` if present — informational
   - `last_run_id` — required; if missing, halt with "run `/ace:run <opp>` first to bootstrap a run folder"

   Halt if `--opp-int-id` is missing — Stage 1 requires the operator to provide
   the labs-side integer manually. (UUID→int automation is Stage 4.)

   Construct the run folder path:
   `ACE/<opp>/runs/<last_run_id>/6-synthetic/`. Create it via
   `mcp__plugin_ace_ace-gdrive__drive_create_folder` if missing.

   Note on phase-folder numbering: until Phase 6 is formally renumbered
   (Stage 4 of Plan B), `6-` already names `6-solicitation-management`. The
   `6-synthetic/` folder coexists at the run level — both directories live
   side-by-side in the run folder until renumbering happens. This mirrors the
   plan and is intentional for Stage 1.

1a. **Payment-units pre-flight.** If a Connect opp UUID was resolved in
    step 1, call:

    ```
    mcp__plugin_ace_ace-connect__connect_list_payment_units(
      organization_slug: <from opp.yaml>,
      opportunity_id: <Connect opp UUID>
    )
    ```

    Capture `payment_unit_count` for use in step 4. If the count is 0, the
    synthetic engine will mint visits but `completed_works` and
    `completed_module` will both be 0 — the engine has nothing to mint
    payments against. This is a soft warning, not a halt: the demo still
    works (the LLO-weekly-review and audit dashboards in later stages
    render visit data, not payments), but a stakeholder demo that needs
    payments visualized requires payment units first. Surface the warning
    at the top of the run summary in step 4.

    On any error from this call (timeout, 4xx, etc.) treat it as
    `payment_unit_count: unknown` and continue — never block synthetic
    generation on a pre-flight signal.

2. **Author or load the manifest.**

   **If `--manifest <path>` is supplied:** read that file via `drive_read_file`
   and use the body verbatim as `manifest_yaml`. Skip to step 3.

   **Otherwise, look for the narrative-plan manifest first.** If
   `6-synthetic/synthetic-narrative-plan.yaml` exists in the run folder
   (Stage 2 of Plan B's `synthetic-narrative-plan` skill produces it),
   read it and use it as `manifest_yaml`. Skip to step 3.

   When the narrative-plan manifest is consumed, log "consuming
   narrative-plan manifest from `<path>`" so the operator sees which
   source drove the run. The narrative plan's named FLWs / anomalies /
   coaching arcs flow through verbatim — `synthetic-data-generate` is a
   thin wrapper around the labs MCP, not a re-author.

   **Otherwise (default-manifest mode):** read the PDD at
   `ACE/<opp>/inputs/pdd.md` and the connect setup summary at
   `ACE/<opp>/runs/<last_run_id>/3-connect/connect-opp-setup.md`. Use them
   to fill in:

   - `opportunity_name` — from `opp.yaml.display_name`
   - The primary measurement field for the single seeded KPI — guess from
     the PDD's Deliver App Specification (e.g. `form.weight_kg` for a
     nutrition opp, `form.muac_cm` for malnutrition, `form.price_inr`
     for a market-survey opp). If no obvious measurement field is present,
     emit `kpi_config: []` and warn in the summary that the operator should
     add KPIs by editing the manifest before generation.

   Default manifest shape (5 FLWs, 1 cohort sized 50, 4-week timeline,
   8 visits/wk/FLW, 1 KPI, no anomalies, no coaching arcs):

   ```yaml
   opportunity_id: <integer from --opp-int-id>
   opportunity_name: "<opp.yaml.display_name>"
   random_seed: 20260506

   timeline:
     start_date: <today − 30d, YYYY-MM-DD>
     end_date:   <today + 0d,  YYYY-MM-DD>   # 4-week window ending today
     weeks: 4
     visit_cadence_per_week_per_flw: { mean: 8, stddev: 2 }

   flw_personas:
     - id: "asha"
       display_name: "Asha M."
       archetype: "rockstar"
       accuracy_distribution:     { mean: 0.92, stddev: 0.04 }
       completeness_distribution: { mean: 0.95, stddev: 0.03 }
       flag_rate: 0.02
     - id: "bao"
       display_name: "Bao N."
       archetype: "steady"
       accuracy_distribution:     { mean: 0.85, stddev: 0.05 }
       completeness_distribution: { mean: 0.90, stddev: 0.04 }
       flag_rate: 0.05
     - id: "carla"
       display_name: "Carla R."
       archetype: "steady"
       accuracy_distribution:     { mean: 0.83, stddev: 0.05 }
       completeness_distribution: { mean: 0.88, stddev: 0.05 }
       flag_rate: 0.06
     - id: "dinesh"
       display_name: "Dinesh P."
       archetype: "struggling"
       accuracy_distribution:     { mean: 0.62, stddev: 0.10 }
       completeness_distribution: { mean: 0.78, stddev: 0.08 }
       flag_rate: 0.18
     - id: "esi"
       display_name: "Esi K."
       archetype: "new_hire"
       accuracy_distribution:     { mean: 0.74, stddev: 0.08 }
       completeness_distribution: { mean: 0.85, stddev: 0.06 }
       flag_rate: 0.10

   beneficiary_cohorts:
     - id: "primary"
       size: 50
       field_distributions: {}     # operator fills these by hand if desired
       progression: "flat"

   anomalies: []
   coaching_arcs: []

   kpi_config:
     - kpi: "accuracy"
       field_path: "<guessed-measurement-field-or-empty>"
       aggregation: "validated_rate"
       threshold_underperform: 0.75
       threshold_target: 0.90
   ```

   Save the manifest as
   `6-synthetic/synthetic-data-generate_manifest.yaml` via
   `mcp__plugin_ace_ace-gdrive__drive_create_file`.

   **Pause for operator review unless `--no-pause` is set.** The default is a
   starting point — operators typically tune cohort size, timeline, and add
   1–2 anomalies before generation. Surface the manifest path and prompt the
   operator to edit-then-resume. On resume, re-read the manifest from Drive
   (operator may have edited it directly in Docs) before passing to the MCP.

3. **Call the labs MCP.**

   ```
   mcp__connect-labs__synthetic_generate_from_manifest(
     opportunity_id: <integer from --opp-int-id>,
     manifest_yaml: "<full text of the manifest from step 2>"
   )
   ```

   `manifest_yaml` is a string (full YAML text, not a parsed object) per the
   labs tool contract — the engine Pydantic-validates server-side.

   **On success**, capture from the response:
   - `folder_id` — GDrive folder where the 5 fixture JSONs landed
   - `record_counts` — per-endpoint integer counts (`user_visits`,
     `user_data`, `completed_works`, `completed_module`, `opportunity`)
   - `form_schema_questions` — count of question paths the engine resolved
     from the deliver app's HQ schema (0 means deliver app empty / unreachable)

   **Error handling:**
   - `PERMISSION_DENIED` (operator not in labs `accessible_opp_ids` for this
     opp) → halt with: "ace@dimagi-ai.com is not authorized for labs
     opportunity_id=<int>; check Connect membership / labs admin grant before
     retrying."
   - `INVALID_SCHEMA` (manifest fails Pydantic validation) → write the
     verbatim error body to `6-synthetic/synthetic-data-generate_error.md`
     and halt. Do not retry; the operator must edit the manifest.
   - Transport / 5xx errors → halt with the labs error body verbatim and a
     pointer to `/ace:doctor` `[Connect Labs]`.

3a. **Verify the fixture folder.** Once labs's GDrive parent is shared with
    `ace-service-account@connect-labs.iam.gserviceaccount.com` (one-time
    Drive admin action — see Plan B issue table item #1), the folder labs
    just created becomes visible to ACE. Call:

    ```
    mcp__plugin_ace_ace-gdrive__drive_list_folder(folderId: <folder_id from step 3>)
    ```

    Assert the folder contains exactly the five expected fixture JSONs:
    `opportunity.json`, `user_visits.json`, `user_data.json`,
    `completed_works.json`, `completed_module.json`. Capture each file's id
    + webViewLink so the run summary can deep-link them.

    If `drive_list_folder` returns `[]` (folder exists but is empty / not
    shared), surface this as a `[WARN]` in step 4 with text: "Labs fixture
    folder is not shared with ACE — verification skipped. Add
    `ace-service-account@connect-labs.iam.gserviceaccount.com` as a
    Reader on `LABS_SYNTHETIC_GDRIVE_PARENT_FOLDER_ID` (or its parent
    Shared Drive) to enable per-file verification on future runs." Do
    not halt — the labs-side `record_counts` are authoritative; this
    step is a defense-in-depth check.

4. **Write the run summary** to
   `6-synthetic/synthetic-data-generate.md` via `drive_create_file`
   (find-or-update — re-runs overwrite the same file rather than
   creating a duplicate). Include in this order:

   - Top-of-doc warning banner if any of the following fired:
     `[WARN] payment_unit_count = 0` (from step 1a) → "this opp has no
     payment units; `completed_works` and `completed_module` will be 0";
     `[WARN] form_schema_questions = 0` (from step 3) → "deliver app
     empty or unreachable; visit `form_json` will be sparse";
     `[WARN] labs fixture folder not shared with ACE` (from step 3a).
     Skip the banner entirely if all three are clean.
   - Manifest path: `ACE/<opp>/runs/<run-id>/6-synthetic/synthetic-data-generate_manifest.yaml`
   - GDrive fixture folder: `https://drive.google.com/drive/folders/<folder_id>`
   - Per-file fixture links table (from step 3a), if verification ran
   - Record counts table (one row per endpoint)
   - Form schema questions resolved: `<count>`
   - Labs URL where the synthetic data is now visible:
     `${LABS_BASE_URL}/a/<organization_slug>/opportunity/<opp-int-id>/`
     (read `LABS_BASE_URL` from the same env the connect-labs proxy uses;
     default `https://labs.connect.dimagi.com`.)

5. **Update `opp.yaml`** via
   `mcp__plugin_ace_ace-gdrive__update_yaml_file`, adding:

   ```yaml
   synthetic:
     enabled: true
     current_folder_id: "<folder_id>"
     current_run_id: "<last_run_id>"
     generated_at: "<ISO-8601 UTC of MCP response receipt>"
     fixture_record_counts:
       user_visits: <int>
       user_data: <int>
       completed_works: <int>
       completed_module: <int>
       opportunity: <int>
   ```

   If a `synthetic:` block already exists (re-run), overwrite all fields
   (Stage 1 keeps a single current pointer; older folders are retained
   labs-side per the design's forensics convention).

6. **Update `run_state.yaml`** — read-merge-write, NOT a naïve
   `update_yaml_file` patch.

   `update_yaml_file` shallow-merges top-level keys (replace, not
   deep-merge — see its tool description). Sending
   `{phases: {synthetic-data-and-workflows: {...}}}` would replace the
   entire `phases:` block, clobbering `design-review`, `ocs-setup`,
   `qa-and-training`, `solicitation-management`, etc. Instead:

   1. `mcp__plugin_ace_ace-gdrive__drive_read_file` on
      `<run-folder>/run_state.yaml`. Capture the response's
      `revisionVersion`.
   2. Parse the YAML body, deep-merge a new `phases.synthetic-data-and-workflows`
      entry (creating the parent `phases:` block if absent), and update
      `last_actor` / `last_actor_at`.
   3. `mcp__plugin_ace_ace-gdrive__drive_update_file` with the full
      serialized YAML and `ifMatchRevisionId: <captured revisionVersion>`.
      On `revision_conflict`, re-read once and retry.

   The new entry shape:

   ```yaml
   phases:
     synthetic-data-and-workflows:
       started_at: <ISO at step 3 dispatch>
       completed_at: <ISO at step 6>
       status: done
       steps:
         synthetic-data-generate:
           status: done
           labs_opp_id: <int from --opp-int-id>
           fixture_folder_id: <folder_id>
           record_counts: <full dict from MCP response>
           form_schema_questions: <int>
           artifacts:
             manifest: <Drive ID>
             summary: <Drive ID>
   ```

   Stage 4 of Plan B will wire the full skill list
   (`synthetic-narrative-plan`, `synthetic-workflow-seed`, etc.); in
   Stage 1 only `synthetic-data-generate` and `synthetic-summary` exist.

## MCP Tools Used

- `mcp__connect-labs__synthetic_generate_from_manifest`
- `mcp__plugin_ace_ace-connect__connect_list_payment_units` (pre-flight, step 1a)
- `mcp__plugin_ace_ace-gdrive__drive_read_file`
- `mcp__plugin_ace_ace-gdrive__drive_create_file` (find-or-update by default — re-runs overwrite same-name files)
- `mcp__plugin_ace_ace-gdrive__drive_create_folder`
- `mcp__plugin_ace_ace-gdrive__drive_list_folder` (fixture verification, step 3a)
- `mcp__plugin_ace_ace-gdrive__drive_update_file` (run_state merge, step 6)
- `mcp__plugin_ace_ace-gdrive__update_yaml_file` (opp.yaml `synthetic` block only — top-level scalar key, safe for shallow-merge)

## Mode Behavior

- **Default:** Write the default manifest, pause for operator review, then
  generate. Operator typically edits cohort size / timeline / anomalies.
- **`--no-pause`:** Skip the review and generate against the default
  manifest immediately. Useful for smoke tests and CI; not recommended for
  stakeholder-facing runs.
- **`--manifest <path>`:** Skip authoring; use the supplied manifest as-is
  (no pause).

## Dry-Run Behavior

When `--dry-run` is active:

- Write the manifest to Drive as normal.
- Skip the `synthetic_generate_from_manifest` call.
- Write `6-synthetic/synthetic-data-generate.md` with a `> dry-run: no labs
  call made` banner and the manifest path.
- Do not mutate `opp.yaml`. State tracks as `dry-run-success`.

## Failure Modes

| Failure | Detection | Recovery |
|---|---|---|
| `--opp-int-id` not provided | step 1 halt | Operator finds the integer in the labs synthetic UI dropdown and re-runs. Stage 4 will automate via `connect-opp-setup`. |
| `opp.yaml` missing `last_run_id` | step 1 halt | Run `/ace:run <opp>` first so the orchestrator bootstraps a run folder. |
| PDD missing primary measurement field | step 2 warn | Default manifest emits `kpi_config: []`; operator adds KPIs in the pause. |
| `INVALID_SCHEMA` from labs | step 3 halt | Operator edits the manifest (error body written to `_error.md`) and re-invokes. |
| `PERMISSION_DENIED` from labs | step 3 halt | Confirm `ace@dimagi-ai.com` membership in the opp's Connect organization, then retry. |
| `form_schema_questions = 0` | step 4 warn | Visit data is generated with empty `form_json`; if the demo needs schema-coherent fields, debug the deliver app's HQ availability and re-run. |
| `payment_unit_count = 0` | step 1a warn → step 4 banner | `completed_works`/`completed_module` will be 0. Add payment units via `connect-opp-setup` and re-run if a stakeholder demo needs payments visualized. Otherwise the demo still works for visit-based dashboards. |
| Labs fixture folder not shared with ACE SA | step 3a `[]` empty list | Per-file verification skipped; `record_counts` from the labs MCP is still authoritative. To enable verification, share `LABS_SYNTHETIC_GDRIVE_PARENT_FOLDER_ID` (or its parent Shared Drive) with `ace-service-account@connect-labs.iam.gserviceaccount.com`. |
| Re-run on an opp that already has `synthetic.enabled = true` | step 5 overwrite | Old folder retained labs-side. The summary file overwrites in place (find-or-update). To fully tear down, call `synthetic_disable(opp_int_id)` directly; no skill yet. |

## Tear-down

There is no Stage 1 skill for disabling synthetic mode. To revert an opp,
call the labs MCP directly:

```
mcp__connect-labs__synthetic_disable(opportunity_id: <int>)
```

The fixture folder is retained labs-side for forensics. Stage 4 may add a
`synthetic-teardown` skill; for now this is a manual call.

## Related skills

- `synthetic-summary` — Stage 1 sibling that composes a one-page,
  reviewer-facing summary from this skill's output. Run `/ace:step
  synthetic-summary --opp <slug>` after this skill completes.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-06 | Initial Stage 1 MVP skill — default manifest + labs MCP call + opp.yaml update | ACE team (Plan B Stage 1) |
| 2026-05-06 | Post-smoke fixes: payment-unit pre-flight (step 1a), fixture verification (step 3a), read-merge-write run_state update (step 6 — replaces naïve `update_yaml_file` patch that would clobber sibling phases), warning banner in run summary for payment-unit/schema/share gaps. | ACE team (Plan B Stage 1.1) |
