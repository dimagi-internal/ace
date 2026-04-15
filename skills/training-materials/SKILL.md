---
name: training-materials
description: >
  Generate training materials for LLOs and FLWs from app summaries and
  template collateral. Output guides, quick-reference cards, and onboarding docs.
---

# Training Materials

Generate training materials from the app summaries and standard templates.

## Process

1. **Read inputs from GDrive:**
   - PDD: `ACE/<opp-name>/pdd.md`
   - Learn app summary: `ACE/<opp-name>/app-summaries/learn-app-summary.md`
   - Deliver app summary: `ACE/<opp-name>/app-summaries/deliver-app-summary.md`
   - Template collateral from `templates/` directory (if available)

2. **Generate training materials:**
   - **LLO Manager Guide** — overview of the opportunity, what LLOs need to do,
     timeline, expectations, escalation contacts
   - **FLW Training Guide** — step-by-step instructions for using the Learn and
     Deliver apps, with screenshots/descriptions of each form
   - **Quick Reference Card** — one-page summary of key workflows, common issues,
     and support contacts
   - **FAQ** — anticipated questions from LLOs and FLWs based on the app design

3. **Self-evaluate (LLM-as-Judge):**
   - Are instructions clear enough for someone with no prior context?
   - Do the materials match the actual app structure?
   - Are all key workflows covered?
   - Is the language appropriate for the target audience?

4. **Write to GDrive:** `ACE/<opp-name>/training-materials/`
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
