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

Find Connect artifacts (programs, opportunities, payment units, FLW invites) that no current opp references, score them, and present them for triage. Connect's upstream API is uneven: opportunity deactivate is available, unaccepted FLW invite delete is available, but programs and payment units have no upstream delete path. This skill auto-executes what it can; programs and PUs surface in a "upstream-gap — delete via Connect admin UI" section.

## Inputs

- Live-set file path from `sweep-live-set` skill output.
- `ACE_CONNECT_BASE_URL` from `.env` (e.g. `https://connect.dimagi.com`).

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
7. **Surface to human** in chat: print the report, prompt for approval per actionable chunk.
8. **On approval:**
   - **Opportunities** → call `connect_update_opportunity` with `{ organization_slug, opportunity_id, active: false }`. NB: the existing `updateOpportunity` interface in `mcp/connect/client.ts` does NOT yet expose `active`; the Playwright backend's `postEditForm` does. Until the public interface is extended (one-line change in a follow-up PR), this step prints the call signature and asks the human to confirm.
   - **Unaccepted FLW invites** → call `connect_delete_unaccepted_flw_invites({ organization_slug, opportunity_id, user_invite_ids: [...] })`. Pass the integer ids from `connect_list_invites`. Accepted invites in the list are silently skipped server-side; cascade-deletes associated `OpportunityAccess` rows.

## Failure modes

- **Live-set path doesn't resolve:** abort with "Run `sweep-live-set` first."
- **`connect_list_*` returns 401/403:** session is stale; recommend `/ace:connect-login` then retry.
- **An orphan opportunity is already inactive:** treat as success (no-op).

## Implementation notes for agents

- The Connect `delete_opportunity()` helper exists in `commcare_connect/opportunity/deletion.py` (used by Celery tasks) but no Django view exposes it. Building a connect-delete-opportunity atom (*not yet implemented*) requires an upstream PR — out of scope.
- The Connect `delete_user_invites` HTML view at `/a/<org_slug>/opportunity/<opp_id>/delete_invites/` is `@csrf_exempt` and the atom `connect_delete_unaccepted_flw_invites` calls it directly. Accepted invites are silently skipped server-side, so the caller doesn't need to pre-filter — but doing so saves a server roundtrip.

## Related skills

- `sweep-live-set` produces the live-set this skill diffs against.
