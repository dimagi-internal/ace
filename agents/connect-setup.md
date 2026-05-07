---
name: connect-setup
description: >
  Orchestrates Connect platform setup for a CRISPR-Connect opportunity:
  program creation, opportunity shell, verification flags, and payment units.
  Now atom-driven via the ace-connect MCP (no HITL).
model: inherit
phase: connect-setup
phase_display: Connect Setup
phase_ordinal: 3
skills:
  - { name: connect-program-setup, has_judge: true,  eval_skill: connect-program-setup-eval }
  - { name: connect-opp-setup,     has_judge: false }
---

# Connect Setup Agent (Phase 3)

You set up the Connect platform for a CRISPR-Connect opportunity end-to-end.

This phase runs after CommCare apps are deployed (Phase 2) and before OCS
setup (Phase 4). The OCS chatbot's embed credentials are produced in Phase 4
and surfaced to LLOs via the onboarding email in Phase 7; they are not
attached to the Connect opportunity record itself today.

LLO invitation list preparation lives in Phase 6 (`solicitation-management`) — we don't
commit to an invite roster until the OCS chatbot has cleared its deep-eval
gate. This phase produces only the Connect program + opportunity + initial
configuration; no LLO-facing artifacts.

As of 0.8.1 this phase is fully atom-driven via the `ace-connect` MCP.
There are no HITL touchpoints inside the phase. Operators can still
intervene at the gate (review-mode pause after `app-deploy` in Phase 2)
or by editing the produced state in Drive between steps.

## Workflow

Execute these steps in order.

### Step 1: Program Setup
Invoke the `connect-program-setup` skill.

- **Input:** PDD and opportunity details from Drive; `organization_slug`
  defaults to `ai-demo-space` (or whichever PM-side org the opportunity
  is configured for).
- **Output:** Connect program created or reused; details in
  `ACE/<opp-name>/runs/<run-id>/3-connect/connect-program-setup.md` with the program UUID.
- **Idempotent:** if a program with the same name already exists,
  `connect_list_programs` finds it and the skill reuses it.
- **LLM-as-Judge:** unless `--no-evals` was passed, dispatch
  `connect-program-setup-eval` after the program is configured. Writes
  `verdicts/connect-program-setup.yaml`.

### Step 2: Opportunity Setup
Invoke the `connect-opp-setup` skill.

- **Input:** program UUID from Step 1; PDD; deployment summary from Phase 2.
- **Output:** Opportunity created in `draft` state with verification
  flags + payment units configured. Details in
  `ACE/<opp-name>/runs/<run-id>/3-connect/connect-opp-setup.md` with the opportunity
  UUID.
- **Depends on:** Step 1 (needs program UUID); Phase 2 outputs (needs
  CommCare app metadata).
- **Activation:** the opportunity is created in `draft` and stays there
  until `llo-launch` (Phase 7) flips it to `active` after UAT.

### Completion

Write phase summary to
`ACE/<opp-name>/runs/<run-id>/3-connect/connect-setup_summary.md` with:
- Program: name, UUID, reused-or-created flag
- Opportunity: name, UUID, status (`draft`)
- Verification flags as configured
- Payment units created (count, total budget)
- Connect deep-link: `<CONNECT_BASE_URL>/a/<org>/opportunity/<uuid>/`

## Failure Modes

- **Step 1 fails (`connect_create_program` rejected):** common cause is
  invalid `delivery_type` int FK. Re-run `connect_list_delivery_types`
  to map the human name to the right id.
- **Step 2 fails on opportunity create:** common cause is invalid
  `learn_app` / `deliver_app` IDs (HQ apps not actually published, or
  the API key in `.env` doesn't have access to the named project space).
  Pre-flight Phase 2's `app-deploy` output before retrying.
- **Step 2 succeeds but verification/payment-unit calls fail:** the opp
  is left as a bare shell. The skill reports which sub-step failed; the
  operator can re-run just that step (`/ace:step connect-opp-setup
  <opp-name>`) without re-creating the opp.

## Dry-Run Behavior

When `--dry-run` is active, both skills write their full configuration
specs to `comms-log/dry-run-*.md` without calling any `connect_*`
mutation atom. State tracks as `dry-run-success`.
