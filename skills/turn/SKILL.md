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
- **Preflight (core Step 1) specifics:** `bin/ace-doctor --installed` — read the `[Auth liveness]`
  block. **Start it in the BACKGROUND and gate the turn on the inbox read instead — the doctor is
  slow AND silent.** It runs ~3-4 minutes (measured 3m39s, 2026-09-01) because it makes live HTTP
  probes per MCP and walks Drive's opp layout, and it pipes through `tee`, so a foreground run
  emits NOTHING until it exits — it just blows the harness 120s Bash timeout and gets backgrounded
  anyway, minus the interim output. Launch it with `run_in_background`, run the inbox pull below
  while it works, and read its verdict before you close. (`--no-live` skips the live probes if you
  only need the static checks.) Each failure names its remediation command. **Read the `TURN-BLOCKING` list, not just the
  aggregate verdict** (dimagi-internal/ace#1189): a revoked Gmail refresh token leaves every inbound
  and outbound path dead while the old aggregate still printed `FAIL: 0 / HEALTHY — ACE works;
  warnings below are non-fatal`, because a Gmail-less machine legitimately still runs most of
  `/ace:run`. **A `PASS gog_auth` is NOT sufficient evidence the inbox works — prove it with a live
  read before you trust it** (dimagi-internal/ace#1338): the probe classifies failure by matching a
  denylist of gog error strings, and gog's "no token for this (mailbox, client) pair" message
  (`No auth for gmail <mailbox>.`) matches none of them, so a mailbox that cannot make a single
  call reports `PASS … live scopes OK`. That is the #1189 gate defeated at its source. So run the
  inbox pull yourself as the real preflight — `gog gmail search "in:inbox is:unread" --account
  $ACE_GMAIL_ACCOUNT --client canopy -j` — and treat an auth error there as TURN-BLOCKING no matter
  what the doctor printed. If the read fails under the configured client, check
  `gog auth tokens list` for a `token:<client>:<mailbox>` key: the pair, not the account, is what
  gog stores, and `gog auth list` collapses to one row per account so it can hide a working token
  (which also misroutes canopy's `reconcile_client` onto a revoked one). The verdict is now
  surface-scoped — `HEALTHY for runs · BROKEN for turns` — and any
  `[TURN-BLOCKING]` item means **this turn cannot do its job**: do NOT proceed to the inbox pull.
  Abort loudly, naming the item and its `fix:` line (they are all one-command remediations:
  `gog login …`, or installing the canopy CLI). A turn that continues past one reads an empty inbox
  and reports "nothing to do", which is indistinguishable from a genuinely quiet mailbox — the
  silent-failure shape this whole preflight exists to prevent. **The `--installed` flag is load-bearing:**
  `ace-doctor` defaults to `MODE=self` and audits whichever copy you invoke, so a bare
  `bin/ace-doctor` run from an emdash worktree audits the *checkout* — which has no `node_modules`
  until someone runs `npm ci` there, and which never executes anything. ACE runs from the installed
  plugin (`~/.claude/plugins/cache/ace/ace/<version>/`), so the checkout's deps are irrelevant to
  whether a turn can run. Auditing the wrong copy yields `FAIL deps` → `Verdict: BROKEN — ACE will
  not function` on a machine that is in fact HEALTHY, every turn, which is how a preflight verdict
  becomes noise people route around. (`agents/ace-orchestrator.md` § preflight already resolves the
  install path for the same reason — this keeps turns consistent with runs.) Gmail as ACE:
  `gog gmail search "in:inbox is:unread" --account $ACE_GMAIL_ACCOUNT --client $ACE_GMAIL_CLIENT --json`
  (doubles as the inbox queue pull). Dead gog auth:
  `gog login ace@dimagi-ai.com --client canopy --services gmail`. **The gog client is the SHARED
  fleet client (`canopy`), not per-agent** — same as eva/hal/ada; what's per-agent is the mailbox
  (`--account`). `config/agent.json`'s `gog_client` is authoritative for the email engine; setting
  it to `ace` kills every read/send, because no `credentials-ace.json` exists and the remedy it
  prints is an interactive browser OAuth a headless turn can't run (jjackson/ace#1147).
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
- **Pre-send review = `skills/agent-turn-review`, applied INLINE** — read that file top to bottom
  and run its A/B/C/D checklist yourself. Do NOT dispatch it (or `canopy:agent-turn-review`) via
  the `Skill` tool: that runs the fleet body alone and drops ACE's §D send-path rules. It also
  governs this turn's CLOSING REPORT (§C: open with the decision, not the housekeeping).
  Supersedes the old `self-review`; ACE's `-qa`/`-eval` skills grade artifacts — this is the
  brief-fidelity counterpart for correspondence.
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
