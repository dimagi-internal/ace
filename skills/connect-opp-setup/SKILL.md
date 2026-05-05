---
name: connect-opp-setup
description: >
  Create and configure an Opportunity in Connect — including the opp shell
  (managed under a program), verification flags, payment units, and the
  pre-invite that makes ACE's emulator-driven mobile testing work.
---

# Connect Opportunity Setup

Create and fully configure a Connect managed opportunity in `ai-demo-space`
(or whichever PM-side org owns the parent program).

## Process

1. **Read inputs from GDrive:**
   - PDD: `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md`
   - Program details: `ACE/<opp-name>/runs/<run-id>/3-connect/connect-program-setup.md`
     (program UUID; the opp is created scoped to it)
   - Awarded LLO: `opp.yaml.selected_llo.org_slug` (populated by Phase 6
     `solicitation-review` — must be the slug of an org that already has an
     ACCEPTED `ProgramApplication` for the program. See § Pre-flight.)
   - App deployment details: `ACE/<opp-name>/runs/<run-id>/2-commcare/app-deploy_summary.md`
     (`hq_server`, `learn_app` ID, `deliver_app` ID, HQ project space slug)

2. **Read the PDD's `archetype:` and `## Evidence Model` section.**
   These are the inputs for steps 4–5. The Evidence Model's Layer A column
   is the spec for verification flags; Layer B/C inform soft-flag metadata.
   **If the PDD has no Evidence Model section, stop and return an error** —
   the PDD is incomplete and `idea-to-pdd` should re-run with the
   stress-test rubric.

3. **Pre-flight (LLO program-application must be ACCEPTED).** The new
   `POST /api/programs/<id>/opportunities/` endpoint validates that the
   target LLO org has an `ACCEPTED` `ProgramApplication` for the program.
   For ACE-driven dogfood runs, the orchestrator handles this in Phase 7
   (`llo-onboarding` → optionally `connect_accept_program_application`)
   *before* this skill runs. For real-LLO runs, the LLO accepts manually
   and this skill simply waits. If the application is still INVITED/APPLIED
   when this skill calls `create_opportunity`, the API rejects with
   `Organization must have an accepted application for this program.`

