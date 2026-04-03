---
name: llo-onboarding
description: >
  Send onboarding emails to invited LLOs with training materials, app
  instructions, and next steps. Uses Ace-AI@Dimagi.com as sender.
---

# LLO Onboarding

Send onboarding communications to LLOs who accepted the opportunity invitation.

## Process

1. **Read inputs from GDrive:**
   - Invite log: `ACE/<opp-name>/connect-setup/invites.md`
   - Training materials: `ACE/<opp-name>/training-materials/`
   - Opportunity details: `ACE/<opp-name>/connect-setup/opportunity.md`

2. **For each invited LLO, compose an onboarding email:**
   - From: Ace-AI@Dimagi.com
   - CC: CRISPR Admin Dimagi Google Group
   - Subject: "[Opportunity Name] — Welcome and Next Steps"
   - Body:
     - Welcome and opportunity overview
     - Links to training materials (GDrive links or attachments)
     - Step-by-step instructions for getting started
     - Timeline and expectations
     - How to ask questions (email Ace-AI@Dimagi.com — handled by OCS)
     - Contact info for escalation

3. **Send emails** (or draft for review).

4. **Log communications** to `ACE/<opp-name>/comms-log/onboarding-emails.md`.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`, `drive_list_folder`

## Current Workaround
1. Generate the email content for each LLO
2. Write drafts to `ACE/<opp-name>/comms-log/onboarding-drafts/`
3. Ask the user to send the emails from Ace-AI@Dimagi.com
4. Update the comms log with send confirmation

## Mode Behavior
- **Auto:** Send emails directly, log to GDrive
- **Review:** Present email drafts for review before sending

## Dry-Run Behavior
When `--dry-run` is active:
- Write the onboarding email content (recipients, subject, body, attachments) to `comms-log/dry-run-llo-onboarding.md`
- Do not send emails
- State tracks as `dry-run-success`

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
