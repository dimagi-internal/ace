---
name: task-tracker
user-invocable: false   # internal: Claude invokes it; it is not a human-launchable /command
description: >
  Connect Helper's project/task state — one board task per iterative thread/project, backed by
  canopy-web (kanban at /agents/connect-helper). The canonical procedure is fleet-wide and lives
  in the installed canopy plugin (agent-core/task-tracker.md); this stub binds it to
  Connect Helper. Use when taking on multi-turn work, when a new request arrives, and at every
  turn's board-drain and close.
---

# Task Tracker — Connect Helper (stub over the fleet-canonical core)

1. **Resolve the installed canopy plugin and check freshness:**
   ```bash
   CANOPY=$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['canopy@canopy'][0]['installPath'])")
   bash "$CANOPY/scripts/canopy-update-check.sh"
   ```
   `UPGRADE_AVAILABLE` → tell the human and run `/canopy:update` BEFORE following a stale core.
2. **Read `$CANOPY/agent-core/task-tracker.md`** and **follow it exactly**, bound to the
   Identity below. Where it says `<slug>`/`<mailbox>`, use this Identity.

## Identity
- Name: **Connect Helper** · slug: `connect-helper` · mailbox: none (contact turns only)
- Board: `/agents/connect-helper` · Drive root env: `GDRIVE_ROOT_FOLDER` (from `~/.connect-helper/.env`)

## Connect Helper-local notes (the ONLY hand-edited section — fleet-process changes go to canopy)
- (none yet)
