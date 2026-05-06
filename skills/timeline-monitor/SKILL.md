---
name: timeline-monitor
description: >
  Watch whether LLOs are hitting expected milestones on schedule.
  Email prompts when behind. Recurring during active opp.
disable-model-invocation: true
---

# Timeline Monitor

Check LLO progress against expected timeline and prompt action if behind.

## Process (runs periodically)

1. **Read opportunity state** from GDrive:
   - Timeline/milestones from PDD
   - Current status from `ACE/<opp-name>/run_state.yaml`
   - Previous monitoring reports from `ACE/<opp-name>/monitoring/`

2. **Check progress indicators:**
   - Have LLOs started onboarding FLWs?
   - Are FLWs submitting forms in the expected timeframe?
   - Are delivery targets on track?
   - Use Connect opportunity status and CommCare submission data

3. **Self-evaluate (LLM-as-Judge):**
   - Is the assessment accurate given the data available?
   - Are the recommendations actionable?
   - Is the tone appropriate for LLO communication?

4. **If behind schedule:**
   - Draft a prompting email to the LLO via ace@dimagi-ai.com
   - Include specific areas of concern and suggested actions
   - CC admin group

5. **Write monitoring report** to `ACE/<opp-name>/monitoring/YYYY-MM-DD-timeline-check.md`.

## OCS Integration

The timeline-monitor skill consumes OCS session data to detect LLOs who are
stuck or going quiet between milestone checks. Uses these MCP atoms:

- `ocs_list_sessions({ experiment_id, since })` — pull recent session activity for this opportunity's chatbot
- `ocs_get_session({ session_id })` — read the transcript of any session flagged as stuck or confused
- `ocs_trigger_bot_message({ experiment_id, identifier, platform, prompt_text })` — push a proactive nudge to an LLO who's behind schedule (only in Auto mode)
- `ocs_add_session_tags({ session_id, tags: ['ace-reviewed', 'needs-followup'] })` — mark reviewed sessions so they aren't re-processed

The `experiment_id` and `public_id` for this opportunity's chatbot come from
`ACE/<opp-name>/runs/<run-id>/4-ocs/ocs-agent-setup.md`, written by the `ocs-agent-setup` skill.

### Heuristics

- **Stuck:** LLO sent a message > 24 hours ago and received a response, but no follow-up message. Trigger a nudge.
- **Confused:** LLO asked the same question (or similar) in three consecutive sessions without acting on the answer. Escalate to admin group.
- **Silent:** LLO has sent zero messages in the past 7 days during an active opp phase. Trigger a check-in message.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Connect (connect-labs): `get_opportunity_apps`, opportunity status queries
- CommCare (connect-labs/scout-data): form submission queries for FLW activity
- OCS: `ocs_list_sessions`, `ocs_get_session`, `ocs_trigger_bot_message`, `ocs_add_session_tags`

## Mode Behavior
- **Auto:** Check timeline, send prompting emails if needed, log report
- **Review:** Present findings and draft emails for approval before sending

## Dry-Run Behavior
When `--dry-run` is active:
- Write any prompting email drafts (recipients, subject, body) to `comms-log/dry-run-timeline-monitor.md`
- Monitoring report is still written to `ACE/<opp-name>/monitoring/` as normal
- Do not send emails to LLOs
- State tracks as `dry-run-success`

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
