---
name: app-release
description: >
  Build and release the Learn + Deliver CommCare apps on CCHQ so Connect
  can read their form schema and surface deliver units.
disable-model-invocation: true
---

# App Release

Make a new build of each app on CCHQ and mark it as **Released**, so Connect
can read its form schema and surface deliver units to the opportunity.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 3 | `3-commcare/app-deploy_summary.md` | HQ app IDs for Learn + Deliver apps |

## Products

- `3-commcare/app-release_summary.md` — released build IDs + version numbers per app

## Why this skill exists

Nova's `/nova:upload_to_hq` writes the app to CCHQ as a **draft** (the
in-flight working copy). It does NOT make a versioned build, and does NOT
release one. By design — Nova doesn't release apps directly.

Connect, however, only sees apps that have at least one **released build**.
Specifically:
- Connect's `connect_create_opportunity` accepts the bare app id and the
  ace-connect MCP wraps it in the form-value Connect requires (0.10.1+),
  so opp creation works against unreleased apps.
- BUT `Sync Deliver Units` (the wizard step that populates per-payment-unit
  deliver-unit checkboxes) reads the *released* build's form schema. Without
  a release, the deliver-units list is empty, no payment unit can be
  created, and the opp is stuck in draft.

This skill closes that gap.

## Prerequisites

The CCHQ user backing `ACE_HQ_USERNAME` (`ace@dimagi-ai.com`) **must
have a role with `edit_apps` permission** on the target project space.
The standard `Admin` role on connect-ace-prod includes this. Verify
once via the Web Users page (`/a/<domain>/settings/users/`) if you hit
auth-shaped errors — the UI's `Sorry, you don't have permission to do
this action!` banner is a generic fallback bound to `buildState() ==
'error'` in Knockout, not a literal permission verdict, so its presence
alone is not diagnostic.

## Endpoints (verified 2026-04-29)

CCHQ's URL patterns are internal UI routes, not public APIs. These were
discovered by network-tracing the UI's `Make New Version` and `Released`
toggle on `/a/<domain>/apps/view/<app_id>/releases/`:

```
# Step 1 — Make a versioned build (creates a "build" doc; sets built_on)
GET  /a/<domain>/apps/view/<app_id>/releases/             # GET first to refresh csrftoken
POST /a/<domain>/apps/save/<app_id>/                       # empty body suffices
  → 200 { "saved_app": { "_id": "<build_id>", ... } }      # _id IS the new build_id

# Step 2 — Release that build (toggles is_released=true)
POST /a/<domain>/apps/view/<app_id>/releases/release/<build_id>/
  Body: ajax=true&is_released=true
  → 200 { "is_released": true, "latest_released_version": <n> }
