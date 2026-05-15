---
name: sweep-labs
description: >
  Diff connect-labs workflows/pipelines/synthetic/records against the
  live-set, score orphans, auto-delete or auto-disable using existing
  labs atoms; report LabsRecord types pending a delete atom.
disable-model-invocation: true
---

# sweep-labs

Find connect-labs artifacts (workflows, pipelines, synthetic opportunities, solicitations, funds, reviews, responses) that no current opp references. Workflows, pipelines, and synthetic opps have existing delete/disable atoms — auto-execute on approval. LabsRecord-backed types (solicitations, funds, reviews, responses) all delete via the same generic `LabsRecordDataView.DELETE` endpoint upstream, but no ACE atom exposes it yet — those surface as report-only with admin-UI links until a `labs_delete_record` atom ships.

## Inputs

- Live-set file path from `sweep-live-set`.
- `LABS_MCP_TOKEN` and labs base URL (loaded via `connect-labs` MCP).
- Labs base URL: `https://labs.connect.dimagi.com`.

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
4. **Score** each orphan via `scoreLabsItem(item, liveSet)` from `lib/sweep-fingerprint.ts`. Note: `scoreLabsItem` defensively downgrades to `low` when an item references a Connect opportunity that's still in `liveSet.identifiers.connectOpportunityIds` — that's a sign the labs caller mis-flagged the item.
5. **Build the `OrphanReport`** with `system: 'labs'`. Partition into:
   - **Actionable:** workflows, pipelines, synthetic opps.
   - **Upstream-blocked-by-atom:** solicitations, funds, reviews, responses — print labs admin URLs (`https://labs.connect.dimagi.com/labs/records/<type>/<id>/`) for manual deletion.
6. **Render** + write `labs-orphans.md` and `.yaml` to the sweep folder.
7. **Surface to human** in chat. Prompt for approval per actionable chunk.
8. **On approval:**
   - Orphan workflows → `workflow_delete({ workflow_id })`
   - Orphan pipelines → `pipeline_delete({ pipeline_id })`
   - Orphan synthetic opps → `synthetic_disable({ synthetic_opp_id })`

## Failure modes

- **Live-set path doesn't resolve:** abort with "Run `sweep-live-set` first."
- **Labs MCP returns 401:** `LABS_MCP_TOKEN` is expired; recommend `/ace:labs-token-mint` to rotate, then retry.
- **`workflow_delete` fails because the workflow has running tasks:** report the item as "in-use — needs manual review"; don't retry, don't abort the batch.

## Implementation notes for agents

- LabsRecord-backed types (solicitation, fund, review, response) all store data in the same Django model (`commcare_connect.opportunity.models:LabsRecord`) with a `type` discriminator. The upstream `LabsRecordDataView.DELETE` endpoint at `/labs_record/` accepts `{"id": pk}` in the request body and hard-deletes. A single generic `labs_delete_record(type, id)` atom in the labs MCP proxy would cover all four types in a follow-up PR.
- Workflow runs are stored as `LabsRecord(type='workflow_run')` too; not currently surfaced.

## Related skills

- `sweep-live-set` produces the live-set this skill diffs against.
- Future: `labs_delete_record` atom unblocks auto-delete for the LabsRecord-backed product types.
