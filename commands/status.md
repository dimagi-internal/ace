---
description: Show the current status of an opportunity or list all active opportunities (opps + runs hierarchy)
allowed-tools: [Read, Bash, mcp__plugin_ace_ace-gdrive__drive_list_folder, mcp__plugin_ace_ace-gdrive__drive_read_file]
---

# /ace:status

Show the current state of opps and their runs.

## Arguments
- `<opp>` (optional) — show only this opp and its runs.
- `<opp>/<run-id>` (optional) — show only this specific run's detailed state.

## Process

### List mode (no args)

1. `drive_list_folder` on `ACE_DRIVE_ROOT_FOLDER_ID`. For each subfolder,
   confirm it has an `inputs/` subfolder (skip ones that don't — those
   are legacy flat opps, surface them under a separate "Legacy" section).
2. For each opp, `drive_list_folder` on `<opp>/runs/`. Sort runs newest
   first by folder name (run-id is sortable as a string).
3. For each run, `drive_read_file` `<opp>/runs/<run-id>/run_state.yaml` and
   pull `phase`, `step`, `mode`, `last_actor`, `last_actor_at`.
4. Print:

   ```
   <opp>  (display_name from opp.yaml)
     20260502-1830  Phase 4/ocs-agent-setup  default  ace@dimagi-ai.com  2026-05-02T18:42Z
     20260502-1430  done                     default  ace@dimagi-ai.com  2026-05-02T16:01Z
     20260501-2200  Phase 2/pdd-to-deliver-app  review  jjackson@dimagi.com  2026-05-01T22:30Z

   <other-opp>  (...)
     ...
   ```

5. After the new-layout opps, if any legacy flat opps exist (folder
   under `ACE/` with `run_state.yaml` at root, no `runs/` subfolder), print
   a section header `## Legacy (delete when ready)` and list them with
   the same per-run line format.

### Detail mode (`<opp>` or `<opp>/<run-id>`)

1. If `<opp>` only: print the per-run summary from list mode for that
   opp's runs, then dump `<opp>/opp.yaml` body.
2. If `<opp>/<run-id>`: print that run's `run_state.yaml` body verbatim, plus
   any `gates:` / verdicts referenced.
