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
  connect — Connect programs / opportunities / payment-units / invites        (partial — soft-deactivate opps; report-only for the rest)
  ocs     — OCS chatbots / collections / sessions / pipelines                 (partial — end orphan sessions; report-only for the rest)
  hq      — CommCare HQ apps                                                  (stub — needs commcare_list_apps atom; report-only)
  labs    — connect-labs workflows / pipelines / synthetic / labs records     (partial — auto-delete workflows+pipelines, disable synthetic; report-only for records)
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
| Connect programs / PUs / invites | connect | ⚠️ Report-only (admin UI link). Programs and PUs have no upstream delete; FLW invites need a `connect_delete_unaccepted_flw_invites` atom. |
| OCS sessions | ocs | ✅ Auto-end via `ocs_end_session` |
| OCS chatbots / collections / pipelines | ocs | ⚠️ Report-only. Upstream supports `is_archived` soft-delete via web UI POST; needs `ocs_archive_*` atoms. |
| CommCare HQ apps | hq | 🚧 Stub. Needs `commcare_list_apps` + `commcare_delete_app` atoms. |
| CommCare HQ builds / multimedia | hq | ❌ Upstream gap. No delete API exists. |
| labs workflows / pipelines / synthetic | labs | ✅ Auto-delete via existing `workflow_delete` / `pipeline_delete` / `synthetic_disable` |
| labs solicitations / funds / reviews / responses | labs | ⚠️ Report-only. Needs a generic `labs_delete_record(type, id)` atom (single upstream endpoint covers all four). |

Items marked ⚠️ surface in the report with an admin-UI deep link the human can click to delete manually. Items marked 🚧 await a prerequisite atom. Items marked ❌ have no upstream support and are surfaced for visibility only.
