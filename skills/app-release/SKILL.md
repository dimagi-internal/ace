---
name: app-release
description: >
  Release the Learn and Deliver CommCare apps that Nova uploaded as drafts.
  Required between `app-deploy` (Phase 2) and `connect-opp-setup` (Phase 3) —
  Connect's `Sync Deliver Units` only enumerates units from *released* HQ
  builds, so unreleased apps make Phase 3 silently impossible.
---

# App Release

Make a new build of each app on CCHQ and mark it as **Released**, so Connect
can read its form schema and surface deliver units to the opportunity.

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
   - `ACE/<opp-name>/deployment-summary.md` frontmatter has `learn_app_id`
     and `deliver_app_id` — the 32-char HQ app IDs Nova wrote there.
   - Also read `hq_domain` (typically `connect-ace-prod`) and `hq_base_url`.

2. **Establish session.** Use the `~/.ace/connect-session.json` cookie jar
   (Connect's OAuth-via-CCHQ flow leaves valid CCHQ cookies). If
   expired, run `/ace:connect-login` to refresh.

3. **Pre-flight: verify Nova added Connect markers to every form.**
   This is the most common failure mode and the cheapest to detect.
   For each app:

   - Call `mcp__plugin_nova_nova__get_app({app_id: <nova_app_id>})` to
     confirm the blueprint declares `Connect type: learn` (or `deliver`).
   - For each form in the blueprint, call
     `mcp__plugin_nova_nova__get_form({app_id, moduleIndex, formIndex})`
     and check the `connect` field on the returned form:
     - **Deliver app forms** must have `connect.deliver_unit` (or
       `connect.task`) set with a `name`. Missing = build will pass
       but Connect's `Sync Deliver Units` will return zero — the
       opp gets stuck at Phase 3 Step 2.
     - **Learn app forms** must have `connect.learn_module` (content)
       and/or `connect.assessment` (quiz) set per the prompt's content/
       quiz/both rule.

   If any form is missing its expected Connect block, halt and surface:
   "Nova autobuild did not configure Connect markers on form <N> of
   module <M> in <app_id>. Re-run `/nova:edit <app_id>` with the
   instruction `Set the Connect deliver_unit/learn_module/assessment
   block on every form per the autobuild prompt's CommCare Connect
   rules.` See § Known Nova bug below for context."

4. **For each app (learn + deliver):** run the verified Step 1 + Step 2
   POSTs above. Each call is idempotent on the build side: re-POSTing
   `/apps/save/` after a release creates a new build at the next version,
   leaving prior builds released. So safe to re-run.

5. **Verify both apps show `is_released: true`** via the API.

6. **Verify the released CCZ contains `<learn:deliver>` /
   `<learn:module>` blocks.** The ultimate test of "Connect can see
   this app" — the form XML in the CCZ must have elements in the
   `http://commcareconnect.com/data/v1/learn` namespace. If `is_released`
   is true but the CCZ has zero such markers, the form lacks Connect
   metadata at the source (Nova didn't generate it). Halt with the
   same remediation as Step 3.

   ```bash
   curl -H "Authorization: ApiKey <user>:<key>" \
     "<base>/a/<domain>/apps/api/download_ccz/?app_id=<app_id>&latest=release" \
     -o /tmp/app.ccz
   unzip -q /tmp/app.ccz -d /tmp/app/
   grep -rcE 'commcareconnect|<learn:(deliver|module|task|assessment)' /tmp/app/ | grep -v ':0'
   # Must list at least one form file with markers per app
   ```

7. **Update `deployment-summary.md`** with a `releases:` block:
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

## Known Nova bugs (as of 2026-04-29)

Two distinct bugs in `voidcraft-labs/nova-plugin` cause Phase 3 Step 2 to
silently produce a draft opp with zero deliver units:

1. **Autobuild often skips Connect markers entirely.** The
   nova-architect-autonomous prompt has a `## CommCare Connect` section
   that instructs the agent to set `learn_module`/`assessment` on Learn
   forms and `deliver_unit`/`task` on Deliver forms, but in practice the
   autobuild run completes WITHOUT setting them. The blueprint records
   `Connect type: deliver` at the app level but each form has no
   `connect` block. Workaround: pre-flight (Step 3 above) calls
   `nova_get_form` on every form and surfaces the missing markers; the
   operator can then fix via `/nova:edit`.

2. **`update_form` `deliver_unit` schema lists only `name`, but the
   runtime auto-fills empty `entity_id` and `entity_name` that
   serialize as invalid XPath.** Repro:
   ```
   nova_update_form(connect={deliver_unit: {name: "Vendor visit"}})
     → form.connect.deliver_unit = {
         name: "Vendor visit", entity_id: "", entity_name: ""
       }
   ```
   On `/apps/save/` (build creation), CCHQ rejects with:
   ```
   Validation Error: Problem with bind for
     /data/connect_deliver/deliver/entity_id
     contains invalid calculate expression []
   ```
   Passing entity_id/entity_name in the update_form call doesn't help —
   they get stripped at the schema validator. **Workaround:** none yet
   from ACE-side; needs a Nova upstream fix to either omit empty
   entity_id/entity_name from the bind, or expose them as input params
   with sensible defaults (e.g. `uuid()`).

If you hit either bug, surface it explicitly to the operator with a
pointer to this section, rather than retrying.

5. **Update deployment-summary.md.**
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
   Optional but recommended sanity check before Phase 3 starts:

   - GET `/a/<connect_org>/opportunity/init/` (Connect side, via ace-connect MCP context)
   - Look at the deliver_app dropdown options for `<hq_domain>`. The option
     text should change from `Unreleased - <name>` to `Released - <name>`
     once the release propagates (typically immediate; Connect doesn't
     cache).

## MCP Tools Used

- **Google Drive MCP:** `drive_read_file`, `drive_update_file`
- No CCHQ MCP exists today (CCHQ tools live in connect-labs MCP, separate
  plugin). This skill uses raw `Bash` + `curl` against `ACE_HQ_BASE_URL`,
  authenticated via the Playwright session in `~/.ace/connect-session.json`
  (Connect-OAuth-via-CCHQ leaves valid CCHQ cookies in that file) plus the
  `ACE_HQ_API_KEY` for the verify step.

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
| 2026-04-29 | Initial version. Carved out as a separate Phase 2 step (between `app-deploy` and `connect-opp-setup`) after the turmeric-market-survey-2026-04-28 dogfood made it clear that "Nova upload" and "released and discoverable by Connect" are different states. (0.10.1) | ACE team |
| 2026-04-29 | Correct the prerequisite section: ace@dimagi-ai.com IS Admin on connect-ace-prod (verified live). The UI's "Sorry, you don't have permission" banner is a Knockout fallback for any `buildState() == 'error'`, not a literal permission verdict. Replace the bad pre-flight with an empirical probe procedure for endpoint discovery — CCHQ's `Make New Version` and `Make Released` URL patterns aren't stable public APIs and need to be re-discovered when the UI changes. (0.10.3) | ACE team |
| 2026-04-29 | Discovered + verified the actual endpoints on `/apps/view/<app_id>/releases/`: `POST /apps/save/<app_id>/` (empty body) returns the new build with `_id`; `POST /apps/view/<app_id>/releases/release/<build_id>/` with `ajax=true&is_released=true` flips the release flag. Tested live against `0c96435881b0...` (deliver) and `76fd5f0e2834...` (learn) on connect-ace-prod — both successfully released. Also documented the Connect-side sync endpoint: `POST /a/<org>/opportunity/<int_id>/sync_deliver_units/`. (0.10.4) | ACE team |
| 2026-04-29 | Add Connect-coverage pre-flight (Step 3) and CCZ verification (Step 6) — checks Nova blueprints have `connect.deliver_unit` / `learn_module` / `assessment` set on every form, then verifies the released CCZ has `<learn:deliver>` / `<learn:module>` markers. Document two upstream Nova bugs that cause silent failures: (a) autobuild often skips Connect markers entirely; (b) `update_form deliver_unit` runtime auto-fills empty `entity_id`/`entity_name` that serialize as invalid XPath, breaking the build. Both need Nova upstream fixes; the skill surfaces clear pointers when either is detected. Learn-app pipeline currently works end-to-end; Deliver-app pipeline blocks on bug (b). (0.10.5) | ACE team |
