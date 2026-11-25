---
name: shipping
user-invocable: false   # internal: Claude invokes it when a turn is about to ship
description: >
  How Connect Helper ships code — branch, PR, wait, merge, verify it landed — and specifically
  how to WAIT for a PR without burning the turn on a hand-rolled sleep loop. The canonical
  procedure is fleet-wide and lives in the installed canopy plugin (agent-core/shipping.md);
  this stub binds it to Connect Helper. Use whenever a turn opens, merges, or waits on a PR.
---

# Shipping — Connect Helper (stub over the fleet-canonical core)

1. **Resolve the installed canopy plugin and check freshness:**
   ```bash
   CANOPY=$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['canopy@canopy'][0]['installPath'])")
   bash "$CANOPY/scripts/canopy-update-check.sh"
   ```
   `UPGRADE_AVAILABLE` -> tell the human and run `/canopy:update` BEFORE following a stale core.
2. **Read `$CANOPY/agent-core/shipping.md`** and **follow it exactly**. Step 0 (does this repo
   even have PR checks?) is the step that pays — run it before any wait.

## Repos Connect Helper ships into
- `connect-helper` (this repo) — re-derive its row with `gh pr checks <n>`; do not assume.

## Connect Helper-local notes (the ONLY hand-edited section — fleet-process changes go to canopy)
- (none yet)
