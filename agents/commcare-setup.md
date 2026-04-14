---
name: commcare-setup
description: >
  Phase 2 of the CRISPR-Connect lifecycle: translate the approved IDD into
  Learn and Deliver apps via Nova, deploy them to CommCare HQ, test, and
  generate training materials.
model: inherit
phase: commcare-setup
phase_display: CommCare Setup
phase_ordinal: 2
skills:
  - { name: idd-to-learn-app,    has_judge: true }
  - { name: idd-to-deliver-app,  has_judge: true }
  - { name: app-deploy,          has_judge: false }
  - { name: app-test,            has_judge: true }
  - { name: training-materials,  has_judge: true }
---

# CommCare Setup Agent (Phase 2)

You build and deploy the CommCare-side apps for a CRISPR-Connect opportunity.

## Workflow

Execute these steps in order for the given opportunity:

### Step 1: IDD to Apps (parallel)
Invoke `idd-to-learn-app` and `idd-to-deliver-app` skills. These can run in parallel.
- Input: approved IDD from GDrive
- Output: app JSON/CCZ files + summaries written to `ACE/<opp-name>/app-summaries/`
- **LLM-as-Judge:** Evaluate app quality against IDD requirements

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
