---
description: Copy a completed ACE run into another ace-web workspace and rebuild its assets in that workspace's own HQ space, Connect orgs and Labs scope (the OCS bot is reviewed by its public link) — so it can be reviewed there without exposing other runs. Starts with an operator setup checklist. No invites (validate with /ace:validate-release-readiness, then share with /ace:release).
argument-hint: "<opp>/<run-id> --to <workspace> [--from <workspace>] [--hq-domain <slug>] [--pm-org <slug>] [--nm-org <slug>] [--labs-domain <@domain>] [--co-owner <email>] [--keep-shared connect]"
allowed-tools: [Bash, Read, Skill, mcp__plugin_ace_ace-gdrive__resolve_opp_path, mcp__plugin_ace_ace-gdrive__drive_read_file, mcp__plugin_ace_ace-gdrive__update_yaml_file, mcp__plugin_ace_ace-connect__commcare_list_apps, mcp__plugin_ace_ace-connect__commcare_get_subscription, mcp__plugin_ace_ace-connect__commcare_linked_app_copy, mcp__plugin_ace_ace-connect__commcare_make_build, mcp__plugin_ace_ace-connect__commcare_release_build, mcp__plugin_ace_ace-connect__commcare_create_api_key, mcp__plugin_ace_ace-connect__connect_list_programs, mcp__plugin_ace_ace-connect__connect_list_opportunities, mcp__plugin_ace_ace-connect__connect_get_opportunity, mcp__plugin_ace_ace-connect__connect_list_payment_units, mcp__plugin_ace_ace-connect__connect_list_flw_invites, mcp__plugin_ace_ace-gdrive__drive_list_folder, mcp__plugin_ace_ace-gdrive__drive_upload_binary, mcp__plugin_ace_ace-gdrive__drive_create_doc_from_markdown, mcp__plugin_ace_ace-gdrive__drive_update_file, mcp__plugin_ace_ace-gdrive__verify_run_claims, mcp__plugin_ace_ace-gdrive__drive_create_folder, mcp__plugin_ace_connect-labs__synthetic_set_allowed_domains, mcp__connect_labs__synthetic_set_allowed_domains, Agent]
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
- **`--pm-org <slug>` / `--nm-org <slug>`** — the two Connect organizations the
  operator created: the one that runs the program and the one that holds the
  opportunity. Omit on the first call: the checklist asks for them.
- **`--labs-domain` / `--co-owner`** (optional) — used only when the target
  workspace or its default tenancy has to be created (Step 0).
- **`--keep-shared connect`** (optional, escape hatch only) — keep the source's
  Connect program + opportunity in the shared orgs instead of rebuilding them in
  the partner's orgs. Not the default; use only when the operator asks.

## Process

Invoke the `clone-to-new-workspace` skill with the parsed arguments and follow
it exactly: workspace → **operator setup checklist** (printed verbatim by
`scripts/clone-setup-checklist.ts`; stop until the operator replies with the
slugs) → ACE accepts its own invitations and verifies every item → default
tenancy → preflight → ace-web copy → `bin/ace-bind` to the NEW opp → rebuild
per system (Connect rebuilt in the partner's orgs by default) → report.
