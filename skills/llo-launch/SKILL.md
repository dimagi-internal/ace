---
name: llo-launch
description: >
  Activate the opportunity for live use. Verify UAT sign-offs, activate the
  opportunity in Connect, confirm apps are published, and notify LLOs of go-live.
---

# LLO Launch (Go-Live)

Activate the opportunity and notify LLOs that they are live.

## Process

1. **Read inputs from GDrive:**
   - UAT results: `ACE/<opp-name>/uat/uat-results.md`
   - Deployment summary: `ACE/<opp-name>/deployment-summary.md`
   - Opportunity config: `ACE/<opp-name>/connect-setup/opportunity.md`
   - LLO contacts: `ACE/<opp-name>/connect-setup/invites.md`

2. **Verify UAT passed:**
   - Check that all LLOs have signed off (or UAT window has closed without blocking issues)
   - If blocking issues remain, halt and notify admin group

3. **Activate the opportunity in Connect:**
   - Change opportunity status from draft/test to active
   - Confirm deliveries will now count toward payment

4. **Confirm apps are published and available:**
   - Verify Learn and Deliver apps are built and published on CCHQ
   - Confirm mobile download is available

5. **Send launch notification to each LLO:**
   - From: Ace-AI@Dimagi.com
   - CC: CRISPR Admin Dimagi Google Group
   - Subject: "[Opportunity Name] — You Are Live!"
   - Body:
     - Confirmation that the opportunity is active
     - FLWs can now use the apps and deliveries count
     - Reminder of key contacts and support channels
     - Link to training materials for reference

6. **Write launch record** to `ACE/<opp-name>/launch/launch-record.md`:
   - Activation timestamp
   - LLO notifications sent
   - App URLs and versions
   - Any outstanding non-blocking issues

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Connect: opportunity activation API — **NOT YET BUILT**

## Current Workaround
1. Verify UAT results from GDrive
2. Ask the user to activate the opportunity in the Connect UI
3. Ask the user to confirm apps are published and available for download
4. Generate launch notification emails as drafts
5. Write to `ACE/<opp-name>/comms-log/launch-notification-drafts/`
6. Ask the user to send them from Ace-AI@Dimagi.com
7. Record the launch details

## Mode Behavior
- **Auto:** Activate opportunity, send launch notifications, proceed to monitoring phase
- **Review:** Present launch readiness summary for approval before activating (this is a **gate step**)

## Dry-Run Behavior
When `--dry-run` is active:
- Write the intended activation action (opportunity ID, status change) to `comms-log/dry-run-llo-launch.md`
- Write the launch notification emails (recipients, subject, body) to the same file
- Do not activate the opportunity or send emails
- State tracks as `dry-run-success`

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
