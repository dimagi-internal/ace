# Connect 2.62.0 Mobile Navigation Atlas

**APK:** `org.commcare.dalvik` v 2.62.0 (Connect-enabled CommCare client).
**Device:** ACE_Pixel_API_34 (Pixel 6 profile, API 34, 1080x2400).
**Test user:** ACE Test (ConnectID `+74260000100`).
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
| Opportunity detail (post-claim) — TBD (gated on Learn completion) | TBD |
| Deliver units list — TBD (gated on Final Assessment pass) | TBD |
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

### Open questions for this screen

- Is there a second section beyond "New Opportunities" (e.g., "Active Opportunities" with claimed opps)? The RecyclerView is `scrollable=true` so there may be more content below — needs scrolling test.
- Does tapping the title-area of a card (not the button) navigate too? `rootCardView` itself isn't marked `clickable`, but Material card semantics often capture taps anywhere on the card body.
- What does the progress-bar overlay look like during the network fetch? Does it become a structural signal we can wait on?

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

### Surface variants

**6a. Suite root** — one row per module in the app:

For the turmeric Learn app, this is a single row:
- `row_txt` = `"Turmeric Market Survey — Learn"` (matches the menu_root id in the CCZ suite.xml).

Drilling in pushes another `MenuActivity` — the form list (6b).

**6b. Form list** — one row per form/quiz inside the module:

For the turmeric Learn app the form list (observed live) is:
1. `"1. Why we are doing this"`
2. `"2. The MTN card"`
3. `"3. Photo standardization"`
4. `"4. Color & shininess scales"`
5. `"5. Vendor consent script"`
6. `"6. Safety protocol"`
7. `"7. Vendor education script"`
8. `"8. Form walkthrough"`
9. `"Final assessment"` — the gating quiz; must be passed to transition to Deliver.

Form names match the form display labels from the Nova-built Learn app. Always pin recipes to `row_txt` text (substring or exact), never row index — adding a new form (e.g. a future "9. Refresher") shifts indices but keeps text stable.

### Transitions

| Trigger | Destination |
|---|---|
| Tap any row in 6a (suite root) | 6b (form list inside that module) |
| Tap a non-assessment row in 6b | `FormEntryActivity` for that form (§ 7) |
| Tap "Final assessment" in 6b | `FormEntryActivity` for the assessment form — same activity, but the form internally branches on quiz answers (TBD: structural distinction from a regular form) |
| Tap Navigate up arrow | One step back in the menu stack (form list → suite root → StandardHomeActivity) |

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
| Tap Navigate up arrow | Pops back to `MenuActivity` form list — TBD whether unsaved state is preserved |

---

## Open questions across the atlas

Outstanding screens not yet documented (need a follow-up walk):

1. **Opportunity detail (post-claim)** — what the opp-detail screen looks like when the user has already started Learn. Does `btn_start` change to "Continue"? Is there a progress indicator? Does the Deliver section unlock when Learn is complete?
2. **Final assessment branch** — the quiz form's pass/fail flow. What's the structural signal that the user passed? Where does the "transition to Deliver" handoff happen — auto, manual button tap, or another screen?
3. **Deliver app home** — analogous to § 5 but with delivery-specific tiles. Likely the same `StandardHomeActivity` with the Deliver CCZ loaded; the title would suffix " — Deliver" instead of " — Learn".
4. **Deliver units list** — analogous to § 6b. Each row is likely a different deliver-unit form.
5. **Vendor Visit form** — the actual atomic-visit form (20 questions, photo, GPS, color/shininess scales, consent gate). Most production-relevant flow.
6. **Form submission confirmation for Deliver forms** — does Deliver have a "Submit" button screen, or auto-finalize like Learn?
7. **Notifications panel** (`action_bell`) — what notification types surface there? Does tapping a notification card claim that opp directly (the path the operator explicitly does NOT want recipes to use)?
8. **Multi-question Learn forms with non-note types** — only `select_one` was observed this session. Real Vendor Visit forms use text input, integer input, multi-select, photo, GPS.

These should be walked in a follow-up session, ideally on a freshly-registered test user (or via faster forms — completing the comprehension gates on all 8 forms + the assessment is ~50–80 taps).

