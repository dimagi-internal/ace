---
name: ocs-setup
description: >
  Phase 4 of the CRISPR-Connect lifecycle: clone the ACE golden template,
  build the opp-specific RAG collection, quality-gate the bot via quick and
  deep chat suites, and stage the widget credentials for Connect.
model: inherit
phase: ocs-setup
phase_display: OCS Setup
phase_ordinal: 4
skills:
  - { name: ocs-agent-setup,    has_judge: true,  eval_skill: ocs-widget-handoff-eval }
  - { name: ocs-chatbot-qa,     has_judge: false }
  - { name: ocs-chatbot-eval,   has_judge: true }
---

# OCS Setup Agent (Phase 4)

You configure the per-opportunity OCS chatbot, quality-test it, and hand the
widget credentials to the operator to attach to the Connect opportunity.

This phase runs AFTER Connect setup (Phase 3) and BEFORE any LLO-facing
communication (Phase 7). No LLOs interact with the bot in this phase — only
the ACE judge does. Each quality gate is a **qa → eval pair** per the
QA vs Eval contract in `skills/README.md`: `ocs-chatbot-qa` captures a
transcript, `ocs-chatbot-eval` judges it.

## Workflow

### Step 1: Configure the chatbot
Invoke the `ocs-agent-setup` skill.
- Input: `ACE/<opp-name>/` — PDD, training materials, app summaries, opportunity config
- Output: cloned chatbot with opp system prompt, RAG collection indexed,
  version published. `ACE/<opp-name>/ocs-agent-config.md` written with
  `{experiment_id, public_id, embed_key, collection_id, pipeline_id, version_number}`
- Idempotent: if a bot named `"ACE - <opp-name>"` already exists, resumes from
  existing config

### Step 2: Quick smoke gate (qa → eval)
Invoke `ocs-chatbot-qa --quick`, then `ocs-chatbot-eval --quick`.
- Input: `experiment_id` from Step 1
- qa captures: 5-question transcript with structural checks (stdout in
  `--quick` mode; no file)
- eval grades: overall score + 4-dimension breakdown; writes verdict to
  `ACE/<opp-name>/verdicts/ocs-chatbot-eval-quick.yaml`
- Tests: core escalation, tagging, shared-collection retrieval. Fast fail
  if the bot is miswired (qa-side structural fail) or miscalibrated
  (eval-side overall < 7)
- **Gate:** if qa structural pass rate < 100% OR eval overall < 7, retry
  `ocs-agent-setup` prompt-patch once; if still failing, escalate to admin
  group
- Depends on: Step 1

### Step 3: Deep pre-launch gate (qa → eval)
Invoke `ocs-chatbot-qa --deep`, then `ocs-chatbot-eval --deep`.
- Input: `experiment_id` from Step 1, `opp_name` for opp-specific prompts
- qa captures: full transcript at
  `ACE/<opp-name>/qa-captures/YYYY-MM-DD-ocs-chat-deep.md`
- eval writes:
  - `ACE/<opp-name>/verdicts/ocs-chatbot-eval-deep.yaml` (machine-readable)
  - `ACE/<opp-name>/eval-reports/YYYY-MM-DD-ocs-eval.md` (human-readable)
  - `ACE/<opp-name>/gate-briefs/ocs-chatbot-eval-deep.md` (for the Phase 4→6 gate)
- Tests: Connect-general + ACE-specific + opp-specific prompts from
  `ACE/<opp-name>/test-prompts.md` (produced in Phase 1 by
  `pdd-to-test-prompts`)
- **Gate (review mode):** Write the gate brief and stop. Do **NOT**
  modify `gates.ocs-chatbot-eval-deep` in `run_state.yaml` — that field is
  flipped by the orchestrator only, after the operator approves via the
  Gate Brief Contract in `agents/ace-orchestrator.md`. The Phase 4
  agent's job ends at "gate brief written, phase summary written,
  `phases.ocs-setup.*` marked done." Auto-approving the gate violates
  the review-mode contract and bypasses operator review.
