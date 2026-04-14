---
name: llo-onboarding
description: >
  First LLO-facing step. Issues the Connect system invite and sends the ACE
  onboarding email (training materials, getting-started, OCS widget link).
  Uses ace@dimagi-ai.com as sender.
---

# LLO Onboarding

First LLO contact for the opportunity. Takes the `prepared` invite list from
Phase 3 (`connect-setup/invites.md`) and the OCS widget config from Phase 4
(`ocs-agent-config.md`), issues the Connect system invite, and sends the
ACE-authored onboarding email with the widget link embedded.

## Process

1. **Read inputs from GDrive:**
   - Invite list: `ACE/<opp-name>/connect-setup/invites.md` (entries with
     status `prepared`)
   - Training materials: `ACE/<opp-name>/training-materials/`
   - Opportunity details: `ACE/<opp-name>/connect-setup/opportunity.md`
   - OCS widget config: `ACE/<opp-name>/ocs-agent-config.md`
     (`public_id`, `embed_key`)

2. **Send Connect system invites** for each `prepared` LLO entry via
   Connect `send_invite` (**NOT YET BUILT** — see workaround below). Flip
   status to `sent` in the invite list.

3. **For each invited LLO, compose an onboarding email:**
   - From: `$ACE_GMAIL_ACCOUNT` (via `email-communicator` skill)
   - CC: CRISPR Admin Dimagi Google Group
   - Subject: "[Opportunity Name] — Welcome and Next Steps"
   - Body:
     - Welcome and opportunity overview
     - Links to training materials (GDrive links or attachments)
     - Step-by-step instructions for getting started
     - Timeline and expectations
     - **OCS widget** — embed link / URL derived from `public_id` + `embed_key`
       so LLOs can chat with the ACE support bot directly. Also mention the
       email fallback (`$ACE_GMAIL_ACCOUNT`)
     - Contact info for escalation

4. **Send emails** via the `email-communicator` skill (or draft for review).

5. **Log communications** to `ACE/<opp-name>/comms-log/onboarding-emails.md`.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`, `drive_list_folder`

## Current Workaround
1. Guide the operator to send Connect invites through the Connect UI for each
   `prepared` LLO; update `invites.md` statuses to `sent`
2. Generate the onboarding email content for each LLO (with widget link)
3. Write drafts to `ACE/<opp-name>/comms-log/onboarding-drafts/`
4. Ask the user to send the emails from ace@dimagi-ai.com
5. Update the comms log with send confirmation

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
| 2026-04-14 | Own Connect system invite send (moved from `llo-invite`) and include OCS widget link in onboarding email; this is the first LLO-facing step in the lifecycle | ACE team |
