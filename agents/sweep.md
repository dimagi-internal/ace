---
name: sweep
description: >
  Procedure doc for /ace:sweep — orchestrates live-set build then per-system
  orphan sweep with human triage. Currently supports drive; per-system
  expansions land in PRs 2-5.
model: inherit
---

# /ace:sweep — Orchestrator (procedure doc)

This is a procedure doc, not a subagent. The `/ace:sweep` slash command reads it and executes the steps inline at level 0 (so it can call the `Agent` tool to dispatch leaf skills, per `CLAUDE.md` § Agent topology).

## Arguments

- `<system>` (optional) — one of `drive`, `connect`, `ocs`, `hq`, `labs`. If omitted, prompt the user to pick. Today only `drive` is implemented; the others print "not yet implemented; ships in PR <N>".

## Process

### Step 1: Determine system

If the user passed `<system>`, use it. Otherwise, present:

```
Which system?
  drive   — Drive folders under ACE/ (this PR)
  connect — Connect programs / opportunities / payment-units (PR 2)
  ocs     — OCS chatbots / collections / sessions (PR 3)
  hq      — CommCare HQ apps (PR 4)
  labs    — connect-labs workflows / pipelines / synthetic / records (PR 5)
```

If they pick a system other than `drive`, respond "Not yet implemented. Ships in PR <N>." and stop.

### Step 2: Build the live-set

Dispatch the `sweep-live-set` skill:

```
Agent(sweep-live-set)
```

Wait for it to return the live-set Drive path. Capture the timestamped sweep folder (e.g. `ACE/_sweep/20260515-180000/`) — every subsequent step writes into that same folder.

### Step 3: Per-system sweep

For `system == 'drive'`, dispatch `sweep-drive`:

```
Agent(sweep-drive, with: { liveSetPath: <from step 2>, sweepFolder: <from step 2> })
```

`sweep-drive` handles the human triage and trash loop itself; this orchestrator only waits for completion.

### Step 4: Summary

Print:

```
/ace:sweep drive — complete

Sweep folder: ACE/_sweep/<timestamp>/
Report:       ACE/_sweep/<timestamp>/drive-orphans.md
Trashed:      <N> high-confidence items, <M> medium-confidence items
Skipped:      <K> items (low confidence or human-rejected)
```

## Notes

- The procedure doc is the only thing that calls `Agent`. Each sub-skill (`sweep-live-set`, `sweep-drive`) is a leaf — no nested `Agent` dispatch.
- Per `CLAUDE.md` § Phase preconditions are restored, not adapted: do not try to detect "is there a stale live-set" — just regenerate it every time. The live-set is cheap (~seconds to build).
- This procedure doc is invoked once per sweep run; it doesn't persist state across runs. Persistent state (the sweep folders themselves) lives in Drive under `ACE/_sweep/`.
