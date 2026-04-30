---
name: commcare-setup
description: >
  Phase 2 of the CRISPR-Connect lifecycle: translate the approved PDD into
  Learn and Deliver apps via Nova, deploy them to CommCare HQ, and test.
model: inherit
phase: commcare-setup
phase_display: CommCare Setup
phase_ordinal: 2
skills:
  - { name: pdd-to-learn-app,        has_judge: true }
  - { name: pdd-to-deliver-app,      has_judge: true }
  - { name: app-connect-coverage,    has_judge: false }
  - { name: app-deploy,              has_judge: false }
  - { name: app-release,             has_judge: false }
  - { name: app-test,                has_judge: true }
---

# CommCare Setup (Phase 2 Procedure Document)

This file specifies Phase 2 of the CRISPR-Connect lifecycle: build and
deploy the CommCare-side apps.

**This file is read and executed inline by the top-level Claude Code
session — it is NOT dispatched as a subagent.** Step 1 invokes
`/nova:autobuild`, which itself dispatches `nova:nova-architect-autonomous`
via the `Agent` tool. `Agent` is only available at level 0; running
Phase 2 as a subagent would put Nova's dispatch at level 2 and fail.
See `agents/ace-orchestrator.md` § Agent Topology. The frontmatter is
retained for tooling that introspects agent metadata, not because Phase
2 is itself dispatched.

## Workflow

Execute these steps in order for the given opportunity:

### Step 1: PDD to Apps (parallel — REQUIRED)
Invoke `pdd-to-learn-app` and `pdd-to-deliver-app` skills.

**These MUST run in parallel.** Each skill dispatches `/nova:autobuild`
which takes 10–15 minutes; running serially wastes ~7 minutes of
wall-clock per opp. Dispatch both `Agent` calls in a **single assistant
message** (two tool-use blocks side-by-side) and await both before
proceeding to Step 1.5. Do not start Deliver after Learn returns.

The two builds are fully independent — Learn reads the PDD's learning
objectives, Deliver reads the visit/registration spec, neither depends
on the other's `nova_app_id`. The topology rule (level-0 dispatch) is
preserved: both Nova subagents dispatch from the top-level session.

If one Nova build fails and the other succeeds, surface the failure
without re-running the successful side.

- Input: approved PDD from GDrive
- Output: app JSON/CCZ files + summaries written to `ACE/<opp-name>/app-summaries/`
- **LLM-as-Judge:** Evaluate app quality against PDD requirements

### Step 1.5: Connect-marker coverage (verify + auto-fix)
Invoke the `app-connect-coverage` skill **once per app** (Learn, Deliver).
- Input: `nova_app_id` from each app summary; PDD for context
- Output: `ACE/<opp-name>/app-coverage/{learn,deliver}-connect-coverage.md`
  reporting before/after state per form. The Nova app on Firestore is
  mutated in place — every form's `connect` block (`learn_module` /
  `assessment` / `deliver_unit` / `task`) is set per the form's purpose.
- **Why before deploy:** Connect's `Sync Deliver Units` reads markers
  from the released CCZ. If markers are missing, the opp gets stuck
  silently at Phase 3 Step 2 (no deliver units → no payment unit).
  Fixing on the Nova side before upload avoids round-tripping HQ
  builds.
- **Why before eval:** the existing `pdd-to-{learn,deliver}-app-eval`
  judges grade Connectify wiring (25% weight). Running coverage first
  means evals score the auto-fixed app, not whatever Nova happened to
  emit.
- **Failure mode:** if the skill exits `blocked` with a Nova-bug
  pointer (`voidcraft-labs/nova-plugin#1`), halt Phase 2 — `app-deploy`
  + `app-release` will produce a broken opp downstream. Wait for
  upstream fix.

### Step 2: Deploy Apps
Invoke the `app-deploy` skill.
- Input: app JSON/CCZ files from GDrive
- Output: apps uploaded to CCHQ as **draft builds** (Nova does not release
  by design — see Step 2.5)
- **Gate (review mode):** Present app deployment summary for verification

### Step 2.5: Release Apps
Invoke the `app-release` skill.
- Input: HQ app ids from `deployment-summary.md`
- Output: each app has a new released build; Connect's `Sync Deliver Units`
  can now read the form schema. Without this step, Phase 3
  (`connect-opp-setup`) creates the opp shell but cannot configure
  payment units (deliver-units list comes back empty).
- **Prerequisite:** the user backing `ACE_HQ_USERNAME` needs a role with
  `edit_apps` on the target project space; the standard `Admin` role
  includes it. The skill includes an empirical probe procedure for the
  underlying CCHQ endpoints — they're internal UI routes, not stable
  public APIs.
- Note: `app-test` reads `deployment-summary.md`, so deploy + release must
  precede test.

### Step 3: Test
Invoke the `app-test` skill.
- `app-test` input: deployed apps on CCHQ
- `app-test` output: test results in `ACE/<opp-name>/test-results/`
- **LLM-as-Judge:** Self-evaluate quality

Note: `training-materials` no longer runs in Phase 2. As of 0.9.0 it lives
in Phase 5 (`training-prep`), where it consumes the screenshots produced
by `app-screenshot-capture` alongside the app summaries.

### Completion
Update opportunity state to mark Phase 2 as complete.
Write phase summary to `ACE/<opp-name>/commcare-setup-summary.md`.
