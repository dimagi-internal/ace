---
description: Decide whether a run is ready to release to a partner — READY or NOT READY, with every blocker, its owner and its fix. /ace:release refuses a run whose latest check is not READY.
argument-hint: "<workspace>/<opp>/<run-id> [--read-only]"
allowed-tools: [Bash, Read, Skill, Agent, mcp__plugin_ace_ace-gdrive__resolve_opp_path, mcp__plugin_ace_ace-gdrive__drive_list_folder, mcp__plugin_ace_ace-gdrive__drive_read_file, mcp__plugin_ace_ace-gdrive__drive_upload_binary, mcp__plugin_ace_ace-gdrive__drive_create_doc_from_markdown, mcp__plugin_ace_ace-gdrive__verify_run_claims, mcp__plugin_ace_ace-connect__connect_get_opportunity, mcp__plugin_ace_ace-connect__connect_list_payment_units, mcp__plugin_ace_ace-connect__connect_list_flw_invites]
---

# /ace:release-check — is this run ready for a partner?

Read `skills/release-check/SKILL.md` and follow it exactly with the parsed
arguments. `--read-only` writes nothing to Drive (a dry run, never releasable).
End with the verdict line, then every blocker (owner → fix), then warnings.
