# Connect 2.62.0 Mobile Navigation Atlas

**APK:** `org.commcare.dalvik` v 2.62.0 (Connect-enabled CommCare client).
**Device:** ACE_Pixel_API_34 (Pixel 6 profile, API 34, 1080x2400).
**Test user:** ACE Test (ConnectID `${ACE_E2E_PHONE}` — `+74260000100` at walk-through time; resolves to whatever 1Password `AI-Agents/connect-test-user/phone` currently holds).
**Walk-through date:** 2026-05-14.

## Purpose

A ground-truth navigation map of the Connect-enabled CommCare client, written by walking the app surface-by-surface and capturing UI dumps + screenshots at each one. Each screen documents:

- **Resource identifier(s)** for the screen container — the most stable signal that "we're on this screen."
- **Reachable transitions** — which surfaces you can reach from here and which selector triggers each.
- **Stable selectors** — fully-qualified resource-ids + text values, with whether the element is `enabled`, `clickable`, and any conditional visibility.
- **Side effects** — system prompts (lock-screen unlock, BiometricPrompt), network calls, screen transitions that happen *in-place* vs. push a new activity.

The atlas is for recipe authoring + state-classification. Static recipes in `mcp/mobile/recipes/static/` should reference atlas screen names and transitions, not invent their own surface labels.

## Prerequisites

### AVD device-clock invariant (load-time, ALWAYS required)

**Symptom of the bug:** opp list loads empty, toast says *"You are not authorized to make this request."* Sync button retry produces the same toast. Logcat shows `Unauthorized: Response Code: 401 | error: {"detail":"Authentication credentials were not provided."} for url /api/opportunity/`.

**Root cause:** the AVD snapshot freezes the device wall-clock at the moment of capture. When the snapshot is loaded N hours/days later:

- The local Connect Token DB has `expiration_date = <real-time when token was issued + token TTL>`.
- The device clock is still set to the snapshot-captured time.
- Locally the app sees `device_time < expiration_date` → thinks token is valid → attempts the API call.
- The server uses real time. If the snapshot-captured time is past the token's actual expiry, the request fails with 401 "Authentication credentials were not provided" — likely Connect's backend rejecting the expired token (the error message is misleading; the symptom is the same as "no creds provided").
- Even when the token IS still real-time-valid, large clock skew (≥ a few minutes) can fail other validations (cookie HMAC, JWT `iat`/`nbf`, anti-replay windows).

**Fix:** align the AVD device clock to the host clock immediately after snapshot load, BEFORE any Connect-side network activity:

```bash
adb -s emulator-5554 root                          # one-time per AVD boot
adb -s emulator-5554 shell "date $(date +%m%d%H%M%Y.%S)"
```

This is unconditional — never depend on the snapshot's frozen clock being "close enough." After the clock fix, tap the toolbar `action_sync` button (top-right) on `connect_fragment_jobs_list` to force a re-pull; opp cards appear within a few seconds.

**Where this belongs in the heal layer:** `MobileClient.restoreDeviceUserState` (`mcp/mobile/client.ts`) should run the `date` sync as the FINAL step of tier-1 restore, AFTER `loadSnapshot` and BEFORE classifier verification. Without it, the classifier sees "ready" (the UI looks fine on `screen_first_start_main`) but the next Connect API call dies.

**Verified live:** 2026-05-14 — snapshot loaded ~10h45m after capture; clock-fix changed empty-list-with-401 to a populated `rvJobList`. Same UI flow, same selectors, same atoms — only the clock was off.

---

## Screen index

