---
name: connect-baseline-screenshots
description: >
  Capture the per-Connect-version baseline of "how Connect works"
  screenshots reused across every training deck. Manual, cross-opp.
disable-model-invocation: true
---

# Connect Baseline Screenshots

Capture the per-Connect-version baseline of "how Connect works" screenshots
that every ACE opp's training deck reuses. **NOT a per-opp skill** — runs
once when the Connect APK updates and the previous baseline goes stale.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Operator | Connect APK version | invocation trigger; new baseline captured per APK version |
| Static | `mcp/mobile/recipes/static/connect-flow*.yaml` | recipe palette for the standard walkthrough |

## Products

- `ACE/_common/connect-screenshots/<connect-version>/*.png` — per-Connect-version PNGs (stable cross-opp path)
- `ACE/_common/connect-screenshots/<connect-version>/manifest.yaml` — fileId/alias index consumed by `training-flw-guide` and `training-deck-outline`

## Why this skill exists

ACE training decks layer two pools of screenshots:

- **Common (this skill's output):** "open the Connect Menu," "claim the opp
  from your invite list," "sync," "view payments." These look the same for
  every ACE opp because they're driven by the Connect APK's own UI, not by
  any opp-specific config.
- **Per-opp (Phase 6 `app-screenshot-capture` output):** the Learn-app
  modules + Deliver form for THIS opp.

Without this layering, every Phase 6 burns AVD time re-capturing the same
20+ Connect-navigation screenshots. With it, those screenshots are captured
once per Connect version, sit at a stable Drive path, and the per-opp
training-flw-guide / training-deck-outline skills embed them by reference.

## When to run

- The Connect Android APK ships a new version that touches navigation, the
  opp-list view, sync, payments, or any other surface the common deck
  shows.
- ACE rebrands a common UI element (e.g., a different "claim" button).
- A new ACE training-deck section adds a Connect surface not previously
  covered (then this skill grows a new recipe in `recipes/baseline/`).

The check-in cadence is operator-judgment, not automated. `bin/ace-doctor`
will surface a `[WARN]` if the latest baseline is older than 60 days OR
older than the live `ACE_CONNECT_APK_VERSION` env value, whichever fires
first.

## Process

### Step 1: Confirm the AVD is at a clean state

The skill assumes:
- AVD is running (`mobile_ensure_avd_running`)
- The ACE test user (`ACE_E2E_PHONE`) is registered and signed in
- At least one demo opportunity is claimable

If any precondition fails, halt with a pointer at `/ace:mobile-bootstrap`.
Do NOT auto-bootstrap from this skill — operator intent should be explicit
when re-baselining.

### Step 2: Run the baseline recipes

For each baseline recipe in `mcp/mobile/recipes/baseline/`:

```
mobile_run_recipe({
  recipePath: 'mcp/mobile/recipes/baseline/<recipe>.yaml',
  envVars: { /* the standard ACE_E2E_* values from .env */ },
  screenshotDir: '/tmp/ace-connect-baseline/<connect-version>/<recipe>/'
})
```

The baseline recipes are:

| Recipe | Surfaces covered |
|--------|------------------|
| `01-sign-in.yaml` | Splash → nav drawer → Sign In/Register → home |
| `02-opp-list-view.yaml` | New Opportunities tab, claimed-opp tab, opp detail layout |
| `03-claim-opportunity.yaml` | Tap an unclaimed opp → claim flow → confirmation |
| `04-launch-learn-app.yaml` | Opp detail → Start Learning → Learn-app home |
| `05-launch-deliver-app.yaml` | Opp detail → Start Delivering → Deliver-app home |
| `06-sync-and-submit.yaml` | Sync indicator, "All synced" state, submission queue |
| `07-payments-tab.yaml` | Payments tab, per-day breakdown, accrued total |
| `08-settings-and-help.yaml` | Settings, About, Sign Out, Help link |

Each recipe is calibrated against the live Connect APK; selectors are stable
text anchors (e.g., `text: "New Opportunities"`) where possible to survive
APK rebuilds.

### Step 3: Upload to the common-assets path

For each captured PNG, upload to:

```
ACE/_common/connect-screenshots/<connect-version>/<recipe-name>/<step-name>.png
```

via `drive_upload_binary` (mime: `image/png`). The `<connect-version>` is
extracted from the running APK via `adb shell dumpsys package
org.commcare.dalvik | grep versionName`.

Then write the manifest at:

```
ACE/_common/connect-screenshots/<connect-version>/manifest.yaml
```

```yaml
connect_apk_version: "2.62.0"
captured_at: <ISO>
captured_by: <git config user.email>
source_avd: <avd-name>

recipes:
  - name: 01-sign-in
    purpose: "Splash → nav drawer → home"
    screenshots:
      - id: common-sign-in-splash
        path: 01-sign-in/splash.png
        purpose: "Welcome to CommCare splash"
        used_in: [training-deck-section-1, llo-manager-guide-onboarding]
      - id: common-sign-in-nav-drawer
        path: 01-sign-in/nav-drawer-open.png
        purpose: "Burger menu opened, Sign In/Register visible"
        used_in: [training-deck-section-1]
  ...
```

### Step 4: Self-evaluate (LLM-as-Judge)

Score across:

| Dimension | Weight | Criteria |
|-----------|--------|----------|
| Coverage | 40% | All 8 baseline recipes ran. Manifest covers all expected surfaces. |
| Screenshot quality | 30% | Every PNG > 100 KB (non-empty), correct portrait orientation, no system-overlay artifacts (notification shade, IME panel). |
| Selector stability | 20% | Recipes used text anchors or stable resource-ids — verified by re-running one recipe and confirming identical screenshots. |
| Version metadata | 10% | `connect_apk_version` extracted from `dumpsys` matches the actually-running APK. |

Write to `ACE/_common/connect-screenshots/<connect-version>/verdict.yaml`.
Threshold 7.0/10.

## Inputs

- AVD running with ACE test user signed in (manual prerequisite)
- `mcp/mobile/recipes/baseline/*.yaml` — the 8 baseline recipes (committed
  to ACE repo)

## Products

- `ACE/_common/connect-screenshots/<connect-version>/<recipe>/<step>.png`
  (binary uploads via `drive_upload_binary`)
- `ACE/_common/connect-screenshots/<connect-version>/manifest.yaml`
- `ACE/_common/connect-screenshots/<connect-version>/verdict.yaml`

## MCP tools used

- **`ace-mobile`:** `mobile_ensure_avd_running`, `mobile_run_recipe`,
  `mobile_capture_ui_dump`
- **`ace-gdrive`:** `drive_create_folder`, `drive_upload_binary`,
  `drive_create_file`

## Mode behavior

- **Auto:** run all 8 recipes, upload all PNGs, write manifest + verdict.
- **Review:** show the connect-apk-version + recipe list before running;
  pause for confirmation. Useful when the AVD has a non-standard APK build
  loaded.
- **Dry-run:** run recipes locally (capturing PNGs to /tmp) but skip the
  Drive upload. State tracks `dry-run-success`.

## CSRF token handling (when seeding ace-web prod sessions)

If a step in this skill needs to POST to a Django-backed endpoint (the
ACE web app's `/api/ingest/upload`, an OCS / Connect write, etc.) from
inside a Playwright browser context, **never use `page.request.post()`**.
The Playwright request context has its own cookie jar that doesn't share
the page's session cookies, so Django rejects the write with HTTP 403
("CSRF cookie not set" or "CSRF token missing or incorrect"). This is
the same class of bug `mcp/connect/backends/playwright.ts` and
`mcp/ocs-server.ts` already work around in production (search those
files for `X-CSRFToken` for the canonical examples).

The two-step pattern is: **read the CSRF cookie from `document.cookie`,
then issue the fetch from inside the page** so the browser's own cookie
jar travels with the request:

```ts
// Inside the Playwright session, after a GET has warmed csrftoken_ace:
const csrf = await page.evaluate(() => {
  const m = document.cookie.match(/(?:^|;\s*)csrftoken_ace=([^;]+)/);
  return m ? m[1] : null;
});
if (!csrf) throw new Error('csrftoken_ace not set — GET base URL first to warm it');

const response = await page.evaluate(
  async ([url, csrf, body]) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'X-CSRFToken': csrf as string, 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.text() };
  },
  [endpoint, csrf, payload],
);
```

Notes:
- Cookie name is `csrftoken_ace` on the ACE web app (`ace-web`); on the
  OCS / Connect Django backends it's plain `csrftoken`. Pick the right
  one for the host you're targeting.
- The cookie isn't set until *some* view rendered by `CsrfViewMiddleware`
  has been hit — a single `await page.goto(baseUrl)` first is enough to
  warm it. See `skills/upload-transcript/SKILL.md` § Shell reference for
  the curl-cookie-jar equivalent of the same pattern.
- The header MUST be `X-CSRFToken` (capital T-O-K-E-N), not `X-CSRF-Token`.
  Django's `CsrfViewMiddleware` only honors the former.

## Failure modes

- **AVD not running / test user not signed in.** Halt with a pointer at
  `/ace:mobile-bootstrap`.
- **Recipe selector mismatch (Connect APK rebuilt with new resource-ids).**
  Surface the failing recipe + step. Operator runs `maestro studio` to
  re-calibrate the recipe + commits the change to the repo before
  re-running this skill.
- **Drive upload fails (Shared-Drive guard).** Verify `ACE/_common/` lives
  on a Shared Drive; SA quota is 0 in My Drive.
- **HTTP 403 "CSRF token missing" when seeding a Django session.** You
  used `page.request.post()` instead of `page.evaluate(fetch, ...)`. See
  the CSRF token handling section above.

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-30 | Initial version. Standalone skill (NOT in any phase). Surfaced by the request to layer common-vs-opp content in training-materials so per-opp Phase 6 doesn't re-capture identical Connect-navigation screenshots every cycle. (0.10.44) | ACE team |