```

CSRF: extract from the `csrftoken` cookie set by the GET in step 1; pass
it as `X-CSRFToken` header on both POSTs.

Verify via the read-only HQ API (no UI session needed):
```
GET /a/<domain>/api/v0.5/application/<build_id>/
Authorization: ApiKey <ACE_HQ_USERNAME>:<ACE_HQ_API_KEY>
→ { "is_released": true, "version": <n>, "built_on": "<iso>" }
```

If the URL pattern shifts in a future CCHQ release, use the probe
procedure below to rediscover.

### Probe procedure (only when the verified URLs above fail)
1. Open `/a/<domain>/apps/view/<app_id>/releases/` in `/browse` with the
   CCHQ cookies imported from `~/.ace/connect-session.json`.
2. Inject an XHR/fetch interceptor (`window._cap = []; XMLHttpRequest…`).
3. Click `Make New Version`. Capture the POST URL + body.
4. Once a build appears, click the `Released` toggle (CSS-styled button,
   bound to `$root.toggleRelease`). Capture that POST URL + body.

## Process

1. **Read app ids from the deployment summary.**
   - `ACE/<opp-name>/runs/<run-id>/3-commcare/app-deploy_summary.md` frontmatter has `learn_app_id`
     and `deliver_app_id` — the 32-char HQ app IDs Nova wrote there.
   - Also read `hq_domain` (typically `connect-ace-prod`) and `hq_base_url`.

2. **Establish session.** Use the `~/.ace/connect-session.json` cookie jar
   (Connect's OAuth-via-CCHQ flow leaves valid CCHQ cookies). If
   expired, run `/ace:connect-login` to refresh.

3. **Pre-flight: confirm Connect-marker coverage was already run in
   Phase 3 Step 1.5.** The `app-connect-coverage` skill is responsible
   for verifying + auto-fixing Connect markers on the Nova side BEFORE
   deploy + release. Just check that
   `ACE/<opp-name>/app-coverage/{learn,deliver}-connect-coverage.md`
   exists with `status: clean`. If missing or `blocked`, halt and tell
   the operator to resolve coverage first — re-running app-release on
   uncovered apps will succeed at the build level but the opp will get
   stuck at Phase 4 Step 2 with empty deliver units.

4. **For each app (learn + deliver):** run the verified Step 1 + Step 2
   POSTs above. Each call is idempotent on the build side: re-POSTing
   `/apps/save/` after a release creates a new build at the next version,
   leaving prior builds released. So safe to re-run.

4a. **If `commcare_make_build` throws `BuildRejectedError` — auto-fix
    loop with the Nova architect.** Added 0.13.141 after the leep run
    20260509-2204 halt: CCHQ rejected a Learn build because Nova's
    XForm emitter skipped entity-encoding `<` in an MCQ option label.
    PR #206 (0.13.140) made that diagnostic legible; this loop closes
    the chicken-and-egg gap (you can't run `commcare-form-patch`
    without a successful `make_build` to download the CCZ from, so
    the fix has to happen Nova-side before the next `make_build`
    attempt).

    The MCP atom now returns
    `{error: 'build_rejected', app_id, error_text, error_html, retryable: false}`
    with `error_text` already HTML-stripped (see
    `mcp/connect/backends/commcare.ts § BuildRejectedError`). Catch
    it; do **not** treat `retryable: false` as "give up." That field
    means "the same args won't succeed against this app id" — the loop
    fixes the app first, then retries.

    **Loop invariants (max 3 iterations per app):**

    1. **Parse `error_text` into a structured form locator.** CCHQ's
       canonical shape is:

           Cannot make new version
           "<form-name>" Form in the "<menu-name>" Menu
           Error parsing XML: <parser-message>, line <N>, column <M>
           Error in form "<form-name> [<lang>]": <repeat>

       Extract: `form_name`, `menu_name`, `line`, `col`,
       `parser_message`. The form-name is the human label (e.g. "Unique
       ID check"), not the form_unique_id; it's all you have at this
       point because the CCZ never built.

    2. **Map `form_name` → Nova `form_id`.** The Nova app summary
       (read from `3-commcare/pdd-to-{learn,deliver}-app_summary.md`
       frontmatter `nova_app_id`) lists modules + forms. Call
       `nova__get_app({app_id})` for the live structure and walk to
       the form whose name matches `form_name`. On ambiguity (two
       forms with the same name in different modules), use
       `menu_name` to disambiguate. If still ambiguous, halt the loop
       and surface the ambiguity in the gate brief — operator decides.

    3. **Dispatch the Nova architect** via `/nova:edit <nova_app_id>`
       with a brief that names the form, the line/col, the parser
       message, and the most-likely fix class. Template:

           Form "<form_name>" in module "<menu_name>" produces invalid
           XForm XML. CCHQ rejected `make_build` with:

             <parser_message>
             at line <N>, column <M>

           The most common cause is unencoded `<`/`>`/`&`/`"` in label,
           option, hint, or constraint-message text — Nova's emitter
           does not entity-encode these (tracked at
           voidcraft-labs/nova-plugin issue #15). Inspect every label,
           option, hint, and constraint_message in this form via
           `get_form` + the per-field `edit_field` getter. For any
           string that contains a literal `<`, `>`, `&`, or `"`,
           replace with words ("three letters") or backticks
           (`three letters`) via `update_form` / `edit_field`. After
           your edits, call `validate_app` to confirm clean.

    4. **Re-upload via `/nova:upload_to_hq <nova_app_id>`.** This
       creates a **fresh** HQ app id (CCHQ has no atomic update API).
       Update the in-memory app reference to the new `hq_app_id` AND
       record both ids in
       `3-commcare/app-release_summary.md.frontmatter.hq_app_id_history`
       so Phase 4's downstream wiring (which reads the LATEST id)
       lines up. The prior orphan id stays in `ai-demo-space` —
       expected; CCHQ has no MCP delete path.

    5. **Retry `commcare_make_build` against the new HQ app id.** If
       it still throws `BuildRejectedError`, parse the new
       `error_text` (it may name a different form / line / cause) and
       loop. **Cap at 3 total attempts per app.**

    6. **On exhaustion (3 failed attempts),** surface the FINAL
       `BuildRejectedError` to the orchestrator as a `[BLOCKER]` in
       `app-release_gate-brief.md` with: every iteration's
       `error_text`, every Nova edit dispatched, the final
       `hq_app_id`, the operator-facing remediation (manual CCHQ
       form-designer edit on the final orphan id, OR wait for Nova
       upstream fix). Phase 3 halts. Do not silently downgrade to
       success.

    **Why bounded.** A perpetually-failing form is almost certainly a
    Nova-emitter regression that the architect can't see (it lives
    below `validate_app`'s scope). Three attempts gives the architect
    a chance to fix the obvious case (literal angle-bracket in a
    label) and one chance to fix a non-obvious case the first round
    missed; beyond that we're burning cycles on a structural bug that
    needs human eyes on the emitted XForm XML.

    **Subagent dispatch note.** `/nova:edit` runs the Nova architect
    via `Agent`, which is only available at level 0. `app-release` is
    invoked from Phase 3 (`commcare-setup`), which runs inline at
    level 0 per § Agent Topology in `agents/ace-orchestrator.md`. So
    the dispatch is structurally legal here — but if a future caller
    moves `app-release` into a subagent, this loop breaks. Keep the
    invariant.

5. **Verify both apps show `is_released: true`** via the API.

6. **Verify the released CCZ via `commcare_download_ccz` projection.**
   Call `commcare_download_ccz(domain, app_id, build_id, include_multimedia=false)`
   and read all three gates on the response:

   - **`projected_connect_state.collision_count`** — MUST be `0`.
     This is a deterministic projection of what Connect's HQ→Connect
     sync will produce: every `<learn:deliver>` / `<learn:module>` /
     `<learn:task>` / `<learn:assessment>` element across every form,
     deduplicated by `(app, slug)` exactly like
     `commcare-connect/opportunity/tasks.py:sync_learn_modules_and_deliver_units`.
     A non-zero count means N forms emit the same `id` attribute and
     Connect will silently collapse them, leaving the non-first forms
     unwired to any payment_unit and unpaid in production.
   - **Per-type record counts** (`projected_connect_state.deliver_units.length`
     etc.) MUST be > 0 for the app type — Learn apps have ≥ 1 module,
     Deliver apps have ≥ 1 deliver_unit. Zero means the form lacks
     Connect metadata at the source (Nova didn't generate it).
   - **`projected_connect_state.oversized_slugs`** — every per-type array
     MUST be empty (`oversized_slugs.deliver_units === [] && .learn_modules
     === [] && .task_units === [] && .assessments === []`). Equivalently:
     `projected_connect_state.max_slug_length <= projected_connect_state.slug_length_limit`
     (50 today; constant on the projection so this gate is self-documenting).
     Connect's `LearnModule.slug` and `DeliverUnit.slug` are
     `SlugField()` with the Django default `max_length=50`. A slug > 50
     chars raises Postgres `DataError: value too long for type character
     varying(50)` at sync time, which falls through the narrow `except
     (CommCareHQAPIException, AppNoBuildException, httpx.*)` in
     `commcare_connect/program/api/views.py:102` and surfaces as HTTP 500
     with an empty body — Phase 4's `connect_create_opportunity` 500s
     opaquely. Reproducer: `leep-paint-collection/20260517-1515` Phase 4,
     module name "Stage 2: Sample Preparation, Drying, Bagging, Shipment"
     → slug `module_6_stage_2_sample_prep_drying_bagging_shipment`
     (52 chars). See `docs/learnings/2026-05-12-boundary-probe-registry.md`.

   On `collision_count > 0`, halt with `[BLOCKER]` in
   `app-release_gate-brief.md`. The brief MUST name every
   `collisions.deliver_units[].slug` + the `kept` form + each `dropped`
   form so the operator can grep the source. Concrete remediation:
   re-build the affected app (typically Deliver) with **one form per
   module**, since Nova's `compile_app` emits the module slug as
   `<learn:deliver id>` for every form in a module, and the only
   reliable way to get N unique slugs is N modules. See
   `feedback_connect_deliver_unit_per_module` memory for full mechanism.

   On any `oversized_slugs.*` non-empty, halt with `[BLOCKER]` in the
   gate brief. The brief MUST list each offender as
   `<type>: <slug> (<length> chars, in <first_seen_in>)`. Concrete
   remediation: rename the offending Nova module / deliver-unit to
   produce a shorter slug. Rule of thumb — keep `connect.learn_module.name`
   / `connect.deliver_unit.name` ≤ 40 chars so Nova's `module_<index>_`
   prefix + slugified name fits Connect's 50-char column. The
   `pdd-to-learn-app` / `pdd-to-deliver-app` SKILL.md brief templates
   carry this constraint upstream of `app-release` — but oversized slugs
   can still leak past the brief (e.g., when an operator re-runs Nova
   manually), so this gate is the structural wall.

   On `< 1` records of the expected type, halt with the same Step 3
   remediation (re-run coverage; this is a Nova autobuild marker-skip,
   not a slug collision).

   **Pre-0.13.81 fallback** (legacy `connect_markers` count, retained
   for one release): if the response only has `connect_markers` and not
   `projected_connect_state`, fall back to the old shape — count > 0
   per type, but cannot detect slug collisions. Treat that path as a
   degraded build (operator has not pulled the projection-aware MCP).

7. **Update `3-commcare/app-deploy_summary.md`** with a `releases:` block:
   ```yaml
   releases:
     learn_app:  { build_id: <id>, version: <n>, released_at: <iso>, connect_markers: <count> }
     deliver_app: { build_id: <id>, version: <n>, released_at: <iso>, connect_markers: <count> }
   ```

8. **Trigger Connect's deliver-unit sync.** Connect caches per-opp
   deliver units; after a release, the next opp create or wizard step
   will pick up the new schema. If an opp ALREADY exists (re-running
   this skill mid-cycle), tell the operator to either re-run
   `connect-opp-setup` (it will re-sync) or visit the opp wizard and
   click `Sync Deliver Units` manually.

   Sync URL pattern (verified 2026-04-29):
   ```
   POST /a/<connect_org>/opportunity/<opp_int_id>/sync_deliver_units/
   X-CSRFToken: <from hx-headers in form HTML>
   ```
   Note `opp_int_id` is Connect's internal int FK, not the UUID. To
   discover it, GET the wizard page and read the `hx-post` attribute on
   the Sync Deliver Units button.

## Known Nova bugs

See `voidcraft-labs/nova-plugin#1` for the upstream tracker (autobuild
skips Connect markers; `update_form` strips fields not in the published
schema and the runtime injects empty `entity_id`/`entity_name` that
serialize as invalid XPath). The `app-connect-coverage` skill (Phase 3
Step 1.5) is the place that detects and reports these — this skill
just consumes its `clean | blocked` verdict.

5. **Update 3-commcare/app-deploy_summary.md.**
   Append a `releases` block to the frontmatter with the new build IDs and
   release timestamps:

   ```yaml
   releases:
     learn_app:
       build_id: <build_id>
       released_at: <ISO-8601>
     deliver_app:
       build_id: <build_id>
       released_at: <ISO-8601>
   ```

6. **Verify Connect can see the release.**
   Optional but recommended sanity check before Phase 4 starts:

   - GET `/a/<connect_org>/opportunity/init/` (Connect side, via ace-connect MCP context)
   - Look at the deliver_app dropdown options for `<hq_domain>`. The option
     text should change from `Unreleased - <name>` to `Released - <name>`
     once the release propagates (typically immediate; Connect doesn't
     cache).

## MCP Tools Used

- **Google Drive MCP:** `drive_read_file`, `drive_update_file`
- **ace-connect MCP (CCHQ atoms, added 0.10.38+):**
  - `commcare_make_build` — POST `/apps/save/<app_id>/`, returns build_id.
  - `commcare_release_build` — POST `/apps/view/<app_id>/releases/release/<build_id>/`,
    sets `is_released: true`.
  - `commcare_download_ccz` — GET `/apps/api/download_ccz/?app_id=...&latest=release`,
    returns CCZ bytes (base64) + Connect-marker counts grepped from the
    inflated form XML.
  These run against `ACE_HQ_BASE_URL` (default `https://www.commcarehq.org`)
  using the same Playwright session as the Connect atoms — Connect's
  OAuth-via-CCHQ flow leaves valid CCHQ cookies in
  `~/.ace/connect-session.json`, so a single login covers both services.

  **Prefer these atoms over raw `Bash` + `curl`.** The orchestrator used
  to regenerate `/tmp/ace-release.js` scripts on every Phase 3 run
  (turmeric-20260429-2330 spent ~10 min on this); the atoms eliminate
  that loop. The bash/curl path documented earlier in this file is the
  fallback when the URL contract shifts and a re-probe is needed.

## Mode Behavior
- **Auto:** Pre-flight, build, release, verify, update summary, proceed.
- **Review:** Same, but pause after step 4 and present the release status
  for confirmation before updating the summary.

## Dry-Run Behavior
When `--dry-run` is active:
- Run pre-flight (read-only).
- Do NOT POST to `save/` or `release/`.
- Write the intended invocations and the current `is_released` state to
  `comms-log/dry-run-app-release.md`.
- State tracks as `dry-run-success`.

## Failure Modes

- **HTTP 500 on `/apps/save/` with full payload**: usually a malformed
  app-state JSON (deprecated case types, missing required fields, etc).
  CCHQ's UI shows the generic `Sorry, you don't have permission to do
  this action!` banner regardless of the underlying cause — that text
  is bound to `buildState() == 'error'` in Knockout, NOT to a literal
  permission check. Don't let the banner mislead the diagnosis. Look
  at the actual response body or the CCHQ project's logs.
- **HTTP 200 from `/apps/save/` but no new build appears**: empty-body
  POST to /apps/save/ is a no-op that just reflects the saved app.
  You need to POST the full app-state JSON, which is non-trivial to
  reproduce outside the UI's Knockout viewmodel.
- **Broken existing build warning**: CCHQ's app-versions page sometimes
  shows "One or more of your versions is broken". This is a benign
  warning about prior builds; new build creation should still work.
- **`is_released` doesn't flip after release POST**: probe URL pattern;
  the release endpoint may have moved.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-29 | Initial version. Carved out as a separate Phase 3 step (between `app-deploy` and `connect-opp-setup`) after the turmeric-market-survey-2026-04-28 dogfood made it clear that "Nova upload" and "released and discoverable by Connect" are different states. (0.10.1) | ACE team |
| 2026-04-29 | Correct the prerequisite section: ace@dimagi-ai.com IS Admin on connect-ace-prod (verified live). The UI's "Sorry, you don't have permission" banner is a Knockout fallback for any `buildState() == 'error'`, not a literal permission verdict. Replace the bad pre-flight with an empirical probe procedure for endpoint discovery — CCHQ's `Make New Version` and `Make Released` URL patterns aren't stable public APIs and need to be re-discovered when the UI changes. (0.10.3) | ACE team |
| 2026-04-29 | Discovered + verified the actual endpoints on `/apps/view/<app_id>/releases/`: `POST /apps/save/<app_id>/` (empty body) returns the new build with `_id`; `POST /apps/view/<app_id>/releases/release/<build_id>/` with `ajax=true&is_released=true` flips the release flag. Tested live against `0c96435881b0...` (deliver) and `76fd5f0e2834...` (learn) on connect-ace-prod — both successfully released. Also documented the Connect-side sync endpoint: `POST /a/<org>/opportunity/<int_id>/sync_deliver_units/`. (0.10.4) | ACE team |
| 2026-04-29 | Add Connect-coverage pre-flight (Step 3) and CCZ verification (Step 6) — checks Nova blueprints have `connect.deliver_unit` / `learn_module` / `assessment` set on every form, then verifies the released CCZ has `<learn:deliver>` / `<learn:module>` markers. Document two upstream Nova bugs that cause silent failures: (a) autobuild often skips Connect markers entirely; (b) `update_form deliver_unit` runtime auto-fills empty `entity_id`/`entity_name` that serialize as invalid XPath, breaking the build. Both need Nova upstream fixes; the skill surfaces clear pointers when either is detected. Learn-app pipeline currently works end-to-end; Deliver-app pipeline blocks on bug (b). (0.10.5) | ACE team |
| 2026-04-29 | Move Connect-marker verify+fix into a dedicated Phase 3 Step 1.5 skill (`app-connect-coverage`) that runs after Nova builds and before deploy. This skill's pre-flight now just consumes that skill's `clean | blocked` verdict instead of duplicating the logic. Step 6 CCZ verification stays here as the post-release sanity check. (0.10.7) | ACE team |
