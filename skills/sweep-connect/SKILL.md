---
name: sweep-connect
description: >
  Diff Connect programs/opportunities/payment-units/invites against the
  live-set, score orphans, surface a triage report. Soft-deactivate
  orphan opportunities; report-only for the rest until atoms exist.
disable-model-invocation: true
---

# sweep-connect

Find Connect artifacts (programs, opportunities, payment units, FLW invites) that no current opp references, score them, and present them for triage. Connect's upstream API is uneven: only opportunity deactivate is straightforwardly available; deletion of opportunities/programs/PUs isn't exposed (no Django view exists for opportunity-delete despite an internal `delete_opportunity()` helper). This skill surfaces orphans and auto-deactivates opportunities; programs/PUs/invites surface in a "upstream-blocked — delete via Connect admin UI" section of the report.

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
   - `connect_list_payment_units` (per opportunity)
   - `connect_list_invites` (per program)
3. **Diff** each item's id against the corresponding live-set bucket:
   - programs → `liveSet.identifiers.connectProgramIds`
   - opportunities → `liveSet.identifiers.connectOpportunityIds`
   - payment units → `liveSet.identifiers.connectPaymentUnitIds`
   - (invites have no live-set bucket; treat all invites tied to orphan opportunities as orphan-candidates)
4. **Score** each orphan via `scoreConnectItem(item, liveSet)` from `lib/sweep-fingerprint.ts`.
5. **Build the `OrphanReport`** with `system: 'connect'`. Partition the report into two sections:
   - **Actionable:** opportunities (can be soft-deactivated via existing atom).
   - **Upstream-blocked:** programs, payment units, FLW invites — print Connect admin URLs (`<base_url>/a/<org_slug>/program/<id>/`, etc.) for manual deletion.
6. **Render** via `renderOrphanReport()` from `lib/sweep-report.ts`. Write `connect-orphans.md` and `connect-orphans.yaml` to the sweep folder.
7. **Surface to human** in chat: print the report, prompt for approval per actionable chunk.
8. **On approval:** for each approved orphan opportunity, call `connect_update_opportunity` with `{ organization_slug, opportunity_id, active: false }`. NB: the existing `updateOpportunity` interface in `mcp/connect/client.ts` does NOT yet expose `active`; the Playwright backend's `postEditForm` does. Extending the public interface is a one-line change blocked on a follow-up PR — until then, this step prints the `update_opportunity` call you'd make and asks the human to confirm.

## Failure modes

- **Live-set path doesn't resolve:** abort with "Run `sweep-live-set` first."
- **`connect_list_*` returns 401/403:** session is stale; recommend `/ace:connect-login` then retry.
- **An orphan opportunity is already inactive:** treat as success (no-op).

## Implementation notes for agents

- The Connect `delete_opportunity()` helper exists in `commcare_connect/opportunity/deletion.py` (used by Celery tasks) but no Django view exposes it. Building `connect_delete_opportunity` requires an upstream PR — out of scope for this skill.
- The Connect `delete_user_invites` HTML view DOES exist (`/a/<org_slug>/opportunity/<opp_id>/delete_invites/` POST with `user_invite_ids[]`). Future PR: add a `connect_delete_unaccepted_flw_invites` atom to handle invite cleanup; this skill currently falls back to admin-UI link for invites.

## Related skills

- `sweep-live-set` produces the live-set this skill diffs against.
- Future: a `connect_delete_unaccepted_flw_invites` atom (in a follow-up PR) lets this skill auto-delete orphan invites instead of linking to the admin UI.
