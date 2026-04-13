---
name: learnings-summary
description: >
  Summarize learnings from the completed opportunity and create a new IDD
  if iteration is warranted. Can trigger another CRISPR-Connect cycle.
---

# Learnings Summary

Synthesize all information from the completed opportunity into actionable learnings.

## Process

1. **Read all opportunity artifacts from GDrive:**
   - IDD (original plan)
   - Test results
   - Monitoring reports from `ACE/<opp-name>/monitoring/`
   - Data reviews from `ACE/<opp-name>/data-reviews/`
   - OCS transcripts (LLO questions and issues)
   - LLO feedback from `ACE/<opp-name>/closeout/llo-feedback.md`
   - Comms log

2. **Analyze against original IDD:**
   - What worked as designed?
   - What didn't work or needed adjustment?
   - Were success metrics met?
   - What was unexpected?

3. **Synthesize learnings:**
   - **Process learnings** — what to change about the CRISPR-Connect process itself
   - **Content learnings** — what to change about the intervention design
   - **Technical learnings** — what to change about the apps or configuration
   - **Relationship learnings** — what to change about LLO engagement

4. **Determine if iteration is warranted:**
   - If yes, draft a new IDD incorporating the learnings
   - This new IDD can trigger another CRISPR-Connect cycle

5. **Write to GDrive:**
   - `ACE/<opp-name>/closeout/learnings.md` — full learnings document
   - `ACE/<opp-name>/closeout/new-idd.md` — new IDD if iteration warranted

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`, `drive_list_folder`
- OCS: `ocs_list_sessions`, `ocs_get_session`

## Mode Behavior
- **Auto:** Generate learnings, create new IDD if warranted, notify admin group
- **Review:** Present learnings and new IDD for team discussion

## Dry-Run Behavior
When `--dry-run` is active:
- Learnings analysis and new IDD generation proceed normally (written to GDrive)
- Write any notification emails (to admin group) to `comms-log/dry-run-learnings-summary.md` instead of sending
- State tracks as `dry-run-success`

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
