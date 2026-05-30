---
name: sweep-connect
description: >
  Diff Connect programs/opportunities/payment-units/invites against the
  live-set, score orphans, surface a triage report. Soft-deactivate
  orphan opportunities; auto-delete orphan unaccepted FLW invites;
  report-only for programs and payment units.
disable-model-invocation: true
---

# sweep-connect

Find Connect artifacts (programs, opportunities, payment units, FLW invites) that no current opp references, score them, and present them for triage. Connect's upstream API is uneven: opportunity deactivate is available, unaccepted FLW invite delete is available, but programs and payment units have no upstream delete path. This skill deactivates opportunities and deletes unaccepted invites **in its execute pass, after the orchestrator's per-system human-confirmation gate** (see `agents/sweep.md § Human-confirmation gate`); programs and PUs surface in a "upstream-gap — delete via Connect admin UI" section.

## Inputs

- Live-set file path from `sweep-live-set` skill output.
- `ACE_CONNECT_BASE_URL` from `.env` (e.g. `https://connect.dimagi.com`).
- `mode` — `recommend` (default) | `execute`. In `recommend` the skill is **report-only**: diff/score/render + return the recommended-action list; **no mutations**. In `execute` it mutates only `approvedIds`. The human-confirmation gate between the two is the orchestrator's job — see `agents/sweep.md § Human-confirmation gate`.
- `approvedIds` (`execute` mode only) — the exact ids the human approved in chat. Mutate nothing outside this set.

## Products

- `ACE/_sweep/<timestamp>/connect-orphans.md` — human-readable triage report.
- `ACE/_sweep/<timestamp>/connect-orphans.yaml` — machine-readable `OrphanReport`.
- For approved orphan opportunities: `connect_update_opportunity({active: false})` calls.

## Process

1. **Read the live-set** via `drive_read_file`. Parse YAML.
2. **List Connect inventory** using existing atoms:
   - `connect_list_programs`
   - `connect_list_opportunities` (per program)
   - `connect_list_invites` (per program — for unaccepted-invite cleanup tied to orphan opportunities)
   - Payment units are NOT listed standalone — they are implicit children of opportunities. When an opp is deactivated (or eventually hard-deleted), its PUs follow.
3. **Diff** each item's id against the corresponding live-set bucket:
   - programs → `liveSet.identifiers.connectProgramIds`
   - opportunities → `liveSet.identifiers.connectOpportunityIds`
   - invites (for orphan opportunities only) → no diff needed; every invite under an orphan opp is itself orphaned
4. **Score** each orphan via `scoreConnectItem(item, liveSet)` from `lib/sweep-fingerprint.ts`.
5. **Build the `OrphanReport`** with `system: 'connect'`. Partition the report into two sections:
   - **Actionable:** opportunities (soft-deactivate) and unaccepted FLW invites (auto-delete).
   - **Upstream-gap:** programs only — print Connect admin URLs (`<base_url>/a/<org_slug>/program/<id>/`) for manual deletion. There is no upstream delete view for programs.
6. **Render** via `renderOrphanReport()` from `lib/sweep-report.ts`. Write `connect-orphans.md` and `connect-orphans.yaml` to the sweep folder.
7. **Recommend — stop here in `mode: recommend`.** Return the structured recommended-action list (opportunities to deactivate; unaccepted FLW invites to delete — each with id, name, confidence) plus the programs report-only list and the report Drive link, to the orchestrator. **Perform no mutations.** Do not try to prompt the human from this skill — a dispatched subagent can't reach them; the orchestrator runs the confirmation gate (see `agents/sweep.md § Human-confirmation gate`).

## Execute phase (`mode: execute` only)

Runs only when the orchestrator re-dispatches with `mode: execute` + `approvedIds` (the ids the human approved in chat). Mutate **only** those ids:

- **Opportunities** → call `connect_update_opportunity` with `{ organization_slug, opportunity_id, active: false }`.
- **Unaccepted FLW invites** → call `connect_delete_unaccepted_flw_invites({ organization_slug, opportunity_id, user_invite_ids: [...] })`. Pass the integer ids from `connect_list_invites`. Accepted invites in the list are silently skipped server-side; cascade-deletes associated `OpportunityAccess` rows.

Return the per-item result. Programs are never mutated (upstream gap — report-only).

## Failure modes

- **Live-set path doesn't resolve:** abort with "Run `sweep-live-set` first."
- **`connect_list_*` returns 401/403:** session is stale; recommend `/ace:connect-login` then retry.
- **An orphan opportunity is already inactive:** treat as success (no-op).

## Implementation notes for agents

- The Connect `delete_opportunity()` helper exists in `commcare_connect/opportunity/deletion.py` (used by Celery tasks) but no Django view exposes it. Building a connect-delete-opportunity atom (*not yet implemented*) requires an upstream PR — out of scope.
- The Connect `delete_user_invites` HTML view at `/a/<org_slug>/opportunity/<opp_id>/delete_invites/` is `@csrf_exempt` and the atom `connect_delete_unaccepted_flw_invites` calls it directly. Accepted invites are silently skipped server-side, so the caller doesn't need to pre-filter — but doing so saves a server roundtrip.

## Related skills

- `sweep-live-set` produces the live-set this skill diffs against.
