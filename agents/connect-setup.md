---
name: connect-setup
description: >
  Orchestrates Connect platform setup for an ACE opportunity:
  program creation, opportunity shell, verification flags, payment units,
  and the Phase 4 decision rows a reviewer reads (decisions.yaml is the review artifact). Now atom-driven via the ace-connect MCP (no HITL).
model: inherit
phase: connect-setup
phase_display: Connect Setup
phase_ordinal: 4
skills:
  - { name: connect-program-setup, has_judge: true,  eval_skill: connect-program-setup-eval }
  - { name: connect-opp-setup,     has_judge: true,  eval_skill: connect-opp-setup-eval }
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

Pass `phaseFolderId` to **all three** skills as the `parentFolderId` for every
artifact write. Hold onto `runFolderId` for the Step 0 self-check at completion.

### Step 1: Program Setup
Invoke the `connect-program-setup` skill.

- **Input:** PDD and opportunity details from Drive; `organization_slug`
  is the configured PM org — `connect_orgs.pm_org` from the preflight
  block the orchestrator passes in (`lib/connect-orgs.ts`; if the dispatch
  did not carry it, run `bash bin/ace-doctor --preflight --no-live` and read
  `connect_orgs:`; HALT when `connect_orgs` reports `fail`). A reused program
  keeps the org recorded in `opp.yaml.connect.program.url`. Pass
  `connect_orgs` through to `connect-program-setup` and `connect-opp-setup`.
  **When `connect_orgs.nm_org` is configured, Phase 4 runs the real PM→NM
  flow:** the program is in the PM org, `connect-opp-setup` invites + accepts
  the NM org and creates the opportunity HELD by it, and verification rules
  are set at the PM org's URL (Connect serves that PM-only page only when
  request org ≠ holding org — ace#2419). Unset → the legacy self-managed
  shape. `lib/connect-orgs.ts` `phase4Orgs()` is the rule.
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
  - **One `decisions.yaml` row per verification rule, per `[ACE]` latitude and per `[FIXED]` ambiguity** (Step 8a) — with `phase: 4-connect`, `skill: connect-opp-setup`, each carrying `plain` and, for rule rows, `scope` + `enforcement` (a rule Connect refused is `enforcement: gap`, which becomes a review ask). The decisions log is the run's review artifact — the build memo is retired (`docs/decisions-contract.md`, `skills/connect-opp-setup/SKILL.md § Decisions Log`). The Phase 4 boundary fails if `connect-opp-setup.md` exists and the skill wrote zero live rows (`verify_phase_artifacts(phase='connect').decisions`; ace#2384).
- **LLM-as-Judge:** unless `--no-evals` was passed, dispatch
  `connect-opp-setup-eval` once the opportunity is configured. Writes
  `4-connect/connect-opp-setup-eval_verdict.yaml`. The eval existed and was
  registered (`_eval-decisions.md`: has eval) but nothing dispatched it, so no
  run ever had the verdict — release-check (now validate-release-readiness) flagged it missing on
  spark-facilitator/20260926-1800.
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

**Write each external identifier the moment its create call returns — do NOT
batch it into this block (ace#2412).** The opportunity UUID and `int_id`, each
payment-unit id, and the test-user invite are external Connect objects, and a
re-dispatch mints a SECOND opportunity — which also permanently burns a shared
`DeliverUnit` binding against the same released Deliver app, so the duplicate
cannot create its payment units at all. A phase killed before reaching this
section leaves `products: null` while the opportunity already exists.
`verify_phase_products` validates an in-flight phase for shape only
(`mode: fragment`), so the incremental write passes the fence. Rationale:
`agents/orchestrator-reference.md § Write an EXTERNAL identifier in the step
that mints it`.

Write the phase summary to `connect-setup_summary.md` with
`parentFolderId = phaseFolderId` (the `4-connect` folder, surfaced under
`ACE/<opp-name>/runs/<run-id>/4-connect/`) with:
- Program: name, UUID, reused-or-created flag
- Opportunity: name, UUID, status — **`active` with `is_test=true`**, not
  `draft`. Step 2's Step 6.5 activates synchronously (see § Activation
  above), so a `draft` opp at end of Phase 4 is a defect, not the
  expected end state: `connect-program-setup-eval`'s `active_window_status`
  dimension scores a never-activated opp ≤3, and Phase 6
  `app-screenshot-capture` cannot claim a non-active opp.
- Verification flags as configured
- Payment units created (count, total budget)
- Orgs: `pm_org_slug` (program) and `holding_org_slug` (opportunity) plus
  `org_mode` (`pm-nm` | `self-managed`)
- Connect deep-link: `<CONNECT_BASE_URL>/a/<holding_org_slug>/opportunity/<uuid>/`
- **To confirm before launch:** the live `review_ask` rows `decisions_enrich`
  reports (id + `plain` + `confirm_reason`) — the list a reviewer must settle.

### Output previews (best effort — after the write-back, before you return)

Every output this phase built must end up either a doc ace-web can draw or with
one or more good screenshots (ace-web `docs/specs/2026-09-29-output-previews-design.md`,
addendum). **After** the `phases.connect-setup` write-back above — ace-web reads this
phase's outputs from `run_state.yaml` — invoke `Skill(output-preview-capture)` with
`opp`, `run_id`, `captured_phase: connect-setup` and the phase filter `connect-setup`. Expect the Connect program (its card on the Programs page) and the opportunity (overview + verification).
It photographs what ace-web's gap list still shows for this phase, looks at every
frame, and files the good ones under this phase's `previews/` folder. It **never
fails or blocks the phase**: whatever it returns, put its one line —
`previews: N captured, M gaps left (<why>)` — in the phase summary (update
`<phase>_summary.md` if it is already written) and in the text you return.

### Self-check (fail loud if artifacts didn't land in 4-connect)

Before returning, call
`verify_phase_artifacts(runFolderId, phase='connect')` and confirm `ok: true` —
all **4** required artifacts present (`connect-program-setup.md`,
`connect-opp-setup.md`, `connect-program-setup-eval_verdict.yaml`,
`connect-setup_summary.md`). If anything is missing, either the
writes landed outside the run folder (the `phaseFolderId` anchor was missed) or a
step never wrote its artifact — STOP and fail loud with the missing-artifact
list; do NOT report the phase complete. This self-check is the structural
preventer for jjackson/ace#635.

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

When `--dry-run` is active, both Connect skills write their full configuration
specs to `comms-log/dry-run-*.md` without calling any `connect_*`
mutation atom. State tracks as `dry-run-success`.
