---
name: idd-to-deliver-app
description: >
  Pass an IDD to Nova to generate the Deliver app. Answer Nova's configuration
  questions. Output the app JSON/CCZ and a summary of decisions made.
---

# IDD to Deliver App

Generate the Deliver (service delivery) app from the IDD using Nova.

## Process

1. **Read the IDD** from `ACE/<opp-name>/idd.md` via Google Drive MCP.

2. **Extract Deliver app requirements** from the IDD:
   - What services need to be delivered?
   - Workflow and case management
   - Verification criteria
   - Payment triggers

3. **Pass to Nova** for app generation.
   - Provide the Deliver app spec section of the IDD
   - Answer Nova's configuration questions based on the IDD
   - Capture all decisions made during configuration

4. **Receive app output** — JSON/CCZ file from Nova.

5. **Self-evaluate (LLM-as-Judge):**
   - Does the app structure match the IDD Deliver spec?
   - Are all service delivery forms present?
   - Is the case management workflow correct?
   - Are verification criteria properly encoded?

6. **Write outputs to GDrive:**
   - App JSON/CCZ to `ACE/<opp-name>/apps/deliver-app.json`
   - Decision summary to `ACE/<opp-name>/app-summaries/deliver-app-summary.md`

7. **Notify admin group** that Deliver app generation is complete.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Nova: TBD — see `playbook/integrations/nova-integration.md`

## Current Workaround (Nova not yet integrated)
1. Generate a structured app brief from the IDD Deliver spec
2. Write it to `ACE/<opp-name>/app-briefs/deliver-app-brief.md`
3. Ask the user to create the app in Nova using this brief
4. Ask the user to upload the resulting JSON/CCZ to the GDrive folder
5. Proceed to write the app summary from the uploaded file

## Mode Behavior
- **Auto:** Generate app (or brief), notify admin group, proceed
- **Review:** Present app summary for review before proceeding

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
