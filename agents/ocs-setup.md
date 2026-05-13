---
name: ocs-setup
description: >
  Phase 6 of the CRISPR-Connect lifecycle: clone the ACE golden template,
  build the opp-specific RAG collection, smoke-test the bot via a thin
  quick chat suite, and stage the widget credentials for Connect.
model: inherit
phase: ocs-setup
phase_display: OCS Setup
phase_ordinal: 5
skills:
  - { name: ocs-agent-setup,    has_judge: true,  eval_skill: ocs-widget-handoff-eval }
  - { name: ocs-chatbot-qa,     has_judge: false }
  - { name: ocs-chatbot-eval,   has_judge: true }
---

# OCS Setup Agent (Phase 5)

You configure the per-opportunity OCS chatbot, smoke-test it, and hand the
widget credentials to the operator to attach to the Connect opportunity.

This phase runs AFTER Connect setup (Phase 4) and BEFORE any LLO-facing
communication (Phase 9). No LLOs interact with the bot in this phase — only
the ACE judge does. The Phase 5 quality gate is a single **qa → eval pair**
in `--quick` mode (3 prompts × 1 dim) per the QA vs Eval contract in
`skills/README.md`: `ocs-chatbot-qa` captures a transcript,
`ocs-chatbot-eval` judges it.

**Note:** Deep OCS evaluation moved out of Phase 5 in the shallow/deep
QA split refactor. Run `/ace:qa-deep <opp>` after `/ace:run` completes
to grade chatbot quality before go-live. The Phase 9 `llo-launch` gate
refuses to proceed without a fresh, passing deep verdict.

## Workflow

### Step 1: Configure the chatbot
Invoke the `ocs-agent-setup` skill.
- Input: `ACE/<opp-name>/` — PDD, training materials, app summaries, opportunity config
- Output: cloned chatbot with opp system prompt, RAG collection indexed,
  version published. `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-agent-setup.md` written with
  `{experiment_id, public_id, embed_key, collection_id, pipeline_id, version_number}`
- Idempotent: if a bot named `"ACE - <opp-name>"` already exists, resumes from
  existing config

### Step 2: Quick smoke gate (qa → eval)
Invoke `ocs-chatbot-qa --quick`, then `ocs-chatbot-eval --quick`.
- Input: `experiment_id` from Step 1
- qa captures: 3-prompt transcript (universal Connect-domain questions
  — claim opp, sync data, get paid) with structural checks
- eval grades: single-dimension `overall_quality_0_to_3` per prompt;
  writes verdict to `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-chatbot-eval_verdict-quick.yaml`
- Tests: shared-collection retrieval against universal Connect prompts.
  Fast fail if the bot is miswired (qa-side structural fail) or any
  prompt scores < 2/3 (eval-side)
