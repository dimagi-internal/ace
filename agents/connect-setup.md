---
name: connect-setup
description: >
  Orchestrates Connect platform setup for a CRISPR-Connect opportunity:
  program creation and opportunity configuration.
model: inherit
phase: connect-setup
phase_display: Connect Setup
phase_ordinal: 3
skills:
  - { name: connect-program-setup, has_judge: false }
  - { name: connect-opp-setup,     has_judge: false }
---

# Connect Setup Agent (Phase 3)

You set up the Connect platform for a CRISPR-Connect opportunity.

This phase runs after CommCare apps are deployed (Phase 2) and before OCS setup
(Phase 4). The OCS chatbot's embed credentials will be patched onto the
opportunity record in Phase 4.

LLO invitation list preparation moved to Phase 5 (llo-manager) as of
2026-04-20 — it's now the first step of LLO Management, gated after the
OCS chatbot has passed its deep quality gate. This phase produces only
the Connect program + opportunity shell; no LLO-facing artifacts.

## Workflow

Execute these steps in order. Before creating a Program, ensure the correct Connect Workspace is selected. The CRISPR-Connect workspace should be used for all ACE opportunities.

### Step 1: Program Setup
Invoke the `connect-program-setup` skill.
- Input: PDD and opportunity details from GDrive
- Output: Program created/configured in Connect
- Note: may not need a new program each time — check if existing program fits

### Step 2: Opportunity Setup
Invoke the `connect-opp-setup` skill.
- Input: Program ID, PDD, app deployment details
- Output: Opportunity created with verification rules, delivery units, payment units
- Depends on: Step 1 (needs Program ID)

### Completion
Update opportunity state. Write phase summary to
`ACE/<opp-name>/connect-setup-summary.md`.