4. **Create the opportunity** via `connect_create_opportunity`. The new
   endpoint is `POST /api/programs/<program_id>/opportunities/` and takes
   the full opp config in one shot — including dates, total_budget, and
   structured `learn_app` / `deliver_app` payloads. The server resolves
   HQ creds, registers HQApiKey records as needed, fetches app names from
   CommCareHQ synchronously, and syncs learn modules + deliver units in
   the same transaction. Args:

   - `organization_slug`: PM-side org (e.g. `ai-demo-space`)
   - `program_id`: from step 1 (program.md)
   - `name`: from PDD
   - `short_description`: **≤50 chars** (server-enforced; the Connect
     opportunity edit form rejects longer values with a generic
     `Ensure this field has no more than 50 characters` error).
     Truncate the PDD's intervention summary to a one-line headline
     and stash the long-form intent in `description`. Mobile-app-facing.
   - `description`: full PDD intervention description
   - `target_organization_slug`: LLO org slug (must be ACCEPTED — see step 3)
   - `start_date` / `end_date`: opportunity dates (YYYY-MM-DD; must fit
     inside the program window)
   - `total_budget`: must fit inside `program.budget − Σ(other managed opps)`
   - `is_test`: defaults `true` server-side; set `false` only when this is a
     production-grade opportunity
   - `learn_app`: `{ hq_server_url, api_key, cc_domain, cc_app_id, description, passing_score }`
     - `hq_server_url`: full URL (e.g. `https://www.commcarehq.org`)
     - `api_key`: the **raw 40-char HQ API key** for the project space
       (read from `~/.claude/plugins/data/ace-ace/.env` → `ACE_HQ_API_KEY`).
       Server creates the `HQApiKey` record if it doesn't exist.
     - `cc_domain`: HQ project space slug
     - `cc_app_id`: bare 32-char HQ app id
     - `description`: required (Connect form marks it `*`); pulled from PDD
       § Training Plan
     - `passing_score`: 0–100 (from PDD § Quality Floor; default 80)
   - `deliver_app`: `{ hq_server_url, api_key, cc_domain, cc_app_id }`
     — `cc_app_id` MUST differ from `learn_app.cc_app_id` (server-validated)

   The response includes `opportunity_id` (UUID), the resolved app names,
   and arrays of `learn_modules` / `deliver_units` already synced from HQ.
   Capture `opportunity_id` for downstream steps. **Don't** call
   `connect_list_deliver_units` after this — the create response already
   carries the full list under `deliver_app.deliver_units`.

   **App-wire fields are write-once at create.** Connect's `/edit` form
   does NOT expose `learn_app` / `deliver_app` — they're only set at create.
   `connect_update_opportunity` only covers `name` / `short_description` /
   `description` / `end_date` / `is_test`. **If Phase 2 re-uploads an app
   after this skill ran, the existing opp is wired to a stale (now-abandoned)
   HQ id** — the only recovery is delete-and-recreate.

   **Verify-after-create (mandatory).** Immediately after the create
   response returns, call `connect_get_opportunity({organization_slug,
   opportunity_id})` and compare every field that was sent against what
   the server stored. Specifically check:
   - `name`, `short_description`, `description` — string match
   - `start_date`, `end_date` — `YYYY-MM-DD` match (the `turmeric-20260503`
     run hit a write-vs-read drift where `end_date=2026-08-09` was
     accepted by create but `connect_get_opportunity` returned `""`;
     this read-back is the canary)
   - `total_budget` — numeric match
   - `is_test` — boolean match
   - `learn_app.cc_app_id` and `deliver_app.cc_app_id` — bare 32-char
     match
   - `passing_score` — numeric match (write-vs-read drift here is a
     known class — PDD `70%` may show as opp `80%` if the server
     overrode; surface as `[INFO]` not `[BLOCKER]` because Connect's
     server has its own default; document the diff in
     `connect-state.yaml`)

   **Action on mismatch:**
   - Date or app-id field disagreement → `[BLOCKER]` in the gate brief;
     log the diff to `comms-log/observations.md` with both values; do
     NOT proceed to Step 5. The opp is in an unknown state — operator
     must inspect via the Connect web UI before continuing.
   - Description / passing_score / is_test disagreement → `[INFO]` log
     to observations; proceed.

   This step costs one extra HTML-driven `connect_get_opportunity` call
   (~2s) and catches a class of bugs the producing skill's response
   alone cannot — server-side serialization gaps, schema drift, or
   silent overrides. The 0.11.7 ocs-chatbot-qa rework adopted the same
   "verify after every external write" discipline; this is the Connect
   side of that rule (see `agents/ace-orchestrator.md § External
   Mutations — Verify After Create`).