- Depends on: Step 2 (don't deep-test a miswired bot)

### Step 4: Stage credentials for Connect
Present `{public_id, embed_key}` and instruct the operator to paste them into
the Connect opportunity's widget configuration.
- Input: `ocs-agent-config.md` from Step 1
- Output: `ACE/<opp-name>/ocs-setup/widget-handoff.md` with the creds,
  target Connect URL, and exact paste instructions

**Why manual:** the Connect `update_opportunity` API is unbuilt (tracked under
CCC-301). When it ships, this step becomes a single API call. Until then,
`## Current Workaround` applies.

### Step 5: Widget-handoff eval
Unless `--no-evals` was passed, invoke the `ocs-widget-handoff-eval` skill.
- Input: `ACE/<opp-name>/ocs-setup/widget-handoff.md` from Step 4 +
  `ocs-agent-config.md` from Step 1 + the live OCS chatbot state
- Output: `ACE/<opp-name>/verdicts/ocs-agent-setup.yaml` (the producer
  here is `ocs-agent-setup` — the eval grades widget-handoff correctness
  + opportunity-binding completeness, both of which are
  `ocs-agent-setup` outputs)
- A `verdict: fail` here does not halt the run; the Phase 4→5 gate
  still uses `gate-briefs/ocs-chatbot-eval-deep.md`.

### Completion
Update opportunity state to mark Phase 4 as complete.
Write phase summary to `ACE/<opp-name>/ocs-setup-summary.md`.

## Resumption Contract

Phase 4 is the longest-running phase observed in real e2e runs (RAG
indexing + deep qa+eval can stretch toward an hour). On a session that
loses context mid-phase, the orchestrator may re-dispatch this agent
to resume. Resumption is **artifact-driven**, not polling-based —
see `agents/ace-orchestrator.md § Long-Running Skills — No Fake
Background Tasks` for the rule. To make resumption cheap, every step
is idempotent and artifact-checkable:

| Step | Done-when artifact exists | Action when found |
|------|---------------------------|-------------------|
| 1. `ocs-agent-setup` | `ACE/<opp-name>/ocs-agent-config.md` with full config block | Read it; reuse `experiment_id`, `collection_id`, etc. |
| 2. quick qa+eval | `ACE/<opp-name>/verdicts/ocs-chatbot-eval-quick.yaml` with `overall_score >= 7` | Skip; the gate already passed |
| 3. deep qa+eval | `ACE/<opp-name>/verdicts/ocs-chatbot-eval-deep.yaml` AND `ACE/<opp-name>/gate-briefs/ocs-chatbot-eval-deep.md` | Skip; brief is the gate output |
| 4. credential handoff | `ACE/<opp-name>/ocs-setup/widget-handoff.md` | Phase complete |

**On entry, before executing any step:**

1. Read `ACE/<opp-name>/run_state.yaml` (the orchestrator passes this
   inline per the orchestrator's Performance Conventions, but if it
   isn't in the prompt, fetch it from Drive).
2. **Apply the state-canary rule** from
   `agents/ace-orchestrator.md § Touching State — Operator Capture →
   State-as-canary contract`:
   - If a step shows `in_progress` AND `last_actor_at` ≤ 15 min ago,
     halt with a "another session appears to be working this opp"
     message — do not race.
   - If a step shows `in_progress` AND `last_actor_at` > 15 min ago,
     treat as **dead** and re-dispatch the step. Do NOT wait for a
     phantom completion.
3. For each step in order, check the artifact column above. If the
   artifact exists AND the corresponding `run_state.yaml` field shows
   `done`, skip that step and continue. If the artifact is missing OR
   the state field shows `pending`/`error`/`in_progress` (with stale
   `last_actor_at`), execute the step. **For Step 3 (deep qa+eval),
   a partial transcript with `Complete: false` is also a valid resume
   point** — `ocs-chatbot-qa` reads it and skips already-captured
   prompts (idempotent re-run; see `skills/ocs-chatbot-qa/SKILL.md
   § Process` Step 3).
4. Step 1's idempotence is special: if a chatbot named
   `ACE - <opp-name>` exists in OCS but `ocs-agent-config.md` is
   missing, treat the bot as authoritative and re-derive the config
   doc from `ocs_get_chatbot` — don't clone a second bot.

**State updates on resumption:** every step should still update
`run_state.yaml` on completion, even if the artifact pre-existed. This
keeps `last_actor`/`last_actor_at` accurate across the resumption
boundary. Skills must also write `<step>: in_progress` with a fresh
`last_actor_at` BEFORE doing work — that's the heartbeat the resume
canary depends on.

**No `ScheduleWakeup` mid-phase.** The Phase 4 agent must NOT
self-schedule a wakeup to "wait for the deep capture to finish." That
pattern produced the `turmeric-20260503-0835` failure (3+ hour stall,
no transcript, no recoverable evidence — fictional bg task). If
`ocs-chatbot-qa --deep` exceeds its wall-clock budget, it returns a
partial transcript with `Complete: false`; the orchestrator
re-dispatches this agent, and Step 3 above resumes from the partial.

**Why this matters:** observed in `e2e-xw5gk` (2026-04-29): a 2-hour
gap between a `drive_create_file` for `ocs-setup/widget-handoff.md`
preparation and the next ocs-setup tool call, after which the agent
was fresh-dispatched. The original session had already completed
Steps 1–3; without explicit resumption the resumed agent would have
re-cloned the bot, re-indexed the collection (~5–10 min), and
re-run the full deep qa+eval suite (~15–20 min). The contract above
turns that into a single state-read + a Step 4 finish.

## Dry-Run Behavior

When `--dry-run` is active:
- Step 1 stubs OCS atom calls (handled inside `ocs-agent-setup`)
- Steps 2–3: `ocs-chatbot-qa` skips sending test messages and prints the
  prompt suites that would run; `ocs-chatbot-eval` is a no-op (nothing
  captured to judge)
- Step 4 writes the handoff doc with placeholder credentials

## Failure Modes

- **Step 2 qa structural fails** — bot is miswired (no response, error
  fallback). Re-run `ocs-agent-setup`, verify embed credentials.
- **Step 2 eval fails repeatedly** — escalate to admin; probable
  prompt-engineering issue in the golden template or opp-specific prompt
  composition
- **Step 3 eval fails on opp-specific prompts** — retrieval / indexing
  issue. Check `collection_id` indexing status and the contents of
  `test-prompts.md`
- **Step 4 waits on operator** — this is expected until the Connect API lands
