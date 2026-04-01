---
name: llo-feedback
description: >
  Prompt LLOs for feedback about the application, process, and suggestions
  for next steps. Collect and document responses.
---

# LLO Feedback

Collect feedback from LLOs about the completed opportunity.

## Process

1. **Read opportunity context** from GDrive:
   - LLO contact info from invite/comms logs
   - Opportunity summary
   - Key metrics (delivery rates, issues encountered)

2. **Compose feedback request email:**
   - From: Ace-AI@Dimagi.com
   - CC: admin group
   - Ask about:
     - Application usability (Learn and Deliver apps)
     - Process experience (onboarding, support, communication)
     - FLW experience and challenges
     - Suggestions for improvement
     - Interest in future opportunities

3. **Send feedback request** to each LLO.

4. **Monitor for responses** via OCS transcripts or email.

5. **Document feedback** to `ACE/<opp-name>/closeout/llo-feedback.md`:
   - Responses from each LLO
   - Common themes
   - Specific improvement suggestions

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- OCS: `ocs_list_transcripts` for monitoring responses

## Current Workaround
1. Generate feedback request email drafts
2. Write to `ACE/<opp-name>/closeout/feedback-request-drafts/`
3. Ask user to send and collect responses
4. Document responses when provided

## Mode Behavior
- **Auto:** Send feedback requests, monitor and document responses
- **Review:** Present email drafts for review before sending
