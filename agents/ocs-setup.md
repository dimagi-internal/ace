---
name: ocs-setup
description: >
  Phase 5 of the ACE lifecycle: clone the ACE golden template,
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

### Step 0: Phase folder setup (do this FIRST)

Resolve-or-create this phase's artifact subfolder before any producer
skill runs (per `agents/orchestrator-reference.md` § Per-Phase Folder
Lifecycle → Phase-agent defensive folder contract):
`drive_create_folder({name: '5-ocs', parentFolderId: <run-folder id>, findOrCreate: true})`
— idempotent, returns the existing `5-ocs/` id on re-runs. **Every
artifact this phase produces** — the `ocs-agent-setup` doc, the quick +
deep QA transcripts, their eval verdicts, the widget-handoff doc and its
eval, and the phase summary — writes into THIS `5-ocs/` folder id. Pass
it to the producer skills as their artifact parent; never hand them the
run-folder id as the write parent (that lands every file flat at the run
root and fails the boundary's `verify_phase_artifacts`, which walks
`5-ocs/` — jjackson/ace#791).

### Step 1: Configure the chatbot
Invoke the `ocs-agent-setup` skill.
- Input: `ACE/<opp-name>/` — PDD, training materials, app summaries, opportunity config
- Output:
  - cloned chatbot with opp system prompt, RAG collection indexed,
    version published. `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-agent-setup.md` written with
    `{experiment_id, public_id, embed_key, collection_id, pipeline_id, version_number}`
  - Appended `system-prompt-baseline`, `rag-collection-scope`, `test-prompt-count` rows in `decisions.yaml` (merge-only; bar criterion per `skills/idea-to-pdd/SKILL.md § Decisions Log Convention`).
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

### Step 3: Stage the chatbot for the LLO
Lead with the **public chat URL** — the route that works today and needs no
configuration hop. Hold `{public_id, embed_key}` for the embed that becomes
possible when CCC-301 ships.
- Input: `ocs-agent-config.md` from Step 1
- Output: `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-setup_widget-handoff.md` with the
  public chat URL, the credentials, the Connect opportunity this bot is bound to
  (an identity reference, so a reader can tell which run's bot they hold), and a
  chat-test prompt whose answer is opp-specific

**Do NOT instruct anyone to paste the credentials into a Connect field.** There
is no per-opportunity widget field: `connect_update_opportunity` carries no
widget parameter and `mcp/connect/` has no widget or embed surface at all, and
`training-faq`, `training-quick-reference`, `training-flw-guide` and
`_training-template` all say so verbatim. An instruction naming a Connect
help-widget field group sends a reader hunting for a UI element this repo
elsewhere states is absent — that shipped on
`hh-poverty-targeting/20260828-0702` and is ace#1811.

**Why there is no API call:** Connect's `update_opportunity` has no widget-config
parameter (tracked under CCC-301). When it ships, this step becomes a single API
call and the credentials above become the payload.

### Step 4: Widget-handoff eval
Unless `--no-evals` was passed, invoke the `ocs-widget-handoff-eval` skill.
- Input: `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-setup_widget-handoff.md` from Step 3 +
  `ocs-agent-config.md` from Step 1 + the live OCS chatbot state
- Output: `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-widget-handoff-eval_verdict.yaml` (the producer
  here is `ocs-agent-setup` — the eval grades widget-handoff correctness
  + opportunity-binding completeness, both of which are
  `ocs-agent-setup` outputs)
- A `verdict: fail` here does not halt the run; the Phase 5→6 gate
  uses `5-ocs/ocs-chatbot-eval_verdict-quick.yaml` (Step 2).

### Completion
Before writing any phase state, the `ocs-agent-setup` skill MUST pass its
**hard embed round-trip gate** (Step 11.5): re-call
`ocs_get_chatbot_embed_info({ experiment_id })` and confirm the
`public_id`/`embed_key` about to be written round-trip against the live
chatbot. If they don't, the phase fails loudly rather than writing a
block with fabricated/placeholder IDs (jjackson/ace#585). The dependent
OCS calls inside that skill run **strictly serially** — clone → create
collection → upload → set pipeline → publish → embed_info — never batched
in one parallel block, so a latency-delayed result can't tempt an invented
placeholder id. `classify_phase_writeback` only checks block shape, so the
live round-trip is the only real guard against fabricated identifiers.

Write phase summary to `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-setup_summary.md`,
then write the `phases.ocs-setup` block per `agents/orchestrator-reference.md §
Phase Write-Back Contract`. Set `phases.ocs-setup.status: done` — the enum is closed
(`lib/run-state-validator.ts`); `complete` is a tolerated legacy synonym, not the
canonical spelling (ace#992). Required top-level keys on the patch: `phases`,
`last_actor`, `last_actor_at`. (0.13.116: legacy
`gates.ocs-chatbot-eval-quick` flip dropped — pause-point status derived
from phases.ocs-setup.status + per-skill verdicts.)

## Resumption Contract

Phase 5 is one of the longer-running phases (RAG indexing + the quick qa+eval can take 5–10 min). On a session that loses context mid-phase, the orchestrator may re-dispatch this agent to resume.

The general resumption procedure (state-canary read, 15-min liveness threshold, no-`ScheduleWakeup` rule) lives in [`orchestrator-reference.md § State-as-canary contract`](orchestrator-reference.md#state-as-canary-contract) and [§ Long-Running Skills — No Fake Background Tasks](orchestrator-reference.md#long-running-skills-no-fake-background-tasks). Read those first; the table below specifies the **Phase-5-specific** resume points each step exposes.

| Step | Done-when artifact exists | Action when found |
|------|---------------------------|-------------------|
| 1. `ocs-agent-setup` | `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-agent-setup.md` with full config block | Read it; reuse `experiment_id`, `collection_id`, etc. |
| 2. quick qa+eval | `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-chatbot-eval_verdict-quick.yaml` with every per-prompt `overall_quality >= 2` | Skip; the gate already passed |
| 3. credential handoff | `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-setup_widget-handoff.md` | Phase complete |

Phase-5-specific resume notes (beyond the general state-canary rule):

- **Step 2 partial-transcript resume.** A transcript file with `Complete: false` is a valid resume point — `ocs-chatbot-qa` reads it and skips already-captured prompts (idempotent re-run; see `skills/ocs-chatbot-qa/SKILL.md § Process` Step 3). The general state-canary rule's "missing artifact" branch is too coarse for this case.
- **Step 1 bot-as-authoritative override — RUN-SCOPED (dimagi-internal/ace#1017).** If a chatbot named **`ACE - <opp-name> (<run-id>)`** — the current run's id, exact match — exists in OCS but `ocs-agent-config.md` is missing, treat that bot as authoritative and re-derive the config doc from `ocs_get_chatbot` — don't clone a second bot. **A bot named `ACE - <opp-name>` with no run-id, or with a DIFFERENT run's id, is NOT a match**: it belongs to a previous run, its collection is indexed off a superseded PDD and superseded app summaries, and resuming it silently hands Phase 6 / `/ace:qa-deep` / the Phase 8 activation gate a bot built from the wrong run's design. That violates the phase-precondition rule (restore, don't adapt). Prior-run bots get recorded for `/ace:sweep ocs` disposal, not resumed.

**Why this matters:** observed in `e2e-xw5gk` (2026-04-29): a 2-hour gap between `drive_create_file` for `ocs-setup/widget-handoff.md` preparation and the next ocs-setup tool call, after which the agent was fresh-dispatched. The original session had already completed Steps 1–2; without explicit resumption the resumed agent would have re-cloned the bot, re-indexed the collection (~5–10 min), and re-run the qa+eval suite. The contract above turns that into a single state-read + a Step 3 finish.

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
  **Exception — `OCS generation error` with a trace pointer:** when the
  atom's error carries `[session …; underlying trace: …]`, the bot
  config is reachable and the failure is server-side generation. Open
  the trace (team login) and branch on the underlying error BEFORE
  blocking the phase: `authentication_error: invalid x-api-key` means
  the TEAM's LLM provider key is dead (golden template fails
  identically — that does NOT prove a platform outage; jjackson/ace#743).
  Repair = re-key the provider at `/a/<team>/service_providers/llm/<pk>/`
  and re-run the quick gate; re-running `ocs-agent-setup` won't help.
- **Step 2 eval fails repeatedly** — any per-prompt `overall_quality`
  < 2/3 after one `--prompt-patch` retry → escalate to admin; probable
  prompt-engineering issue in the golden template or opp-specific
  prompt composition. Deep multi-dimensional regressions (e.g.
  retrieval / indexing problems on opp-specific prompts) surface in
  `/ace:qa-deep` and the Phase 8 `llo-launch` activation gate, not
  in Phase 5.
- **Step 3 waits on operator** — this is expected until the Connect API lands
