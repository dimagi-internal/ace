---
name: turn
description: >
  ACE's turn-of-work orchestrator. Use when a human says "do a turn", "check your inbox",
  or otherwise triggers ACE to process what's come in. Sequences the whole turn: preflight →
  drain the canopy-web board (iff configured) → inbox triage (one thread, one sender at a
  time) → skill-development self-check → close-out. This is the counterpart-facing entry
  point; /ace:run remains the pipeline entry point — a turn wraps around runs, it does not
  replace them.
---

# Turn — ACE's turn of work

A turn processes ACE's **inbound surfaces**: email to `ace@dimagi-ai.com` and (when configured) the
canopy-web task board at `/agents/ace`. The pipeline (`/ace:run`) produces outbound artifacts and
pause points; the turn is how replies, approvals, and requests flow back in without a human relaying
them. Design + counterpart model: `docs/superpowers/specs/2026-07-01-agent-operating-model-adoption.md`.

**Re-read this file at the start of every turn and follow it in order** — running a turn from memory
is how steps get dropped under load.

Guardrails: reads are free. `bin/ace-email` is the only send path (a deny rail blocks raw
`gog gmail send` as ACE — see `config/gating.json`), and a turn runs in **review posture**: every
outbound reply is presented in-conversation and gets the human's yes before it goes. Approval is
procedural, not a hook prompt — rigorous steps, autonomous execution (the hal lesson; see the spec's
§ Gating).

## Step 1 — Preflight

- `bin/ace-doctor` — read the `[Auth liveness]` block; each failure names its remediation command.
- Gmail as ACE: `gog gmail search "in:inbox is:unread" --account $ACE_GMAIL_ACCOUNT --client $ACE_GMAIL_CLIENT --json`
  (also doubles as the queue pull for Step 3). If gog auth is dead:
  `gog login ace@dimagi-ai.com --client ace --services gmail`.

**Don't abort the whole turn for one blocker** — run the surfaces that passed and report the fix for
what's blocked.

## Step 2 — Drain the canopy-web board (iff configured)

Config-gated and best-effort by design (the ace-web vs canopy-web question is deliberately open —
never make a turn depend on canopy-web). If the canopy plugin's shared agent CLI is available
(`canopy agent --help`) and a workbench token exists, list commands queued for `ace` and apply each
under normal guardrails; otherwise note "board: not configured" in the close-out and move on.

## Step 3 — Inbox triage

Run `skills/inbox-triage/SKILL.md` in full. In brief: apply the standing noise table first (auto-
dismiss known machine classes, drain ALL search pages); then for **each** remaining thread, in
order — read it, resolve the sender's tier (**act** = `config/allowlist.txt`; **correspond** =
derived from the routed run's state; neither = read-only), route the thread to its opp/run via the
comms-log `thread_id`, decide ONE action, approval-gate anything outbound, write back to the run's
comms-log. **One thread, one sender, one memory scope — never reason about two senders in one step.**

Reply quality follows canopy `docs/agent-operating-model.md § 1b` (deliverables are gdocs + draft
shown inline; decide-then-show in one numbered, consistent order; verify recipients from the
structured read). Before every reply: run `skills/self-review/SKILL.md` against the sender's
original asks.

## Step 4 — Skill-development self-check (every turn, explicitly)

Report the answers to both, out loud, in the close-out:
1. **Did I create or improve a skill this turn?** Name + link it.
2. **Did I repeat work by hand that SHOULD be a skill (or an issue)?** ACE's standing convention
   applies inside turns too: a confirmed defect or improvement gets a GitHub issue filed the moment
   it's confirmed (`gh issue create`, no `-R`) — don't defer to turn end, don't fix silently.

## Step 5 — Close the turn

- Mark fully-handled threads read: `bin/ace-mark-read <threadId> …` — but NOT threads still awaiting
  a human decision.
- Best-effort workspace refresh if the canopy agent CLI is configured (never blocks the close).
- Give ONE combined summary: **Board** (drained / not configured) · **Inbox** (per thread: sender,
  tier, routed run, proposed action, what was approved & done, what's parked; noise counts by
  class) · **Open threads by age** (ALL open correspond-tier threads with days-since-last-inbound;
  >5 days = explicit escalation to the run's operator — standing state, repeated every turn until
  resolved) · **Runs advanced** (any pause points resumed or skills dispatched) ·
  **Blocked/awaiting** (preflight failures, human decisions needed) · **Issues filed / skills
  changed**.

## Related

- `inbox-triage` — Step 3 in full (tiering, routing, the cardinal isolation rule)
- `email-communicator` — all Gmail I/O (search/read free; sends only via `bin/ace-email`, gated)
- `self-review` — gate every reply against the original asks before sending
- `/ace:run`, `/ace:status` — the pipeline the turn feeds into; a turn may resume a paused run at the
  instruction of an **act**-tier sender, executing the same procedure the pause point defines
