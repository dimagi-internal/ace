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

3. **Create the opportunity** via `connect_create_opportunity`. Pass
   high-level values; the MCP handles all the Connect-form wiring (server
   int-FK lookup, HQ-API-key registration, JSON-encoded app values):
   - `organization_slug`: `ai-demo-space`
   - `program_id`: from step 1 (program.md)
   - `name`: from PDD
   - `short_description`: ≤50 chars; mobile-app-facing
   - `description`: full PDD intervention description
   - `currency` / `country`: ISO codes from the program (carry forward)
   - `hq_server`: `prod` (or `india` / `eu`). The MCP resolves the human
     label to Connect's int FK by parsing live form options.
   - `api_key`: the **raw 40-char HQ API key** for `connect-ace-prod`
     (read from `~/.claude/plugins/data/ace-ace/.env` → `ACE_HQ_API_KEY`).
     The MCP registers it with Connect via `/opportunity/add_api_key/`
     idempotently (no-op on second call) and uses the resulting Connect
     int FK on the form. Do NOT pass an int FK directly.
   - `learn_app_domain`: HQ project space for the Learn app
   - `learn_app`: bare 32-char HQ app id. The MCP fetches Connect's
     `/hq/applications/` HTMX fragment and wraps your id in the
     JSON-encoded `{id, name}` form-value Connect requires.
   - `learn_app_description`: **required** (Connect form marks it `*`).
     Pulled from PDD § Training Plan.
   - `learn_app_passing_score`: 0–100 (from PDD § Quality Floor; default 80)
   - `deliver_app_domain` / `deliver_app`: same shape, for the Deliver app

   Capture the returned `opportunity_id` (UUID).

   **Pre-flight (post-0.9.10):** the MCP catches three former silent-500
   failure modes — wrong-shape `hq_server`, raw vs FK `api_key`, and bare
   vs JSON-wrapped `learn_app`/`deliver_app` — by parsing Connect's live
   form HTML at call time. If your error message says "did not match any
   Connect-known server" or "app id '...' not found in Connect's options",
   the input doesn't match what Connect serves; verify the deploy summary.

   **App-wire fields are write-once at create (added 2026-04-30).** Connect's
   `/edit` form does NOT expose `learn_app` / `deliver_app` / `hq_server` /
   `api_key` / `learn_app_passing_score` — only the `/init/` create form
   does. Once the opp is created, those fields cannot be changed via the
   UI's normal edit path; `connect_update_opportunity` accordingly only
   covers `name` / `short_description` / `description` / `end_date` /
   `is_test`. **If Phase 2 re-uploads an app after this skill ran, the
   existing opp is wired to a stale (now-abandoned) HQ id** — the only
   recovery is delete-and-recreate. Surfaced 2026-04-30 (turmeric-
   20260429-2330): the operator caught the symptom downstream when the
   AVD test user got "Failed to start learning" and a sibling opp showed
   different HQ ids in the detail page. **Diagnostic gotcha:**
   `connect_get_opportunity` parses the edit form for its return shape,
   which means `learn_app` / `deliver_app` come back as empty strings even
   when the opp IS correctly wired. Fixed in 0.10.41 by also reading the
   detail page (which renders `/apps/view/<id>/` links). Pre-0.10.41,
   never trust empty `learn_app` / `deliver_app` from `get_opportunity`
   as evidence of broken wiring — verify against the detail page.

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

