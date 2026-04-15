---
name: pdd-to-learn-app
description: >
  Pass an PDD to Nova to generate the Learn app. Answer Nova's configuration
  questions. Output the app JSON/CCZ and a summary of decisions made.
---

# PDD to Learn App

Generate the Learn (data collection) app from the PDD using Nova.

## Process

1. **Read the PDD** from `ACE/<opp-name>/pdd.md` via Google Drive MCP.

2. **Extract Learn app requirements** from the PDD:
   - What data needs to be collected?
   - Visit structure and frequency
   - Form design requirements
   - Case management needs

3. **Pass to Nova** for app generation.
   - Provide the Learn app spec section of the PDD
   - Answer Nova's configuration questions based on the PDD
   - Capture all decisions made during configuration

4. **Receive app output** — JSON/CCZ file from Nova.

5. **Self-evaluate (LLM-as-Judge):**
   - Does the app structure match the PDD Learn spec?
   - Are all required data collection forms present?
   - Is the visit structure correct?
   - Are case properties properly configured?

6. **Write outputs to GDrive:**
   - App JSON/CCZ to `ACE/<opp-name>/apps/learn-app.json`
   - Decision summary to `ACE/<opp-name>/app-summaries/learn-app-summary.md`

7. **Notify admin group** that Learn app generation is complete, with link to summary.

## Archetypes

The Learn app's job depends on the PDD's `archetype:` field. Read it before passing anything to Nova.

### `atomic-visit`
Learn app teaches FLWs to **collect data** at individual visits. Standard form-walkthrough Learn app: how to open a case, complete each form field, what good vs. bad inputs look like (e.g., the photo standardization protocol from the Evidence Model — Layer A), how to handle edge cases (no stock, hostile vendor, duplicate), submission and case closure.

### `focus-group`
Learn app teaches FLWs to **facilitate group discussions** — this is a **craft, not a checklist**. The brief to Nova is fundamentally different from atomic-visit:

- **Facilitation basics**: opening the session, introducing yourself, setting ground rules
- **Probing techniques**: how to ask "tell me more," "can you give an example," "what do you mean by that," without leading
- **Neutral framing**: how to ask sensitive questions (vaccination decisions, religious objections) without conveying judgment
- **Group dynamics**: managing dominant participants, drawing out quiet ones, handling disagreement, recognizing groupthink
- **Question guide walkthrough**: the PDD's prioritized question list, with probes — covered in the order specified (program-specific questions last to avoid anchoring)
- **Session form walkthrough**: how to capture per-domain themes, notable quotes, level of consensus, time spent, facilitator reflection — referencing the Output Specification from the PDD
- **Consent and ethics**: verbal consent script, audio recording consent, what to do if a participant withdraws
- **Logistics**: venue setup, attendance register, audio recording start/stop, compensation distribution

The Nova prompt should explicitly say "this is a facilitation training app, not a form-walkthrough app" and reference the PDD's Facilitation Protocol section.

### `multi-stage`
Generate one Learn app per stage that has its own delivery work, branching on each stage's archetype. If only Stage 2 involves FLW delivery, only that stage gets a Learn app. The Stage Gate from the PDD determines whether Stage 2 training launches before or after Stage 1 results.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Nova: TBD — see `playbook/integrations/nova-integration.md`

## Current Workaround (Nova not yet integrated)
1. Generate a structured app brief from the PDD Learn spec
2. Write it to `ACE/<opp-name>/app-briefs/learn-app-brief.md`
3. Ask the user to create the app in Nova using this brief
4. Ask the user to upload the resulting JSON/CCZ to the GDrive folder
5. Proceed to write the app summary from the uploaded file

## Mode Behavior
- **Auto:** Generate app (or brief), notify admin group, proceed
- **Review:** Present app summary for review before proceeding

## Dry-Run Behavior
When `--dry-run` is active:
- Write app outputs and summaries to GDrive as normal
- Write the admin notification content (recipients, subject, body) to `comms-log/dry-run-pdd-to-learn-app.md`
- Do not send notifications to the admin group
- State tracks as `dry-run-success`

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
| 2026-04-08 | Add `## Archetypes` section: `atomic-visit` (form walkthrough), `focus-group` (facilitation craft training), `multi-stage` (per-stage branching) | ACE team (PM scout, focus-group framework lens) |
