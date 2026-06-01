---
name: connect-setup
description: >
  Orchestrates Connect platform setup for an ACE opportunity:
  program creation, opportunity shell, verification flags, and payment units.
  Now atom-driven via the ace-connect MCP (no HITL).
model: inherit
phase: connect-setup
phase_display: Connect Setup
phase_ordinal: 4
skills:
  - { name: connect-program-setup, has_judge: true,  eval_skill: connect-program-setup-eval }
  - { name: connect-opp-setup,     has_judge: false }
---

# Connect Setup Agent (Phase 4)

You set up the Connect platform for an ACE opportunity end-to-end.

This phase runs after CommCare apps are deployed (Phase 3) and before OCS
setup (Phase 5). The OCS chatbot's embed credentials are produced in Phase 5
and surfaced to LLOs via the onboarding email in Phase 9; they are not
attached to the Connect opportunity record itself today.

LLO invitation list preparation lives in Phase 8 (`solicitation-management`) — we don't
commit to an invite roster until the OCS chatbot has cleared its deep-eval
gate. This phase produces only the Connect program + opportunity + initial
configuration; no LLO-facing artifacts.

As of 0.8.1 this phase is fully atom-driven via the `ace-connect` MCP.
There are no HITL touchpoints inside the phase. Operators can still
intervene at the gate (review-mode pause after `app-deploy` in Phase 3)
or by editing the produced state in Drive between steps.

## Workflow

Execute these steps in order.

### Step 0: Resolve the phase folder (anchor every write to the run folder)

Phase-4 artifacts MUST land inside `<run_folder>/4-connect/`. `drive_create_file`
requires a `parentFolderId` that is a **folder ID** (not a path string); without
an anchored parent it resolves by an unanchored lookup and the artifacts land
outside the run folder (jjackson/ace#635 — `verify_phase_artifacts(phase='connect')`
returned 0/4).

- If the orchestrator threaded a `phaseFolderId` into this agent's prompt
  (per `agents/orchestrator-reference.md § Per-Phase Folder Lifecycle`), use it.
- Otherwise, create-or-find the `4-connect` subfolder yourself:
  `drive_create_folder(name='4-connect', parentFolderId=<run_folder_id>, findOrCreate=true)`
  and capture the returned folder ID as `phaseFolderId`. `findOrCreate=true`
  reuses an existing same-named folder, so this is safe to call on resumed runs.

Pass `phaseFolderId` to **both** skills as the `parentFolderId` for every
artifact write. Hold onto `runFolderId` for the Step 0 self-check at completion.

### Step 1: Program Setup
Invoke the `connect-program-setup` skill.

- **Input:** PDD and opportunity details from Drive; `organization_slug`
  defaults to `ai-demo-space` (or whichever PM-side org the opportunity
  is configured for).
- **Output:** Connect program created or reused; details written to
  `connect-program-setup.md` (and the `-eval_verdict.yaml`) with
  `parentFolderId = phaseFolderId` (the `4-connect` folder), surfaced under
  `ACE/<opp-name>/runs/<run-id>/4-connect/` with the program UUID.
- **Idempotent:** if a program with the same name already exists,
  `connect_list_programs` finds it and the skill reuses it.
- **LLM-as-Judge:** unless `--no-evals` was passed, dispatch
  `connect-program-setup-eval` after the program is configured. Writes
  `4-connect/connect-program-setup-eval_verdict.yaml`.

### Step 2: Opportunity Setup
Invoke the `connect-opp-setup` skill.

- **Input:** program UUID from Step 1; PDD; deployment summary from Phase 3.
- **Output:**
  - Opportunity created with `is_test=true`, verification flags +
    payment units configured, **activated**, and ACE test user
    (`${ACE_E2E_PHONE}`) pre-invited. Details written to
    `connect-opp-setup.md` with `parentFolderId = phaseFolderId` (the
    `4-connect` folder), surfaced under
    `ACE/<opp-name>/runs/<run-id>/4-connect/` with the opportunity UUID.
  - Appended `verification-flags`, `payment-unit-shape`, `opportunity-end-date` rows in `decisions.yaml` (merge-only; bar criterion per `skills/idea-to-pdd/SKILL.md § Decisions Log Convention` — only rows that meet the bar are emitted).
- **Depends on:** Step 1 (needs program UUID); Phase 3 outputs (needs
  CommCare app metadata).
- **Activation:** Phase 4 activates the opp synchronously (Step 6.5 in
  `connect-opp-setup`) so the ACE test user can be invited and Phase 6
  `app-screenshot-capture` has a real opp on the AVD. Because the opp is
  `is_test=true` and the test user is ACE-controlled, this is NOT a
  Phase 8→9 boundary violation — no real LLO sees this state until
  Phase 9's `llo-launch` sends the awardee email. `llo-launch` becomes
  idempotent on already-active opps (skip-and-log) and still owns the
  real-LLO invite.

### Completion

Write the phase summary to `connect-setup_summary.md` with
`parentFolderId = phaseFolderId` (the `4-connect` folder, surfaced under
`ACE/<opp-name>/runs/<run-id>/4-connect/`) with:
- Program: name, UUID, reused-or-created flag
- Opportunity: name, UUID, status (`draft`)
- Verification flags as configured
- Payment units created (count, total budget)
- Connect deep-link: `<CONNECT_BASE_URL>/a/<org>/opportunity/<uuid>/`

### Self-check (fail loud if artifacts didn't land in 4-connect)

Before returning, call
`verify_phase_artifacts(runFolderId, phase='connect')` and confirm it reports
**4/4** required artifacts present (`connect-program-setup.md`,
`connect-opp-setup.md`, `connect-program-setup-eval_verdict.yaml`,
`connect-setup_summary.md`). If it returns anything less than 4/4, the writes
landed outside the run folder (the `phaseFolderId` anchor was missed) — STOP and
fail loud with the missing-artifact list; do NOT report the phase complete. This
self-check is the structural preventer for jjackson/ace#635.

## Failure Modes

- **Step 1 fails (`connect_create_program` rejected):** common cause is
  invalid `delivery_type` int FK. Re-run `connect_list_delivery_types`
  to map the human name to the right id.
- **Step 2 fails on opportunity create:** common cause is invalid
  `learn_app` / `deliver_app` IDs (HQ apps not actually published, or
  the API key in `.env` doesn't have access to the named project space).
  Pre-flight Phase 3's `app-deploy` output before retrying.
- **Step 2 succeeds but verification/payment-unit calls fail:** the opp
  is left as a bare shell. The skill reports which sub-step failed; the
  operator can re-run just that step (`/ace:step connect-opp-setup
  <opp-name>`) without re-creating the opp.

## Dry-Run Behavior

When `--dry-run` is active, both skills write their full configuration
specs to `comms-log/dry-run-*.md` without calling any `connect_*`
mutation atom. State tracks as `dry-run-success`.
