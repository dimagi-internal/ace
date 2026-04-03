---
name: idd-to-learn-app
description: >
  Pass an IDD to Nova to generate the Learn app. Answer Nova's configuration
  questions. Output the app JSON/CCZ and a summary of decisions made.
---

# IDD to Learn App

Generate the Learn (data collection) app from the IDD using Nova.

## Process

1. **Read the IDD** from `ACE/<opp-name>/idd.md` via Google Drive MCP.

2. **Extract Learn app requirements** from the IDD:
   - What data needs to be collected?
   - Visit structure and frequency
   - Form design requirements
   - Case management needs

3. **Pass to Nova** for app generation.
   - Provide the Learn app spec section of the IDD
   - Answer Nova's configuration questions based on the IDD
   - Capture all decisions made during configuration

4. **Receive app output** — JSON/CCZ file from Nova.

5. **Self-evaluate (LLM-as-Judge):**
   - Does the app structure match the IDD Learn spec?
   - Are all required data collection forms present?
   - Is the visit structure correct?
   - Are case properties properly configured?

6. **Write outputs to GDrive:**
   - App JSON/CCZ to `ACE/<opp-name>/apps/learn-app.json`
   - Decision summary to `ACE/<opp-name>/app-summaries/learn-app-summary.md`

7. **Notify admin group** that Learn app generation is complete, with link to summary.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Nova: TBD — see `playbook/integrations/nova-integration.md`

## Current Workaround (Nova not yet integrated)
1. Generate a structured app brief from the IDD Learn spec
2. Write it to `ACE/<opp-name>/app-briefs/learn-app-brief.md`
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
