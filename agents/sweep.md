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
  ocs     — OCS chatbots + pipelines + sessions                               (auto: archive chatbots+pipelines, end sessions; collections never auto-archive — shared with golden template)
  hq      — CommCare HQ apps                                                  (auto-soft-delete; builds and multimedia are upstream gaps and not surfaced)
  labs    — connect-labs workflows + pipelines + synthetic                    (auto-delete/disable; solicitations/funds/reviews/responses report-only — lifecycle semantics belong to labs MCP)
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
| OCS chatbots | ocs | ✅ Auto-archive via `ocs_archive_chatbot` (per-opp clone — safe; golden template explicitly safe-listed) |
| OCS pipelines | ocs | ✅ Auto-archive via `ocs_archive_pipeline` (per-opp deep clone via `create_new_version(is_copy=True)` — safe) |
| OCS collections / source-material files | ocs | ❌ SHARED with golden template (LLM nodes pass collection_id through unchanged on clone). Surface for visibility but NEVER auto-archive — would break golden template + every other clone. |
| CommCare HQ apps | hq | ✅ Auto-soft-delete via `commcare_delete_app` (mutates `doc_type` to `<original>-Deleted`; restorable 90d via HQ admin UI). Listing via new `commcare_list_apps`. |
| CommCare HQ builds / multimedia | hq | ❌ Upstream gap. No delete API exists; not surfaced in sweep report. |
| labs workflows / pipelines / synthetic | labs | ✅ Auto-delete via existing `workflow_delete` / `pipeline_delete` / `synthetic_disable` |
| labs solicitations / funds / reviews / responses | labs | ⚠️ Report-only. Labs MCP intentionally has no per-type delete — these have lifecycle semantics (status state machines, allocation refs, audit trails). Cleanup happens via the existing `update_*` atoms (e.g. `update_solicitation({status:'cancelled'})`) or via cascade-on-opp-delete when upstream ships a real Connect opportunity-delete view. Sweep surfaces them for visibility only. |

Items marked ⚠️ surface in the report with an admin-UI deep link the human can click to delete manually. Items marked 🚧 await a prerequisite atom. Items marked ❌ have no upstream support and are surfaced for visibility only.
