---
description: Deprecated alias for /ace:validate-release-readiness — use that instead.
argument-hint: "<workspace>/<opp>/<run-id> (--reviewers <email[:role]>,... | --from-thread <id>) [--forward-source [--allow-cross-workspace-forward]] [--allow-shared connect] [--read-only]"
allowed-tools: [Bash, Read, Skill, Agent, AskUserQuestion, mcp__plugin_ace_ace-gdrive__resolve_opp_path, mcp__plugin_ace_ace-gdrive__drive_list_folder, mcp__plugin_ace_ace-gdrive__drive_read_file, mcp__plugin_ace_ace-gdrive__drive_upload_binary, mcp__plugin_ace_ace-gdrive__drive_create_doc_from_markdown, mcp__plugin_ace_ace-gdrive__drive_update_file, mcp__plugin_ace_ace-gdrive__update_yaml_file, mcp__plugin_ace_ace-gdrive__verify_run_claims, mcp__plugin_ace_ace-connect__connect_get_opportunity, mcp__plugin_ace_ace-connect__connect_list_payment_units, mcp__plugin_ace_ace-connect__connect_list_flw_invites, mcp__plugin_ace_ace-connect__commcare_get_subscription]
---

# /ace:release-check — deprecated

`/ace:release-check` was replaced by **`/ace:validate-release-readiness`**
(2026-10-03). Tell the operator so in one line, then read
`commands/validate-release-readiness.md` and follow it with the same arguments.
Without `--reviewers` / `--from-thread` the run can only come back NOT READY.
