---
name: learnings-summary
description: >
  Synthesize learnings from a completed opportunity. Drafts a new PDD
  to seed the next cycle when iteration is warranted.
disable-model-invocation: true
---

# Learnings Summary

Synthesize all information from the completed opportunity into actionable learnings.

## Process

1. **Read all opportunity artifacts from GDrive:**
   - PDD (original plan)
   - Test results
   - Monitoring reports from `ACE/<opp-name>/monitoring/`
   - Data reviews from `ACE/<opp-name>/data-reviews/`
   - OCS transcripts (LLO questions and issues)
   - LLO feedback from `ACE/<opp-name>/runs/<run-id>/8-closeout/llo-feedback.md`
   - Comms log

2. **Analyze against original PDD:**
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
   - If yes, draft a new PDD incorporating the learnings
   - This new PDD can trigger another CRISPR-Connect cycle

5. **Write to GDrive:**
   - `ACE/<opp-name>/runs/<run-id>/8-closeout/learnings-summary.md` — full learnings document
   - `ACE/<opp-name>/runs/<run-id>/8-closeout/learnings-summary_new-pdd.md` — new PDD if iteration warranted

6. **Write `phases.closeout.products.learnings`** to the current run's
   `run_state.yaml` so downstream readers (ace-web summary, next-cycle
   `idea-to-pdd` if iteration is warranted) can deep-link to the
   learnings doc and the iteration PDD without listing the closeout
   folder.

   ```yaml
   phases:
     closeout:
       products:
         learnings:
           summary_file_id: <Drive fileId of learnings-summary.md>
           new_pdd_file_id: <Drive fileId of learnings-summary_new-pdd.md, or null when iteration not warranted>
           iteration_warranted: <true | false>
   ```

   Apply via `mcp__plugin_ace_ace-gdrive__update_yaml_file` with
   `merge: 'two-level'`. Sole writer of `products.learnings`.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`, `drive_list_folder`
- OCS: `ocs_list_sessions`, `ocs_get_session`

## Mode Behavior
- **Auto:** Generate learnings, create new PDD if warranted, notify admin group
- **Review:** Present learnings and new PDD for team discussion

## Dry-Run Behavior
When `--dry-run` is active:
- Learnings analysis and new PDD generation proceed normally (written to GDrive)
- Write any notification emails (to admin group) to `comms-log/dry-run-learnings-summary.md` instead of sending
- State tracks as `dry-run-success`

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
