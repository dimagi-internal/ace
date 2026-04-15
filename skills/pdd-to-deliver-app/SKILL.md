---
name: pdd-to-deliver-app
description: >
  Pass an PDD to Nova to generate the Deliver app. Answer Nova's configuration
  questions. Output the app JSON/CCZ and a summary of decisions made.
---

# PDD to Deliver App

Generate the Deliver (service delivery) app from the PDD using Nova.

## Process

1. **Read the PDD** from `ACE/<opp-name>/pdd.md` via Google Drive MCP.

2. **Extract Deliver app requirements** from the PDD:
   - What services need to be delivered?
   - Workflow and case management
   - Verification criteria
   - Payment triggers

3. **Pass to Nova** for app generation.
   - Provide the Deliver app spec section of the PDD
   - Answer Nova's configuration questions based on the PDD
   - Capture all decisions made during configuration

4. **Receive app output** — JSON/CCZ file from Nova.

5. **Self-evaluate (LLM-as-Judge):**
   - Does the app structure match the PDD Deliver spec?
   - Are all service delivery forms present?
   - Is the case management workflow correct?
   - Are verification criteria properly encoded?

6. **Write outputs to GDrive:**
   - App JSON/CCZ to `ACE/<opp-name>/apps/deliver-app.json`
   - Decision summary to `ACE/<opp-name>/app-summaries/deliver-app-summary.md`

7. **Notify admin group** that Deliver app generation is complete.

## Archetypes

The Deliver app's structure depends on the PDD's `archetype:` field. The "delivery unit" concept is the most archetype-sensitive part of ACE — get this wrong and `connect-opp-setup` will configure the wrong verification rules.

### `atomic-visit`
Delivery unit = **one FLW visit to one beneficiary**. The form is the verification artifact: every required field, photo, GPS coordinate. Case management follows the standard create → update → close pattern. The form's fields map 1:1 to Layer A and Layer B of the PDD's Evidence Model.

### `focus-group`
Delivery unit = **one completed group session with all required artifacts**. The form is a session-documentation form, not an individual-beneficiary form. Required artifacts:

- **Pre-session**: date, GPS, venue, segment, participant count, consent confirmed (per participant), recording started
- **Per question domain (one section per domain in the PDD's question guide)**: themes observed, notable quotes (verbatim, with translation if needed), level of consensus, time spent
- **Post-session**: facilitator reflection (what went well, what didn't, anything surprising), attendance photo, audio file upload, total session duration

Case management is **per session**, not per participant. There's no "case lifecycle" for participants — they're not the unit. The opportunity-level case is the segment (e.g., "Women, remote, under-vaccinated children"), and each session against that segment is a delivery against that case.

The Nova prompt should explicitly call out that this is **session documentation, not atomic data collection**, and reference the PDD's Output Specification section for the per-domain summary fields.

### `multi-stage`
Generate one Deliver app per stage that has its own delivery work, branching on each stage's archetype. The two Deliver apps may have completely different structures (e.g., Stage 1 = focus-group session form, Stage 2 = atomic household-visit form).

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Nova: TBD — see `playbook/integrations/nova-integration.md`

## Current Workaround (Nova not yet integrated)
1. Generate a structured app brief from the PDD Deliver spec
2. Write it to `ACE/<opp-name>/app-briefs/deliver-app-brief.md`
3. Ask the user to create the app in Nova using this brief
4. Ask the user to upload the resulting JSON/CCZ to the GDrive folder
5. Proceed to write the app summary from the uploaded file

## Mode Behavior
- **Auto:** Generate app (or brief), notify admin group, proceed
- **Review:** Present app summary for review before proceeding

## Dry-Run Behavior
When `--dry-run` is active:
- Write app outputs and summaries to GDrive as normal
- Write the admin notification content (recipients, subject, body) to `comms-log/dry-run-pdd-to-deliver-app.md`
- Do not send notifications to the admin group
- State tracks as `dry-run-success`

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
| 2026-04-08 | Add `## Archetypes` section: `atomic-visit` (per-beneficiary form), `focus-group` (per-session documentation form, segment-level case), `multi-stage` (per-stage branching) | ACE team (PM scout, focus-group framework lens) |
