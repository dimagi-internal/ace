---
name: sweep-labs
description: >
  Diff connect-labs workflows/pipelines/synthetic/records against the
  live-set, score orphans, auto-delete or auto-disable everything using
  existing labs atoms plus labs_delete_record for LabsRecord types.
disable-model-invocation: true
---

# sweep-labs

Find connect-labs artifacts (workflows, pipelines, synthetic opportunities, solicitations, funds, reviews, responses) that no current opp references. Every product type now has an auto-execute atom: `workflow_delete`, `pipeline_delete`, `synthetic_disable`, and `labs_delete_record` (covers all four LabsRecord-backed types via a single primary-key DELETE — the upstream view doesn't need a type discriminator).

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
5. **Build the `OrphanReport`** with `system: 'labs'`. All entries are actionable — no upstream-blocked section needed.
6. **Render** + write `labs-orphans.md` and `.yaml` to the sweep folder.
7. **Surface to human** in chat. Prompt for approval per chunk (one prompt per atom type, since each maps to a different atom).
8. **On approval:**
   - Orphan workflows → `workflow_delete({ workflow_id })`
   - Orphan pipelines → `pipeline_delete({ pipeline_id })`
   - Orphan synthetic opps → `synthetic_disable({ synthetic_opp_id })`
   - Orphan LabsRecord-backed items (solicitations, funds, reviews, responses) → `labs_delete_record({ id })` per item. The labs MCP proxy intercepts this call locally and issues an HTTP DELETE to `/export/labs_record/`; no type discriminator needed.

## Failure modes

- **Live-set path doesn't resolve:** abort with "Run `sweep-live-set` first."
- **Labs MCP returns 401:** `LABS_MCP_TOKEN` is expired; recommend `/ace:labs-token-mint` to rotate, then retry.
- **`workflow_delete` fails because the workflow has running tasks:** report the item as "in-use — needs manual review"; don't retry, don't abort the batch.

## Implementation notes for agents

- LabsRecord-backed types (solicitation, fund, review, response) all store data in the same Django model (`commcare_connect.opportunity.models:LabsRecord`) with a `type` discriminator. The `labs_delete_record(id)` atom hits the upstream HTTP DELETE at `/export/labs_record/` directly (not via the labs MCP) using the same Bearer token. No type discriminator is needed — lookup is by primary key alone.
- Workflow runs are also stored as `LabsRecord` entries; not currently surfaced as orphans (no live-set bucket for them).
- The `labs_delete_record` atom is implemented as a LOCAL tool in the ACE proxy at `mcp/connect-labs-server.ts`. The proxy intercepts `tools/list` to advertise it alongside upstream tools, and intercepts `tools/call` for `labs_delete_record` to issue the REST DELETE directly. All other JSON-RPC frames forward unchanged.

## Related skills

- `sweep-live-set` produces the live-set this skill diffs against.
