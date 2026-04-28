---
name: connect-opp-setup
description: >
  Create and configure an Opportunity in Connect — including the opp shell,
  verification flags, payment units, and (for now) read-only delivery units
  derived from the CommCare app.
---

# Connect Opportunity Setup

Create and fully configure a Connect opportunity in `ai-demo-space` (or
whichever PM-side org the opportunity targets).

## Process

1. **Read inputs from GDrive:**
   - PDD: `ACE/<opp-name>/pdd.md`
   - Program details: `ACE/<opp-name>/connect-setup/program.md`
   - App deployment details: `ACE/<opp-name>/deployment-summary.md`
     (provides `hq_server`, `learn_app`, `deliver_app` IDs and the HQ
     project space)

2. **Read the PDD's `archetype:` and `## Evidence Model` section.**
   These are the inputs for steps 4–6 below. The Evidence Model's Layer A
   column is the spec for verification flags; Layer B/C inform soft-flag
   metadata. **If the PDD has no Evidence Model section, stop and return
   an error** — the PDD is incomplete and `idea-to-pdd` should re-run
   with the stress-test rubric.

3. **Create the opportunity** via `connect_create_opportunity`:
   - `organization_slug`: `ai-demo-space`
   - `program_id`: from step 1 (program.md)
   - `name`: from PDD
   - `short_description`: ≤50 chars; mobile-app-facing
   - `description`: full PDD intervention description
   - `currency` / `country`: ISO codes from the program (carry forward)
   - `hq_server`: CommCare HQ server identifier from
     `deployment-summary.md` (typically `prod` or the configured server FK)
   - `api_key`: ACE's HQ API key for `connect-ace-prod` (from
     `ACE_HQ_API_KEY` env or the deployment summary)
   - `learn_app_domain`: HQ project space for the Learn app
   - `learn_app`: Learn app id on HQ
   - `learn_app_description` (optional): from PDD § Training Plan
   - `learn_app_passing_score`: 0–100 (from PDD § Quality Floor; default 80)
   - `deliver_app_domain` / `deliver_app`: same shape, for the Deliver app

   Capture the returned `opportunity_id` (UUID).

4. **List deliver units** via `connect_list_deliver_units` — these come
   from the Deliver app's form schema and are NOT directly creatable in
   Connect. The list is the input space for verification flags + payment
   units in steps 5–6.

5. **Configure verification flags** via `connect_set_verification_flags`,
   mapping the PDD's Evidence Model Layer A to Connect toggles:
   - `gps`: true if Layer A requires GPS fence — **almost always true**
     for atomic-visit, **optional** for focus-group (venue GPS is less
     meaningful)
   - `duplicate`: true (always — duplicate-form-submission flagging is
     defensive default)
   - `catchment_areas`: true if the PDD names per-FLW catchment areas
   - `location`: boolean toggle — enables location-distance verification.
     Note: the threshold (default 10m) is NOT settable via the MCP today;
     `connect_set_verification_flags` preserves whatever value is already
     on the form. If a tighter threshold is required, log it as a manual
     follow-up in `comms-log/observations.md` and leave the toggle on.
   - `form_submission_start` / `form_submission_end`: HH:MM:SS — set
     only if the PDD has time-of-day plausibility constraints
   - `deliver_unit_checks`: per-deliver-unit attachment requirements
     (e.g. for a "household visit" deliver unit, set `check_attachments=true`
     so submissions without photos get flagged). Match each
     `deliver_unit_id` from step 4 against the PDD's per-unit Layer A
     requirements.

6. **Configure payment units** via `connect_create_payment_unit` for each
   unit in the PDD's payment plan:
   - `name`: descriptive (e.g. `"Per verified visit"`)
   - `description`: payment criteria
   - `amount`: per-unit payment from PDD
   - `max_total` / `max_daily`: caps from PDD if present
   - `start_date` / `end_date`: typically the opportunity dates
   - `required_deliver_unit_ids`: which deliver units (from step 4) MUST
     be completed for this payment to trigger
   - `optional_deliver_unit_ids`: which deliver units are bonus/optional

7. **Write config summary** to `ACE/<opp-name>/connect-setup/opportunity.md`:
   - Opportunity ID (UUID) and URL
     (`<CONNECT_BASE_URL>/a/<org>/opportunity/<uuid>/`)
   - All configuration details
   - Verification flags (final values, including which were inherited
     from defaults vs. set explicitly)
   - Deliver units (from step 4) and Payment units (from step 6)

## Archetypes

The PDD's `archetype:` field shapes verification + payment unit setup:

### `atomic-visit`
- **Verification:** `gps=true`, `duplicate=true`, `catchment_areas=true`
  if PDD specifies per-FLW areas. `deliver_unit_checks` should set
  `check_attachments=true` on deliver units that require photos
  (Layer A "Photo present").
- **Payment:** typically one main payment unit per verified visit,
  optional bonus tier when Layer B passes (e.g. AI photo-quality check).
- **Soft flags** (Layer B/C from PDD): logged in
  `opportunity.md` but no Connect toggle; surfaced via
  `flw-data-review` skill in Phase 5.

### `focus-group`
- **Verification:** `gps=false` typically (venue GPS less meaningful).
  `duplicate=true`. `deliver_unit_checks` set `check_attachments=true`
  on the session-recording deliver unit (audio file required).
- **Payment:** one payment unit per **completed group session** — set
  `max_total` to the PDD's planned session count. Do NOT model per-
  participant payment; the unit is the session.

### `multi-stage`
- Configure verification + payment for **Stage 1 only**. Subsequent
  stages get their own opportunities (or their own payment-unit calls
  on the same opportunity, depending on the PDD's stage-overlap pattern).

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Connect (`ace-connect` MCP, 0.8.1+):
  - `connect_create_opportunity`
  - `connect_list_deliver_units`
  - `connect_set_verification_flags`
  - `connect_create_payment_unit`
  - `connect_get_opportunity` (verify after create)

## Mode Behavior
- **Auto:** Create + configure end-to-end, proceed
- **Review:** Present configuration spec for approval before calling
  `connect_create_opportunity` (the highest-stakes step — opp creation
  is harder to roll back than verification-flag adjustments)

## Dry-Run Behavior
When `--dry-run` is active:
- Write the full opportunity configuration spec (all fields that would
  be POSTed, plus the per-deliver-unit verification + payment-unit
  matrix) to `comms-log/dry-run-connect-opp-setup.md`
- Do not call any `connect_*` mutation atom
- State tracks as `dry-run-success`

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
| 2026-04-08 | Add `## Archetypes` section: focus-group delivery unit = session (not participant), audio + attendance + per-domain summary verification, requires "Experiment" delivery type | ACE team (PM scout, focus-group framework lens) |
| 2026-04-08 | Add explicit step 2 to read PDD `## Evidence Model`; Layer A → verification rules, Layer B/C → soft flags; error if Evidence Model missing | ACE team (PM scout, focus-group framework lens) |
| 2026-04-28 | Replace HITL workaround with `connect_*_opportunity` + `connect_set_verification_flags` + `connect_create_payment_unit` atoms (ace-connect 0.8.1). Verification mapped to Connect's actual toggles (`gps`, `duplicate`, `catchment_areas`, `location`); deliver units now read-only via `connect_list_deliver_units` (sourced from CommCare app schema) | ACE team |
| 2026-04-28 | Fix `location` field description — it's a boolean toggle, not a meters threshold; threshold is currently un-settable via the MCP (0.9.4) | ACE team |
