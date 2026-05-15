---
name: sweep-ocs
description: >
  Diff OCS chatbots/collections/sessions against the live-set, score
  orphans, auto-end orphan sessions, report orphan chatbots/collections
  for manual archive until atoms exist.
disable-model-invocation: true
---

# sweep-ocs

Find OCS artifacts (chatbots, collections, sessions, pipelines) that no current opp references and triage them. Sessions soft-close via the existing `ocs_end_session` atom. Chatbots/collections/pipelines all use `is_archived` soft-delete in OCS but the archive operation is exposed only via web UI POST (not REST API) — until per-product Playwright atoms are added, this skill reports them with admin-UI deep links.

## Inputs

- Live-set file path from `sweep-live-set`.
- `OCS_TEAM_SLUG` and `OCS_GOLDEN_TEMPLATE_ID` from `.env`.
- `OCS_BASE_URL` (e.g. `https://chatbots.dimagi.com`).

## Products

- `ACE/_sweep/<timestamp>/ocs-orphans.md` — human-readable triage report.
- `ACE/_sweep/<timestamp>/ocs-orphans.yaml` — machine-readable `OrphanReport`.
- For approved orphan sessions: `ocs_end_session` calls.

## Process

1. **Read the live-set** via `drive_read_file`.
2. **List OCS inventory** using existing atoms:
   - `ocs_list_chatbots`
   - `ocs_list_sessions` (filter to OCS_TEAM_SLUG; default to recent sessions only — last 90 days — to avoid overwhelming list).
3. **Diff** each item's id against the live-set:
   - chatbots → `liveSet.identifiers.ocsChatbotIds`
   - sessions → `liveSet.identifiers.ocsSessionIds`
4. **Score** each orphan via `scoreOcsItem(item, liveSet, OCS_GOLDEN_TEMPLATE_ID)`.
5. **Build the `OrphanReport`** with `system: 'ocs'`. Partition into:
   - **Actionable:** sessions (auto-end via `ocs_end_session`).
   - **Upstream-blocked:** chatbots, collections, pipelines, files — print admin URLs (`<OCS_BASE_URL>/team/<slug>/chatbots/<id>/`, etc.) for manual archive.
6. **Render** + write `ocs-orphans.md` and `.yaml` to the sweep folder.
7. **Surface to human** in chat. Prompt for approval per actionable chunk.
8. **On approval:** for each approved orphan session, call `ocs_end_session`.

## Failure modes

- **Live-set path doesn't resolve:** abort with "Run `sweep-live-set` first."
- **`ocs_list_*` returns 401:** session is stale; recommend `/ace:ocs-login` then retry.
- **A session is already ended:** treat as success (no-op).

## Implementation notes for agents

- OCS chatbots, collections, pipelines all use `is_archived` soft-delete (`apps/experiments/models.py:641`, `apps/documents/models.py:103`, `apps/pipelines/models.py:115`). The archive view is at `/team/<slug>/<resource>/<id>/delete/` — a future PR can add Playwright atoms (`ocs_archive_chatbot`, etc.) to drive these URLs and unblock auto-archive.
- Collection files use hard-delete via async task (`apps/documents/urls.py:15`); also UI-only.
- Listing collections directly isn't currently exposed as an atom — this skill iterates chatbots and surfaces each chatbot's collection_id as a derived candidate.

## Related skills

- `sweep-live-set` produces the live-set this skill diffs against.
- Future: `ocs_archive_chatbot`, `ocs_archive_collection`, `ocs_archive_pipeline`, `ocs_delete_collection_file` atoms unblock auto-archive.
