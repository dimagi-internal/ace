---
name: sweep-labs
description: >
  Diff connect-labs workflows/pipelines/synthetic/solicitations against
  the live-set, score orphans, auto-delete/disable. Funds and standalone
  reviews/responses remain report-only (no upstream per-type atom yet).
disable-model-invocation: true
---

# sweep-labs

Find connect-labs artifacts (workflows, pipelines, synthetic opportunities, solicitations, funds, reviews, responses) that no current opp references. Workflows, pipelines, synthetic opps, and **solicitations** have first-class delete/disable atoms in the labs MCP — auto-execute. The remaining LabsRecord-backed types (funds + standalone reviews/responses) are report-only by design until per-type atoms exist upstream. Reviews and responses cascade-delete with their parent solicitation, so they generally don't need standalone cleanup.

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
- For approved orphan draft/closed solicitations: `delete_solicitation` calls (cascade-deletes reviews + responses).

## Process

1. **Read the live-set** via `drive_read_file`.
2. **List labs inventory** using existing atoms:
   - `workflow_list`
   - `pipeline_list`
   - `list_solicitations` (each entry includes `program_id` and `status` fields — both needed for the delete call)
   - `list_funds`
   - `list_reviews`
   - `list_responses`
3. **Diff** against the live-set's labs buckets:
   - workflows → `liveSet.identifiers.labsWorkflowIds`
   - pipelines → `liveSet.identifiers.labsPipelineIds`
   - synthetic opps → `liveSet.identifiers.labsSyntheticIds`
   - solicitations/funds/reviews/responses → `liveSet.identifiers.labsRecordIds`
4. **Score** each orphan via `scoreLabsItem(item, liveSet)` from `lib/sweep-fingerprint.ts`. The scorer defensively downgrades to `low` when an item references a Connect opportunity that's still in `liveSet.identifiers.connectOpportunityIds` — that's a sign the caller mis-flagged the item.
5. **Filter solicitations by lifecycle status:** only solicitations with `status in {'draft', 'closed'}` are deletable via `delete_solicitation`. Active and awarded solicitations refused server-side (they have downstream commitments — invited respondents, funded awards). Partition the orphan solicitation list by status: deletable vs blocked-by-lifecycle.
6. **Build the `OrphanReport`** with `system: 'labs'`. Partition into:
   - **Actionable — auto-execute:** workflows, pipelines, synthetic opps, draft/closed solicitations.
   - **Blocked by lifecycle:** active/awarded solicitations — print labs admin URLs and a note that these need lifecycle changes (use `update_solicitation` to flip status to `closed` first if cleanup is wanted).
   - **Informational only:** funds, standalone reviews/responses (reviews+responses that were already cascade-deleted with a parent solicitation don't appear here). Funds may need their own per-type atom in a future labs MCP release; reviews/responses generally cascade with their parent solicitation.
7. **Render** + write `labs-orphans.md` and `.yaml` to the sweep folder.
8. **Surface to human** in chat. Prompt for approval per actionable chunk; the blocked-by-lifecycle and informational lists are read-only.
9. **On approval:**
   - Orphan workflows → `workflow_delete({ workflow_id })`
   - Orphan pipelines → `pipeline_delete({ pipeline_id })`
   - Orphan synthetic opps → `synthetic_disable({ synthetic_opp_id })`
   - Orphan deletable solicitations → `delete_solicitation({ solicitation_id, program_id })`. The atom cascade-deletes the solicitation's reviews and responses in one call and returns the count of records deleted at each level — surface that in the chat summary so the human sees the cascade impact.

## Failure modes

- **Live-set path doesn't resolve:** abort with "Run `sweep-live-set` first."
- **Labs MCP returns 401:** `LABS_MCP_TOKEN` is expired; recommend `/ace:labs-token-mint` to rotate, then retry.
- **`workflow_delete` fails because the workflow has running tasks:** report the item as "in-use — needs manual review"; don't retry, don't abort the batch.
- **`delete_solicitation` refused due to status:** the lifecycle check failed server-side (race condition — status flipped between list and delete). Report the item as "lifecycle-blocked"; don't retry.

## Why funds + standalone reviews/responses remain report-only

The labs MCP exposes per-type delete for solicitations because solicitations are the **lifecycle unit** for the audit-data ecosystem (reviews and responses are children that cascade-delete with their parent). The other LabsRecord types intentionally don't have per-type delete atoms because:

- **Funds** may have allocations + downstream allocation refs from responses. A future `delete_fund` atom would need similar lifecycle guards (and the labs team hasn't surfaced demand for one yet — funds tend to be reused across solicitations rather than created per-opp).
- **Standalone reviews/responses** (not cascade-deleted with a parent solicitation) are uncommon — if they exist as true orphans, they were probably created by a buggy producer and should be investigated rather than auto-deleted. Surface them for visibility.

If the labs team adds `delete_fund` upstream, this skill's coverage matrix entry flips automatically — the proxy is a pure forwarder so no ACE-side wiring is needed beyond updating Step 5/6/9 and `agents/sweep.md`.

## Related skills

- `sweep-live-set` produces the live-set this skill diffs against.
