---
name: sweep-ocs
description: >
  Diff OCS chatbots/pipelines/sessions against the live-set, score
  orphans, auto-archive per-opp clones and auto-end sessions. Collections
  are SHARED with the golden template; explicitly excluded from auto-archive.
disable-model-invocation: true
---

# sweep-ocs

Find OCS artifacts (chatbots, pipelines, sessions) that no current opp references and triage them. Per-opp chatbots and pipelines are deep-clones — safe to archive. Sessions soft-close via `ocs_end_session`. **Collections and source-material files are NOT safe to archive** (see Critical safety boundary below) — they surface in the report for visibility only, with explicit warnings against deletion.

## Critical safety boundary — what is and isn't deep-cloned

Verified 2026-05-15 against `apps/chatbots/views.py:copy_chatbot` and `apps/pipelines/models.py:Node.create_new_version`:

| Resource | On clone | Sweep behavior |
|---|---|---|
| Experiment (chatbot) | NEW row created | ✅ Safe to archive orphan clones |
| Pipeline | NEW row created via `create_new_version(is_copy=True)` | ✅ Safe to archive orphan clones |
| Collection | SHARED — LLM nodes reuse golden template's `collection_id` (the `if not is_copy` branch in `Node.create_new_version` is intentionally skipped on clone, so collection refs pass through unchanged) | ❌ Never auto-archive — archiving an opp's collection breaks the golden template AND every other opp's clones |
| Source material / collection files | Live inside the shared collection | ❌ Same — never auto-delete |
| Chatbot version | Created per `ocs_publish_chatbot_version`; tied to parent experiment | Cascades when parent experiment is archived |

Additionally, the **golden template chatbot itself** (`OCS_GOLDEN_TEMPLATE_ID` from `.env`) is never an orphan candidate — it has no entry in any opp's `run_state.yaml`, so naive diff would flag it. This skill's Step 3a below adds it to the live-set as a safe-list entry before diffing.

## Inputs

- Live-set file path from `sweep-live-set`.
- `OCS_TEAM_SLUG` and `OCS_GOLDEN_TEMPLATE_ID` from `.env`.
- `OCS_BASE_URL` (e.g. `https://chatbots.dimagi.com`).

## Products

- `ACE/_sweep/<timestamp>/ocs-orphans.md` — human-readable triage report.
- `ACE/_sweep/<timestamp>/ocs-orphans.yaml` — machine-readable `OrphanReport`.
- For approved orphan chatbots: `ocs_archive_chatbot({ experiment_id })` calls.
- For approved orphan pipelines: `ocs_archive_pipeline({ pipeline_id })` calls.
- For approved orphan sessions: `ocs_end_session` calls.

## Process

1. **Read the live-set** via `drive_read_file`.
2. **Augment live-set with safety entries:**
   - Add `OCS_GOLDEN_TEMPLATE_ID` to `liveSet.identifiers.ocsChatbotIds` so the golden template itself is never flagged as an orphan.
3. **List OCS inventory** using existing atoms:
   - `ocs_list_chatbots` (paginate as needed)
   - `ocs_list_sessions` (filter to `OCS_TEAM_SLUG`; default to recent sessions only — last 90 days — to avoid overwhelming the list).
4. **Diff** each item's id against the live-set:
   - chatbots → `liveSet.identifiers.ocsChatbotIds` (now includes the golden template).
   - sessions → `liveSet.identifiers.ocsSessionIds`.
   - pipelines → derived from orphan chatbots' `pipeline_id` (one pipeline per chatbot since 2026-05-15 verified deep-clone).
5. **Score** each orphan via `scoreOcsItem(item, liveSet, OCS_GOLDEN_TEMPLATE_ID)`. The scorer downgrades items whose id matches `goldenTemplateId` defensively (even though step 2 should have excluded them).
6. **Build the `OrphanReport`** with `system: 'ocs'`. Partition into:
   - **Actionable — auto-archive:** chatbots and their pipelines.
   - **Actionable — auto-end:** sessions.
   - **Do NOT auto-archive (informational):** collections + source-material files referenced by orphan chatbots. List them so the human knows they exist, but the report explicitly states "SHARED with golden template — manual review only" next to each. Most are still actively used by the template.
7. **Render** + write `ocs-orphans.md` and `.yaml` to the sweep folder.
8. **Surface to human** in chat. Prompt for approval per actionable chunk; the collection list is read-only.
9. **On approval:**
   - For each approved orphan chatbot, call `ocs_archive_chatbot({ experiment_id })`.
   - For each approved orphan pipeline (1:1 with archived chatbots), call `ocs_archive_pipeline({ pipeline_id })`.
   - For each approved orphan session, call `ocs_end_session`.

## Failure modes

- **Live-set path doesn't resolve:** abort with "Run `sweep-live-set` first."
- **`OCS_GOLDEN_TEMPLATE_ID` not set in env:** abort. Without it, step 2 can't protect the template — refuse to run rather than risk archiving the template.
- **`ocs_list_*` returns 401:** session is stale; recommend `/ace:ocs-login` then retry.
- **A session is already ended:** treat as success (no-op).
- **A chatbot is already archived:** treat as success (no-op).

## Implementation notes for agents

- OCS uses `is_archived` soft-delete on `Experiment`, `Pipeline`, and `Collection` (`apps/experiments/models.py:641`, `apps/pipelines/models.py:115`, `apps/documents/models.py:103`). The archive view per resource is at `/a/<slug>/<resource>/<id>/delete/`. Chatbot is POST (`@require_POST`); pipeline and collection are HTTP `DELETE` method (Django `View.delete()`).
- Collection files use hard-delete via async task (`apps/documents/urls.py:15`). Same shared-collection concern applies — not exposed as an atom.
- The "1:1 chatbot → pipeline" invariant matters: orphan-chatbot archive should pair with archive of its pipeline. The skill does this in Step 9 by reading each orphan chatbot's pipeline_id from `ocs_get_chatbot` before the chatbot is archived (since archive may cascade-archive but we don't depend on it).

## Related skills

- `sweep-live-set` produces the live-set this skill diffs against.
