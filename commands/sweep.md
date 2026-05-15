---
description: Sweep orphaned ACE artifacts in a given system (drive supported; connect, ocs, hq, labs coming)
allowed-tools: [Read, Bash, mcp__plugin_ace_ace-gdrive__drive_list_folder, mcp__plugin_ace_ace-gdrive__drive_read_file, mcp__plugin_ace_ace-gdrive__drive_create_file, mcp__plugin_ace_ace-gdrive__drive_create_folder, mcp__plugin_ace_ace-gdrive__drive_trash_file]
---

# /ace:sweep

Find and clean up orphaned artifacts ACE has created across the systems it touches.

## Arguments

- `<system>` (optional) — one of `drive`, `connect`, `ocs`, `hq`, `labs`. Omit to be prompted.

## Process

Read `agents/sweep.md` and execute its procedure inline (this is a procedure doc, not a subagent — see `CLAUDE.md` § Agent topology). Pass `<system>` through if provided.

## Examples

```
/ace:sweep              # prompts for system
/ace:sweep drive        # sweeps Drive end-to-end
/ace:sweep connect      # "Not yet implemented — ships in PR 2"
```
