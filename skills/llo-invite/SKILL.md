---
name: llo-invite
description: >
  Look up LLO contacts from the LLO Directory and invite them to the
  Connect opportunity.
---

# LLO Invite

Identify and invite LLOs to participate in the opportunity.

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

4. **Send invitations** via Connect invite API.

5. **Write invite log** to `ACE/<opp-name>/connect-setup/invites.md`:
   - Who was invited
   - When invites were sent
   - Status of each invite

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Connect: `list_llo_contacts`, `send_invite` — **NOT YET BUILT**

## Current Workaround
1. Read the IDD's LLO preference section
2. Generate a recommended invite list with rationale
3. Write to `ACE/<opp-name>/connect-setup/recommended-invites.md`
4. Ask the user to review the list and send invites through the Connect UI
5. Ask for confirmation of which LLOs were invited
6. Update the invite log

## Mode Behavior
- **Auto:** Send invites (or guide manual invites), notify admin group
- **Review:** Present invite list for approval before sending (this is a gate step)
