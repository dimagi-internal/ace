---
name: llo-uat
description: >
  Coordinate User Acceptance Testing with onboarded LLOs. Send UAT instructions,
  monitor for feedback, and compile results with LLO sign-off status.
---

# LLO User Acceptance Testing

Coordinate UAT with LLOs before the opportunity goes live.

## Process

1. **Read inputs from GDrive:**
   - Deployment summary: `ACE/<opp-name>/deployment-summary.md`
   - Training materials: `ACE/<opp-name>/training-materials/`
   - Opportunity config: `ACE/<opp-name>/connect-setup/opportunity.md`
   - LLO contacts: `ACE/<opp-name>/connect-setup/invites.md`

2. **Compose UAT instruction email for each onboarded LLO:**
   - From: ace@dimagi-ai.com
   - CC: CRISPR Admin Dimagi Google Group
   - Subject: "[Opportunity Name] — Please Test Your Apps Before Go-Live"
   - Body:
     - What to test (Learn app modules, Deliver app forms, case management flow)
     - How to access the apps (download links, login instructions)
     - How to report issues (reply to this email — handled by OCS)
     - UAT deadline (from opportunity timeline)
     - What "sign-off" means (confirm apps work for your FLWs)

3. **Send UAT instruction emails** (or draft for review).

4. **Monitor for LLO feedback** during UAT window:
   - Check OCS transcripts for reported issues
   - Track which LLOs have responded
   - Track which LLOs have signed off

5. **Compile UAT results:**
   - Issues reported (with severity and status)
   - LLO sign-off status (signed off / pending / blocked)
   - If blocking issues found: log them and notify admin group

6. **Write UAT results** to `ACE/<opp-name>/uat/uat-results.md`:
   - Per-LLO sign-off status
   - Issues found and resolution status
   - Overall UAT verdict (pass / blocked)

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`, `drive_list_folder`
- OCS: `ocs_list_sessions`, `ocs_get_session`

## Current Workaround
1. Generate UAT instruction emails as drafts
2. Write to `ACE/<opp-name>/comms-log/uat-instruction-drafts/`
3. Ask the user to send the emails from ace@dimagi-ai.com
4. Ask the user to collect LLO feedback and sign-offs
5. Document results when provided

## Mode Behavior
- **Auto:** Send UAT instructions, monitor for results, proceed when all LLOs sign off or UAT window closes
- **Review:** Present UAT results for approval before proceeding to launch

## Dry-Run Behavior
When `--dry-run` is active:
- Write the UAT instruction emails (recipients, subject, body) to `comms-log/dry-run-llo-uat.md` instead of sending
- UAT monitoring is skipped (no real emails were sent)
- Write a simulated UAT result with all LLOs marked as "dry-run — not contacted"
- State tracks as `dry-run-success`

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
