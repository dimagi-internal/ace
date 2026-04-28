---
name: commcare-setup
description: >
  Phase 2 of the CRISPR-Connect lifecycle: translate the approved PDD into
  Learn and Deliver apps via Nova, deploy them to CommCare HQ, test, and
  generate training materials.
model: inherit
phase: commcare-setup
phase_display: CommCare Setup
phase_ordinal: 2
skills:
  - { name: pdd-to-learn-app,    has_judge: true }
  - { name: pdd-to-deliver-app,  has_judge: true }
  - { name: app-deploy,          has_judge: false }
  - { name: app-test,            has_judge: true }
  - { name: training-materials,  has_judge: true }
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

### Step 1: PDD to Apps (parallel)
Invoke `pdd-to-learn-app` and `pdd-to-deliver-app` skills. These can run in parallel.
- Input: approved PDD from GDrive
- Output: app JSON/CCZ files + summaries written to `ACE/<opp-name>/app-summaries/`
- **LLM-as-Judge:** Evaluate app quality against PDD requirements

### Step 2: Deploy Apps
Invoke the `app-deploy` skill.
- Input: app JSON/CCZ files from GDrive
- Output: apps uploaded to CCHQ CRISPR-Connect domain, built and published
- **Gate (review mode):** Present app deployment summary for verification
- Note: `app-test` depends on deployed apps (reads deployment-summary.md), so
  deploy must precede test

### Step 3: Test and Train (parallel)
Invoke `app-test` and `training-materials` skills. These can run in parallel.
- `app-test` input: deployed apps on CCHQ
- `app-test` output: test results in `ACE/<opp-name>/test-results/`
- `training-materials` input: app summaries from GDrive
- `training-materials` output: training docs in `ACE/<opp-name>/training-materials/`
- **LLM-as-Judge:** Both skills self-evaluate quality

### Completion
Update opportunity state to mark Phase 2 as complete.
Write phase summary to `ACE/<opp-name>/commcare-setup-summary.md`.
