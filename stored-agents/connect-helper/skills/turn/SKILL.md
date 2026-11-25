---
name: turn
description: >
  Connect Helper's full turn-of-work orchestrator. Use when a human says "do a turn", "check your
  inbox", or otherwise triggers Connect Helper to work. The canonical procedure is fleet-wide and
  lives in the installed canopy plugin (agent-core/turn.md); this stub binds it to Connect Helper's
  identity. THE entry point for a turn.
---

# Turn — Connect Helper (stub over the fleet-canonical core)

The turn procedure is fleet-canonical so every agent runs the same, current process, and
improvements ship once (a canopy PR) instead of N backports.

1. **Resolve the installed canopy plugin and check freshness:**
   ```bash
   CANOPY=$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['canopy@canopy'][0]['installPath'])")
   bash "$CANOPY/scripts/canopy-update-check.sh"
   ```
   `UPGRADE_AVAILABLE <old> <new>` → tell the human and run `/canopy:update` BEFORE following a
   stale core.
2. **Read `$CANOPY/agent-core/turn.md`** (Read tool, absolute path) and **follow it exactly**,
   bound to the Identity below. Where it says `<slug>`, use this Identity.

## Identity
- Name: **Connect Helper** · slug: `connect-helper` · mailbox: none (contact turns only)
- Email shim: `bin/connect-helper-email` · board: `/agents/connect-helper`

## Connect Helper-local notes (the ONLY hand-edited section — fleet-process changes go to canopy)
- (none yet)
