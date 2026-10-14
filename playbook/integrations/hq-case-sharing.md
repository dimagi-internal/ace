# Location-based case sharing — Nova + CommCare HQ

How ACE builds an app where records are shared by **place** (an M&E officer sees the
participants several FLWs enrolled; FLWs in one area do not see another's) and what
each half of the work needs. Origin: Sophie Feintuch's "Case Sharing" request,
2026-10-13; ACE first answered "I have no tool for this", which was wrong about
the app side — Nova ships a full place model (`begin_work` → `add_organization_levels`,
`create_location`, `add_personas`, `start_app_test`).

Evidence tiers used below: **OBSERVED** = ran it this session; **SOURCE** = read in
HQ / Nova source (file named); **ASSUMED** = not seen working.

## The chain

| # | Step | Who does it | Status |
|---|------|-------------|--------|
| 1 | Author levels (`area` → `flw_place`), places, roles, personas, forms in Nova | `mcp__nova__*` (skill `app-case-sharing`) | OBSERVED 2026-10-14 (scratch app, deleted) |
| 2 | Prove the three sharing checks in Nova's disposable multi-session test | `start_app_test` / `continue_app_test` | OBSERVED (below) |
| 3 | Create the same **levels** on the HQ project space, with the sharing flags | `commcare_set_location_types` (new) | SOURCE only — not yet run on a live space |
| 4 | Push the app; Nova pushes the **places** with it | `upload_app_to_hq` | SOURCE (`lib/commcare/hq/locations.ts`, `v0_6.py::LocationResource.patch_list`) |
| 5 | Create mobile workers already assigned to places | `provision_workers` (personas carry `locationUuids`) | SOURCE (`lib/commcare/hq/workers.ts`) |
| 6 | Assign workers Nova did **not** create (e.g. Connect-provisioned FLWs) | `commcare_assign_user_locations` (new) | SOURCE (`api/user_updates.py::_update_location`); Connect-created workers ASSUMED to accept it |
| 7 | Verify | `commcare_list_location_types`, `commcare_list_locations`, `commcare_list_users` | read-backs |

## What Nova's app carries — and what it does not (OBSERVED)

Compiling the scratch app (`compile_app json`) produced **no** location types, places,
or sharing config. The only trace is in the form XML: the enrolment form's
`owner_id` is calculated from
`instance('commcaresession')/session/user/data/commcare_primary_case_sharing_id`.
That value comes from the **worker's HQ user record**, which HQ fills from the
worker's assigned place — and only if that place's level has *Owns cases* on.
So the app is correct on its own and delivers nothing until steps 3-5 have
happened on HQ. An unassigned worker's `owner_id` is empty.

## Authoring rules (Nova guide `peopleAndPlaces`, `workflows` — OBSERVED where noted)

- A **registration** form's record is owned by the individual worker (guide:
  "the child defaults to the current worker as owner"). To own it by place, the
  enrolment form is a **survey** form with a `create` case operation whose
  `owner` is `external-user('commcare_primary_case_sharing_id')` (OBSERVED: the
  resulting `owner_id` was the FLW's place id).
- Level `caseFlow` decides sharing: `ownsCases` (places of this level own records),
  `workers: assigned`, `descendantCases: none | all | down-to <level>` (how far below
  its own place a worker's records reach). `addressBook` is independent and does
  **not** deliver records.
- A worker's own place needs `ownsCases: true` to be a record owner; the officer's
  level needs `descendantCases: all` and, in the test, `ownsCases: false`.
- Case flow and address-book settings are complete replacements — read before editing.
- Places need a **saved app** (`create_location` fails before the first save), so
  author a minimal valid module/form, `save_work`, then add places.

## Sophie's three checks — OBSERVED in Nova Preview (4 sessions, 3 places)

Hierarchy: `Area` (owns no records, reach all below) → `FLW place` (owns records,
reach none). Area 1 has FLW 1A, FLW 1B places; Area 2 has FLW 2A. Officer assigned
to Area 1.

1. **Officer sees both Area 1 FLWs' participants** — PASS: officer list showed Pat A
   and Pat B.
2. **Area 1 FLWs see each other's** — NO: FLW 1A saw only Pat A (`outsideRestoreCount: 1`).
   *Prevented* by one place per FLW; to *share*, assign both FLWs the same place.
3. **Area 2 FLW sees nothing from Area 1** — PASS: empty list, `outsideRestoreCount: 2`.
4. **Officer's update reaches the FLW** — PASS after sync: the officer's M&E check set
   `business_verified=yes` on Pat A and FLW 1A's synced copy carried it.

Boundary Nova states and ACE repeats: this is Preview/Postgres, not a device or an
HQ restore. Items 1-4 describe Nova's model of ownership; HQ's restore is the
authority and has not been observed.

## HQ facts that cost time (SOURCE: commcare-hq `corehq/apps/locations`, `api`)

- **Levels have no write API** (`v0_5.py::LocationTypeResource` is GET-only). The only
  writer is the Organization Levels page POST (`views.py::LocationTypesView.post`),
  form field `json` = `{"loc_types": [...]}`.
- **That POST is a full replace.** `remove_old_location_types` deletes every level whose
  pk is not in the payload (blocked only when the level already has places).
  `commcare_set_location_types` therefore reads the page's current levels first and
  round-trips all of them; `lib/hq-location-types.ts` + its test pin this.
- **Four gates** on the location APIs: the space's `LOCATIONS` privilege, its
  `API_ACCESS` privilege, and the key owner's Edit Locations + Access APIs
  permissions; two of the four give the same bodyless 403 (Nova's own docs say so).
- **Places** are writable via `v0.6` `PATCH` (atomic, 100 per call); a level must
  exist first or the place is refused.
- **User assignment**: `PUT /api/v0.5/user/<id>/` with `primary_location` and
  `locations` together (`locations` must contain the primary). Omitting both is a
  no-op, so `commcare_update_user_field` does not disturb assignments; an empty pair
  removes all of them (`user_updates.py::_update_location`).
- Web users take `primary_location_id` + `assigned_location_ids` on the web-user
  resource (`v0_5.py::WebUserResource`) — **no ACE atom yet**; needed only if the
  M&E officer is an HQ web user rather than a mobile worker.

## Open — needs a person or a live space

- Whether `commcare_set_location_types` round-trips cleanly on a real space (first
  run: use `dry_run`, then a scratch space, then read back).
- Whether HQ's `shares_cases` / `view_descendants` produce the same reach Nova's
  Preview shows for `ownsCases` / `descendantCases`.
- Whether a Connect-provisioned worker accepts a location assignment and whether
  Connect leaves `owner_id` alone.
- The M&E officer's account type (Connect worker vs HQ web user).
- A project space with the `LOCATIONS` privilege that ACE's key can use. ACE has not
  checked which of its spaces have it.
