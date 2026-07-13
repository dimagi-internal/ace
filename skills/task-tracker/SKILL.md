---
name: task-tracker
description: >
  ACE's project/task state — one board task per iterative thread/project, backed by
  canopy-web (kanban at /agents/ace). The canonical procedure is fleet-wide and lives
  in the installed canopy plugin (agent-core/task-tracker.md); this stub binds it to
  ACE. Use when taking on multi-turn work, when a new request arrives, and at every
  turn's board-drain and close.
---

# Task Tracker — ACE (stub over the fleet-canonical core)

1. **Resolve the installed canopy plugin and check freshness:**
   ```bash
   CANOPY=$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['canopy@canopy'][0]['installPath'])")
   bash "$CANOPY/scripts/canopy-update-check.sh"
   ```
   `UPGRADE_AVAILABLE` → tell the human and run `/canopy:update` BEFORE following a stale core.
2. **Read `$CANOPY/agent-core/task-tracker.md`** and **follow it exactly**, bound to the
   Identity below. Where it says `<slug>`/`<mailbox>`, use this Identity.

## Identity
- Name: **ACE** · slug: `ace` · mailbox: `ace@dimagi-ai.com`
- Board: `/agents/ace` · Drive folder id env: `ace_DRIVE_FOLDER_ID`

## ACE-local notes (the ONLY hand-edited section — fleet-process changes go to canopy)
- **Board/task integration is config-gated and best-effort — it NEVER blocks a turn** (per
  `config/agent.json` `_doc`: workspace integration is best-effort; the ace-web vs canopy-web
  question is deliberately open). If `canopy agent --help` fails or no workbench token exists,
  note "board: not configured" in the close-out and move on.
- Per-opportunity pipeline state stays in Drive (`ACE/<opp>/runs/<run-id>/run_state.yaml` +
  comms-logs) — the board tracks counterpart-facing iterative threads/projects, not run state.
