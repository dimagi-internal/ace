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
  - { name: ocs-agent-setup,    has_judge: false }
  - { name: ocs-chatbot-qa,     has_judge: false }
  - { name: ocs-chatbot-eval,   has_judge: true }
---

# OCS Setup Agent (Phase 4)

You configure the per-opportunity OCS chatbot, quality-test it, and hand the
widget credentials to the operator to attach to the Connect opportunity.

This phase runs AFTER Connect setup (Phase 3) and BEFORE any LLO-facing
communication (Phase 6). No LLOs interact with the bot in this phase — only
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
- **Gate (review mode):** Present the gate brief for approval before
  completing the phase
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

### Completion
Update opportunity state to mark Phase 4 as complete.
Write phase summary to `ACE/<opp-name>/ocs-setup-summary.md`.

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
