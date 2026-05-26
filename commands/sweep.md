---
description: Sweep orphaned ACE artifacts across drive, connect, ocs, hq, labs, ace-web; or prune per-opp run history via opp-runs
allowed-tools: [Read, Bash, mcp__plugin_ace_ace-gdrive__drive_list_folder, mcp__plugin_ace_ace-gdrive__drive_read_file, mcp__plugin_ace_ace-gdrive__drive_create_file, mcp__plugin_ace_ace-gdrive__drive_create_folder, mcp__plugin_ace_ace-gdrive__drive_trash_file, mcp__plugin_ace_ace-connect__connect_list_programs, mcp__plugin_ace_ace-connect__connect_list_opportunities, mcp__plugin_ace_ace-connect__connect_list_invites, mcp__plugin_ace_ace-connect__connect_update_opportunity, mcp__plugin_ace_ace-connect__connect_delete_unaccepted_flw_invites, mcp__plugin_ace_ace-connect__commcare_list_apps, mcp__plugin_ace_ace-connect__commcare_delete_app, mcp__plugin_ace_ace-ocs__ocs_list_chatbots, mcp__plugin_ace_ace-ocs__ocs_list_sessions, mcp__plugin_ace_ace-ocs__ocs_end_session, mcp__plugin_ace_ace-ocs__ocs_delete_chatbot, mcp__plugin_ace_ace-ocs__ocs_delete_pipeline, mcp__plugin_ace_ace-ocs__ocs_delete_collection, mcp__connect_labs__workflow_list, mcp__connect_labs__pipeline_list, mcp__connect_labs__list_solicitations, mcp__connect_labs__list_funds, mcp__connect_labs__list_reviews, mcp__connect_labs__list_responses, mcp__connect_labs__workflow_delete, mcp__connect_labs__pipeline_delete, mcp__connect_labs__synthetic_disable, mcp__connect_labs__delete_solicitation]
---

# /ace:sweep

Find and clean up orphaned artifacts ACE has created across the systems it touches.

## Arguments

- `<system>` (optional) — one of `drive`, `connect`, `ocs`, `hq`, `labs`, `opp-runs`, `ace-web`, `all`. Omit to be prompted.
- `--keep <N>` (optional, `opp-runs` only) — newest runs to retain per opp. Defaults to `3` if omitted; prompted if you also omit the system.

## Process

Read `agents/sweep.md` and execute its procedure inline (this is a procedure doc, not a subagent — see `CLAUDE.md` § Agent topology). Pass `<system>` through if provided.

## Examples

```
/ace:sweep              # prompts for system
/ace:sweep drive        # auto-trashes orphan Drive folders on approval
/ace:sweep connect      # auto-deactivates orphan opps + auto-deletes unaccepted FLW invites
/ace:sweep ocs          # auto-deletes orphan chatbots + pipelines + per-opp collections + ends orphan sessions (golden template + shared collection safe-listed)
/ace:sweep hq           # auto-soft-deletes orphan apps (90-day restorable via HQ admin UI)
/ace:sweep labs         # auto-deletes orphan workflows + pipelines + solicitations (cascade; gated on responses+reviews == 0); disables synthetic; funds + standalone reviews/responses report-only
/ace:sweep opp-runs            # retention prune: keep newest 3 runs per opp under ACE/<opp>/runs/ (default --keep 3)
/ace:sweep opp-runs --keep 5   # keep newest 5 runs per opp instead
/ace:sweep ace-web      # bulk-deletes every uploaded chat Session on the deployed ace-web that this PAT can write to (CASCADEs uploads, messages, share tokens)
/ace:sweep all          # runs drive + connect + ocs + hq + labs + ace-web in sequence (opp-runs excluded — retention is a manual decision)
```

## Coverage matrix

See `agents/sweep.md § Status of per-system delete coverage` for which products have auto-delete vs upstream gap.
