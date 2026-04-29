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

## Endpoint discovery is empirical

CCHQ's URL patterns for "Make New Version" and "Release" are not stable
public APIs. The UI's `Make New Version` button calls a Knockout
`makeNewBuild()` function which POSTs a large app-state JSON to a
domain-specific URL. The release URL pattern is also internal.

This skill documents what's known to work as of 2026-04-29; if the
upstream UI changes, follow the **probe procedure** below before
guessing.

### Probe procedure
1. Open `/a/<domain>/apps/view/<app_id>/` in a real browser (or via
   `/browse` with imported CCHQ cookies from `~/.ace/connect-session.json`).
2. Open DevTools → Network. Click `Make New Version`. Copy the POST URL
   and request body.
3. Once a build appears in the table, click `Make Released`. Copy that
   POST URL and body.
4. Replicate the calls via curl with the same cookies + CSRF.

The skill's "happy path" below assumes the patterns observed in 2026-04
(below); when they break, use the probe procedure to find the new ones
rather than guessing at variants.

## Process

1. **Read app ids from the deployment summary.**
   - `ACE/<opp-name>/deployment-summary.md` frontmatter has `learn_app_id`
     and `deliver_app_id` — the 32-char HQ app IDs Nova wrote there.
   - Also read `hq_domain` (typically `connect-ace-prod`) and `hq_base_url`.

2. **Establish session.** Use the `~/.ace/connect-session.json` cookie jar
   (same one ace-connect uses — Connect's OAuth-via-CCHQ flow leaves
   valid CCHQ cookies in it). Or, if the session has expired, run
   `/ace:connect-login` to refresh.

3. **Make a build for each app.** For each of `learn_app_id` and
   `deliver_app_id`:

   - GET the app's view page to refresh the `csrftoken` cookie:
     ```
     GET /a/<hq_domain>/apps/view/<app_id>/
     ```
   - POST to `/a/<hq_domain>/apps/save/<app_id>/`. Empty body returns
     a 200 with the saved-app JSON but does NOT make a build. The UI's
     button POSTs the full app-state JSON; if you can scrape that JSON
     from the page (Knockout viewmodel → JSON.stringify) and replay it,
     the response should include a build with `built_on != null` and
     a versioned id.
   - Verify the build was created by querying:
     ```
     GET /a/<hq_domain>/api/v0.5/application/?app_type=build&app_id=<app_id>
     Authorization: ApiKey <ACE_HQ_USERNAME>:<ACE_HQ_API_KEY>
     ```
     A real build has `built_on` set and a non-null `version > 1`.

4. **Release the build.** Once a build exists, mark it released. Probe
   the URL pattern via the UI's `Make Released` button if needed.
   Successful release flips `is_released` to true. Verify:
   ```
   GET /a/<hq_domain>/api/v0.5/application/<build_id>/
   ```
   Look for `is_released: true`.

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
