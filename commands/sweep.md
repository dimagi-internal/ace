---
description: Sweep orphaned ACE artifacts across drive, connect, ocs, hq, and labs
allowed-tools: [Read, Bash, mcp__plugin_ace_ace-gdrive__drive_list_folder, mcp__plugin_ace_ace-gdrive__drive_read_file, mcp__plugin_ace_ace-gdrive__drive_create_file, mcp__plugin_ace_ace-gdrive__drive_create_folder, mcp__plugin_ace_ace-gdrive__drive_trash_file, mcp__plugin_ace_ace-connect__connect_list_programs, mcp__plugin_ace_ace-connect__connect_list_opportunities, mcp__plugin_ace_ace-connect__connect_list_invites, mcp__plugin_ace_ace-connect__connect_update_opportunity, mcp__plugin_ace_ace-connect__connect_delete_unaccepted_flw_invites, mcp__plugin_ace_ace-connect__commcare_list_apps, mcp__plugin_ace_ace-connect__commcare_delete_app, mcp__plugin_ace_ace-ocs__ocs_list_chatbots, mcp__plugin_ace_ace-ocs__ocs_list_sessions, mcp__plugin_ace_ace-ocs__ocs_end_session, mcp__plugin_ace_ace-ocs__ocs_archive_chatbot, mcp__plugin_ace_ace-ocs__ocs_archive_pipeline, mcp__connect_labs__workflow_list, mcp__connect_labs__pipeline_list, mcp__connect_labs__list_solicitations, mcp__connect_labs__list_funds, mcp__connect_labs__list_reviews, mcp__connect_labs__list_responses, mcp__connect_labs__workflow_delete, mcp__connect_labs__pipeline_delete, mcp__connect_labs__synthetic_disable, mcp__connect_labs__labs_delete_record]
---

# /ace:sweep

Find and clean up orphaned artifacts ACE has created across the systems it touches.

## Arguments

- `<system>` (optional) — one of `drive`, `connect`, `ocs`, `hq`, `labs`, `all`. Omit to be prompted.

## Process

Read `agents/sweep.md` and execute its procedure inline (this is a procedure doc, not a subagent — see `CLAUDE.md` § Agent topology). Pass `<system>` through if provided.

## Examples

```
/ace:sweep              # prompts for system
/ace:sweep drive        # auto-trashes orphan Drive folders on approval
/ace:sweep connect      # auto-deactivates orphan opps + auto-deletes unaccepted FLW invites
/ace:sweep ocs          # auto-archives orphan chatbots + pipelines + ends orphan sessions (collections never auto-archived — shared with golden template)
/ace:sweep hq           # auto-soft-deletes orphan apps (90-day restorable via HQ admin UI)
/ace:sweep labs         # auto-deletes/disables orphan workflows, pipelines, synthetic, and LabsRecord types
/ace:sweep all          # runs all five in sequence with a unified summary
```

## Coverage matrix

See `agents/sweep.md § Status of per-system delete coverage` for which products have auto-delete vs upstream gap.
