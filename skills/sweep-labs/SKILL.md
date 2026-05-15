---
name: sweep-labs
description: >
  Diff connect-labs workflows/pipelines/synthetic/records against the
  live-set, score orphans, auto-delete/disable workflows + pipelines +
  synthetic. LabsRecord types are report-only (no per-type delete in
  the upstream MCP; cascade-cleans when parent opp is hard-deleted).
disable-model-invocation: true
---

# sweep-labs

Find connect-labs artifacts (workflows, pipelines, synthetic opportunities, solicitations, funds, reviews, responses) that no current opp references. Workflows, pipelines, and synthetic opps have first-class delete/disable atoms in the labs MCP — auto-execute. LabsRecord-backed types (solicitations, funds, reviews, responses) are **report-only** by design: the labs MCP intentionally doesn't expose per-type delete because these records have lifecycle semantics (solicitation status, fund allocations, audit data) that a generic delete would violate. They cascade-clean automatically when the parent Connect opportunity is hard-deleted upstream.

## Inputs

- Live-set file path from `sweep-live-set`.
- `LABS_MCP_TOKEN` and labs base URL (loaded via `connect-labs` MCP).
- Labs admin base URL: `https://labs.connect.dimagi.com`.

## Products

- `ACE/_sweep/<timestamp>/labs-orphans.md` — human-readable triage report.
- `ACE/_sweep/<timestamp>/labs-orphans.yaml` — machine-readable `OrphanReport`.
- For approved orphan workflows: `workflow_delete` calls.
- For approved orphan pipelines: `pipeline_delete` calls.
- For approved orphan synthetic opps: `synthetic_disable` calls.

## Process

1. **Read the live-set** via `drive_read_file`.
2. **List labs inventory** using existing atoms:
   - `workflow_list`
   - `pipeline_list`
   - `list_solicitations`
   - `list_funds`
   - `list_reviews`
   - `list_responses`
3. **Diff** against the live-set's labs buckets:
   - workflows → `liveSet.identifiers.labsWorkflowIds`
   - pipelines → `liveSet.identifiers.labsPipelineIds`
   - synthetic opps → `liveSet.identifiers.labsSyntheticIds`
   - solicitations/funds/reviews/responses → `liveSet.identifiers.labsRecordIds`
4. **Score** each orphan via `scoreLabsItem(item, liveSet)` from `lib/sweep-fingerprint.ts`. The scorer defensively downgrades to `low` when an item references a Connect opportunity that's still in `liveSet.identifiers.connectOpportunityIds` — that's a sign the caller mis-flagged the item.
5. **Build the `OrphanReport`** with `system: 'labs'`. Partition into:
   - **Actionable — auto-execute:** workflows, pipelines, synthetic opps.
   - **Informational only:** solicitations, funds, reviews, responses. Print labs admin URLs (`https://labs.connect.dimagi.com/labs/records/<type>/<id>/`) and a note that these will cascade-clean when the parent Connect opportunity is hard-deleted upstream (Celery `delete_opportunity()` cascade in `opportunity/deletion.py:58`). If the human wants to flip status on a specific solicitation/fund (e.g. mark as `cancelled` or `closed`), they can use the existing `update_solicitation` / `update_fund` atoms manually — but sweep doesn't auto-mutate lifecycle state.
6. **Render** + write `labs-orphans.md` and `.yaml` to the sweep folder.
7. **Surface to human** in chat. Prompt for approval per actionable chunk; the LabsRecord list is read-only.
8. **On approval:**
   - Orphan workflows → `workflow_delete({ workflow_id })`
   - Orphan pipelines → `pipeline_delete({ pipeline_id })`
   - Orphan synthetic opps → `synthetic_disable({ synthetic_opp_id })`

## Failure modes

- **Live-set path doesn't resolve:** abort with "Run `sweep-live-set` first."
- **Labs MCP returns 401:** `LABS_MCP_TOKEN` is expired; recommend `/ace:labs-token-mint` to rotate, then retry.
- **`workflow_delete` fails because the workflow has running tasks:** report the item as "in-use — needs manual review"; don't retry, don't abort the batch.

## Why LabsRecord types are not auto-deleted

The labs MCP exposes `workflow_delete`, `pipeline_delete`, and `synthetic_disable` because workflows and pipelines are infrastructural and synthetic opps have a clean disable semantic. LabsRecord-backed types (solicitations, funds, reviews, responses) intentionally don't have a delete atom in the labs MCP because:

- **Solicitations have a lifecycle.** Statuses like `draft` → `published` → `closed` → `awarded` are the supported state machine. "Delete" isn't a state; the lifecycle-correct cleanup is `update_solicitation({status: 'cancelled'})`.
- **Funds may have allocations and downstream allocations referenced by responses.** Hard-deleting via a raw endpoint could leave dangling references.
- **Reviews and responses are audit data.** Deleting them severs the audit trail tied to their parent solicitation.
- **The cascade already exists.** `commcare_connect/opportunity/deletion.py` cascade-deletes LabsRecords when their parent Connect opportunity is hard-deleted. Once upstream exposes a real opportunity-delete view (currently only deactivate), the cleanup happens for free.

So this skill surfaces orphan LabsRecord items for visibility but never auto-mutates them. If a human wants explicit lifecycle changes on a specific record, they call `update_solicitation` / `update_fund` / `update_review` directly — those are the lifecycle-correct primitives the labs MCP exposes.

## Related skills

- `sweep-live-set` produces the live-set this skill diffs against.
