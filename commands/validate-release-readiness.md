---
description: Validate that a run is ready to release to named reviewers — do every check and every non-sharing fix, then READY or NOT READY with blockers, and on READY the exact release plan (every grant and every email) that /ace:release will execute and nothing else.
argument-hint: "<workspace>/<opp>/<run-id> (--reviewers <email[:role]>,... | --from-thread <gmail-thread-id>) [--forward-source [--allow-cross-workspace-forward]] [--allow-shared connect] [--read-only]"
allowed-tools: [Bash, Read, Skill, Agent, AskUserQuestion, mcp__plugin_ace_ace-gdrive__resolve_opp_path, mcp__plugin_ace_ace-gdrive__drive_list_folder, mcp__plugin_ace_ace-gdrive__drive_read_file, mcp__plugin_ace_ace-gdrive__drive_upload_binary, mcp__plugin_ace_ace-gdrive__drive_create_doc_from_markdown, mcp__plugin_ace_ace-gdrive__drive_update_file, mcp__plugin_ace_ace-gdrive__update_yaml_file, mcp__plugin_ace_ace-gdrive__verify_run_claims, mcp__plugin_ace_ace-connect__connect_get_opportunity, mcp__plugin_ace_ace-connect__connect_list_payment_units, mcp__plugin_ace_ace-connect__connect_list_flw_invites, mcp__plugin_ace_ace-connect__commcare_get_subscription]
---

# /ace:validate-release-readiness — everything but the sharing

Read `skills/validate-release-readiness/SKILL.md` and follow it exactly with the
parsed arguments.

## Arguments

- **`<workspace>/<opp>/<run-id>`** (required) — the run, normally a clone.
- **`--reviewers`** — comma-separated emails, each optionally `:viewer` /
  `:editor` (default viewer). Or **`--from-thread <id>`**: the non-Dimagi
  participants of the ace@ thread that asked for the review. **Required for
  READY** — without reviewers the run can only come back NOT READY.
- **`--forward-source`** — plan the source run's public summary to redirect
  here. Refused when the source is in another workspace (it would take over
  that workspace's own public page, e.g. Dimagi's) unless
  **`--allow-cross-workspace-forward`** is also passed.
- **`--allow-shared connect`** — plan Connect grants into the shared orgs (only
  for a clone made with `--keep-shared connect`); each is marked for revocation.
- **`--read-only`** — a dry run: writes nothing, never releasable.

It shares nothing, invites nobody and sends no email. End with the verdict
line, every blocker (owner → fix), the warnings, and on READY the release plan
(grant table + every email) and the exact `/ace:release …` command, with the
same reviewers and flags.
