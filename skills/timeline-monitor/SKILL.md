---
name: timeline-monitor
description: >
  Monitor whether LLOs are hitting expected milestones on schedule.
  Send prompting emails if behind. Runs recurring during active opp.
---

# Timeline Monitor

Check LLO progress against expected timeline and prompt action if behind.

## Process (runs periodically)

1. **Read opportunity state** from GDrive:
   - Timeline/milestones from IDD
   - Current status from `ACE/<opp-name>/state.yaml`
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
   - Draft a prompting email to the LLO via Ace-AI@Dimagi.com
   - Include specific areas of concern and suggested actions
   - CC admin group

5. **Write monitoring report** to `ACE/<opp-name>/monitoring/YYYY-MM-DD-timeline-check.md`.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Connect (connect-labs): `get_opportunity_apps`, opportunity status queries
- CommCare (connect-labs/scout-data): form submission queries for FLW activity

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
