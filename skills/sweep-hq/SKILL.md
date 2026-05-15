---
name: sweep-hq
description: >
  Report orphan CommCare HQ applications in ACE-owned domain. Read-only
  until commcare_list_apps and commcare_delete_app atoms ship.
disable-model-invocation: true
---

# sweep-hq

Find CommCare HQ applications in the ACE-owned domain (`connect-ace-prod`) that no current opp references. Currently a **stub skill**: list and delete atoms for HQ apps don't exist yet in `mcp/connect/backends/commcare.ts`, so this skill prints a placeholder report and a Connect-admin-UI deep link per known HQ app referenced by Drive. Implementation completes once `commcare_list_apps` and `commcare_delete_app` atoms ship in a follow-up PR.

## Inputs

- Live-set file path from `sweep-live-set`.
- `ACE_HQ_DOMAIN` from `.env` (defaults to `connect-ace-prod`).
- `ACE_HQ_BASE_URL` (e.g. `https://www.commcarehq.org`).

## Products

- `ACE/_sweep/<timestamp>/hq-orphans.md` — placeholder report listing every Drive-referenced HQ app id with a deep link to its HQ admin page; flags this skill as stub-mode.

## Process (stub)

1. **Read the live-set** via `drive_read_file`.
2. **Print a "stub mode" banner** in the report:
   > This skill is in stub mode. `commcare_list_apps` and `commcare_delete_app` atoms have not yet shipped. The list below contains HQ app ids referenced by current Drive opps — these are NOT orphans. Once the atoms ship, this skill will diff HQ-listed apps against the live-set to surface true orphans.
3. **For each `liveSet.identifiers.commcareAppIds[]`** print a row with the HQ admin URL: `<ACE_HQ_BASE_URL>/a/<ACE_HQ_DOMAIN>/apps/view/<app_id>/`.
4. **Write** `hq-orphans.md` to the sweep folder.

## Future process (when atoms ship)

1. Call `commcare_list_apps({ domain: ACE_HQ_DOMAIN })` to get every app in the ACE domain.
2. Diff against `liveSet.identifiers.commcareAppIds`.
3. Score via `scoreHqApp(item, ACE_HQ_DOMAIN)`.
4. On approval, call `commcare_delete_app({ domain, app_id })` which Playwright-POSTs to HQ's `/a/<domain>/apps/delete_app/<app_id>/` (soft-delete via `doc_type` mutation; restorable via `undo_delete_app`).

## Failure modes

- **Live-set path doesn't resolve:** abort with "Run `sweep-live-set` first."
- All other failure modes deferred until the atoms ship.

## Implementation notes for agents

- HQ app delete is **POST-only** via `/a/<domain>/apps/delete_app/<app_id>/` (no REST API). The view soft-deletes by mutating `doc_type` to `<original>-Deleted` and creates a `DeleteApplicationRecord` for audit. Implement via Playwright form POST in `mcp/connect/backends/commcare.ts`.
- HQ builds and multimedia have **no delete mechanism** at all — only `is_released` toggle for builds. Document as upstream gap; surface in report as "cannot be deleted from HQ."

## Related skills

- `sweep-live-set` produces the live-set this skill diffs against.
- Future: `commcare_list_apps` and `commcare_delete_app` atoms (separate PR) unlock real sweep.
