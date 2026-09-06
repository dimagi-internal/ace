# CommCare 2.64.0 — selector-map calibration report

**Date:** 2026-09-06 · **Device:** `ACE_Pixel_API_34` / `emulator-5554`, adb server port **5038**
**Scope:** harvest + map only. No pins flipped, no PR, no ship. Issue: dimagi-internal/ace#1997.

## Device provenance

```
$ ANDROID_ADB_SERVER_PORT=5038 adb -s emulator-5554 shell \
    dumpsys package org.commcare.dalvik | grep versionName
    versionName=2.64.0        # versionCode=490738  (2.63.2 was 488693)
```
Corroborated in-app: the nav drawer footer reads `app_version = "v 2.64.0"`
(`34-post-registration-setup.xml`).

## Product

`mcp/mobile/selectors/connect-2.64.0.yaml` — **91 rows: 46 verified, 45 unverified.**

- 83 rows inherited from `connect-2.63.2.yaml`. **None dropped, no value drift.**
- 41 of those 83 re-observed live and re-annotated with the dump they resolve against.
- 5 rows **new**: the 2.64.0 PersonalID email step.
- 3 rows **added**: the CommCare version-upgrade prompt (ace#1998), flagged unverified.

34 ui-dumps + the two extracted resource-id lists are committed under
`docs/mobile-atlas/evidence/connect-2.64.0/`.

## What changed in 2.64.0

### 1. A new PersonalID email step — the only change that breaks a recipe

Between the backup-code screen and whatever follows it. All five ids are absent
from 2.63.2's resource table and present in 2.64.0's. Dismissing it takes **two
taps**: `personalid_email_skip_button` ("SKIP FOR NOW") raises a "Skip email?"
dialog whose `positive_button` ("YES") must then be tapped.

`connect-register-from-otp.yaml` has no handler and strands there —
**dimagi-internal/ace#2029**, `blocks-e2e`.

An entire email-**verification** leg ships alongside (`otp_code_view`,
`personalid_email_verify_button`, `personalid_email_resend_button`, …) and is
deliberately unmapped: ACE only needs the skip path, and the surface was never
rendered.

### 2. A PersonalID profile section, with a rename

`image_user_profile` → `user_image`, `manage_profile` → `header_manage_profile`,
plus a whole `personalid_profile_*` / `profile_*` family and
`nav_graph_personalid_profile`. **No row in the map referenced either old name**,
so nothing broke; a future row must use the new ones.

### 3. A rebuilt camera surface

`camera_controls_container`, `camera_capture_instructions`,
`camera_capture_mode_indicator`, `capture_button_label`, `capture_progress`,
`rectangle_overlay`, `switch_camera_lens_button` — all 2.64.0-only. The OLD
`take_photo_button` / `camera_shutter_button` / `save_photo_button` ids all
still exist. **Not walked**; the photo rows are demoted to unverified and say so.

### 4. Nothing else that touches ACE

Removed in 2.64.0: only DOTS/TB-treatment ids plus the two profile renames.

## Registration: it works, and the earlier claim was right for the wrong reason

Commit `3cb37af5` recorded in its message that 2.64.0 adds a "new PersonalID
email step". **The artifacts it committed did not show that** —
`10-registration-stuck.xml` holds one text node, "Please wait a few moments.",
and `11-after-wait.xml` shows a system "Location Data Disabled" dialog. That
run hung on the post-CONTINUE server call and never reached the email screen.

Walking it on a clean device settled it: **the email step is real, and it is
new.** The conclusion was right; the evidence was not. Both halves matter —
an assertion the artifact does not show is unsafe even when it happens to be
true, because nothing downstream can tell the difference.

The hang itself did **not** reproduce. Registration advanced from CONTINUE to
the App Lock screen in under 3 seconds and completed end to end:

```
phone -> [OTP skipped, demo snackbar] -> App Lock -> system unlock
-> name -> backup code -> EMAIL (new) -> "Skip email?" YES (new)
-> Account Recovered -> OK -> GO TO CONNECT MENU -> unlock -> rvJobList
```

This walk took the **RECOVERY** branch (the +7426 demo phone already had a
server-side account). The fresh-signup branch — the one that renders
`confirm_code_view` and then photo capture — was **not** reached and is
recorded as unverified.

## Coverage

**Walked:** first-start · nav drawer · phone entry · GMS phone-hint sheet ·
App Lock / Unlock Options · system unlock · demo snackbar · name entry ·
backup code (recovery) · email step + skip confirm · Account Recovered ·
post-registration setup · Connect jobs list · opp-detail bottom sheet ·
StandardHomeActivity · MenuActivity (grid, two levels) · FormEntryActivity
(select-one + free-text) · Exit Form dialog.

**Not walked, and why:** fresh-signup backup-code create · registration photo
capture · real OTP entry · device-lock SETUP (the device already carried a PIN)
· unclaimed-opp cards · pre-claim opp detail · Learn assessment + result ·
Deliver download gate · case list · in-form camera · geopoint · date picker ·
repeat junctures. **Most need a fresh `/ace:run` opportunity.** Learn completion
is one-way per `(test user, opportunity)` (#568), so they cannot be harvested
off a borrowed one.

## The version-upgrade prompt (ace#1998) is dormant, not gone

The prompt fires only on version **skew** — the live 2.63.2 capture read *"The
application requires CommCare version 2.64.0. You are currently running
2.63.2."* Installing 2.64.0 removes the precondition.

Tested, not assumed: a fresh CCZ install on a wiped device went straight to
`StandardHomeActivity` (`37-after-resume.xml`), and

```
$ grep -l "prompt_title\|do_later_button" docs/mobile-atlas/evidence/connect-2.64.0/*.xml
(no matches)
```

The three rows are added and flagged unverified so the surface stays
addressable when a CCZ next requires 2.65.0. `commcare-version-update-now` is
recorded as a **named anti-target**: tapping it leaves CommCare for the Play
Store and strands the walk off-app.

## Residuals

| # | Residual | What would close it |
|---|---|---|
| R1 | 45 of 91 rows unverified | A full Phase 6 walk on a fresh `/ace:run` opp (Learn + Deliver + case list + geopoint + photo) |
| R2 | Fresh-signup registration branch (`confirm_code_view`, photo capture) unwalked | A demo-user rotation to a phone with no server-side account |
| R3 | Device-lock SETUP branch (`lock_pin`, `password_entry`) unwalked | An AVD wiped with no prior registration having set a system PIN |
| R4 | The rebuilt 2.64.0 camera surface is unexamined | Walk registration photo capture, or an in-form photo question |
| R5 | `home-opportunities-tab` demoted — no bottom nav bar rendered on ConnectActivity | Walk the Connect home on a device with unclaimed opportunities |
| R6 | ace#2029's recipe fix is unwritten and unvalidated | Add the skip branch, stage via `ACE_MOBILE_STATIC_RECIPES_DIR`, re-run registration |
| R7 | `selector-map-calibrate` was NOT used — this walk was hand-driven | Run it against 2.64.0 and reconcile against this map |

## Review of `skills/connect-apk-upgrade` — first execution

The skill had never been run. Seven findings, ordered by what they cost.

**1. There is no step that gets the new APK onto the device — and it is needed
BEFORE calibration, not after.** Step 2 says calibrate against a live device;
Step 7 flips `.env` + restarts. But `mobile_ensure_avd_running` installs the
version named by `ACE_CONNECT_APK_VERSION` **in the installed `.env`**, read by
the live MCP subprocess **at its own startup**. Editing `DEFAULT_APK_VERSION`
in the repo does nothing to a device walk. So Step 2 as written calibrates the
OLD APK. This cost the first ten minutes of the walk and is silent: the
bootstrap reports success, and the device runs 2.63.2 while the branch says
2.64.0. The out-of-band swap that works:

```bash
adb -s <serial> uninstall org.commcare.dalvik
adb -s <serial> install -r "$TMPDIR/ace-mobile-apk-cache/commcare-<new>.apk"
adb -s <serial> shell dumpsys package org.commcare.dalvik | grep versionName
```

Needs a new **Step 2.0**, with the verify line as part of it.

**2. GMS must be re-enabled before any hand-driven PersonalID walk, and the
command in everyone's muscle memory does not exist.** `mobile_ensure_avd_running`
leaves GMS **disabled** (face-capture ManualMode). `PersonalIdActivity` then
refuses to render, showing an "Enable Google Play services" AlertDialog with a
single ENABLE button — which reads as a broken registration, not a device
setting. Fix: `adb shell pm enable com.google.android.gms`. Note
`pm enable-user` returns `Unknown command` — only `disable-user` exists, and
`backends/avd.ts:1592` already uses the right asymmetric pair.

**3. Step 1's asset-convention table teaches a false mental model.** It presents
naming as a progression (`2.62.0` → `2.63.0/1` → `2.63.2+`), implying
`2.64.0` would be `commcare-2.64.0.apk`. It is not:

```
$ gh release view commcare_2.64.0 -R dimagi/commcare-android \
    --json isDraft,assets --jq '{isDraft, assets:[.assets[].name]}'
{"assets":["app-commcare-release.aab","app-commcare-release.apk"],"isDraft":false}
```

Dimagi reverted to the **oldest** name. `client.ts` already probes
`app-commcare-release.apk` first (commit `d88036db`), so the code is right — but
the table should say the convention does **not** progress and must be read from
the release every time.

**4. Checklist A2 (`rows_unverified: 0`) is not achievable in one pass, and the
skill should say so.** 45 of 91 rows here are unverified because their surfaces
need a fresh `/ace:run` opportunity, and Learn's one-way completion means they
cannot be borrowed. A2's escape hatch ("or the residual names exactly which rows
and why") is the realistic bar and should be the primary wording. For what it is
worth, `bin/ace-doctor`'s `selector_map_currency` agrees with the realistic
reading — it **passes** with unverified rows and emits an `info`
(`bin/ace-doctor:2964-2966`); only unresolved selectors warn.

**5. Checklist B6 is structurally unverifiable during the upgrade that fixes the
skew.** B6 asks that the version-upgrade prompt "is dismissed by its own
branch". The prompt only exists while the APK is behind the CCZ; the upgrade
removes that. Step 2b compounds it by demanding "validate the branch on-device
in this session". Fix: capture the rows from the OLD version's failure dump
**before** the pin flips, and mark B6 explicitly unverifiable post-upgrade, with
the dismissal branch shipped as defence for the next skew.

**6. The skill's drift model is selector-centric and cannot see the change that
actually mattered.** Every failure mode it lists is about pins or transcription;
Step 2 hunts changed *selectors*. But 2.64.0 renamed nothing this map uses — it
added a **screen**. A cheap static step finds that class in one command, before
any device time:

```bash
comm -13 <(sort -u ids-<old>.txt) <(sort -u ids-<new>.txt)   # ids added
comm -23 <(sort -u ids-<old>.txt) <(sort -u ids-<new>.txt)   # ids removed
```

The added set here named the email step, its verification leg, the profile
section and the rebuilt camera outright — i.e. it told us what to go look for.
This belongs in the skill as an explicit early step. It also reframes Step 2's
own guarantee: **"no id drift" is not "no flow drift"**, and the email step is
the proof.

**7. Step 2's delegation to `selector-map-calibrate` is still unexercised.**
This walk was hand-driven (adb + `uiautomator dump`) because harvesting a dump
per surface is what the task needed. The delegation may well work; it has not
been shown to.

Two things the skill got right and should keep verbatim: the adb-port warning
(port 5038, allocated — the `lsof` recipe is correct and the "never probe with
bare `adb`" rule saved time), and the Step 7 activation ORDER, which correctly
predicts the `.env`-before-restart trap that produced finding 1.

## Test status on this branch — 9 red, all pre-existing, all the half-flipped pin

`npx vitest run test/lib/apk-pin-sites.test.ts test/apk-pin-currency.test.ts test/mcp/mobile/`
→ **9 failed / 1130 passed.** Every one is the deliberate consequence of
`DEFAULT_APK_VERSION` having been flipped to `2.64.0` while the other pin sites
still read `2.63.2`. That half-flip predates this walk; the remaining pins are
the SHIP pass's job, not the harvest's.

Verified against the tree as it stood before any commit in this session
(`3cb37af5`):

```
$ git show 3cb37af5:mcp/mobile/client.ts | grep "DEFAULT_APK_VERSION = "
export const DEFAULT_APK_VERSION = '2.64.0';
$ git show 3cb37af5:.env.tpl | grep ACE_CONNECT_APK_VERSION
ACE_CONNECT_APK_VERSION=2.63.2
$ git show 3cb37af5:CLAUDE.md | grep -o "default APK 2\.[0-9.]*"
default APK 2.63.2
$ git ls-tree -r --name-only 3cb37af5 docs/mobile-atlas/ | grep -v evidence
docs/mobile-atlas/connect-2.62.0.md
docs/mobile-atlas/connect-2.63.2.md
$ git diff --stat 3cb37af5..HEAD -- '*.ts' '*.tpl' 'CLAUDE.md'
 mcp/mobile/client.ts | 10 ++++++++--       # a comment correction, nothing else
```

| Test | Why red | Whose job |
|---|---|---|
| `apk-pin-currency` × 2 | `.env.tpl` and `CLAUDE.md` still say `2.63.2` | ship pass, Step 5 |
| `apk-pin-sites` × 1 | the same disagreement, machine-detected | ship pass, Step 5 |
| `client.test.ts` × 2 (`getConfiguredApkVersion`) | assert the OLD default `'2.63.2'` | ship pass |
| `client.test.ts` × 2 (`ensureCommCareApkCached`) | assert the OLD `candidateUrls` ORDER. **The code is right and the tests are stale** — `d88036db` reordered the probe to try `app-commcare-release.apk` first, which is exactly what `commcare_2.64.0` ships (see finding 3 above). Update the tests to the new order; do not revert the code. | ship pass |
| `static-palette-health` × 2 | `docs/mobile-atlas/connect-2.64.0.md` does not exist — the skill's Step 4 | ship pass, Step 4. **The 34 dumps for it are already committed under `docs/mobile-atlas/evidence/connect-2.64.0/`.** |
