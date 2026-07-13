---
name: turn
description: >
  ACE's turn-of-work orchestrator. Use when a human says "do a turn", "check your inbox",
  or otherwise triggers ACE to process what's come in. The canonical procedure is fleet-wide
  and lives in the installed canopy plugin (agent-core/turn.md); this stub binds it to ACE's
  identity. This is the counterpart-facing entry point; /ace:run remains the pipeline entry
  point — a turn wraps around runs, it does not replace them.
---

# Turn — ACE (stub over the fleet-canonical core)

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
- Name: **ACE** · slug: `ace` · mailbox: `ace@dimagi-ai.com`
- Email shim: `bin/ace-email` · board: `/agents/ace`

## ACE-local notes (the ONLY hand-edited section — fleet-process changes go to canopy)
- **Entry points:** the turn is the counterpart-facing entry point; **`/ace:run` remains the
  pipeline entry point** — a turn wraps around runs, it does not replace them. A turn may resume a
  paused run at the instruction of an **act**-tier sender, executing the same procedure the pause
  point defines. Design + counterpart model:
  `docs/superpowers/specs/2026-07-01-agent-operating-model-adoption.md`.
- **Preflight (core Step 1) specifics:** `bin/ace-doctor` — read the `[Auth liveness]` block; each
  failure names its remediation command. Gmail as ACE:
  `gog gmail search "in:inbox is:unread" --account $ACE_GMAIL_ACCOUNT --client $ACE_GMAIL_CLIENT --json`
  (doubles as the inbox queue pull). Dead gog auth:
  `gog login ace@dimagi-ai.com --client ace --services gmail` (ACE's gog client is `ace`,
  deliberately per-agent).
- **Board drain is config-gated and best-effort by design** — its absence NEVER blocks a turn (the
  ace-web vs canopy-web question is deliberately open; see `config/agent.json` `_doc`). If
  `canopy agent --help` works and a workbench token exists, drain per `skills/task-tracker`;
  otherwise note "board: not configured" in the close-out and move on. The core's close-out
  workspace refresh (`canopy agent skills`, `canopy agent turn …`) is best-effort under the same
  gate.
- **Inbound processing (core Step 2) = `skills/inbox-triage` in full:** standing noise table first
  (drain ALL search pages), then per thread — tier the sender (**act** = `config/allowlist.txt`;
  **correspond** = derived from the routed run's state; neither = read-only), route to opp/run via
  the comms-log `thread_id`, one action, approval-gated outbound. Per-sender isolation and tier
  resolution live there.
- **ACE's state layer is Drive, never local:** where the core says "record `thread_id` in your
  state layer", that's the routed run's comms-log (`email-communicator` step 7) — the routing key
  inbox-triage matches inbound threads against. Turn state = comms-logs + `run_state.yaml`.
- **Pre-send review = `skills/agent-turn-review`** (supersedes the old `self-review`; ACE's
  `-qa`/`-eval` skills grade artifacts — this is the brief-fidelity counterpart for
  correspondence).
- **Skill self-check (core Step 3), ACE addition:** ACE's standing issues-as-you-go convention
  applies inside turns — a confirmed defect or improvement gets a GitHub issue filed the moment
  it's confirmed (`gh issue create`, no `-R`); don't defer to turn end, don't fix silently. Also
  ask: did I repeat work by hand that SHOULD be a skill (or an issue)?
- **Close-out (core Step 4) ACE shape:** mark fully-handled threads read via
  `bin/ace-mark-read <threadId> …` — NOT threads still awaiting a human decision. Summary covers:
  **Board** (drained / not configured) · **Inbox** (per thread: sender, tier, routed run, proposed
  action, approved & done, parked; noise counts by class) · **Open threads by age** (all open
  correspond-tier threads, days-since-last-inbound; >5 days = explicit escalation to the run's
  operator, repeated every turn until resolved) · **Runs advanced** · **Blocked/awaiting** ·
  **Issues filed / skills changed**.
- **Gating note:** ACE's hook is plugin-level (fires in every session with ACE installed), so
  `config/gating.json` rails stay NARROW and identity-scoped — see its `_doc` before adding rails.
