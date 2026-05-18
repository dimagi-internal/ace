---
name: sweep
description: >
  Procedure doc for /ace:sweep — orchestrates live-set build then per-system
  orphan sweep with human triage. Supports drive, connect, ocs, hq, labs.
model: inherit
---

# /ace:sweep — Orchestrator (procedure doc)

This is a procedure doc, not a subagent. The `/ace:sweep` slash command reads it and executes the steps inline at level 0 (so it can call the `Agent` tool to dispatch leaf skills, per `CLAUDE.md` § Agent topology).

## Arguments

- `<system>` (optional) — one of `drive`, `connect`, `ocs`, `hq`, `labs`, `all`. If omitted, prompt the user to pick.

## Process

### Step 1: Determine system

If the user passed `<system>`, use it. Otherwise, present:

```
Which system?
  drive   — Drive folders under ACE/                                          (auto-trash)
  connect — Connect opportunities + unaccepted FLW invites                    (auto: deactivate opps, delete unaccepted invites; programs report-only)
  ocs     — OCS chatbots + pipelines + per-opp collections + sessions         (auto: delete chatbots/pipelines/per-opp-collections, end sessions; golden template + shared collection safe-listed)
  hq      — CommCare HQ apps                                                  (auto-soft-delete; builds and multimedia are upstream gaps and not surfaced)
  labs    — connect-labs workflows + pipelines + synthetic + solicitations    (auto: delete workflows/pipelines/solicitations [cascade-empty gate], disable synthetic; funds/standalone-reviews/standalone-responses report-only)
  all     — run all five in sequence
```

### Step 2: Build the live-set

Dispatch the `sweep-live-set` skill:

```
Agent(sweep-live-set)
```

Wait for it to return the live-set Drive path. Capture the timestamped sweep folder (e.g. `ACE/_sweep/20260515-180000/`) — every subsequent step writes into that same folder.

### Step 3: Per-system sweep

Dispatch the matching skill:

| system  | skill          |
|---------|----------------|
| drive   | `sweep-drive`  |
| connect | `sweep-connect`|
| ocs     | `sweep-ocs`    |
| hq      | `sweep-hq`     |
| labs    | `sweep-labs`   |

Each sub-skill handles its own diff + score + render + triage + execute. The orchestrator only waits for completion.

For `system == 'all'`, dispatch each in order: drive → connect → ocs → hq → labs. Each gets the same `liveSetPath` + `sweepFolder` from Step 2. Stop on the first hard failure (auth issue, broken atom); soft failures (per-item delete errors) are reported by the sub-skill and don't halt the orchestrator.

### Step 4: Summary

After each system sweep:

```
/ace:sweep <system> — complete

Sweep folder: ACE/_sweep/<timestamp>/
Report:       ACE/_sweep/<timestamp>/<system>-orphans.md
Actioned:     <N> auto-deleted/deactivated/ended
Manual TODO:  <M> items linked in the report for admin-UI cleanup
Skipped:      <K> items (low confidence or human-rejected)
```

When `system == 'all'`, print one summary block per system, then a final aggregate.

## Notes

- The procedure doc is the only thing that calls `Agent`. Each sub-skill (`sweep-live-set`, `sweep-<system>`) is a leaf — no nested `Agent` dispatch.
- Per `CLAUDE.md` § Phase preconditions are restored, not adapted: do not try to detect "is there a stale live-set" — just regenerate it every time. The live-set is cheap (~seconds to build).
- This procedure doc is invoked once per sweep run; it doesn't persist state across runs. Persistent state (the sweep folders themselves) lives in Drive under `ACE/_sweep/`.
- Per-system skills can be invoked manually for ad-hoc runs (`Agent(sweep-connect)` etc.), but you must still produce a live-set first.

## Status of per-system delete coverage

| Product | System | Coverage |
|---|---|---|
| Drive folders | drive | ✅ Auto-trash (`drive_trash_file`) |
| Connect opportunities | connect | Soft-deactivate via existing `update_opportunity({active: false})` |
| Connect unaccepted FLW invites | connect | ✅ Auto-delete via `connect_delete_unaccepted_flw_invites` (cascade-deletes OpportunityAccess; accepted invites silently skipped server-side) |
| Connect payment units | connect | Implicit children of opportunities — no standalone cleanup. When an opp is deactivated/deleted, its PUs follow. Sweep does not list PUs separately. |
| Connect programs | connect | ❌ Upstream gap. No delete view exists. Admin UI link only. |
| OCS sessions | ocs | ✅ Auto-end via `ocs_end_session` |
| OCS chatbots | ocs | ✅ Auto-delete via `ocs_delete_chatbot` (per-opp clone — safe; golden template `OCS_GOLDEN_TEMPLATE_ID` safe-listed) |
| OCS pipelines | ocs | ✅ Auto-delete via `ocs_delete_pipeline` (per-opp deep clone via `create_new_version(is_copy=True)` — safe) |
| OCS per-opp collections | ocs | ✅ Auto-delete via `ocs_delete_collection` (Phase-5-created collections are not shared; cascades to underlying File rows + object-storage blobs + FileChunkEmbedding vectors via `delete_document_source_task`). Shared collection `OCS_SHARED_COLLECTION_ID` (typically 350) safe-listed. |
| CommCare HQ apps | hq | ✅ Auto-soft-delete via `commcare_delete_app` (mutates `doc_type` to `<original>-Deleted`; restorable 90d via HQ admin UI). Listing via new `commcare_list_apps`. |
| CommCare HQ builds / multimedia | hq | ❌ Upstream gap. No delete API exists; not surfaced in sweep report. |
| labs workflows / pipelines / synthetic | labs | ✅ Auto-delete via existing `workflow_delete` / `pipeline_delete` / `synthetic_disable` |
| labs solicitations | labs | ✅ Auto-delete via `delete_solicitation` (gated on cascade emptiness — refuses when `responses + reviews > 0` unless `force: true`; cascade-deletes reviews + responses on success). connect-labs PR #197. |
| labs funds / standalone reviews / standalone responses | labs | ⚠️ Report-only. No per-type delete atom upstream yet. Reviews/responses generally cascade with their parent solicitation; funds tend to be reused. If `delete_fund` ships upstream later, the proxy forwards it automatically and the coverage matrix here can be updated. |

Items marked ⚠️ surface in the report with an admin-UI deep link the human can click to delete manually. Items marked 🚧 await a prerequisite atom. Items marked ❌ have no upstream support and are surfaced for visibility only.
