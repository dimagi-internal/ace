---
name: sweep-ocs
description: >
  Diff OCS chatbots/pipelines/collections/sessions against the live-set,
  score orphans, auto-delete per-opp clones and their pipelines and
  per-opp collections. Golden template + shared collection are safe-listed.
disable-model-invocation: true
---

# sweep-ocs

Find OCS artifacts (chatbots, pipelines, collections, sessions) that no current opp references and triage them. Per-opp chatbots, pipelines, and collections are all owned by a single clone — safe to delete when the clone is. Sessions soft-close via `ocs_end_session`. The golden template chatbot and the shared collection it references are explicitly safe-listed.

## Critical safety boundary — what's per-opp vs shared

Verified 2026-05-15 against `apps/chatbots/views.py:copy_chatbot`, `apps/pipelines/models.py:Node.create_new_version`, and `apps/files/models.py:File`:

| Resource | On clone | Sweep behavior |
|---|---|---|
| Experiment (chatbot) | NEW row created | ✅ Auto-delete orphan clones |
| Pipeline | NEW row created via `create_new_version(is_copy=True)` | ✅ Auto-delete orphan clones |
| Per-opp Collection | NEW row created by Phase 5 `ocs_create_collection` | ✅ Auto-delete orphan clones (cascades to underlying File rows + object-storage blobs + FileChunkEmbedding vectors via `delete_document_source_task`) |
| Shared Collection (`OCS_SHARED_COLLECTION_ID`, typically 350) | SHARED — every cloned pipeline references it via LLM node `collection_id` (the `if not is_copy` branch in `Node.create_new_version` intentionally skips versioning collection refs on clone) | ❌ Never auto-delete — would break every clone |
| Golden template chatbot (`OCS_GOLDEN_TEMPLATE_ID`) | — | ❌ Never auto-delete |
| Files (in any collection) | Each File row is per-collection; no content-hash dedup at the file or blob layer | Cascades when collection is deleted |
| Embedding vectors | Per `(file, collection)` tuple | Cascades when collection is deleted |
| Chatbot version | Created per `ocs_publish_chatbot_version`; tied to parent experiment | Cascades when parent experiment is deleted |

No dedup at the file or vector layer means uploading the same PDD into 19 per-opp collections costs 19× storage + 19× embedding API calls. Deleting orphan per-opp collections reclaims real storage and pays back the embedding cost over the project lifetime.

## Inputs

- Live-set file path from `sweep-live-set`.
- `OCS_TEAM_SLUG`, `OCS_GOLDEN_TEMPLATE_ID`, `OCS_SHARED_COLLECTION_ID` from `.env`.
- `OCS_BASE_URL` (e.g. `https://chatbots.dimagi.com`).

## Products

- `ACE/_sweep/<timestamp>/ocs-orphans.md` — human-readable triage report.
- `ACE/_sweep/<timestamp>/ocs-orphans.yaml` — machine-readable `OrphanReport`.
- For approved orphan chatbots: `ocs_delete_chatbot({ experiment_id })` calls.
- For approved orphan pipelines: `ocs_delete_pipeline({ pipeline_id })` calls.
- For approved orphan per-opp collections: `ocs_delete_collection({ collection_id })` calls.
- For approved orphan sessions: `ocs_end_session` calls.

## Process

1. **Read the live-set** via `drive_read_file`.
2. **Augment live-set with safety entries:**
   - Add `OCS_GOLDEN_TEMPLATE_ID` to `liveSet.identifiers.ocsChatbotIds` so the golden template chatbot is never an orphan candidate.
   - Add `OCS_SHARED_COLLECTION_ID` to `liveSet.identifiers.ocsCollectionIds` so the shared collection is never an orphan candidate.
3. **List OCS inventory** using existing atoms:
   - `ocs_list_chatbots` (paginate as needed)
   - `ocs_list_sessions` (filter to `OCS_TEAM_SLUG`; last 90 days by default).
   - For each chatbot, derive its pipeline id and per-opp collection ids from the chatbot's published version description / pipeline definition. The chatbot's most-recent version description embeds the per-opp collection id explicitly (e.g. "shared Connect collection 350 + new per-run collection 418"). Parse it; cross-check by reading the pipeline's LLM node params for collection refs.