5. **Configure verification flags** via `connect_set_verification_flags`,
   mapping the PDD's Evidence Model Layer A to Connect toggles. *(This atom
   still goes through the legacy HTML form — the verification config page
   isn't part of PR #1135's automation API.)*
   - `gps`: true if Layer A requires GPS fence — **almost always true**
     for atomic-visit, **optional** for focus-group (venue GPS is less
     meaningful)
   - `duplicate`: true (always — duplicate-form-submission flagging is
     defensive default)
   - `catchment_areas`: true if the PDD names per-FLW catchment areas
   - `location`: boolean toggle — enables location-distance verification.
     Threshold (default 10m) is NOT settable via the MCP today; the atom
     preserves whatever value is on the form. Log a follow-up in
     `comms-log/observations.md` if a tighter threshold is required.
   - `form_submission_start` / `form_submission_end`: HH:MM:SS — set
     only if the PDD has time-of-day plausibility constraints
   - `deliver_unit_checks`: per-deliver-unit attachment requirements
     (e.g. for a "household visit" deliver unit, set `check_attachments=true`
     so submissions without photos get flagged). Match each
     `deliver_unit_id` (from step 4's create response) against the PDD's
     per-unit Layer A requirements.

6. **Configure payment units** via `connect_create_payment_units` (plural,
   atomic batch — the new automation API takes a list). Build one entry
   per unit in the PDD's payment plan; the entire request is rejected if
   any unit is invalid. Per-unit fields:
   - `name`: descriptive (e.g. `"Per verified visit"`)
   - `description`: payment criteria
   - `amount`: per-unit FLW pay from PDD. **MUST be a non-negative
     integer** in the opp currency's smallest unit — Connect's serializer
     rejects floats. If the PDD specifies a fractional rate (e.g.
     `$1.50`), pick a representation explicitly:
     - **Option A (recommended):** round to the nearest integer
       (`$1.50` → `2`) and log an `[INFO]` to
       `comms-log/observations.md` noting the rounding.
     - **Option B:** convert to a smaller unit (cents: `$1.50` → `150`)
       — only do this if the rest of the opp's currency convention
       agrees, otherwise the FLW dashboard renders the wrong number.
     - Never silently truncate (`$1.50` → `1`) — that's where the
       prior `turmeric-20260503` run produced a malformed PU.
   - `org_amount`: per-unit LLO pay — **REQUIRED for managed opps**.
     Same integer constraint as `amount`. (Note: commcare-connect commit
     `4c430de3` loosened this validation on 2026-04-29 to accept `0` —
     before that fix, falsy values were rejected with
     `org_amount is required for managed opportunities.`)
   - `max_total`: total visits per user across the opportunity (≥1)
   - `max_daily`: visits per user per day (≥1)
   - `start_date` / `end_date`: optional; default to opportunity dates
   - `required_deliver_units`: which DU ids (from step 4) MUST be completed
     for this payment to trigger. **At least one required DU is necessary**
     for the opp to pass `is_setup_complete`; an empty `required_deliver_units`
     blocks Phase 6 `connect_send_flw_invite` and Phase 5 mobile screenshot
     capture (the FLW can't claim the opp).
   - `optional_deliver_units`: which DUs are bonus/optional. **No DU id
     may appear in `required` and `optional` of the same unit, AND no DU
     may appear in two payment units in the same request** — the server
     rejects the whole batch.

   Use `connect_create_payment_unit` (singular) only when adding a single
   PU after the fact; under the hood it sends a 1-item list to the same
   endpoint and shares the same validation rules.

   **Verify-after-create (mandatory).** Immediately after the create
   response returns, call `connect_list_payment_units({organization_slug,
   opportunity_id})` and compare each created PU against what was sent.
   Specifically check, per unit:
   - `name`, `amount`, `org_amount`, `max_total`, `max_daily` — exact
     match against the request payload.
   - `required_deliver_units` — array length matches request and
     contains the same DU ids (order may differ).
   - `optional_deliver_units` — same.

   **Action on any mismatch:** halt with a `[BLOCKER]` in the gate
   brief specifying the exact field divergence (sent vs. stored). Log
   the full sent payload AND the full server response to
   `comms-log/observations.md`. Do NOT proceed to Step 7 — a malformed
   PU cascades through `is_setup_complete` and silently breaks every
   downstream skill (Phase 6 invites, Phase 5 screenshots). Operator
   recovery is delete + recreate via the Connect web UI; there is no
   `connect_delete_payment_unit` atom yet.

   This guard is the producer-side complement to the
   `connect-program-setup-eval` rubric. The eval correctly graded a
   malformed PU as `payment_unit_fit: 5.0` (warn) on the
   `turmeric-20260503-0835` run, but by then Phase 3 had already
   handed off to Phase 4 with corrupted state. Catching the
   malformation at the source converts a multi-phase cascade into a
   single-skill halt.

7. **Pre-invite the ACE test user (REQUIRED for PersonalID registration).**

   This step is structurally load-bearing for ACE's emulator-driven mobile
   testing — not just a convenience. Two reasons ACE must invite
   `${ACE_E2E_PHONE}` to every Connect opportunity it creates:

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
   `getSessionFailureSubcode()`). See Sentry `CONNECT-ID-3F`.

   **Constraint:** the new `POST /api/opportunities/<id>/invite_users/`
   endpoint validates that the opp is **active** and not ended. So the
   pre-invite must happen *after* `connect_activate_opportunity`, which is
   handled by `llo-launch` (Phase 7). For ACE-driven dogfood runs that need
   the test user invited *before* an LLO actually exists (the common case),
   either:

   - **(a)** Wait until `llo-launch` activates the opp, then call
     `connect_send_flw_invite` here. This is the natural sequence for new
     opps.
   - **(b)** For backfilling on already-active prior opps: call directly.

   Args (when ready to invite):
   ```
   connect_send_flw_invite({
     organization_slug: <PM-side org>,
     opportunity_id: <UUID from step 4>,
     phone_numbers: [process.env.ACE_E2E_PHONE]
   })
   ```
   The atom returns `{ status: 'queued', invited_count: N }` because the
   server invokes `add_connect_users.delay(...)` async. The `UserInvite`
   row + SMS go out within a few seconds. Treat `queued` as success.

   Persist to `ACE/<opp-name>/connect-state.yaml`:
   ```yaml
   ace_test_user_invited_phone: ${ACE_E2E_PHONE}
   ace_test_user_invited_at: <ISO timestamp>
   ace_test_user_invite_pending_until_active: false
   ```
   If the FLW invite is deferred to post-`llo-launch`, set
   `ace_test_user_invite_pending_until_active: true` and re-call
   `connect_send_flw_invite` from `llo-launch` after the opp is active.

8. **Write config summary** to `ACE/<opp-name>/runs/<run-id>/3-connect/connect-opp-setup.md`:
   - Opportunity ID (UUID) and URL
     (`<CONNECT_BASE_URL>/a/<org>/opportunity/<uuid>/`)
   - All configuration details (dates, total_budget, target LLO org)
   - Verification flags (final values, including which were inherited
     from defaults vs. set explicitly)
   - Deliver units (from create response) and Payment units (from step 6)
   - Whether the FLW pre-invite landed or is deferred until activation

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
- Connect (`ace-connect` MCP, 0.10.47+):
  - `connect_create_opportunity` — REST `POST /api/programs/<id>/opportunities/`
  - `connect_get_opportunity` — verify after create (HTML-driven read,
    Step 4 verify-after-create)
  - `connect_set_verification_flags` — still HTML-driven (no REST yet)
  - `connect_create_payment_units` — REST `POST /api/opportunities/<id>/payment_units/` (atomic list)
  - `connect_list_payment_units` — verify after create (Step 6
    verify-after-create — this is the canary that catches PU
    malformation before it cascades to Phase 6 invites)
  - `connect_send_flw_invite` — REST `POST /api/opportunities/<id>/invite_users/`

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
| 2026-04-28 | Replace HITL workaround with `connect_*_opportunity` + `connect_set_verification_flags` + `connect_create_payment_unit` atoms (ace-connect 0.8.1). | ACE team |
| 2026-04-28 | Add Step 8: invite ACE test user (`${ACE_E2E_PHONE}`) and persist invite URL to `connect-state.yaml`; required for Phase 5 `app-screenshot-capture` to drive the claim-opp flow | ACE team (mobile-emulation) |
| 2026-04-30 | Adopt commcare-connect PR #1135's automation API (0.10.47). `connect_create_opportunity` is now `POST /api/programs/<id>/opportunities/`, takes structured `learn_app`/`deliver_app` payloads + dates + total_budget upfront. Eliminates the two-step "create → finalize" flow and the silent-500 schema bugs around `hq_server` resolution + `api_key` registration + `learn_app`/`deliver_app` JSON wrapping (the server now does all of it). `register_hq_api_key` and `finalize_opportunity` atoms removed. `connect_create_payment_units` (plural) added for atomic-batch creation. FLW pre-invite now requires opp to be active first — coordinate with `llo-launch`. | ACE team |
| 2026-05-04 | **Verify-after-create discipline** added to Step 4 (opportunity) and Step 6 (payment units) — every external write is now followed by an immediate read-back, with `[BLOCKER]` halt on field misalignment. Catches the class of bug `turmeric-20260503-0835` hit: PU created with shifted values (`amount=500` vs sent `1.50`, `max_total=20` vs sent `500`, `required_deliver_units=[]` vs sent `[Vendor Visit]`), which cascaded through `is_setup_complete` to break Phase 6 invites and Phase 5 screenshot capture. Catching at the source converts a multi-phase cascade into a single-skill halt. Also: `short_description` cap doc fix (≤50 chars server-enforced, was wrongly documented as ≤255); `amount` integer-rounding behavior pinned (recommended: round + INFO-log, never silent truncate); empty `required_deliver_units` flagged as a downstream cascade trigger. See `agents/ace-orchestrator.md § External Mutations — Verify After Create` for the cross-skill rule. | ACE team (0.11.11) |
