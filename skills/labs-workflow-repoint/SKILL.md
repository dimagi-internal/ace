---
name: labs-workflow-repoint
description: >
  Repoint a labs workflow at other opportunities or freeze/refollow its template, then rebuild history. Needs its id.
---

# Repoint a labs workflow

Changes what an existing labs workflow (a report page or dashboard) reads, or how it tracks its
template. Common cases:

- a program adds a partner opportunity and the cross-partner report should include it;
- a dashboard was built on a test opportunity and now needs the live one;
- a report a reviewer relies on must stop moving when its template is republished.

Platform facts: [`connect-labs.md` § Workflow template lifecycle](../../playbook/integrations/connect-labs.md#workflow-template-lifecycle-follow-freeze-refollow),
§ Changing live labs objects and § History (simulated time).

## Inputs

| Parameter | Used for | Resolver |
|---|---|---|
| `workflow_id` | the workflow definition | explicit arg; default: the run's Phase 7 products; else the program context doc's Metrics |
| `owner_scope` | exactly one of `opportunity_id` (per-opp workflow) or `program_id` (program-owned workflow) | explicit arg; same defaults |
| `opportunity_ids` | the new list, for a repoint (an empty list reverts to single-opportunity) | explicit arg |
| `template` | for follow/freeze: `template_workflow_id` and its `template_program_id` or `template_opportunity_id`, plus `follow: true` (refollow) or `false` (freeze) | explicit arg |
| `rebuild` | whether to rebuild saved-run history afterwards | default: true after a repoint on a periodic `semantic_snapshot` workflow |

No `run_state.yaml` is needed.

## Products

- A change record with the opportunity list or template state before and after, the definition
  versions, and the rebuild report:
  - inside a run, `7-synthetic/labs-workflow-repoint_<YYYYMMDD-HHMM>.md`;
  - on a program project, a dated line in the context doc's Decisions.

## Process

1. **Confirm the approval.** Labs report pages are what reviewers and partners read. The caller at
   level 0 must already have approval of the change. With none recorded, return the proposal and
   stop.
2. **Read the before state.** Call `workflow_get` with `include_render_code: false` and the owner
   scope. Record:
   - the definition `version`, needed as `expected_version`;
   - the current `opportunity_ids`;
   - whether the workflow follows a template.

   Then `workflow_history_eligibility` to learn whether its history can be rebuilt.
3. **Repoint**, when requested: `workflow_update_opportunity_ids` with `{workflow_id,
   opportunity_ids, expected_version}` plus the owner scope. Every id must be an opportunity the
   caller can access. A version conflict means someone else edited the workflow. Re-read it and
   re-propose; never force.
4. **Freeze or refollow**, when requested: `workflow_follow_template` with the template ids and
   `follow`.
   - Freezing (`follow: false`) forks the published render into the workflow, so the page does
     not change at that moment.
   - Refollowing makes the page track every later template publish. Only refollow a page nobody
     relies on as a fixed record.
   - For a whole run's reports, `scripts/labs-report-templates.ts freeze|refollow` records each
     page's `frozen_version`. Use it instead of looping by hand.
5. **Rebuild history** when `rebuild` is set and step 2 said the workflow is eligible. Past saved
   runs were computed on the old opportunity set, so the trend line is wrong until they are
   rebuilt.
   - Grade one date with `workflow_preview_as_of` first.
   - Then run `workflow_rebuild_history`, rolling: repeat with `start = next_start` until `done`,
     and follow `job_id` with `job_status` when it returns one.
   - An ineligible workflow is left as is. Say that its history still reflects the old set.
6. **Read back.** Call `workflow_get` again and compare `opportunity_ids` and the template state
   with the request.
7. **Record.** Write the before and after, the versions and the rebuild summary to the record
   named in § Products.

## MCP Tools Used

- connect-labs: `workflow_get`, `workflow_history_eligibility`, `workflow_update_opportunity_ids`, `workflow_follow_template`, `workflow_preview_as_of`, `workflow_rebuild_history`, `job_status`

## Existing objects

- **A following page changes with every template publish.** That includes pages a finished run
  was judged against. Freeze those before anyone republishes the template.
- **Saved runs freeze the registry they were computed with.** A repoint does not restate past runs
  until step 5 rebuilds them, and only runs the rebuild itself created are replaced. Hand-made
  runs are left alone.

## Mode Behavior

- **Auto:** with approval recorded in the dispatch, runs steps 2–7.
- **Review:** presents the before state, the new list or template state, and whether history will
  be rebuilt, and waits.

## Dry-Run Behavior

When `--dry-run` is active, run step 2, and `workflow_rebuild_history` with `dry_run: true` for
the plan. Make no other writes.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-18 | Initial version: repoint a workflow or freeze/refollow its template, with a history rebuild (audit item 6) | ACE (build-vs-maintain audit) |
