---
description: Copy a completed ACE run into another ace-web workspace and rebuild its assets in that workspace's own HQ space, Connect orgs and Labs scope (the OCS bot is reviewed by its public link) — so it can be reviewed there without exposing other runs. No invites (that is /ace:release).
argument-hint: "<opp>/<run-id> --to <workspace> [--from <workspace>] [--hq-domain <slug>] [--labs-domain <@domain>] [--co-owner <email>] [--keep-shared connect]"
allowed-tools: [Bash, Read, Skill, mcp__plugin_ace_ace-gdrive__resolve_opp_path, mcp__plugin_ace_ace-gdrive__drive_read_file, mcp__plugin_ace_ace-gdrive__update_yaml_file, mcp__plugin_ace_ace-connect__commcare_list_apps, mcp__plugin_ace_ace-connect__commcare_create_domain, mcp__plugin_ace_ace-connect__commcare_linked_app_copy, mcp__plugin_ace_ace-connect__commcare_make_build, mcp__plugin_ace_ace-connect__commcare_release_build, mcp__plugin_ace_ace-connect__commcare_create_api_key, mcp__plugin_ace_ace-connect__connect_list_programs, mcp__plugin_ace_ace-connect__connect_list_opportunities, mcp__plugin_ace_ace-connect__connect_get_opportunity, mcp__plugin_ace_ace-gdrive__drive_create_folder, mcp__plugin_ace_connect-labs__synthetic_set_allowed_domains, mcp__connect_labs__synthetic_set_allowed_domains, Agent]
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
- **`--hq-domain` / `--labs-domain` / `--co-owner`** (optional) — used only
  when the target workspace or its default tenancy has to be created (Step 0).
- **`--keep-shared connect`** (optional, interim) — keep the source's Connect
  program + opportunity in the shared orgs.

## Process

Invoke the `clone-to-new-workspace` skill with the parsed arguments and follow
it exactly: preflight (creates nothing, lists every manual setup item) → ace-web
copy → `bin/ace-bind` to the NEW opp → rebuild per system → report.
