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

The CCHQ user backing `ACE_HQ_USERNAME` (`ace@dimagi-ai.com`) **must have
App Editor permissions** on the target project space (e.g. `connect-ace-prod`).
Without that role, the "Make New Version" UI returns 500 with "Sorry, you
don't have permission to do this action!" and the CCHQ REST API returns
405/403 for the same operation. Confirmed live 2026-04-29.

If the role is missing, halt and report — this is an admin-side fix
(via `https://www.commcarehq.org/a/<domain>/settings/users/` → Web Users →
edit ace@dimagi-ai.com → role: App Editor), not something this skill can
resolve.

## Process

1. **Read app ids from the deployment summary.**
   - `ACE/<opp-name>/deployment-summary.md` frontmatter has `learn_app_id`
     and `deliver_app_id` — the 32-char HQ app IDs Nova wrote there.
   - Also read `hq_domain` (typically `connect-ace-prod`) and `hq_base_url`.

2. **Pre-flight: confirm ace@dimagi-ai.com has App Editor on hq_domain.**
   Make a probe GET on the app-versions page:

   ```
   GET /a/<hq_domain>/apps/view/<app_id>/
   ```

   Parse the response. If the body contains "Sorry, you don't have permission",
   stop and surface the exact remediation steps (Web Users → ace → role:
   App Editor). Do NOT attempt the build — it will 500 silently.

3. **Make a new build for each app.**
   For each of `learn_app_id` and `deliver_app_id`:

   - GET the app's edit page once to populate the CSRF token cookie.
   - POST to `/a/<hq_domain>/apps/save/<app_id>/` with `{}` body and the
     `csrfmiddlewaretoken` cookie value as `X-CSRFToken` header. CCHQ's
     "Make New Version" button calls this endpoint via the Knockout
     `makeNewBuild()` JS function. A successful response returns JSON
     containing the new `build_id`. If the response is 500 with
     "permission" in body, fall back to the pre-flight error path.

   Capture the resulting `build_id`.

4. **Release the new build.**
   For each `build_id`, POST to:

   ```
   /a/<hq_domain>/apps/<app_id>/<build_id>/release/
   ```

   Body: empty form with CSRF. A successful release returns 200 / 302 and
   the build's `is_released` flag flips to true. Verify by re-fetching
   the application via the API:

   ```
   GET /a/<hq_domain>/api/v0.5/application/<app_id>/
   Authorization: ApiKey <ACE_HQ_USERNAME>:<ACE_HQ_API_KEY>
   ```

   Look for `is_released: true` in the JSON.

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

- **Permission denied (500 on `/apps/save/`)**: ace@dimagi-ai.com is not
  an App Editor on the project space. Route operator to Web Users page;
  this is the most common cause and is admin-side, not skill-side.
- **Broken existing build warning**: CCHQ's app-versions page sometimes
  shows "One or more of your versions is broken". This is a benign warning
  about prior builds; new build creation should still work. If it doesn't,
  the underlying cause is usually a deprecated case type or schema error
  in the app — re-run `pdd-to-deliver-app` / `pdd-to-learn-app` and
  redeploy.
- **`is_released` doesn't flip after release POST**: rare. Re-POST the
  release endpoint; if still failing, inspect the build's "Settings" tab
  on CCHQ for explicit "Don't release" flags.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-29 | Initial version. Carved out as a separate Phase 2 step (between `app-deploy` and `connect-opp-setup`) after the turmeric-market-survey-2026-04-28 dogfood made it clear that "Nova upload" and "released and discoverable by Connect" are different states. Documents the App Editor permission prerequisite surfaced by the live UI's "Sorry, you don't have permission" failure. (0.10.1) | ACE team |
