# Connect 2.64.0 Mobile Navigation Atlas

**APK:** `org.commcare.dalvik` v 2.64.0 (`versionCode=490738`; 2.63.2 was `488693`) — the value of `DEFAULT_APK_VERSION` in `mcp/mobile/client.ts`.
**Device:** `ACE_Pixel_API_34` (Pixel 6 profile, API 34, 1080x2400), adb server port 5038 (ALLOCATED — ask `mobile_diagnose`, never assume).
**Test user:** ACE Test (`${ACE_E2E_PHONE}`, a `+7426` demo number — OTP is skipped server-side).
**Walk-through date:** 2026-09-06 (dimagi-internal/ace#1997). 34 ui-dumps under `docs/mobile-atlas/evidence/connect-2.64.0/`, plus both APKs' extracted resource-id tables.
**Calibration report:** `docs/mobile-calibration/connect-2.64.0-2026-09-06.md` — the walk's findings, coverage and residuals, in full.

## Purpose

A ground-truth navigation map of the Connect-enabled CommCare client: which screen replaces which, what fires in between, and what a transition changes that you did not ask it to change.

**This atlas is NARRATIVE. The selector map is IDENTITY, and it wins on conflict.** `mcp/mobile/selectors/connect-2.64.0.yaml` is the authoritative, per-row-provenanced source for *what a thing is called and how to match it*; every row there carries either `unverified: true` or a `Live-verified …` note naming the dump it resolves against. Grep the map for a matcher, never paraphrase one out of here.

## What 2.64.0 changed — the short version

**Zero selector drift, one new screen.** Not a single id this map uses was renamed, removed or re-valued between 2.63.2 and 2.64.0. That made the whole APK look inert to a selector-centric check — and it was not: 2.64.0 **inserts a PersonalID email step into registration**, which stranded `connect-register-from-otp.yaml` (dimagi-internal/ace#2029, `blocks-e2e`).

**"No id drift" is not "no flow drift."** The resource-table diff is what caught it, before any device time:

```
$ comm -13 <(sort -u resource-ids-2.63.2.txt) <(sort -u resource-ids-2.64.0.txt) | grep -i email
personalid_email_skip_button, personalid_email_continue_button, email_text_value,
personalid_email_verify_button, personalid_email_resend_button, …
action_personalid_backupcode_to_personalid_email     <- the nav graph names the transition
```

Both id tables are committed under `evidence/connect-2.64.0/`. `skills/connect-apk-upgrade § Step 1b` is now the durable form of this step.

Three other 2.64.0-only clusters, none of which ACE walked:

- a **PersonalID profile section** (`personalid_profile_*`, `nav_graph_personalid_profile`), carrying two renames — `image_user_profile` → `user_image`, `manage_profile` → `header_manage_profile`. No row in ACE's map referenced either old name, so nothing broke; a future row must use the new ones.
- a **rebuilt camera surface** (`camera_controls_container`, `capture_button_label`, `rectangle_overlay`, `switch_camera_lens_button`, …). The OLD `take_photo_button` / `camera_shutter_button` / `save_photo_button` ids all still exist.
- removals confined to DOTS/TB-treatment ids, which ACE does not use.

## Provenance and coverage

Every surface below is one of three states. Nothing here is an untagged assertion — an untagged claim recreates the ace#972 defect one version later.

- **`calibrated-2.64.0`** — observed on a 2.64.0 device in the 2026-09-06 walk, citing the dump.
- **`carried-from-2.63.2-unverified`** — the 2.63.2 atlas's prose is reproduced by reference; NOT re-walked on 2.64.0.
- **`uncovered`** — named, deliberately not guessed, routed somewhere.

| Surface | Evidence | Date | Confidence |
|---|---|---|---|
| § 1 First start + permission prompt | `21-first-start.xml`, `20-permission-prompt.xml` | 2026-09-06 | calibrated-2.64.0 |
| § 1 Nav drawer (`app_version` = "v 2.64.0") | `22-nav-drawer.xml` | 2026-09-06 | calibrated-2.64.0 |
| § 2 PersonalID phone entry + GMS phone-hint sheet | `23-personalid-phone-entry.xml`, `24-gms-phone-hint.xml`, `25-phone-filled.xml` | 2026-09-06 | calibrated-2.64.0 |
| § 2 App Lock / Unlock Options + system unlock | `26-app-lock-unlock-options.xml`, `27-after-agree-continue.xml`, `28-after-unlock.xml` | 2026-09-06 | calibrated-2.64.0 |
| § 2 Demo-user OTP-bypass snackbar | `28-after-unlock.xml` | 2026-09-06 | calibrated-2.64.0 |
| § 2 Name entry | `29-post-unlock-next.xml` | 2026-09-06 | calibrated-2.64.0 |
| § 2 Backup code (RECOVERY branch, single widget) | `30-backup-code-create.xml` | 2026-09-06 | calibrated-2.64.0 |
| **§ 3 The NEW email step + "Skip email?" confirm** | `31-after-backup-code.xml`, `32-after-email-skip.xml` | 2026-09-06 | calibrated-2.64.0 |
| § 3 "Account Recovered" sheet | `33-after-skip-confirm.xml` | 2026-09-06 | calibrated-2.64.0 |
| § 4 Post-registration setup + GO TO CONNECT MENU | `34-post-registration-setup.xml` | 2026-09-06 | calibrated-2.64.0 |
| § 5 Connect home jobs list (`rvJobList`) | `35-connect-home-jobs.xml` | 2026-09-06 | calibrated-2.64.0 |
| § 5 Opportunity-detail bottom sheet | `36-opp-detail.xml` | 2026-09-06 | calibrated-2.64.0 |
| § 6 `StandardHomeActivity` after Resume | `37-after-resume.xml` | 2026-09-06 | calibrated-2.64.0 |
| § 6 `MenuActivity` grid, two levels | `38-suite-menu.xml`, `39-after-module-tap.xml` | 2026-09-06 | calibrated-2.64.0 |
| § 6 `FormEntryActivity` (select-one + free text) | `40-form-entry.xml`, `41-form-question-1.xml`, `42-form-question-2.xml` | 2026-09-06 | calibrated-2.64.0 |
| § 6 "Exit Form?" choice dialog | `43-form-exit-dialog.xml` | 2026-09-06 | calibrated-2.64.0 |
| § 7 Version-upgrade prompt (`prompt_title` / `do_later_button`) | 2.63.2 failure capture; **dormant on 2.64.0** — see § 7 | 2026-09-05 | calibrated on 2.63.2, **unverifiable on 2.64.0** |
| Fresh-SIGNUP registration branch (`confirm_code_view`, photo capture) | — | — | **uncovered** — needs a demo phone with no server-side account |
| Device-lock SETUP branch (`lock_pin`, `password_entry`) | — | — | **uncovered** — the device already carried a PIN |
| The rebuilt 2.64.0 camera surface | — | — | **uncovered** — routed to a Phase 6 photo-question walk |
| Learn assessment + result, Deliver download gate, case list, geopoint, date picker, repeat junctures | — | — | **uncovered** — need a fresh `/ace:run` opp; Learn completion is one-way per `(test user, opportunity)` (#568) |
| Real-OTP entry, unclaimed-opp cards, pre-claim opp detail | — | — | carried-from-2.63.2-unverified |

## § 1–2 Registration, up to the backup code

Unchanged from 2.63.2 in both identity and sequence. Two things worth stating because they are timing, not structure:

- **The demo-user snackbar surfaced AFTER the system unlock**, not immediately after CONTINUE (`28-after-unlock.xml`). A fixed post-CONTINUE wait can miss it entirely; the recipe's `runFlow when: visible` guards are correct and a hard wait would not be.
- **The App Lock screen can flash past** a 15s `extendedWaitUntil` on a re-registration where the system lock already exists. That is why every upstream step in `connect-register-from-otp.yaml` is conditional and the recipe's only hard assert is the terminal one.

`30-backup-code-create.xml` shows `connect_backup_code_button` arriving `enabled=false` and flipping `enabled=true` once six digits land in `backup_code_view`.

## § 3 The new PersonalID email step — the one flow change

**This is the surface that broke registration on 2.64.0.**

### 3.1 The email screen (`31-after-backup-code.xml`)

Reached from the backup-code screen by tapping CONTINUE (`connect_backup_code_button`). On 2.63.2 that tap went straight to "Account Recovered"; on 2.64.0 it lands here. The nav graph says so itself: `action_personalid_backupcode_to_personalid_email`.

```
toolbar                          "Email"
personalid_email                 "Add your email (optional)"
                                 "Your email helps you recover your account if you lose access to your phone."
email_text_value                 hint "Email address"          (EditText)
personalid_email_skip_button     "SKIP FOR NOW"   [13,1169][527,1326]
personalid_email_continue_button "CONTINUE"       enabled=false until an address is entered
```

**Reachable transitions:**

| Trigger | Goes to | ACE uses it? |
|---|---|---|
| `personalid_email_skip_button` | the "Skip email?" confirm dialog — **NOT out of the screen** | yes |
| `personalid_email_continue_button` (after filling `email_text_value`) | the email-VERIFICATION leg | **no — deliberately unmapped** |

**Side effect worth naming: SKIP FOR NOW does not skip.** It raises a confirmation. A recipe that taps it and then waits for the next real surface strands — which is precisely the ace#2029 failure, one tap short.

**The verification leg is a fork, not a detour.** `personalid_email_verification_fragment`, `personalid_email_verify_button`, `personalid_email_resend_button`, `personalid_resend_countdown_text`, `otp_code_view` all ship in 2.64.0, and four nav actions leave these two screens (`action_personalid_email_to_personalid_{email_verification,message,photo_capture}`, `action_personalid_email_verification_to_personalid_{message,photo_capture}`). Entering an address changes which screen you land on. ACE never fills the field, and the map deliberately covers only the skip path. Do not author against the verification leg without walking it.

### 3.2 The "Skip email?" confirmation (`32-after-email-skip.xml`)

CommCare's generic choice dialog — the same `dialog_title_text` component as "Exit Form?", which makes that component **load-bearing during registration** on 2.64.0, not just during form entry.

```
dialog_title    "Skip email?"
dialog_message  "Are you sure you want to skip?"
negative_button "NO"    [493,1317][724,1454]
positive_button "YES"   [758,1317][989,1454]
```

**NO is a named anti-target.** It returns to the email form, where the walk then strands exactly as if the dialog had never been answered — indistinguishable, downstream, from having no handler at all.

ACE matches YES by **text**, not by `positive_button`: the two buttons are otherwise identical chrome and the ids alone do not say which is which.

### 3.3 Out of the email step

YES advanced straight to the "Account Recovered" sheet (`33-after-skip-confirm.xml`: `connect_message_title` "Account Recovered", `connect_message_message` "Your account has been recovered! You may resume using PersonalID.", `connect_message_button` "OK"). On a truly FRESH signup the nav graph routes email → photo capture instead; that branch is **uncovered**.

### 3.4 The full 2.64.0 registration sequence

```
phone -> [OTP skipped, demo snackbar] -> App Lock -> system unlock -> name
-> backup code -> EMAIL (new) -> "Skip email?" YES (new) -> Account Recovered
-> OK -> GO TO CONNECT MENU -> unlock -> rvJobList
```

Handled by the guarded email block in `mcp/mobile/recipes/static/connect-register-from-otp.yaml`. The block uses RAW ids rather than `${SELECTOR:}` on purpose: a placeholder is resolved before Maestro sees the recipe, and these rows exist only in `connect-2.64.0.yaml`, so a rollback to the 2.63.2 pin would fail at RESOLVE time instead of harmlessly skipping the guard. The recipe's own header explains it.

## § 4–6 Post-registration, Connect home and CommCare

Identity is unchanged from 2.63.2 across this whole cluster, and the sequence was re-walked:

- `34-post-registration-setup.xml` — registration lands on **`CommCareSetupActivity`** ("Welcome to CommCare!") with the Connect nav drawer, NOT directly on the jobs list. `GO TO CONNECT MENU` is the transition, then an "Unlock PersonalID" PIN prompt may interpose.
- `35-connect-home-jobs.xml` — `connect_fragment_jobs_list` / `rvJobList` holding multiple `rootCardView` tiles, with `action_sync` and `action_bell` in the toolbar. **`rvJobList` remains the correct terminal anchor** for the registration recipe on 2.64.0.
  **No bottom navigation bar rendered on `ConnectActivity`** in this walk, so `home-opportunities-tab` is demoted to `unverified` in the map. Reproducing it needs a device with unclaimed opportunities.
- `36-opp-detail.xml` — the opportunity-detail bottom sheet, `connect_delivery_*` cluster intact.
- `37-after-resume.xml` — Resume goes to `StandardHomeActivity`. **A fresh CCZ install on this wiped device went straight there with NO version-upgrade prompt** (see § 7).
- `38-suite-menu.xml` / `39-after-module-tap.xml` — `MenuActivity` in GRID mode (`grid_menu_grid`, `row_img`), two levels deep.
- `40`–`42` — `FormEntryActivity` (`form_entry_pane`, `nav_btn_prev` / `nav_btn_next`) across a select-one and a free-text question.
- `43-form-exit-dialog.xml` — "Exit Form?" via `choice_dialog_panel` / `choices_list_view`.

## § 7 The version-upgrade prompt is DORMANT on 2.64.0, not gone

`prompt_title` / `action_button` / `do_later_button` fire only on version **SKEW** — the live 2.63.2 capture read *"The application requires CommCare version 2.64.0. You are currently running 2.63.2."* Installing 2.64.0 removes the precondition, so the surface **cannot be made to appear on a 2.64.0 device** and is structurally unverifiable from here. Tested rather than assumed:

```
$ grep -l "prompt_title\|do_later_button" docs/mobile-atlas/evidence/connect-2.64.0/*.xml
(no matches)
```

The three rows are carried in the map flagged `unverified` so the surface stays addressable when a CCZ next requires 2.65.0. **`commcare-version-update-now` is a named anti-target**: tapping it leaves CommCare for the Play Store and strands the walk off-app. See `skills/connect-apk-upgrade § B6 in full` for why this check belongs to the NEXT upgrade's Step 0, not this one's checklist.

## Prerequisites

### AVD device-clock invariant — **CARRIED OVER, not re-walked on 2.64.0**

Reproduced by reference from `docs/mobile-atlas/connect-2.63.2.md § Prerequisites`. It is a snapshot/clock mechanism, not an APK-version mechanism, so the 2.63.2 → 2.64.0 upgrade would not be expected to change it — but it has not been re-observed and is tagged `carried-from-2.63.2-unverified`. Implemented as `AvdBackend.syncDeviceClockToHost`.

### Google Play Services

`mobile_ensure_avd_running` deliberately leaves GMS **disabled** so in-app face capture falls back to ManualMode. A hand-driven PersonalID walk must re-enable it first — `adb shell pm enable com.google.android.gms` — or `PersonalIdActivity` shows an "Enable Google Play services" dialog that reads as broken registration. **`pm enable-user` does not exist**; only `disable-user` does.

## Residuals

Carried from `docs/mobile-calibration/connect-2.64.0-2026-09-06.md § Residuals`; do not drop them on the next bump.

| # | Residual | What would close it |
|---|---|---|
| R1 | 45 of 91 map rows unverified | A full Phase 6 walk on a fresh `/ace:run` opp (Learn + Deliver + case list + geopoint + photo) |
| R2 | Fresh-signup registration branch unwalked | A demo-user rotation to a phone with no server-side account |
| R3 | Device-lock SETUP branch unwalked | An AVD wiped with no prior registration having set a system PIN |
| R4 | The rebuilt 2.64.0 camera surface unexamined | Walk registration photo capture, or an in-form photo question |
| R5 | `home-opportunities-tab` demoted — no bottom nav bar rendered | Walk Connect home with unclaimed opportunities |
| R6 | `selector-map-calibrate` was NOT used — the walk was hand-driven | Run it against 2.64.0 and reconcile against this map |
