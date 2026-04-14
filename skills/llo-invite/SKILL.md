---
name: llo-invite
description: >
  Identify candidate LLOs for a Connect opportunity and prepare the invite
  list. Sending happens later in Phase 5 (llo-onboarding) once the OCS widget
  is ready to include in the onboarding email.
---

# LLO Invite

Identify and prepare the invite list for LLOs to participate in the opportunity.
This skill runs in Phase 3 (Connect setup) and produces a reviewable list;
invites go out in Phase 5 (`llo-onboarding`) so the onboarding email can
include the OCS widget link configured in Phase 4.

## Process

1. **Read inputs from GDrive:**
   - IDD: `ACE/<opp-name>/idd.md` (LLO preferences section)
   - Opportunity details: `ACE/<opp-name>/connect-setup/opportunity.md`

2. **Look up LLO contacts:**
   - Check IDD for preferred/known LLOs
   - Search LLO Directory for matching organizations
   - Get contact details for each LLO

3. **Prepare invite list:**
   - LLO name, contact person, email
   - Why this LLO was selected (geographic match, capability match, etc.)
   - Opportunity summary for the invite

4. **Write invite list** to `ACE/<opp-name>/connect-setup/invites.md` with
   status `prepared` for each entry. Phase 5's `llo-onboarding` picks this up,
   issues the Connect invite, and flips the status to `sent`.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Connect: `list_llo_contacts` — **NOT YET BUILT**
- (Connect `send_invite` is called from `llo-onboarding` in Phase 5, not here)

## Current Workaround
1. Read the IDD's LLO preference section
2. Generate a recommended invite list with rationale
3. Write to `ACE/<opp-name>/connect-setup/invites.md` with status `prepared`
4. Phase 5 guides the operator to send invites through the Connect UI and
   flip statuses

## Mode Behavior
- **Auto:** Write the invite list, notify admin group
- **Review:** Present invite list for approval (this is a gate step)

## Dry-Run Behavior
When `--dry-run` is active:
- Write the invite list (LLO names, contacts, rationale) to
  `comms-log/dry-run-llo-invite.md`
- State tracks as `dry-run-success`

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
| 2026-04-14 | Split prepare-vs-send: this skill only prepares in Phase 3; sending moves to `llo-onboarding` in Phase 5 so the onboarding email can include the OCS widget link | ACE team |