| Screen | Section |
|---|---|
| `screen_first_start_main` (Welcome + nav drawer) | [§ 1](#1-screen_first_start_main) |
| `connect_fragment_jobs_list` (Opportunities list — unclaimed cards) | [§ 2](#2-connect_fragment_jobs_list) |
| **AVD device-clock invariant** — load-time prerequisite | [§ Prerequisites](#prerequisites) |
| Opportunity detail (pre-claim) — `tv_job_*`, `btn_start`, Learn/Delivery preview blocks | [§ 3](#3-opportunity-detail-pre-claim) |
| Downloading Learn App — `Step N of 14` progress screen | [§ 4](#4-downloading-learn-app) |
| `StandardHomeActivity` (CommCare app home, Connect-mode) — 4 tiles (Start / Job Status / Sync / Logout) | [§ 5](#5-standardhomeactivity-commcare-app-home) |
| `MenuActivity` — suite root + form list (`screen_suite_menu_list`) | [§ 6](#6-menuactivity-suite--form-list) |
| `FormEntryActivity` — question rendering, `nav_btn_prev`/`nav_btn_next`, required-validation banner | [§ 7](#7-formentryactivity) |
| Exit Form dialog — Deliver-side mid-form back-press confirmation | [§ 7.1](#71-exit-form-dialog-deliver-side-mid-form-back) |
| Opportunity detail (post-Learn-complete) — certificate view, `View Opportunity Details` CTA | [§ 8](#8-opportunity-detail-post-learn-complete--certificate) |
| Opportunity detail (post-Deliver-download) — View Info bottom-sheet, 4-stage progress widget, Delivery Details card | [§ 8.5](#85-opportunity-detail-post-deliver-download--view-info-bottom-sheet) |
| Download Delivery gate — single-screen handoff between Learn completion and Deliver download | [§ 9](#9-download-delivery-gate) |
| `StandardHomeActivity` — Deliver mode — same 4-tile grid, title suffix `— Deli…`, Sync subtext `Daily Visits N/M` | [§ 10](#10-standardhomeactivity-deliver-mode) |
| `MenuActivity` — Deliver-side — `Vendor Visits` module tile | [§ 11](#11-menuactivity-deliver-side) |
| Vendor Visit form — composite widgets (text + GPS + photo), binary-radio gates (Safety exit / Consent), validation banner | [§ 12](#12-vendor-visit-form-walk) |
| Form submission confirmation / auto-finalize behavior | [§ 7 note](#7-formentryactivity) |

---

## 1. `screen_first_start_main`

The CommCare "Welcome" landing screen. Reachable two ways:

- **Cold launch with a stale Connect session:** `am start org.commcare.dalvik` after the snapshot loads.
- **Direct path from PersonalID:** post-registration + post-login (when no app is installed via `Scan Application Barcode` or `Enter Code`).

**Activity:** CommCare's setup activity. The nav drawer overlays it.

### Container resource-ids

- `org.commcare.dalvik:id/screen_first_start_main` — main welcome container (the right-half content behind the drawer).
- `org.commcare.dalvik:id/drawer_layout` — the DrawerLayout root.
- `org.commcare.dalvik:id/nav_drawer_frame` — drawer container.
- `org.commcare.dalvik:id/include_tool_bar` + `org.commcare.dalvik:id/toolbar` — top toolbar.

### Toolbar (top, persistent)

| Element | Selector | Notes |
|---|---|---|
| Nav drawer toggle | `content-desc="Close navigation drawer"` ImageButton at top-left | Toggles the drawer. When drawer is closed, content-desc flips to `"Open navigation drawer"`. |
| Title | `TextView` text `"CommCare"` | Static. |
| More-options | `content-desc="More options"` ImageView at top-right | Three-dot menu. |

### Welcome content (behind drawer when drawer is open)

| Element | Selector | Notes |
|---|---|---|
| Top banner | `id/main_top_banner` ImageView | Decorative. |
| Welcome text | `id/str_setup_message` TextView, text `"Welcome to CommCare!"` | |
| "GO TO CONNECT MENU" button | `id/connect_login_button` Button | Top CTA — goes to Connect home (the opp-list-having path). |
| Divider | `id/login_or` TextView, text `"___________ OR ___________"` | |
| "Please choose an installation method below" | `id/str_setup_message_2` TextView | |
| "Scan Application Barcode" | `id/btn_fetch_uri` (container `id/btn_fetch_uri_container`) | App-install path (QR code). Not a Connect path. |
| "Enter Code" | `id/enter_app_location` | App-install path (manual install code). Not a Connect path. |

### Nav drawer (left)

When drawer is open, `bounds` for drawer content is roughly `[0,136][693,2337]`. Items are a `RecyclerView` (`id/nav_drawer_recycler`).

| Item | Selector | Enabled? | Notes |
|---|---|---|---|
| Profile card (header) | `id/header_user_name` text `"ACE Test"` | static | Not clickable — display only. |
| **Opportunities** | `id/list_title` text `"Opportunities"`, container `id/parent_item_container` | enabled, clickable | Primary path to the jobs list. |
| CommCare Apps | `id/list_title` text `"CommCare Apps"` | **disabled** (`enabled="false"`) | Greyed out — no CommCare app installed at this stage. |
| Messaging | `id/list_title` text `"Messaging"` | enabled, clickable | |
| Work History | `id/list_title` text `"Work History"` | enabled, clickable | |
| Notifications (footer) | `id/notification_view` (text `"Notifications"`) | enabled, clickable | Connect-side notification feed. |
| About CommCare (footer) | `id/about_view` | enabled, clickable | |
| Version | `id/app_version` text `"v 2.62.0"` | static | |

### Transitions from this screen

| Trigger | Destination | Side-effect |
|---|---|---|
| Tap **Opportunities** in drawer | system `lockPassword` prompt → `connect_fragment_jobs_list` | Triggers a BiometricPrompt / device-credential PIN entry (`com.android.systemui:id/lockPassword`). Answer is the test user's device PIN (`${ACE_E2E_PIN}`). |
| Tap **GO TO CONNECT MENU** | Connect home (jobs list path, no PIN re-prompt observed) | TBD — needs verification this run. |
| Tap **Scan Application Barcode** | Camera opens to scan a CCZ install URI | Not Connect-relevant. |
| Tap **Enter Code** | Text input for manual install code | Not Connect-relevant. |
| Tap nav drawer toggle | Closes drawer | Reveals welcome content full-screen. |

### Open questions for this screen

- Does **GO TO CONNECT MENU** skip the PIN prompt that tapping **Opportunities** triggers? Or does it route through the same Connect entry point and prompt identically? Worth a side-by-side comparison.
- Why is **CommCare Apps** disabled? Presumably because no CommCare app (CCZ) is currently installed on the device — the snapshot is Connect-only. Tapping it would presumably be a no-op or surface an empty-state.
- The `notification_view` has a small red dot in the screenshot (unread badge). Confirm whether tapping shows opp-invite notifications + whether tapping a notification card claims that opp directly (the "notification-based claim" flow the user explicitly said we should NOT use).

---

## 2. `connect_fragment_jobs_list`

Connect's "Opportunities" screen — the list view of opps the user has been invited to. Cards have a `rootCardView` container and a `"View Opportunity"` button per card.

**Activity:** `org.commcare.activities.connect.ConnectActivity`.
**Fragment container:** `id/nav_host_fragment_connect`.
**Screen container:** `id/connect_fragment_jobs_list`.

Reached from `screen_first_start_main` → nav drawer "Opportunities" → PersonalID PIN unlock.

### Toolbar (top)

| Element | Selector | Notes |
|---|---|---|
| Navigate up arrow | `content-desc="Navigate up"` ImageButton at `[0,136][147,283]` | Back to setup activity. |
| Title | TextView text `"Connect"` | Static. |
| Notifications | `id/action_bell` (`content-desc="Notifications"`) at `[826,146][953,272]` | Bell icon; opens the Connect notifications panel. Small red unread badge visible in the screenshot. |
| Sync | `id/action_sync` (`content-desc="Sync"`) at `[953,146][1080,272]` | Cloud icon. Forces a re-pull of the opp list from Connect. Tap this AFTER the device-clock-fix prereq, never before. |

### Body — populated state

When the list has cards:

| Element | Selector | Notes |
|---|---|---|
| Section header | `id/tv_section_header` text `"New Opportunities"` | Static section label. |
| Each card | `id/rootCardView` FrameLayout, ~400px tall | Repeating element in `rvJobList` RecyclerView. |
| Card title | `id/tvTitle` TextView | The opp's display name. Substring of the opp's Connect-side title. |
| Card date | `id/tvDate` TextView, format `"Task ends on DD MMM, YYYY"` | Deadline display. |
| Card icon | `id/imgJobType` ImageView | Decorative job-type badge. |
| **View Opportunity button** | `id/btn_view_opportunity` Button text `"View Opportunity"` | THE clickable thing per card. Pinning by parent card text (`tvTitle`) is more stable than by button text (all buttons share the same label). |
| Progress overlay | `id/progressBar` View | Hidden until a tap on `btn_view_opportunity` triggers a network fetch. |

**Substring matching:** `tvTitle` rendered text appears to mirror the opp's display name on Connect — including punctuation, dashes, parentheses. Match it as a substring; don't try to reconstruct it from opp slug + run-id.

### Body — empty state

| Element | Selector | Notes |
|---|---|---|
| Empty-state TextView | `id/connect_no_jobs_text` text `"You haven't been invited to any opportunities yet. Once you've been invited to an opportunity, it will appear in this list."` | Visible only when `rvJobList` has zero children. |

**IMPORTANT:** if you see the empty-state text but you KNOW the user has been invited (e.g., Phase 4 just sent `connect_send_flw_invite`), the cause is one of:

1. **Device clock skew** (most common) — see [§ Prerequisites](#prerequisites). Fix clock + sync.
2. **Invite hasn't propagated yet** — Phase 4's `connect_send_flw_invite` returns `queued`; the SMS-trigger / server-side fan-out is async. Wait + sync, or poll `connect_list_invites` server-side until `delivered`.
3. **The invite is for a DIFFERENT ConnectID phone number** — verify the FLW phone on the opp's Connect-side invite list matches `${ACE_E2E_PHONE}` (the test user).

### Transitions

| Trigger | Destination | Side-effect |
|---|---|---|
| Tap `btn_view_opportunity` on a card | Opportunity detail (pre-claim) | Network fetch; `progressBar` shown briefly. |
| Tap title text on a card | (TBD — does the whole card click, or only the button?) | Test in this walk. |
| Tap `action_sync` | Re-fetches opp list; UI flashes briefly | Required after clock-fix. |
| Tap `action_bell` | Notifications panel | Separate surface; documented later. |
| Tap "Navigate up" arrow | Back to `screen_first_start_main` | |

### Card-tap semantics — VERIFIED 2026-05-14

Tapping the card TEXT (`tvTitle` or anywhere on the card body) **does NOT navigate**. The clickable elements per card are:

- `id/btn_view_opportunity` — the only on-card element with `clickable=true`. Tapping this navigates to the opp detail screen (§ 3).
- The card body (`rootCardView` FrameLayout, the title TextView, the date TextView, the icon) all have `clickable=false`. Tap events on these are no-ops at the Maestro level.

**Recipe-authoring guidance:** to tap a SPECIFIC card by its title, use Maestro's `below` matcher to scope a `btn_view_opportunity` tap to the one whose y-coordinate is below the title text:

```yaml
- tapOn:
    id: "org.commcare.dalvik:id/btn_view_opportunity"
    below:
      text: ${OPP_NAME}
```

Without scoping, an unscoped `tapOn { id: btn_view_opportunity }` taps the topmost button — usually the wrong opp when the user has multiple invites.

### Scroll behavior — VERIFIED 2026-05-14

Newest invite appears at the **BOTTOM** of `rvJobList`, not the top. The RecyclerView is `scrollable=true` and new invites are appended, not prepended. The ACE test user accumulates invites across runs (`${ACE_E2E_PHONE}` is reused), so on a typical Phase 6 dispatch you'll see 5+ cards and the run-of-interest's tile is below the initial viewport. Accumulation eventually requires rotating to a fresh demo phone (1P `AI-Agents/connect-test-user/phone`) — `OpportunityAccess` rows are not cleared by `/ace:sweep connect`, since the mobile-facing `/api/opportunity/` endpoint filters by `opportunityaccess__user` not `active`.

**Recipe-authoring guidance:** use `scrollUntilVisible(direction: DOWN, element: {text: ${OPP_NAME}}, timeout: 20000)` before any `assertVisible` / `tapOn` keyed on the target card's text.

### Remaining open questions

- Is there a second section beyond "New Opportunities" (e.g., "Active Opportunities" with claimed opps)? Adjacent `tv_section_header` in `rvJobList` could expose another section below — needs deeper scrolling test once the user has multiple claimed opps.
- What does the `id/progressBar` overlay look like during the per-card network fetch (between `btn_view_opportunity` tap and the opp-detail screen)? Does it become a structural signal we can `extendedWaitUntil(visible)` on?

---

## 3. Opportunity detail (pre-claim)

Reached from `connect_fragment_jobs_list` → tap `btn_view_opportunity` on a card. The whole screen lives inside a vertical `ScrollView` so all content below the visible viewport scrolls into view.

**Toolbar:** same as `connect_fragment_jobs_list` (Navigate up, "Connect" title, `action_bell`, `action_sync`).

**Body layout (top to bottom):**

| Element | Selector | Notes |
|---|---|---|
| Job icon | unnamed ImageView at top-left | Decorative (e.g., yellow trial-spice icon). |
| Title | `id/tv_job_title` TextView | Same `tvTitle` text as the source card. |
| Description | `id/tv_job_description` TextView | The full PDD-derived description prose. Can be paragraphs. |
| End-date | `id/tv_end_date` text `"Complete Project by DD MMM, YYYY"` | Static deadline. |
| **Start button** | `id/btn_start` Button text `"Start"` | THE claim trigger. Fires `POST /users/start_learn_app/` on tap — server-side mints the CCHQ mobile worker, links to ConnectID, then the client downloads the Learn CCZ. |
| Learn Details container | unnamed FrameLayout | Section card. Contains: |
|   "Learn Details" header | TextView (no ID) | Section title. |
|   Subtitle | TextView text `"Complete the following learn modules and assessment to earn a certificate"` | Static. |
|   Learn modules summary | `id/tv_learn_modules_list` TextView | Single TextView listing modules. **OBSERVED:** for the turmeric atomic-visit Learn app, this shows just `"1. Form walkthrough"` even though the actual Learn app, once installed, has 9 forms (8 educational + Final assessment). The pre-claim preview is a summary, not the full module list. Don't rely on this text matching the post-claim Learn app contents. |
| Delivery Details container | unnamed FrameLayout | Section card. Contains: |
|   `id/connect_delivery_title` text `"Delivery Details"` | Section title. |
|   `id/connect_delivery_subtitle` text `"Once you have completed the learning assessment, you will transition to delivery"` | Explains the gate. |
|   `id/connect_delivery_total_visits_text` (e.g. `"500 maximum Visits"`) | + icon `id/connect_delivery_visits_icon`. |
|   `id/connect_delivery_days_text` (e.g. `"122 Days to complete"`) | + icon `id/connect_delivery_days_icon`. |
|   `id/connect_delivery_max_daily_text` (e.g. `"Maximum visits per day 20"`) | + icon `id/connect_delivery_max_daily_icon`. |
|   `id/connect_delivery_budget_text` (e.g. `"Earn up to 9 USD for visit"`) | + icon `id/connect_delivery_budget_icon`. |

### Transitions

| Trigger | Destination | Side-effect |
|---|---|---|
| Tap `btn_start` | "Downloading Learn App" progress screen → `StandardHomeActivity` on completion | Fires `POST /users/start_learn_app/`. ~15–30s round-trip for fresh CCZ download. |
| Tap Navigate up arrow (toolbar) | Back to `connect_fragment_jobs_list` | |

### Notes

- This is the only surface where `id/tv_learn_modules_list` appears. After claim, the equivalent listing lives in `MenuActivity` rows (`row_txt`).
- `btn_start` is text `"Start"` (the rendered `→` arrow is a drawable, not part of the text).
- The progress indicator for the post-tap download is a fullscreen blue progress screen, not the per-card `progressBar`. See § 4.

---

## 4. Downloading Learn App

Transient progress screen between `btn_start` tap and `StandardHomeActivity`. Renders fullscreen blue with:

- Static text **"Connect"** in the title bar (back arrow + bell icons remain).
- Phone-with-heart vector illustration centered.
- Bold text **"Downloading Learn App"**.
- Horizontal progress bar with yellow fill.
- Subtext **"Step N of 14"** updating as download progresses.

Wall-clock observed: ~15s from Step 1 → Step 14 → handoff. The 14-step sequence is the CCZ download + install pipeline. The screen never blocks on user input — fully autonomous.

### Transitions

| Trigger | Destination | Side-effect |
|---|---|---|
| Auto on completion | `StandardHomeActivity` | The Learn CCZ is now installed locally and the home grid surfaces it. |

### Recipe-authoring guidance

A recipe that taps `btn_start` should:

1. Wait up to ~60s for `StandardHomeActivity` to take focus (resource-id signal: `connect_login_button` is NOT present, `home_gridview_buttons` IS).
2. Do NOT poll the "Step N of 14" text — it's not a stable structural signal and substring-matching against numbers is brittle.
3. Fall back: if the progress screen sticks > 60s, screenshot + halt with the visible Step number + a logcat tail.

---

## 5. `StandardHomeActivity` (CommCare app home)

CommCare's standard home activity, post-CCZ-install. This is the SAME activity used by any CommCare app — not a Connect-specific surface. Hosts a 4-tile action grid.

**Activity:** `org.commcare.activities.StandardHomeActivity`.
**Title:** truncated form of the opp+app name, e.g. `"Turmeric Market Survey — Lea..."`. Full text inside `id/tv_job_title` on the project card.

### Toolbar

| Element | Selector | Notes |
|---|---|---|
| Hamburger | `content-desc="Open navigation drawer"` ImageButton at top-left | Opens the CommCare nav drawer (different drawer from § 1 — this drawer is per-app). |
| Title | TextView, e.g. `"Turmeric Market Survey — Learn (turmeric)"` | Suffix `" — Learn"` or `" — Deliver"` distinguishes which app is loaded. |
| More-options | `content-desc="More options"` ImageView at top-right | Standard 3-dot menu. |

### Body — project card

| Element | Selector | Notes |
|---|---|---|
| Project card container | `id/viewJobCard` FrameLayout | Card at top of scroll view. |
| Title | `id/tv_job_title` (note: SAME id as on opp detail — overloaded) | Full opp name, e.g. `"Turmeric Market Survey — turmeric (2026-04-29)"`. |
| Description | `id/tv_job_description` (same id as opp detail) | Short description (e.g. `"Turmeric vendor market survey pilot"`). |
| End date | `id/connect_job_end_date` text `"Complete Project by DD MMM, YYYY"` | Different ID than the pre-claim `tv_end_date` (`connect_job_end_date` here vs `tv_end_date` on § 3). |

### Body — 4-tile action grid (`id/home_gridview_buttons` RecyclerView)

Repeating `id/home_card` FrameLayout, each containing a clickable `id/card` RelativeLayout with:

- `id/card_image` — icon
- `id/card_text` — label
- `id/card_subtext` — optional status text below the label

The 4 tiles are (2x2 grid):

| Tile | `card_text` | `card_subtext` (observed) | Action |
|---|---|---|---|
| Top-left (green) | `"Start"` | (none) | Launches `MenuActivity` (suite root). |
| Top-right (orange) | `"View Job Status"` | (none) | Shows the project status detail page (TBD — not walked). |
| Bottom-left (blue) | `"Sync with Server"` | `"You last synced with the server: HH:MM:SS AM/PM"` initially; `"N form(s) sent to server!"` after submitting form(s) | Forces a sync of submitted form(s) up to CCHQ. |
| Bottom-right (dark) | `"Log out of CommCare"` | `"Logged In: <hq-worker-id-hex>"` | Logs out + returns to `screen_first_start_main`. |

**Stable card-tap rule:** pin to `card_text` substring, then tap the parent `id/card` container — NOT the text itself. Bounds for tap = parent `id/home_card` bounds (the visible tile is the whole FrameLayout, not just the text strip).

### Transitions

| Trigger | Destination |
|---|---|
| Tap `card_text="Start"` | `MenuActivity` showing suite root (1 row per module — § 6). |
| Tap `card_text="Sync with Server"` | Triggers HQ sync; toast `"N form sent to server!"` if there were unsynced forms; tile subtext updates. Stays on `StandardHomeActivity`. |
| Tap `card_text="View Job Status"` | TBD — separate activity. |
| Tap `card_text="Log out of CommCare"` | Confirmation dialog → on confirm, back to `screen_first_start_main`. |

### Recipe-authoring guidance

- "Start" is the entry into the Learn form sequence. Subsequent forms appear in the same `StandardHomeActivity` after returning from each form completion.
- After each form auto-submits, the device returns to `StandardHomeActivity` with the "Sync" tile updated. The recipe can either: (a) tap "Sync with Server" immediately after each form, or (b) batch all forms then sync at the end. (b) is faster.

---

## 6. `MenuActivity` (suite + form list)

CommCare's menu activity — same surface used for the suite root AND for in-suite form lists. Identical layout pattern: `id/screen_suite_menu_list` ListView with rows of `id/row_img` + `id/row_txt`.

**Activity:** `org.commcare.activities.MenuActivity` (same instance reused — drilling deeper into a submenu pushes a new `MenuActivity` onto the back stack).

### Pattern: `screen_suite_menu_list` rows

| Element | Selector | Notes |
|---|---|---|
| Row container | unnamed LinearLayout (~210px tall, full width minus 21px padding) | Whole row is tappable; tap anywhere in the bounds. |
| Row icon | `id/row_img` ImageView | Folder-style icon at left for suite entries; pencil-style for forms. |
| Row text | `id/row_txt` TextView | The module/form name (e.g. `"1. Why we are doing this"`, `"Final assessment"`). |

### Surface variants — VERIFIED 2026-05-14 retry #4 (2 menu levels)

After tapping the Start tile on StandardHomeActivity (§5), you land on the **module list** (6a). Tapping a module row drills into the **form list for that module** (6b). Tapping a form row launches FormEntryActivity (§7). Total: 2 MenuActivity surfaces between StandardHomeActivity and FormEntryActivity.

Earlier (incorrect) versions of this atlas misread 6a as a "form list" — leading recipes to chain ONE `learn-tap-module` and then tap `nav_btn_next` directly. The retry #4 walk drilled into the actual sub-menu and corrected the labeling.

**6a. Module list** — first `MenuActivity` after the StandardHomeActivity Start tap. One row per module in the Learn app.

For the turmeric Learn app the module list is (live observation 2026-05-14):
1. `"1. Survey Background & Adulteration Basics"`
2. `"2. The MTN card"`
3. `"3. Photo standardization"`
4. `"4. Color & shininess scales"`
5. `"5. Vendor consent script"`
6. `"6. Safety protocol"`
7. `"7. Vendor education script"`
8. `"8. Form walkthrough"`
9. `"Final assessment"`

Atomic-visit Learn apps from other opps may have a single "suite-root row" (e.g. `"<Opp> — Learn"`) at this level instead — a one-module app collapses. Always pin recipes to row text content, not row count or index.

**6b. Form list** — second `MenuActivity`, reached by tapping a module row. One row per form inside the module.

For module 1 ("Survey Background & Adulteration Basics") the form list is:
1. `"Background & Adulteration Basics"` — the lesson form.
2. `"Module 1 Quiz"` — the comprehension-check form.

Each module typically has 1-2 forms: a lesson + an optional quiz. The "Final assessment" module typically has a single form (the gating quiz).

Drilling into any form-list row launches `FormEntryActivity` for that form (§7).

### Transitions

| Trigger | Destination |
|---|---|
| Tap module-list row (6a) | Form list for that module (6b) |
| Tap form-list row (6b) | `FormEntryActivity` for that form (§7) |
| Tap Navigate up arrow | One step back in the menu stack (form list → module list → StandardHomeActivity) |

### Recipe-authoring implication — chain TWO `learn-tap-module` calls

A recipe driving to a specific form needs:

1. `learn-launch.yaml` → lands on module list (6a).
2. `learn-tap-module.yaml` with `MODULE_NAME` = module name (e.g. `"1. Survey Background & Adulteration Basics"`). Drills 6a → 6b.
3. `learn-tap-module.yaml` with `MODULE_NAME` = form name (e.g. `"Background & Adulteration Basics"` or `"Module 1 Quiz"`). Drills 6b → FormEntryActivity.
4. Form-entry steps (`form-advance.yaml`, etc.) operate on the now-loaded FormEntryActivity.

Net: **two** `learn-tap-module` invocations between `learn-launch` and FormEntryActivity. The historical pattern of one invocation lands the recipe on a menu list, not a form — subsequent `nav_btn_next` taps then find no button.

The `learn-tap-module.yaml` recipe is structurally generic (taps any `screen_suite_menu_list` row by text-match); the recipe COMPOSER (the `app-test-cases` skill) decides how many invocations to chain based on the app's depth.

---

## 7. `FormEntryActivity`

CommCare/ODK's form entry surface. **Same activity for every form across every CommCare app** (Learn, Deliver, anywhere). Once the selectors here are mapped, they work universally — no per-app calibration needed.

**Activity:** `org.commcare.activities.FormEntryActivity`.
**Title:** the form's display name (e.g. `"1. Why we are doing this"`).

### Toolbar

| Element | Selector | Notes |
|---|---|---|
| Navigate up | unnamed ImageButton, `content-desc="Navigate up"` | Pops back to `MenuActivity` form list. **WARNING:** popping out mid-form abandons unsaved answers (TBD: confirm). |
| Title | TextView with the form's display name | |
| More-options | `content-desc="More options"` ImageView | Standard 3-dot — typically "Save form", "Save form as", "Form hierarchy". |

### Navigation pane (below toolbar)

| Element | Selector | Notes |
|---|---|---|
| Nav pane container | `id/nav_pane` RelativeLayout | Spans full width; bounds `[0,283][1080,430]`. |
| Previous button | `id/nav_btn_prev` ImageButton | Left-edge arrow / X icon. Disabled on first question. |
| Progress bar | `id/nav_prog_bar` ProgressBar | Indicates position within form. Fills as you advance. |
| Next button | `id/nav_btn_next` ImageButton | Right-edge arrow `>` icon. On the LAST question, tap finalizes + auto-submits the form. |

### Body (`id/form_entry_pane`)

A `ScrollView` wrapping `id/odkview_layout` containing the current question's widgets. The widget set is question-type-specific:

**Type: text/heading (no input — informational)**
- `id/text_container` → `id/text` → unnamed TextView with the rendered question prose.
- The TextView text contains the question label + body joined with `\n\n`.
- Tapping `nav_btn_next` always advances.

**Type: `select_one` (radio button — single selection from a list)**
- For each option: `RelativeLayout` (clickable) → `id/text_container` → `id/text` → `RadioButton` with the option label as its `text` attribute.
- Required-input violation banner: `id/warning_root` FrameLayout → `id/message` TextView text `"Sorry, this response is required!"` (visible only after a `nav_btn_next` tap with no selection).
- Tapping a radio updates state; tap `nav_btn_next` to advance.

**Other types (TBD — not exhaustively walked this session):**
- `select_multi` (checkboxes) — multiple selections from a list. Selectors TBD.
- Text-input — `EditText` widget. Selectors TBD.
- Integer-input — `EditText` with numeric IME. Selectors TBD.
- Photo capture — opens camera; `take_photo_button` / `save_photo_button` already documented in `mcp/mobile/selectors/connect-2.62.0.yaml`. The camera flow is its own sub-flow.
- GPS auto-capture — typically no widget visible; the form silently captures location on entry. May surface a permission prompt the first time.

### Form completion (auto-finalize)

Tapping `nav_btn_next` on the LAST question of a form (after all required questions are answered):

- Form serializes to local DB.
- Returns directly to `StandardHomeActivity`.
- A "Sent" toast appears at the bottom: `"N form sent to server!"` (e.g. `"1 form sent to server!"`).
- The "Sync with Server" tile's `card_subtext` updates to reflect the same `"N form(s) sent to server!"` text.

**Important:** there is NO intermediate "Save form" confirmation screen for short Learn forms. The advance-from-last-question IS the finalize action. (TBD: is this the same for the Final Assessment, or does that branch on quiz-pass/fail before finalizing?)

### Transitions

| Trigger | Destination |
|---|---|
| Tap `nav_btn_next` on non-last question | Same activity, next question rendered |
| Tap `nav_btn_next` on last question (validated) | `StandardHomeActivity` with submission toast |
| Tap `nav_btn_next` on required question without input | Same activity, `warning_root` banner shown |
| Tap `nav_btn_prev` | Same activity, previous question rendered (disabled on Q1) |
| Tap Navigate up arrow | Pops back to `MenuActivity` form list — for Deliver-side forms, surfaces the **Exit Form dialog** (§ 7.1) instead. |

### 7.1. Exit Form dialog (Deliver-side mid-form back)

VERIFIED 2026-05-14 (delivery-walk session — Deliver-side Vendor Visit form).

When the user presses the system back / Navigate-up arrow while inside a Deliver-side form with any pending input, CommCare interposes a confirmation dialog instead of immediately popping. Same dialog widget that other CommCare flows use; documented here because it's load-bearing in Phase 6 recipes (any mid-form recovery needs to dismiss it).

| Element | Selector | Notes |
|---|---|---|
| Dialog title | `id/dialog_title_text` TextView text `"Exit Form?"` | |
| `STAY IN FORM` button | `id/choice_dialog_panel` Button, `text="STAY IN FORM"` | Default selection (`selected="true"`). |
| `EXIT WITHOUT SAVING` button | `id/choice_dialog_panel` Button, `text="EXIT WITHOUT SAVING"` | Note: **both buttons share the same resource-id** (`id/choice_dialog_panel`) — scope by text-match, not by id alone. |

Tap `EXIT WITHOUT SAVING` to abandon and pop back to the `MenuActivity` form list (§ 11). Tap `STAY IN FORM` to dismiss the dialog and remain on the current question.

---

## 8. Opportunity detail (post-Learn-complete) — certificate

VERIFIED 2026-05-14 (delivery-walk session).

The opp-detail surface reached by tapping `Resume` on a 50%-progress In-Progress card after the Learn-side Final Assessment has been passed and synced **but before the Deliver CCZ is downloaded.** Transient one-time gate — once the Deliver app is installed (§ 10 reachable), Resume bypasses this surface entirely and goes straight to Deliver `StandardHomeActivity`. The post-Deliver-download equivalent is the **View Info bottom-sheet** (§ 8.5).

**Activity:** Connect-side opp-detail screen (resource-IDs TBD — not yet dump-captured; this screen was navigated by coordinate-taps captured from screenshots, and the surface is no longer reachable from this opp's current state to re-dump. A future opp run mid-window between Learn-pass and Deliver-download will need to capture it).

### Visible content

- Title bar with the opp's display name (e.g. "Turmeric").
- Body: a certificate-style block.
  - Heading: "Congratulations, ACE Test!" (or the registered user's name).
  - Body text: "You have successfully completed the Learn modules for **Turmeric**."
  - Metadata line: `Completed on: <DD MMM, YYYY>` (e.g. `14 May, 2026`).
- Footer CTA button: `VIEW OPPORTUNITY DETAILS`, centered, full-width.
  - Live tap point captured at `(540, 1486)` on a 1080x2400 device.

### Transitions

| Trigger | Destination |
|---|---|
| Tap `VIEW OPPORTUNITY DETAILS` | § 9 — Download Delivery gate |
| Tap `Navigate up` / system back | Connect-side opp list (`connect_fragment_jobs_list`) |

### Open questions for this screen

- Resource-IDs not captured (taps were by coordinate). The surface is transient — a future opp at the Learn-pass / pre-Deliver-download stage will be needed to dump it. Best opportunity is during Phase 6 J5 the moment after the Final Assessment passes and before the operator advances.
- Does this screen appear before OR after the Final-Assessment-pass score syncs to Connect? Observed live AFTER `Sync with Server` was tapped on the Learn home; the certificate did not appear until sync completed. (Worth confirming whether a slow sync would show a partial state.)

---

## 8.5. Opportunity detail (post-Deliver-download) — View Info bottom-sheet

VERIFIED 2026-05-14 (delivery-walk session).

The post-Deliver-download replacement for § 8. Reached by tapping `btn_view_info` on the In-Progress card in the Connect-side opp list (`connect_fragment_jobs_list`). The opp-list `btn_resume` no longer surfaces the certificate after Deliver is installed — it now lands directly on Deliver `StandardHomeActivity` (§ 10).

**Surface:** a Material `BottomSheetDialog` overlayed on the opp-list surface. Two components: (a) a four-stage opp-progress widget at the top, (b) a Delivery Details info card at the bottom.

### (a) Opp-progress widget — `id/include_job_progress`

Horizontal row of four stage indicators with three connecting lines between them. Each stage has an icon + a progress-bar:

| Stage | Icon | Progress bar | Connecting line (to next) |
|---|---|---|---|
| 1. New opportunity (claim) | `id/iv_new_opp` ImageView | `id/pb_new_opp` ProgressBar | `id/iv_first_line` |
| 2. Learn | `id/iv_learn` ImageView | `id/pb_learn` ProgressBar | `id/iv_second_line` |
| 3. Delivery | `id/iv_delivery` ImageView | `id/pb_delivery` ProgressBar | `id/iv_third_line` |
| 4. Review | `id/iv_review` ImageView | `id/pb_review` ProgressBar | (terminal — no next-line) |

All four icons are `clickable="false"` — pure visual indicators, NOT navigable. The icon tint reflects the stage's completion state (filled = complete, dim = locked, in-progress hue = mid). Recipes wanting to assert "user is in stage N" should read the bar fill of `pb_<stage>` rather than visual icon state.

### (b) Delivery Details card

| Element | Selector | Live value (turmeric opp) |
|---|---|---|
| Title | `id/connect_delivery_title` TextView | `"Delivery Details"` |
| Sub-label | `id/connect_review` TextView | `"Review the delivery details"` |
| Total visits — icon | `id/connect_delivery_visits_icon` | — |
| Total visits — text | `id/connect_delivery_total_visits_text` | `"500 maximum Visits"` |
| Days to complete — icon | `id/connect_delivery_days_icon` | — |
| Days to complete — text | `id/connect_delivery_days_text` | `"122 Days to complete"` |
| Max daily visits — icon | `id/connect_delivery_max_daily_icon` | — |
| Max daily visits — text | `id/connect_delivery_max_daily_text` | `"Maximum visits per day 20"` |
| Per-visit budget — icon | `id/connect_delivery_budget_icon` | — |
| Per-visit budget — text | `id/connect_delivery_budget_text` | `"Earn up to 9 USD for visit"` |

Container resource-id: `id/connect_delivery_details_container`. Bottom-sheet root: `id/design_bottom_sheet` inside `id/coordinator`. Outside-tap dismiss target: `id/touch_outside`. Explicit close: `id/imgCloseDialog` (X glyph, top-right of the sheet).

### Transitions

| Trigger | Destination |
|---|---|
| Tap `imgCloseDialog` or outside the sheet | Dismiss; return to `connect_fragment_jobs_list` |
| System back | Dismiss; return to `connect_fragment_jobs_list` |
| Stage icons (`iv_*`) | No-op — not clickable |

### Recipe-authoring guidance

- This sheet is the most reliable place to read the opp's **operational parameters** (max visits, max daily, budget, days). Recipes that need to assert "the opp's daily cap is 20" should pattern-match on `id/connect_delivery_max_daily_text` rather than scraping the Sync tile's `card_subtext` on `StandardHomeActivity` (which only shows the consumed count, not the cap).
- To detect "Learn complete, Deliver active" without navigating into the CommCare app, read `id/pb_learn` (full) + `id/pb_delivery` (partial / non-empty) from this sheet. Cheaper than reaching the Deliver-mode `StandardHomeActivity`.

### Open questions for this screen

- Stage-icon tint state machine — what exact tints correspond to "not started / in progress / complete / locked"? Worth dumping at multiple opp states (fresh-claim, mid-Learn, Learn-complete-pre-Deliver, mid-Deliver, Review).
- `id/connect_review` label says `"Review the delivery details"` — is this clickable to navigate to Stage 4 (Review)? Did not exercise this session.

---

## 9. Download Delivery gate

VERIFIED 2026-05-14 (delivery-walk session).

A single-screen handoff between Learn-completion and the Deliver-side app download. Functionally analogous to § 4 (Downloading Learn App) but for the Deliver CCZ.

**Activity:** TBD (coordinate-based interaction; dump pending follow-up).

### Visible content

- Title: identifies the opp ("Turmeric") and the Deliver phase.
- Body: brief instructions explaining that the Deliver app needs to be downloaded to start collecting visits.
- Single CTA: `DOWNLOAD` button, mid-right area of the screen.
  - Live tap point captured at `(741, 1248)` on a 1080x2400 device.

### Transitions

| Trigger | Destination |
|---|---|
| Tap `DOWNLOAD` | Deliver-CCZ install progress (likely the same `Step N of M` progress UI as § 4, but downloading the Deliver app instead of Learn); on completion, lands directly on § 10 `StandardHomeActivity` in Deliver mode. |
| Tap `Navigate up` / system back | Back to § 8 certificate screen. |

### Open questions for this screen

- Confirm whether the in-progress download surface is the same `Step N of M` progress UI as § 4 (Learn download). Visually it appears identical, but selectors not dumped.
- What happens if the Deliver download is interrupted (network drop)? Does the gate re-appear, or does the user land mid-install with a resume option?

---

## 10. `StandardHomeActivity` (Deliver mode)

VERIFIED 2026-05-14 (delivery-walk session, resource-IDs dumped).

**Same activity as § 5** with the Deliver CCZ loaded — the 4-tile grid is structurally identical. The Deliver-mode home adds a dedicated **project-card progress widget** at the top of the body that doesn't exist in Learn mode. That widget is the load-bearing differentiator, not the toolbar title or `card_subtext`.

**Activity:** `org.commcare.activities.StandardHomeActivity` (identical to § 5).
**Toolbar title:** full text in the `TextView` is `"<opp> — Deliver (turmeric)"` (e.g. `"Turmeric Market Survey — Deliver (turmeric)"`). The toolbar visually truncates it to `— Deli…` on a 1080-wide device, but the underlying `text` attribute is the full string — text-matchers should anchor on `"— Deliver"` directly, not on `"— Deli…"`.

### Project-card progress widget — `id/viewJobCard` (NEW vs § 5)

Sits above the 4-tile grid in `id/nsv_home_screen`. Exposes the Deliver opp's operational state as named widgets, not subtext strings:

| Element | Selector | Live value (turmeric, fresh-Deliver state) |
|---|---|---|
| Card container | `id/viewJobCard` | — |
| Title | `id/tv_job_title` TextView | `"Turmeric Market Survey — turmeric (2026-04-29)"` |
| Description | `id/tv_job_description` TextView | `"Turmeric vendor market survey pilot"` |
| Visit-progress label | `id/tv_primary_visit_title` TextView | `"Daily Visits"` |
| Visit-progress count | `id/tv_primary_visit_count` TextView | `"0/20"` |
| Visit-progress bar | `id/lp_primary_visit_progress` ProgressBar | (numeric fill matches count) |
| End-date | `id/connect_job_end_date` TextView | `"Complete Project by 30 Sep, 2026"` |
| Delivery-type list | `id/rdDeliveryTypeList` RecyclerView | (visit-type chip row) |

### Differentiators from Learn-mode home (§ 5)

| Surface | Learn mode (§ 5) | Deliver mode (§ 10) |
|---|---|---|
| **Project-card progress widget (`id/viewJobCard`)** | absent | **present — primary differentiator** |
| Toolbar title text (in dump) | `<opp> — Learn (<slug>)` | `<opp> — Deliver (<slug>)` |
| Sync tile `card_subtext` | `N form(s) sent to server!` after submissions | `You last synced with the server: never` (initially) — does NOT contain "Daily Visits N/M" on this surface. The daily-visits metric lives on the project-card widget, not the Sync tile. |
| Start tile target | Learn module list (§ 6) | Deliver-side module list (§ 11) — only the Vendor Visits module is present |

The 4-tile grid (Start / Job Status / Sync / Logout), grid resource-id (`id/home_gridview_buttons`), and per-tile resource-ids are identical to § 5. Recipe-authoring guidance from § 5 applies unchanged for the tile grid.

### Recipe-authoring guidance

- **To assert "we are on the Deliver home"**, check presence of `id/viewJobCard` (it's absent on the Learn home). Cheaper and more reliable than any text-match.
- **To read the daily-cap counter** ("X/Y"), read `id/tv_primary_visit_count` directly — don't pattern-match across multiple TextViews. The value is structured.
- **To assert the operational cap** (the denominator in X/Y), split `tv_primary_visit_count` on `/`. The cap also appears in the View Info bottom-sheet's `connect_delivery_max_daily_text` (§ 8.5) which is reachable without leaving the Connect-side opp list.
- **An earlier version of this section** (PR #295) recommended pattern-matching `card_subtext` for `Daily Visits N/M`. That was wrong — the visit counter is on the project-card widget, not the Sync tile. Use `id/tv_primary_visit_count` instead.

### Open questions for this screen

- Does the Job Status tile show different content in Deliver mode (visits-completed counter vs Learn-modules counter)? Not captured this session.
- Is there a structural cue (badge, distinct icon) on the Start tile when there are unfinished or rejected visits to return to?
- The `id/rdDeliveryTypeList` RecyclerView — for multi-delivery-type opps, what does each row look like? Single-row case (this opp's "Vendor Visit") not dumped.

---

## 11. `MenuActivity` (Deliver-side)

VERIFIED 2026-05-14 (delivery-walk session).

**Same activity, same `screen_suite_menu_list` pattern as § 6** — the suite-and-form-list MenuActivity reused for the Deliver-side module structure. Two-level drill identical to Learn: module list → form list → FormEntryActivity.

**Activity:** `org.commcare.activities.MenuActivity` (identical to § 6).

### Module list (level 1)

VERIFIED 2026-05-14 (resource-IDs dumped).

Toolbar title TextView text: `"Turmeric Market Survey — Deliver (turmeric)"` (full Deliver suffix; not truncated like the home-tile title).

Single tile observed:

| Tile | Row image (id) | Row text (id) | Row text value |
|---|---|---|---|
| `Vendor Visits` | `id/row_img` (folder glyph) | `id/row_txt` | `"Vendor Visits"` |

Container: `id/screen_suite_menu_list` RecyclerView (same as Learn-side § 6 — confirms § 6's pattern reuses on the Deliver side).

(Only one Deliver-side module exists for the turmeric opp. Other opps with multiple deliver-unit types would render additional tiles here.)

### Form list (level 2 — after tapping Vendor Visits)

VERIFIED 2026-05-14 (resource-IDs dumped).

Toolbar title: `"Vendor Visits"`.

Single form observed:

| Row | Row image (id) | Row text (id) | Row text value |
|---|---|---|---|
| `Vendor Visit` | `id/row_img` (pencil glyph — distinct from level-1's folder glyph) | `id/row_txt` | `"Vendor Visit"` |

Container: `id/screen_suite_menu_list` (same id as level 1). Tap launches § 12 `FormEntryActivity`.

### Recipe-authoring implication

Recipe pattern mirrors § 6: chain TWO `tapOn` operations — one for the module tile, one for the form row. Apply the same `below: text` scoping pattern that § 6 retry #4 required: `id/row_txt` is the TextView with the row label, but the **row container** is what receives the tap (the TextView itself is not directly clickable in this widget tree). Scope by `id: row_txt` for the visibility assertion, then `tapOn` the row container by anchoring `below: text "Vendor Visits"` (or whatever the row label is).

### Open questions for this screen

- Multi-form-per-module Deliver configurations (e.g. an opp with both `Vendor Visit` and a separate `Quality Check` form under one module) — not exercised this session.
- Both module-tile and form-row use `id/row_img` + `id/row_txt`. The differentiator between "this is a module — drill in" vs "this is a form — launch FormEntryActivity" is the row image glyph (folder vs pencil), which isn't a resource-id signal. Toolbar-title context disambiguates (the module-list toolbar title contains `"— Deliver"`; the form-list toolbar title is the module name).

---

## 12. Vendor Visit form-walk

VERIFIED 2026-05-14 (delivery-walk session).

Walked through the first four questions of the live `Vendor Visit` form on a registered test user. Each `FormEntryActivity` question screen was dumped and structural elements recorded. Subsequent questions beyond § 12.4 were not walked end-to-end (gated on GPS auto-capture + camera permission, which would require additional emulator setup); the surface types not exercised are listed as open questions.

The activity, navigation pane, and form-completion semantics are identical to § 7 `FormEntryActivity`. This section documents the **widget types** observed in a Deliver-side form.

### 12.1. Form intro screen (no input — informational)

Lands here on first tap of the `Vendor Visit` row from § 11.

- Header: `form_entry_group_label` TextView `"Turmeric Market Survey — Vendor Visit"` (the form's display name).
- Body: composite informational text covering:
  - **Operational caps** — `20 vendor visits per FLW per day, 5 per market per day`. Server-side enforced; the form does not gate locally.
  - **Daylight window** — visits accepted only between sunrise + 1 hour and sunset − 1 hour. Server-side verified post-submission.
  - **Before you begin** — checklist mentioning the yellow MTN reference card pre-flight; pointer to `Safety exit` as the recommended way to abort a visit.
- Widget structure: `id/text_container` → `id/text` → unnamed TextView (no inputs on this screen — matches § 7's "text/heading" widget type).
- Advance: tap `nav_btn_next`.

### 12.2. `Safety exit` — binary `select_one`

`form_entry_group_label` `"Safety exit"`.

- Question prose: `Exit visit now (safety)?` plus help text `Choose Yes only if you need to leave the visit for safety reasons. The case will close and will NOT count against the daily cap.`
- Two `RadioButton` options stacked vertically:
  - `"No — continue with visit"` — bounds `[42,907][1038,991]` (center `(540, 949)`).
  - `"Yes — exit now"` — bounds `[42,1070][1038,1154]` (center `(540, 1112)`).
- Behavior: tapping `Yes` immediately terminates the visit (case closes, form abandoned). Selecting `No` and advancing proceeds to § 12.3.
- Widget type matches § 7 `select_one` pattern — `RadioButton` widgets with the option text as the `text` attribute.

### 12.3. `Consent` — binary `select_one`

`form_entry_group_label` `"Consent"`.

- Question prose: `Read the consent script aloud to the vendor in their preferred language. Record their response below. If consent is No, the visit will end immediately, the case will close, and no further questions will be asked.` followed by `Consent given?`.
- Two `RadioButton` options:
  - `"Yes — vendor consents"` (top option, ~center `(540, 1184)` observed live).
  - `"No — vendor declines"` (bottom).
- Behavior: selecting `No` terminates the visit. `Yes` advances to § 12.4.
- Widget type matches § 7 `select_one`.

### 12.4. `Visit context` — composite multi-widget screen

`form_entry_group_label` `"Visit context"`.

Unlike Learn-mode forms (which render exactly one question per screen), this Deliver-side screen renders **three widgets in a single `id/odkview_layout`**. Each widget retains its standard `id/text_container` → `id/text` → widget-input structure.

| # | Question | Widget type | Selector |
|---|---|---|---|
| a | `Market name` (help text: "Name of the market where this vendor is located.") | text-input | `EditText` immediately below the help text. Bounds `[42,812][1038,948]` (focused state). |
| b | `GPS coordinates` (help text: "Auto-capture the vendor's location. Stand at the stall when capturing.") | GPS-coordinate (manual fallback) | Unnamed `EditText` at bounds `[42,1159][1038,1295]` for manual entry. Auto-capture may run silently on screen entry (permission prompt the first time); no explicit "Capture" button observed in the dumped hierarchy. |
| c | `Photo of turmeric with yellow MTN card visible` (help text: "Place the yellow MTN reference card directly next to the turmeric. Card must be clearly visible in the frame.") | photo-capture | Two `Button` widgets stacked: `TAKE PICTURE` (bounds `[49,1781][1031,1907]`) and `CHOOSE IMAGE` (bounds `[49,1917][1031,2043]`). |

**Validation surface when advancing without input** — tapping `nav_btn_next` with any sub-widget empty surfaces the same `id/warning_root` → `id/message` banner documented in § 7, with text `"Sorry, this response is required!"`. The banner inserts BETWEEN the offending widget and the next one (observed live: the banner appeared between the GPS `EditText` and the Photo widget when GPS was empty). All un-filled widgets get a red-tinted outer container; the per-widget container resource-id was not captured this session.

### 12.5. Question types not walked this session

Subsequent screens after § 12.4 were not walked end-to-end (would require triggering real GPS auto-capture + granting camera permission + capturing/choosing an image, none of which were set up on this emulator). Based on the form spec, the remaining questions exercise:

- 5-point color scale (`select_one` with 5 options) — same widget type as § 12.2 / 12.3.
- 5-point shininess scale (`select_one`).
- Integer-input (price, quantity) — `EditText` with numeric IME (selectors TBD).
- Final acknowledgement / "Save" — TBD whether Deliver forms auto-finalize on last-question `nav_btn_next` like § 7 documents, or whether there's an explicit Submit step.

### Recipe-authoring guidance

- **Composite-screen scoping**: when a Deliver-side screen renders multiple widgets, `tapOn` calls must scope by widget label (`below: text`) or by widget index — anchoring on `text_container` alone matches every widget on the screen. § 6 retry #4 already established the pattern; § 12.4 is the first observed composite screen where it MUST be applied.
- **GPS strategy**: prefer the manual `EditText` entry path for recipe runs (input `0.0 0.0 0 5` or similar) rather than waiting for emulator GPS to auto-capture — the auto-capture is dependent on emulated location settings that aren't part of the AVD snapshot.
- **Photo strategy**: `CHOOSE IMAGE` (picker) is more recipe-friendly than `TAKE PICTURE` (live camera) since a fixed image asset can be pre-staged on the emulator's gallery and selected deterministically. `TAKE PICTURE` requires camera-permission grant + emulator camera config.

---

## Open questions across the atlas

Outstanding screens not yet documented (need a follow-up walk):

1. ~~**Opportunity detail (post-claim)**~~ — RESOLVED in § 8. Certificate view replaces the pre-claim opp detail surface once Learn completes; the `VIEW OPPORTUNITY DETAILS` CTA hands off to § 9.
2. **Final assessment branch** — the quiz form's pass/fail flow. RESOLVED partially: a passing score (≥ threshold) syncs to Connect via the standard `Sync with Server` tile; the In-Progress card on the opp list then unlocks the Resume → Certificate (§ 8) path. The fail-path UX was not exercised — what surfaces if a learner scores below the threshold?
3. ~~**Deliver app home**~~ — RESOLVED in § 10. Same `StandardHomeActivity` as Learn; differentiate on Sync tile's `card_subtext` matching `Daily Visits N/M`.
4. ~~**Deliver units list**~~ — RESOLVED in § 11. Two-level `MenuActivity` drill (module list → form list), same as Learn-mode § 6.
5. ~~**Vendor Visit form**~~ — PARTIALLY RESOLVED in § 12. First 4 questions walked (intro + Safety exit + Consent + Visit context). Remaining 5-point scales, integer inputs, and the submission terminus still need a walk that grants camera + GPS permissions.
6. **Form submission confirmation for Deliver forms** — STILL OPEN. § 7 documents Learn-form auto-finalize; whether the multi-screen Deliver form follows the same auto-finalize path or surfaces an explicit Submit screen is untested.
7. **Notifications panel** (`action_bell`) — what notification types surface there? Does tapping a notification card claim that opp directly (the path the operator explicitly does NOT want recipes to use)?
8. **Multi-question Learn forms with non-note types** — PARTIALLY RESOLVED via § 12.4: text-input + GPS-EditText + photo-capture widget shapes documented for Deliver forms; Learn-side forms with the same widget types should follow the same patterns.
9. **Resource-IDs for Deliver-side screens (§ 8–§ 11)** — PARTIALLY RESOLVED in the follow-up dump pass (2026-05-14):
   - § 8 (certificate) — STILL OPEN. The surface is transient (vanishes after Deliver-download), and the current opp has already moved past that state. A future opp run mid-window between Final-Assessment-pass and Deliver-download will need to capture it. § 8.5 (View Info bottom-sheet) is the post-download equivalent and is fully dumped.
   - § 8.5 (View Info bottom-sheet) — RESOLVED. Full resource-IDs for the opp-stage progress widget + Delivery Details card.
   - § 9 (Download Delivery gate) — STILL OPEN. Also transient (one-time during Deliver-CCZ download). Requires uninstalling the Deliver app or capturing during another opp's Phase 6 J5.
   - § 10 (Deliver `StandardHomeActivity`) — RESOLVED. Project-card progress widget (`id/viewJobCard`) is the structural Learn-vs-Deliver differentiator; `tv_primary_visit_count` exposes the daily-visits counter as a structured value (revises the `card_subtext` text-match guidance from PR #295).
   - § 11 (Deliver-side `MenuActivity`) — RESOLVED. Both module-list and form-list use `id/screen_suite_menu_list` with `id/row_img` + `id/row_txt`; row-glyph (folder vs pencil) is the only structural signal that distinguishes a module from a form.

These should be walked in a follow-up session, ideally on a freshly-registered test user (or via faster forms — completing the comprehension gates on all 8 forms + the assessment is ~50–80 taps).

