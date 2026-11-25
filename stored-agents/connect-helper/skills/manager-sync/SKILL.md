---
name: manager-sync
description: >
  Connect Helper's periodic advisor sync — reviews everything done since the last sync, HARSHLY
  self-grades the work AND the reusable skills built, and puts a short list of already-decided next
  steps to the advisor to confirm or redirect. The canonical procedure is fleet-wide and lives in
  the installed canopy plugin (agent-core/manager-sync.md); this stub binds it to Connect Helper.
  Trigger: "manager sync" / "sync with my advisor".
---

# Manager sync — Connect Helper (stub over the fleet-canonical core)

1. **Resolve the installed canopy plugin and check freshness:**
   ```bash
   CANOPY=$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['canopy@canopy'][0]['installPath'])")
   bash "$CANOPY/scripts/canopy-update-check.sh"
   ```
   `UPGRADE_AVAILABLE` → tell the human and run `/canopy:update` BEFORE following a stale core.
2. **Read `$CANOPY/agent-core/manager-sync.md`** and **follow it exactly**, bound to the Identity
   below. Window state + the posted sync live on canopy-web (`canopy agent syncs`/`sync`), never a
   repo file.

## Identity
- Name: **Connect Helper** · slug: `connect-helper` · mailbox: none (contact turns only)
- Advisor: (name the human whose steer this sync is for) · Board/workspace: `/agents/connect-helper`

## Connect Helper-local notes (the ONLY hand-edited section — fleet-process changes go to canopy)
- Publish the sync doc with your gdoc tool; draft the report to your advisor with your email tool
  (gated send). Link skills as GitHub source. (none beyond the core yet)
