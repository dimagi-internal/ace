# `/ace:sweep` — Cross-System Orphan Cleanup

**Status:** design • **Date:** 2026-05-15 • **Owner:** jjackson

## Problem

Every `/ace:run` creates artifacts across many systems: Drive folders, Connect programs/opportunities/payment-units, OCS chatbots/collections/sessions, CommCare HQ apps + builds, connect-labs workflows/pipelines/synthetic opps. Most have no in-line teardown.

Jon's current habit is to delete the Drive folder when an opp is done, which leaves the target-system artifacts orphaned — they've lost their reference back to ACE, but they remain alive in Connect, OCS, HQ, and labs. Orphan accumulation degrades each system's signal-to-noise and burns through quotas (OCS chatbots, HQ app slots).

The goal: a **repeatable sweeping pass** that finds and removes orphaned artifacts ACE has created, run one system at a time, with human triage.

## Non-goals

- **Not** real-time / per-run cleanup. A later phase could add `/ace:closeout`-driven teardown; that's separate.
- **Not** authoritative deletion of non-ACE artifacts. ACE-likely is a fingerprint judgment, not a guarantee — humans confirm.
- **Not** historical recovery. Trashed Drive items survive 30 days; deleted Connect/OCS/HQ items are gone.

## Core mechanism: live-set diff

The safety mechanism is structural, not pattern-based:

1. **Live set** = every external identifier still referenced by an opp visible in Drive. Walk `ACE/<opp>/`; for each opp, parse `opp.yaml` + every `runs/<run-id>/run_state.yaml` and harvest IDs into one index.
2. **System inventory** = everything ACE's credentials can see in a target system.
3. **Orphans** = (system inventory) − (live set).
4. **ACE-fingerprint score** is applied *only* to orphans, to help the human triage which of them ACE plausibly created vs. ones that pre-date ACE / belong to a different agent / are real human-created artifacts.

Crucially: deleting the Drive folder is exactly what marks a thing as "abandoned" — it's the user's existing signal. The sweep operationalizes that signal.

## Architecture

### New components

```
agents/
  sweep.md                      # procedure doc; orchestrates live-set → probe → triage → execute

skills/
  sweep-live-set/SKILL.md       # Drive walk → live-set.yaml
  sweep-drive/SKILL.md          # Drive sweep (and validates live-set extractor)
  sweep-connect/SKILL.md        # Connect sweep (PR 2)
  sweep-ocs/SKILL.md            # OCS sweep (PR 3)
  sweep-hq/SKILL.md             # CommCare HQ sweep (PR 4)
  sweep-labs/SKILL.md           # connect-labs sweep (PR 5)

commands/
  sweep.md                      # /ace:sweep [system]

lib/
  sweep-fingerprint.ts          # ACE-fingerprint scoring rules (shared)
  sweep-report.ts               # markdown table renderer
```

`sweep.md` must be a procedure doc (not a subagent) because it dispatches sub-skills.

### Per-system skill contract

Each `sweep-<system>` skill:

1. Reads `live-set.yaml`.
2. Lists everything in its system via existing `list_*` atoms.
3. Diffs → orphan candidates.
4. Scores each orphan via `sweep-fingerprint.ts`:
   - **high** — name matches a known ACE pattern (e.g. `CRISPR-*`, golden-template clone signature) AND created in an ACE activity window.
   - **medium** — one of the two signals.
   - **low** — neither, but visible to ACE's account.
5. Emits `runs/sweep-<timestamp>/<system>-orphans.md` (the triage report) and `<system>-delete-plan.yaml` (initially empty; populated as user approves chunks).
6. Executor pass: reads `delete-plan.yaml`, calls auto-delete atoms where available, or emits a manual punch list for systems without delete atoms.

### Capability matrix (per product, per system)

Per-system research (2026-05-15, reading upstream source on GitHub) produced the following. The pattern is consistent across systems: most products have **no REST DELETE API**, but **do have HTML/web-UI POST endpoints** that we can drive from a new Playwright-backed atom — the same architectural split ACE already uses for `connect-*` and `ocs-*` writes.

