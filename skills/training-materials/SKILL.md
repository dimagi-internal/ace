---
name: training-materials
description: >
  Generate training materials for LLOs and FLWs from app summaries and
  template collateral. Output guides, quick-reference cards, and onboarding docs.
---

# Training Materials

Generate training materials from the app summaries and standard templates.

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `ACE/<opp>/pdd.md` | overall framing, opp goals, archetype |
| Phase 1 | `ACE/<opp>/test-prompts.md` | seed FAQ entries |
| Phase 2 | `ACE/<opp>/app-summaries/learn-app-summary.md` | content + form names in FLW guide |
| Phase 2 | `ACE/<opp>/app-summaries/deliver-app-summary.md` | content + form names in FLW guide |
| Phase 2 | `ACE/<opp>/deployment-summary.md` | HQ domain quoted in LLO Manager Guide |
| Phase 3 | `ACE/<opp>/connect-state.yaml` (`opportunity_name`, `payment_units`, `delivery_types`) | payment + verification details in LLO Manager Guide |
| Phase 4 | `ACE/<opp>/ocs-state.yaml` (`chatbot_widget_url`) | "where to ask questions" link in FLW Training Guide and Quick Reference |
| Phase 5 (this phase, prior step) | `ACE/<opp>/screenshots/manifest.yaml` + the PNGs it points to | embed step-by-step screenshots in FLW Training Guide |

## Process

1. **Read inputs from GDrive** as listed above. Template collateral from `templates/` directory (if available).

2. **Generate training materials:**
   - **LLO Manager Guide** — overview of the opportunity, what LLOs need to do,
     timeline, expectations, escalation contacts
   - **FLW Training Guide** — step-by-step instructions for using the Learn and
     Deliver apps, with screenshots/descriptions of each form
   - **Quick Reference Card** — one-page summary of key workflows, common issues,
     and support contacts
   - **FAQ** — anticipated questions from LLOs and FLWs based on the app design

3. **Embed step-by-step screenshots** in `flw-training-guide.md`. For each entry in `screenshots/manifest.yaml`, render the screenshot inline with its step label and a 1–2 sentence caption derived from the recipe step name + the corresponding form question / module heading.

4. **Self-evaluate (LLM-as-Judge):**
   - Are instructions clear enough for someone with no prior context?
   - Do the materials match the actual app structure?
   - Are all key workflows covered?
   - Is the language appropriate for the target audience?

5. **Write to GDrive:** `ACE/<opp-name>/training-materials/`
   - `llo-manager-guide.md`
   - `flw-training-guide.md`
   - `quick-reference.md`
   - `faq.md`

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`

## Mode Behavior
- **Auto:** Generate materials, notify admin group, proceed
- **Review:** Present materials for review before distributing to LLOs

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
| 2026-04-28 | Move skill from Phase 2 (commcare-setup) to Phase 5 (training-prep). Add upstream-input contract: read connect-state.yaml, ocs-state.yaml, screenshots/manifest.yaml. Embed real screenshots in flw-training-guide. | ACE team (mobile-emulation) |
