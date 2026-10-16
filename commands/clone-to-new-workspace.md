---
description: Copy a completed ACE run into another ace-web workspace and rebuild its assets in that workspace's own HQ space, Connect orgs and Labs scope (the OCS bot is reviewed by its public link) — so it can be reviewed there without exposing other runs. Starts with an operator setup checklist. No invites (validate with /ace:validate-release-readiness, then share with /ace:release).
argument-hint: "<opp>/<run-id> --to <workspace> [--from <workspace>] [--hq-domain <slug>] [--pm-org <slug>] [--nm-org <slug>] [--co-owner <email>] [--keep-shared connect]"
allowed-tools: [Bash, Read, Skill, mcp__plugin_ace_ace-gdrive__resolve_opp_path, mcp__plugin_ace_ace-gdrive__drive_read_file, mcp__plugin_ace_ace-gdrive__update_yaml_file, mcp__plugin_ace_ace-connect__commcare_list_apps, mcp__plugin_ace_ace-connect__commcare_get_subscription, mcp__plugin_ace_ace-connect__commcare_linked_app_copy, mcp__plugin_ace_ace-connect__commcare_make_build, mcp__plugin_ace_ace-connect__commcare_release_build, mcp__plugin_ace_ace-connect__commcare_create_api_key, mcp__plugin_ace_ace-connect__connect_list_programs, mcp__plugin_ace_ace-connect__connect_list_opportunities, mcp__plugin_ace_ace-connect__connect_get_opportunity, mcp__plugin_ace_ace-connect__connect_list_payment_units, mcp__plugin_ace_ace-connect__connect_list_flw_invites, mcp__plugin_ace_ace-gdrive__drive_list_folder, mcp__plugin_ace_ace-gdrive__drive_upload_binary, mcp__plugin_ace_ace-gdrive__drive_create_doc_from_markdown, mcp__plugin_ace_ace-gdrive__drive_update_file, mcp__plugin_ace_ace-gdrive__verify_run_claims, mcp__plugin_ace_ace-gdrive__drive_create_folder, mcp__plugin_ace_connect-labs__synthetic_clone_to_labs_only, mcp__connect_labs__synthetic_clone_to_labs_only, mcp__plugin_ace_connect-labs__synthetic_local_records_count, mcp__connect_labs__synthetic_local_records_count, mcp__plugin_ace_connect-labs__semantic_registry_get, mcp__connect_labs__semantic_registry_get, mcp__plugin_ace_connect-labs__pipeline_get, mcp__connect_labs__pipeline_get, mcp__plugin_ace_connect-labs__semantic_registry_validate, mcp__connect_labs__semantic_registry_validate, mcp__plugin_ace_connect-labs__semantic_registry_create, mcp__connect_labs__semantic_registry_create, mcp__plugin_ace_connect-labs__workflow_create_from_template, mcp__connect_labs__workflow_create_from_template, mcp__plugin_ace_connect-labs__workflow_get, mcp__connect_labs__workflow_get, mcp__plugin_ace_connect-labs__pipeline_update_schema, mcp__connect_labs__pipeline_update_schema, mcp__plugin_ace_connect-labs__pipeline_preview, mcp__connect_labs__pipeline_preview, mcp__plugin_ace_connect-labs__workflow_preview_as_of, mcp__connect_labs__workflow_preview_as_of, mcp__plugin_ace_connect-labs__benchmarks_cohort_create, mcp__connect_labs__benchmarks_cohort_create, mcp__plugin_ace_connect-labs__benchmarks_cohort_add_opportunities, mcp__connect_labs__benchmarks_cohort_add_opportunities, mcp__plugin_ace_connect-labs__benchmarks_create_opp_reports, mcp__connect_labs__benchmarks_create_opp_reports, mcp__plugin_ace_connect-labs__workflow_rebuild_history, mcp__connect_labs__workflow_rebuild_history, mcp__plugin_ace_connect-labs__workflow_history_runs, mcp__connect_labs__workflow_history_runs, mcp__plugin_ace_connect-labs__benchmarks_publish, mcp__connect_labs__benchmarks_publish, mcp__plugin_ace_connect-labs__labs_context, mcp__connect_labs__labs_context, Agent]
---

# /ace:clone-to-new-workspace — copy a run into its own workspace

Copy one completed run into another ace-web workspace and rebuild its assets in
that workspace's tenancy. The source run is untouched; nobody is invited.

## Arguments

- **`<opp>/<run-id>`** (required) — the source run.
- **`--to <workspace>`** (required) — the target ace-web workspace; its default
  tenancy says where the rebuilt assets go.
- **`--from <workspace>`** (optional) — source workspace; default
  `$ACE_WEB_WORKSPACE`.
- **`--hq-domain <slug>`** — the HQ project space the operator created from the
  setup checklist. Omit on the first call: the checklist asks for it.
- **`--pm-org <slug>` / `--nm-org <slug>`** — the two Connect organizations: the
  one that runs the program and the one that holds the opportunity. Default
  `<to>-pm-test` / `<to>-nm-test`, which ACE creates itself; pass them only to
  reuse existing orgs.
- **`--co-owner`** (optional) — used only when the target
  workspace or its default tenancy has to be created (Step 0).
- **`--keep-shared connect`** (optional, escape hatch only) — keep the source's
  Connect program + opportunity in the shared orgs instead of rebuilding them in
  the partner's orgs. Not the default; use only when the operator asks.

## Process

Invoke the `clone-to-new-workspace` skill with the parsed arguments and follow
it exactly: workspace → ACE creates the HQ space and both Connect orgs →
**operator setup checklist** (printed verbatim by
`scripts/clone-setup-checklist.ts`: only HQ demo mode and the two settings on
each Connect org's edit page; stop until the operator replies "done") → ACE
verifies every item → default
tenancy → preflight → ace-web copy → `bin/ace-bind` to the NEW opp → rebuild
per system (Connect rebuilt in the partner's orgs by default) → report.