| System | Product | Existing ACE atom | Upstream mechanism | Backend | Plan |
|--------|---------|-------------------|--------------------|---------|------|
| Drive | folder / doc / sheet / slide | `drive_trash_file` | `files.update(trashed:true)` | REST | ✅ use existing |
| connect-labs | workflow | `workflow_delete` | REST DELETE | REST | ✅ use existing |
| connect-labs | pipeline | `pipeline_delete` | REST DELETE | REST | ✅ use existing |
| connect-labs | synthetic opp | `synthetic_disable` | `enabled=False` | REST | ✅ use existing (soft) |
| connect-labs | solicitation | — | `LabsRecordDataView.DELETE` ({id: pk}) | REST | **new atom** `labs_delete_record(type, id)` (generic, covers 4 products) |
| connect-labs | fund | — | same generic endpoint | REST | covered by above |
| connect-labs | review | — | same generic endpoint | REST | covered by above |
| connect-labs | response | — | same generic endpoint | REST | covered by above |
| connect-labs | workflow run | — | Django ORM only? | unclear | research as part of PR 5 |
| Connect | opportunity | — | internal `delete_opportunity()` cascading helper, HTML view; also `active=False` toggle | Playwright (POST) | **new atom** `connect_delete_opportunity` |
| Connect | program | — | no delete, no inactive | — | ❌ upstream gap; report-only |
| Connect | payment unit | — | no delete, no inactive | — | ❌ upstream gap; report-only |
| Connect | LLO invite (program application) | `connect_accept_program_application` | status mutation only | — | ❌ no delete; status update only |
| Connect | FLW invite | — | HTML view `delete_user_invites/`, unaccepted-only | Playwright (POST) | **new atom** `connect_delete_unaccepted_flw_invites` |
| OCS | chatbot (experiment) | — | `/team/<slug>/chatbots/<id>/delete/` → `experiment.archive()` (sets `is_archived=True`) | Playwright (POST) | **new atom** `ocs_archive_chatbot` |
| OCS | collection | — | `/team/<slug>/collections/<id>/delete/` → `collection.archive()` + async file cleanup | Playwright (POST) | **new atom** `ocs_archive_collection` |
| OCS | pipeline | — | `/team/<slug>/pipelines/<id>/delete/` → `pipeline.archive()` | Playwright (POST) | **new atom** `ocs_archive_pipeline` |
| OCS | session | `ocs_end_session` | `POST /api/sessions/<id>/end_experiment_session/` (REST!) | REST | ✅ use existing |
| OCS | source material / collection file | — | `/team/<slug>/collections/<id>/files/<file_id>/delete` (hard delete via async task) | Playwright (POST) | **new atom** `ocs_delete_collection_file` |
| OCS | chatbot version | — | no independent delete; cascades from chatbot archive | — | covered by `ocs_archive_chatbot` |
| CommCare HQ | application | — | `POST /a/{domain}/apps/delete_app/{app_id}/` → soft-delete (`doc_type` → `Application-Deleted`), restorable via `undo_delete_app` | Playwright (POST) | **new atom** `commcare_delete_app` |
| CommCare HQ | build | — | no delete, only `is_released` toggle | — | ❌ upstream gap (builds immutable); report-only |
| CommCare HQ | multimedia | — | no scalable delete; only logo removal | — | ❌ upstream gap; report-only |
| Nova | app (blueprint DB) | `mcp__nova__delete_app` | local DB | REST | ✅ local to Nova, runs as part of sweep but doesn't touch HQ |

**New atoms to build (one per system PR):**

- **connect-labs (PR 5):** `labs_delete_record(type, id)` — one atom covers solicitation/fund/review/response via the generic `LabsRecordDataView.DELETE`.
- **Connect (PR 2):** `connect_delete_opportunity`, `connect_delete_unaccepted_flw_invites` — Playwright POSTs to existing HTML views.
- **OCS (PR 3):** `ocs_archive_chatbot`, `ocs_archive_collection`, `ocs_archive_pipeline`, `ocs_delete_collection_file` — Playwright POSTs to existing archive views.
- **CommCare HQ (PR 4):** `commcare_delete_app` — Playwright POST to `delete_app` HQ view. Lives alongside the other `commcare_*` atoms in `mcp/connect/backends/commcare.ts`.