- **Gate (Phase 5→6):** if qa structural pass rate < 100% OR any
  per-prompt `overall_quality` < 2/3, dispatch
  `ocs-agent-setup --prompt-patch` once (recomposes the prompt and
  re-saves the pipeline; skips the 5–10 min re-index because the RAG
  content didn't change), then re-run `ocs-chatbot-qa --quick` and
  `ocs-chatbot-eval --quick`. If still failing, escalate to admin
  group. This is the only OCS gate Phase 5 enforces — deep
  multi-dimensional judging now lives in `/ace:qa-deep` and gates
  Phase 9 activation.
- Depends on: Step 1

### Step 3: Stage credentials for Connect
Present `{public_id, embed_key}` and instruct the operator to paste them into
the Connect opportunity's widget configuration.
- Input: `ocs-agent-config.md` from Step 1
- Output: `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-setup_widget-handoff.md` with the creds,
  target Connect URL, and exact paste instructions

**Why manual:** the Connect `update_opportunity` API is unbuilt (tracked under
CCC-301). When it ships, this step becomes a single API call. Until then,
`## Current Workaround` applies.

### Step 4: Widget-handoff eval
Unless `--no-evals` was passed, invoke the `ocs-widget-handoff-eval` skill.
- Input: `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-setup_widget-handoff.md` from Step 3 +
  `ocs-agent-config.md` from Step 1 + the live OCS chatbot state
- Output: `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-widget-handoff-eval_verdict.yaml` (the producer
  here is `ocs-agent-setup` — the eval grades widget-handoff correctness
  + opportunity-binding completeness, both of which are
  `ocs-agent-setup` outputs)
- A `verdict: fail` here does not halt the run; the Phase 5→6 gate
  uses `verdicts/ocs-chatbot-eval-quick.yaml` (Step 2).

### Completion
Write phase summary to `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-setup_summary.md`,
then write the `phases.ocs-setup` block per `agents/ace-orchestrator.md §
Phase Write-Back Contract`. Required top-level keys on the patch: `phases`,
`last_actor`, `last_actor_at`. (0.13.116: legacy
`gates.ocs-chatbot-eval-quick` flip dropped — pause-point status derived
from phases.ocs-setup.status + per-skill verdicts.)

## Resumption Contract

Phase 5 is one of the longer-running phases (RAG indexing + the
quick qa+eval can take 5–10 min). On a session that loses context
mid-phase, the orchestrator may re-dispatch this agent to resume.
Resumption is **artifact-driven**, not polling-based — see
`agents/ace-orchestrator.md § Long-Running Skills — No Fake
Background Tasks` for the rule. To make resumption cheap, every step
is idempotent and artifact-checkable:

| Step | Done-when artifact exists | Action when found |
|------|---------------------------|-------------------|
| 1. `ocs-agent-setup` | `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-agent-setup.md` with full config block | Read it; reuse `experiment_id`, `collection_id`, etc. |
| 2. quick qa+eval | `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-chatbot-eval_verdict-quick.yaml` with every per-prompt `overall_quality >= 2` | Skip; the gate already passed |
| 3. credential handoff | `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-setup_widget-handoff.md` | Phase complete |

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
   `last_actor_at`), execute the step. **For Step 2 (quick qa+eval),
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

**No `ScheduleWakeup` mid-phase.** The Phase 5 agent must NOT
self-schedule a wakeup to "wait for a capture to finish." That
pattern produced the `turmeric-20260503-0835` failure (3+ hour stall,
no transcript, no recoverable evidence — fictional bg task). If
`ocs-chatbot-qa --quick` exceeds its 270s wall-clock budget, it
returns a partial transcript with `Complete: false`; the orchestrator
re-dispatches this agent, and Step 2 above resumes from the partial.

**Why this matters:** observed in `e2e-xw5gk` (2026-04-29): a 2-hour
gap between a `drive_create_file` for `ocs-setup/widget-handoff.md`
preparation and the next ocs-setup tool call, after which the agent
was fresh-dispatched. The original session had already completed
Steps 1–2; without explicit resumption the resumed agent would have
re-cloned the bot, re-indexed the collection (~5–10 min), and
re-run the qa+eval suite. The contract above turns that into a
single state-read + a Step 3 finish.

## Dry-Run Behavior

When `--dry-run` is active:
- Step 1 stubs OCS atom calls (handled inside `ocs-agent-setup`)
- Step 2: `ocs-chatbot-qa --quick` skips sending test messages and
  prints the prompt suite that would run; `ocs-chatbot-eval --quick`
  is a no-op (nothing captured to judge)
- Step 3 writes the handoff doc with placeholder credentials

## Failure Modes

- **Step 2 qa structural fails** — bot is miswired (no response, error
  fallback). Re-run `ocs-agent-setup`, verify embed credentials.
- **Step 2 eval fails repeatedly** — any per-prompt `overall_quality`
  < 2/3 after one `--prompt-patch` retry → escalate to admin; probable
  prompt-engineering issue in the golden template or opp-specific
  prompt composition. Deep multi-dimensional regressions (e.g.
  retrieval / indexing problems on opp-specific prompts) surface in
  `/ace:qa-deep` and the Phase 8 `llo-launch` activation gate, not
  in Phase 5.
- **Step 3 waits on operator** — this is expected until the Connect API lands
