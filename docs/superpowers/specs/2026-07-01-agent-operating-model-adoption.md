# ACE adopts the canopy agent operating model — turn framework, gating, guarded email

**Date:** 2026-07-01 · **Status:** approved (Jon, 2026-07-01) · **Ships in:** the PR carrying this spec

## Why

Canopy's agent operating model (echo-proven; see canopy `docs/agent-operating-model.md`) defines seven
primitives for controllable autonomous agents: persona + routing key, a `turn` orchestrator, reads-free /
writes-gated guarding, invariants-as-hooks, capability-in-MCP, self-improvement-in-the-turn, and a
canopy-web agent workspace. ACE is the deepest agent in the portfolio and the fleet's biggest
infrastructure donor (echo borrows `ace-gdrive`, the GOG pattern, the 1Password bootstrap), but until now
it had only one of the seven primitives fully (capability-in-MCP) and was not a fleet member.

The specific capability gap: **ACE only sends email.** Phases 8–9 email LLOs (`llo-invite`,
`llo-onboarding`, `llo-uat`, `timeline-monitor`) and then a human relays every reply back in. The turn
framework closes that loop: ACE drains its own inbox, routes each thread to the opp/run it belongs to,
and advances runs — with every outbound action gated.

## Decisions (Jon, 2026-07-01)

1. **Internal + external facing by design.** ACE's counterparts are both Dimagi staff and external LLO
   contacts. External senders get a *correspond* tier (reply-with-approval, never run mutations); **run
   management stays internal-staff-only**. Longer term ACE answers external email on turns.
2. **ace-web vs canopy-web is deliberately undecided.** ace-web is currently single-user (Jon). Nothing
   in this design may *require* canopy-web: the board-drain turn step is config-gated and additive. Do
   not migrate ace-web features to canopy-web without an explicit decision.
3. **GOG + gdrive become shared framework capability.** The idealized shared layer (email channel
   adapter + Google Workspace MCP with per-agent identity carve-outs) is specified in the canopy repo;
   ACE remains the reference implementation and first consumer. ACE keeps its own GOG client (`ace`) —
   identity is never shared between agents (echo enforces the same rule in reverse).

## Design

### Counterpart model (allowlist tiers)

`config/allowlist.txt` defines two tiers; `skills/inbox-triage` enforces them:

| Tier | Who | May trigger |
|---|---|---|
| **act** | `@dimagi.com` operators (static allowlist) | Anything: resume paused runs, queue run actions, approve/reject pause points by reply |
| **correspond** | External counterparts *derived from run state* — `selected_llo.contact_email`, solicitation invitees, onboarding recipients, scoped to their opp's threads | Drafted replies (approval-gated), escalation to staff. **Never** run-state mutations |
| (no tier) | Unknown senders | Read-only triage; summarized to a human; never acted on |

The correspond tier is *derived, not maintained*: a sender qualifies for a thread iff their address
appears in the current run's `run_state.yaml` products/comms context for the opp that thread routes to.
This keeps the allowlist in sync with the source of truth automatically.

### Thread → opp/run routing

`email-communicator` now records `thread_id` + `message_id` in the per-phase comms-log
(`<skill>_comms-log.md`) on every send. Inbound triage resolves a thread by:
1. comms-log match on `thread_id` (deterministic), else
2. subject-line opp-slug conventions, else
3. unroutable → escalate to a human, read-only.

### Turn orchestrator

`/ace:turn` (level 0, sibling of `/ace:run` — the turn wraps around the pipeline, it does not replace
it): preflight (`ace-doctor` auth-liveness + GOG-as-`ace` check) → drain the canopy-web board *iff
configured* → inbox triage (one thread, one sender, one memory scope — echo's cardinal rule) → gated
actions → skill-development self-check → one combined close-out summary. `skills/turn/SKILL.md` is the
checklist; re-read it every turn.

### Gating (rails, not approval gates) — decision revised by Jon, 2026-07-01

Hooks come in two kinds, and ACE adopts only one:

- **Deny rails** (adopted) — make the wrong path *impossible*, never prompt anyone. The agent hits the
  rail, reads the message naming the right path, self-corrects, and keeps going. Zero autonomy cost.
- **Approve/ask gates** (rejected) — interactive permission prompts at the tool boundary. This is what
  hal leaned on and it worked poorly: an "ask" is a blocking modal, so it stalls autonomous runs and
  nags interactive ones. ACE already governs its outbound moments **procedurally** — the pause-point
  mode matrix (`default/review/auto`) written to `run_state.yaml` (resumable state, not a modal),
  Phase 9 entry gated on `selected_llo`, `solicitation-review`'s HITL checkpoint before
  `award_response`, and review-posture in turns. Procedural gates are the ACE way: rigorous steps that
  run as autonomously as possible.

`hooks/gating_guard.py` (adapted from hal's generalization of echo's hook; stdlib-only python3) is
wired as a **plugin-level PreToolUse hook** in `hooks/hooks.json` (matcher: `Bash`), reading
`config/gating.json` — whose `approve` list is deliberately empty. The one rail:

- **deny** — raw `gog gmail send|reply` under the ACE identity (`--client ace` / `ace@dimagi-ai.com`).
  The only send path is `bin/ace-email` (HTML multipart wrapper, echo's pattern — Gmail display-wraps
  plain text at ~72 cols), which also guarantees the comms-log threadId capture that inbound routing
  depends on.

Everything else — Drive writes, Connect atoms, solicitation publish, `award_response`, all reads —
stays hook-free; the pipeline's pause points and the turn's review posture are the governance.

### Fleet membership

`persona.md` (identity/voice/mandate) + `config/agent.json` (canopy-web workspace identity, mailbox
`ace@dimagi-ai.com`). Workspace registration/refresh is best-effort in the turn close-out via the
`canopy agent …` CLI when present; its absence never blocks a turn (decision 2).

## Ships later (explicitly out of scope here)

- Autonomous/scheduled turns (fleet-wide the trigger is still a human; `pm-autonomous-loop` is the
  pattern when we get there).
- Pause-point → board-task bridge (powerful, but blocked on the ace-web/canopy-web decision).
- External-sender auto-reply without approval (the correspond tier stays approval-gated indefinitely
  until Jon relaxes it).
- The canopy-side shared email adapter + extracted Google Workspace MCP (specified in canopy; ACE
  migrates to consuming them when they exist).

## Relationship to existing ACE conventions

- Skills stay stateless; triage context lives in Drive comms-logs + `run_state.yaml`, never locally.
- The turn respects run independence: a thread routes to the *current* run of its opp; it never reaches
  across runs.
- `agent-review ace` (canopy) becomes a standing lens over turn transcripts, alongside the existing
  canopy improvement cycle.
