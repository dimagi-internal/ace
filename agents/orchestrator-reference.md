# ACE Orchestrator — Reference

This doc is the *reference* counterpart to `agents/ace-orchestrator.md`. It catalogs schemas, contracts, lifecycle invariants, and architectural diagrams that the orchestrator's procedure references. The procedure doc tells you WHAT to do; this doc tells you the SHAPE of what you're doing.

If you're executing `/ace:run`, read `agents/ace-orchestrator.md` first. Come here only when the procedure points you at a specific section.

---

## Agent Topology

The architectural rule and full topology table live in `CLAUDE.md § Agent topology` (the canonical source — every session loads it). Summary for the orchestrator's purposes:

- **The rule:** anything that calls `Agent` runs at level 0. `ace-orchestrator` and `commcare-setup` (Phase 2) are procedure docs read and executed inline by the top-level session because they dispatch further work; the other seven agents (`design-review`, `connect-setup`, `ocs-setup`, `qa-and-training`, `execution-manager`, `closeout`, `ocs-tester`) are subagents dispatched via `Agent(...)` from level 0.
- **Invocation in the procedure below:** "dispatch the X agent" means a top-level `Agent(X)` call (subagent rows in the CLAUDE.md table) or "read `agents/X.md` and execute it inline" (procedure-doc rows).
- **Why the rule:** the `Agent` tool is unavailable to subagents; a node that nests further work cannot itself be a subagent. There are never two levels of `Agent` dispatch.

## Your State

Opportunity state lives in Google Drive under `ACE/<opp-name>/`. Use the Google Drive
MCP tools (`sheets_read`, `drive_read_file`, `drive_list_folder`, etc.) to read and
write state.

The state file at `ACE/<opp-name>/run_state.yaml` tracks:
- Current phase and step
- Mode (auto or review)
- Timestamps for each completed step
- Gate approvals (who approved, when)
- Any errors or manual interventions
- Operator identity — see § State Schema below

## State Schema

`run_state.yaml` top-level fields (added in 0.3.3 for admin-group legibility):

```yaml
opportunity: <opp-name>
run_id: <YYYYMMDD-HHMM>     # multi-run layout (v0.11.0+); the run folder name
mode: default|review|auto
created: <ISO timestamp>
initiated_by: <email>        # set once on creation; never overwritten
last_actor: <email>          # updated on every skill invocation
last_actor_at: <ISO timestamp>  # updated on every skill invocation

phases:
  design-review:        # Phase 1
    idea-to-pdd: done|pending|error|dry-run-success|...
    pdd-to-test-prompts: done|pending|...
  commcare-setup:       # Phase 2
    pdd-to-learn-app: pending
    pdd-to-deliver-app: pending
    app-deploy: pending
    app-test-cases: pending
  connect-setup:        # Phase 3
    connect-program-setup: pending
    connect-opp-setup: pending
  ocs-setup:            # Phase 4 — qa/eval split in 0.3.5; deep moved to /ace:qa-deep
    ocs-agent-setup: pending
    ocs-chatbot-qa-quick: pending
    ocs-chatbot-eval-quick: pending
  qa-and-training:        # Phase 5 — added 0.9.0; per-artifact training split 0.10.79–0.10.84; qa-plan retired in shallow/deep QA split
    app-screenshot-capture: pending
    training-llo-guide: pending
    training-flw-guide: pending
    training-quick-reference: pending
    training-faq: pending
    training-deck-outline: pending
    training-deck-build: pending          # skipped if ACE_TRAINING_DECK_TEMPLATE_ID unset
    training-onboarding-email: pending    # last — links to other docs by URL
  solicitation-management:  # Phase 7 — added 0.12.0
    solicitation-create: pending
    llo-invite: pending               # repurposed 0.12.0: emails solicitation URL to PDD-named candidates
    solicitation-monitor: pending     # recurring (post-/ace:run, while solicitation open)
    solicitation-review: pending      # manual (HITL gate before award_response; only path that unblocks Phase 8)
  execution-management: # Phase 8 (renamed from llo-management 0.12.0)
    llo-onboarding: pending           # reads opp.yaml.selected_llo (populated by Phase 7 solicitation-review)
    llo-uat: pending
    llo-launch: pending
    timeline-monitor: pending         # recurring
    flw-data-review: pending          # recurring
    ocs-chatbot-qa-monitor: pending   # recurring
    ocs-chatbot-eval-monitor: pending # recurring
  closeout:             # Phase 9 (was Phase 8)
    opp-closeout: pending
    llo-feedback: pending
    learnings-summary: pending
    cycle-grade: pending

```

(0.13.116: the legacy `gates:` top-level field was removed. Pause-point
status is derived from `phases.<phase>.status` + per-skill verdict
files at runtime; no separate field carries it. See § Pause Points.)

**`initiated_by`** — the operator who kicked off the opp. Set once in
"Starting a New Opportunity" from `git config user.email`. Never overwritten.
Fallback to the literal string `unknown` if git config is unset.

**`last_actor` / `last_actor_at`** — updated on *every* skill invocation,
both by the orchestrator (full `/ace:run` passes) and by the
`/ace:step` command. Always pull from `git config user.email` at the
moment of the touch. These two fields power `/ace:status`'s
"last touched by X, N days ago" column and its `--mine` filter, which is
the primary hand-off mechanism across the 5-person admin group.

The operator identity is *captured*, not *enforced*. There is no
authorization check — a git config mismatch just means `/ace:status --mine`
won't find the opp. Keep it that way.

**Defensive `run_state.yaml` init on bypass paths.** `/ace:run` initializes
`run_state.yaml` as part of "Starting a New Opportunity." But operators can
bypass the orchestrator (via `/ace:step <skill> <opp>`, or by dispatching
a phase agent directly with the `Agent` tool — only valid for the phase
agents that are subagents per § Agent Topology; `commcare-setup` cannot
be dispatched this way and must be invoked inline at top-level). Every
entry path that touches state must tolerate a missing `run_state.yaml`:

1. If `ACE/<opp-name>/run_state.yaml` does not exist when the entry path is
   invoked, initialize it first using the schema above. Required fields:
   `opportunity`, `mode` (default `default`), `created` (ISO now),
   `initiated_by` (`git config user.email` or `unknown`), `last_actor` +
   `last_actor_at` (same email + timestamp), all `phases.<phase>.<skill>`
   keys set to `pending`. (Pre-0.13.116 init also seeded a top-level
   `gates:` map; that field was removed when the gate concept was
   replaced by Pause Points — see § Pause Points.)
2. Then proceed with the skill dispatch.

`commands/step.md` owns this defensive init for the `/ace:step` path.
Agent-tool dispatches are expert paths and assumed to know what they're
doing — but phase agents should still not crash on a missing `run_state.yaml`
read; they should skip the status update with a single-line warning and
let the operator fix the state gap explicitly.

## Scope boundaries — what goes in `run_state.yaml`

(populated in Task 4)

## Cruft management — `archive:` block convention

(populated in Task 4)

## Per-Phase Folder Lifecycle

(populated in Task 4)

## Producer Artifact Verifier

(populated in Task 5)

## Phase Write-Back Contract

(populated in Task 5)

## Phase Write-Back Verifier — procedure

(populated in Task 5)

## Pause Points

(populated in Task 6)

## Touching State — Operator Capture

(populated in Task 7)