8. **Pre-invite the ACE test user (REQUIRED for PersonalID registration).**

   This step is structurally load-bearing for ACE's emulator-driven mobile
   testing — not just a convenience. There are **two reasons** ACE must
   invite `${ACE_E2E_PHONE}` to every Connect opportunity it creates:

   **(a) Claim flow:** Phase 5 `app-screenshot-capture` drives Connect mobile
   through the claim-opp flow as this user; without the invite, the opp
   won't appear in the test user's opportunity list and the screenshot
   recipe stalls.

   **(b) PersonalID registration gate (the critical reason):** Connect-id's
   `/users/start_configuration` endpoint runs an `@app_integrity` decorator
   that synchronously calls `check_number_for_existing_invites(phone)` over
   HTTP to connect.dimagi.com. **For phone numbers with NO existing invite
   anywhere in Connect, this lookup hangs long enough to trip gunicorn's
   worker timeout, which kills the worker via `sys.exit(1)`.** The client
   receives an empty/malformed response and force-stops (CommCare NPE on
   `getSessionFailureSubcode()`). See Sentry `CONNECT-ID-3F` and the paired
   filed bug in CommCare-Android. So `${ACE_E2E_PHONE}` must have an active
   invite somewhere in Connect *before* `/ace:mobile-bootstrap` attempts
   to register it for the first time.

   This means: the **first** ACE opp ever created bootstraps the test user's
   pre-invite. Subsequent opps keep it warm. If the test user has never
   been invited to anything, registration will crash the CommCare app —
   not because of an integrity / OTP / SMS issue, but because of this
   server-side timeout cascade.

   - Tool: `connect_send_flw_invite` (NOT `connect_send_llo_invite` —
     that one invites LLO orgs to programs, which is a different flow.
     The FLW invite atom POSTs to
     `/a/<org>/opportunity/<uuid>/user_invite/`.)
   - Args:
     ```
     {
       organization_slug: <slug from step 1>,
       opportunity_id: <UUID from step 3>,
       phone_numbers: [process.env.ACE_E2E_PHONE]
     }
     ```
   - The atom returns `{ status: 'queued' }` because the server invokes
     `add_connect_users.delay(...)` async. The actual `UserInvite` row +
     SMS go out within a few seconds. Treat `queued` as success.
   - Persist to `ACE/<opp-name>/connect-state.yaml`:
     ```yaml
     ace_test_user_invited_phone: ${ACE_E2E_PHONE}
     ace_test_user_invited_at: <ISO timestamp>
     ```
   - If `ACE/<opp-name>/connect-state.yaml` doesn't exist yet, create it.
     If it does, merge — don't overwrite other fields.

   **Constraint:** the opportunity must be `is_setup_complete` before
   the FLW invite atom can succeed. Step 8 has two sub-steps:

   **8a. Finalize the opportunity.** Call
   `connect_finalize_opportunity` to set `start_date`, `end_date`, and
   `max_users`. The form auto-computes
   `total_budget = max_users × Σ(payment_unit.amount × max_total)` and
   persists it. After this fires the opportunity has all the fields
   `is_setup_complete` needs:
   - `total_budget` ✓ (computed by finalize)
   - `start_date` ✓ (passed to finalize)
   - `end_date` ✓ (passed to finalize)
   - PaymentUnit with `max_total` ✓ (Step 6)
   - PaymentUnit with `max_daily` — **pass this explicitly to
     `connect_create_payment_unit` in Step 6** or the invite still
     trips `is_setup_complete`.

   ```
   connect_finalize_opportunity({
     organization_slug: <slug>,
     opportunity_id: <UUID>,
     start_date: <today, YYYY-MM-DD>,
     end_date: <PDD end_date or +6 months, YYYY-MM-DD>,
     max_users: <PDD's expected FLW count, default 5>,
   })
   ```

   **8b. Invite the test user.** Then call `connect_send_flw_invite`
   with `${ACE_E2E_PHONE}` as documented above.

   Don't move Step 8 earlier in the skill — finalize requires
   PaymentUnits to exist (it reads them to compute total_budget).

   **First-time setup:** if no opp has ever been created for this
   workstation's `${ACE_E2E_PHONE}`, the very first
   `connect-opp-setup` run bootstraps the test-user invite. Subsequent
   opps keep it warm. Pre-existing manual invites in `connect-ace-prod`
   are no longer required.

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
  - `connect_finalize_opportunity` (Step 8a — set dates + total_budget)
  - `connect_send_flw_invite` (Step 8b — pre-invite the ACE test user)

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
| 2026-04-28 | Add Step 8: invite ACE test user (`${ACE_E2E_PHONE}`) and persist invite URL to `connect-state.yaml`; required for Phase 5 `app-screenshot-capture` to drive the claim-opp flow | ACE team (mobile-emulation) |
| 2026-04-29 | Fix three silent-500 schema bugs in `connect_create_opportunity`: `hq_server` now accepts the human label "prod"/"india"/"eu" (resolves to int FK by parsing live form), `api_key` now takes the raw 40-char HQ key (registered with Connect transparently via `/opportunity/add_api_key/`), and `learn_app`/`deliver_app` now take bare HQ app ids (wrapped in the JSON form-value Connect requires by querying `/hq/applications/`). Also: `learn_app_description` is now required in the schema to match Connect's form. (0.10.1) | ACE team |
| 2026-04-29 | Step 8 docs: clarify the test-user pre-invite is structurally required for PersonalID registration, not just the claim flow. Connect-id's `/users/start_configuration` synchronously calls `check_number_for_existing_invites` and the worker dies (SystemExit) when that lookup hangs for un-invited numbers — see Sentry `CONNECT-ID-3F` and paired CommCare NPE bug. ACE must keep `${ACE_E2E_PHONE}` invited to at least one Connect opp at all times. | ACE team (mobile-emulation) |
| 2026-04-29 | Step 8 now uses `connect_send_flw_invite` (new atom in 0.10.34) instead of `connect_send_llo_invite`. The previous text incorrectly pointed at the LLO atom (which invites partner orgs to programs); FLW phone invites are an opportunity-level form at `/a/<org>/opportunity/<uuid>/user_invite/` and need their own atom. Step 8 is now executable end-to-end with no manual Connect-UI fallback. | ACE team (mobile-emulation) |