**Documented upstream gaps (report-only — sweep lists them, human can't delete):**

- Connect: programs, payment units, LLO invites (status mutations only)
- CommCare HQ: builds, multimedia
- These get a separate "upstream-blocked" section in the sweep report. File upstream issues to track each gap so we can revisit when an API delete lands.

**Architectural note:** Every new atom follows the existing Playwright-write-CSRF-form pattern in `mcp/{connect,ocs}/backends/playwright.ts` — fetch the page, scrape CSRF token, POST the form. The executor calls the atom by canonical name; backend choice is invisible to the sweep skills.

### ACE-fingerprint heuristics (initial set)

- **Connect program/opportunity:** name matches `^CRISPR-.*`, or description contains `ACE-generated`, or organization_name is one of ACE's known seed orgs.
- **OCS chatbot:** cloned from `OCS_GOLDEN_TEMPLATE_ID` (chatbot exposes parent on `ocs_get_chatbot`); name starts with `ACE-` or matches opp-name shape.
- **OCS collection:** ditto, plus structural — single-collection chatbots only.
- **HQ app:** name contains "Learn" or "Deliver" AND domain is `connect-ace-prod`, project space owned by `ace@dimagi-ai.com`.
- **labs workflow/pipeline:** created_by is ACE service account; opportunity_ids reference Connect IDs in live-set or orphans.

Each heuristic is a separate function in `sweep-fingerprint.ts` so they can be tuned independently as we observe real orphan distributions.

## UX

```
$ /ace:sweep
Which system? drive | connect | ocs | hq | labs | all

$ /ace:sweep drive
[1/3] Building live set from Drive...
      Found 14 active opps, 47 active runs, 312 referenced IDs.

[2/3] Listing Drive root ACE/...
      Found 89 folders. 14 active, 75 orphan candidates.

[3/3] Triage report → ACE/_sweep/2026-05-15T18-22Z/drive-orphans.md
      high   42  (will trash on approval)
      medium 21  (review individually)
      low    12  (likely human-created — skipping by default)

Approve high-confidence batch (42 items)? [y/N]
```

Per-system runs are independent; you can sweep Drive today and Connect next week.

## Phasing

Research pass complete (2026-05-15). All per-system findings codified in the matrix above. Implementation phasing:

- **PR 1:** `sweep-live-set` + `sweep-drive` + `sweep.md` procedure doc + `/ace:sweep` command + `sweep-fingerprint.ts` skeleton + `sweep-report.ts`. End-to-end works for Drive. No new MCP atoms.
- **PR 2 (Connect):** `sweep-connect` skill + new Playwright atoms `connect_delete_opportunity`, `connect_delete_unaccepted_flw_invites`. Programs/payment-units/program-applications surface in sweep report as upstream-blocked.
- **PR 3 (OCS):** `sweep-ocs` skill + new Playwright atoms `ocs_archive_chatbot`, `ocs_archive_collection`, `ocs_archive_pipeline`, `ocs_delete_collection_file`. Sessions auto-end via existing `ocs_end_session`.
- **PR 4 (HQ):** `sweep-hq` skill + new Playwright atom `commcare_delete_app` in `mcp/connect/backends/commcare.ts`. Builds and multimedia surface as upstream-blocked.
- **PR 5 (labs):** `sweep-labs` skill + new REST atom `labs_delete_record(type, id)` (generic, covers solicitation/fund/review/response). Workflows/pipelines/synthetic auto-delete via existing atoms.

Each per-system PR is independent after PR 1. Upstream-blocked items each get an issue filed against the relevant Dimagi repo so we can revisit when an API delete is added.

## Open questions

- **Drive trash vs delete.** MVP uses `drive_trash_file` (30-day recovery). If we ever want hard delete (e.g. quota pressure), add a `--purge` flag that calls `drive.files.delete()` directly on items already in trash.
- **Sweep report retention.** Sweep reports themselves accumulate under `ACE/_sweep/<timestamp>/`. We should set a TTL — proposal: sweep reports older than 90 days are auto-trashed by the next sweep run.
- **Cross-run live-set caching.** Building the live set requires walking every opp's runs. For ~100 opps this is fine. If it gets slow, cache last build with an ETag-style invalidation. Not MVP.

## What this design explicitly avoids

- **A cleanup phase in `/ace:run`.** That's a different problem (real-time teardown). Sweep is for the backlog.
- **A keep-list / tombstone marker.** Live-set diff already gives us "what's still referenced"; tombstones would be redundant.
- **Auto-deletion of high-confidence items without human approval.** Even high-confidence orphans go through the approval gate. Safety > speed.