4. **Diff** each item's id against the live-set:
   - chatbots → `liveSet.identifiers.ocsChatbotIds` (now includes golden template).
   - sessions → `liveSet.identifiers.ocsSessionIds`.
   - pipelines → derived from orphan chatbots' pipeline_id (one pipeline per chatbot since deep-clone verified).
   - collections → `liveSet.identifiers.ocsCollectionIds` (now includes shared collection). Per-opp collections derived from orphan chatbots' LLM node collection refs minus the safe-list.
5. **Score** each orphan via `scoreOcsItem(item, liveSet, OCS_GOLDEN_TEMPLATE_ID)`. The scorer defensively downgrades items whose id matches `goldenTemplateId` (even though step 2 should have excluded them).
6. **Build the `OrphanReport`** with `system: 'ocs'`. Partition into:
   - **Actionable — auto-delete:** chatbots, their paired pipelines, and their per-opp collections.
   - **Actionable — auto-end:** sessions.
   - **Safe-listed (informational):** `OCS_GOLDEN_TEMPLATE_ID` chatbot + `OCS_SHARED_COLLECTION_ID` collection. Show them in the report so the human can verify the safe-list is correctly applied, but never propose deletion.
7. **Render** + write `ocs-orphans.md` and `.yaml` to the sweep folder.
8. **Surface to human** in chat. Prompt for approval per actionable chunk.
9. **On approval (in order, per orphan chatbot):**
   - Call `ocs_delete_chatbot({ experiment_id })`.
   - Call `ocs_delete_pipeline({ pipeline_id })` for the paired pipeline.
   - For each per-opp collection_id derived in step 3, call `ocs_delete_collection({ collection_id })` — but ONLY if collection_id ≠ `OCS_SHARED_COLLECTION_ID`. The atom itself doesn't enforce this; the skill must filter.
   - For each approved orphan session, call `ocs_end_session`.

## Failure modes

- **Live-set path doesn't resolve:** abort with "Run `sweep-live-set` first."
- **`OCS_GOLDEN_TEMPLATE_ID` or `OCS_SHARED_COLLECTION_ID` not set in env:** abort. Without them, steps 2 and 9's safe-list filter can't run — refuse to act rather than risk the template or shared collection.
- **`ocs_list_*` returns 401:** session is stale; recommend `/ace:ocs-login` then retry.
- **A session is already ended:** treat as success (no-op).
- **A chatbot/pipeline/collection is already archived** (`is_archived=True`): treat as success (no-op).
- **Per-opp collection delete returns 4xx:** report the item as "delete failed — leaves orphan storage"; don't retry; don't halt the batch.

## Implementation notes for agents

- OCS uses `is_archived` soft-delete on `Experiment`, `Pipeline`, and `Collection` (`apps/experiments/models.py:641`, `apps/pipelines/models.py:115`, `apps/documents/models.py:103`). Collection delete additionally triggers `delete_document_source_task` to async-purge File rows and FileChunkEmbedding vectors.
- The chatbot/pipeline/collection delete URLs are at `/a/<slug>/<resource>/<id>/delete/`. Chatbot is POST (`@require_POST`); pipeline and collection are HTTP `DELETE` method (Django `View.delete()`). The `ocs_delete_*` atoms handle both.
- The "1 chatbot : 1 pipeline : N per-opp collections" invariant matters when computing the deletion batch. Read the chatbot's pipeline_id before deleting; same with the collection refs.
- Collection files use hard-delete via async task (`apps/documents/urls.py:15`). Once `delete_document_source_task` fires, files are gone — not recoverable from OCS admin UI. The `is_archived=True` flag on Collection itself is reversible (admin could unset it), but the underlying files would still be gone. The "deletion" is irreversible in practice.

## Related skills

- `sweep-live-set` produces the live-set this skill diffs against.
