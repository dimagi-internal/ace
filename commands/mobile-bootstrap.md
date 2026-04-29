---
name: mobile-bootstrap
description: One-time per-machine setup for ACE mobile emulation (Maestro, AVD, Playwright cookies, ACE test user).
---

# `/ace:mobile-bootstrap`

Run this **once per workstation** before the `training-prep` phase can capture screenshots.

This command is idempotent — re-run any time you suspect drift.

## Steps the agent should execute, in order

1. **Check Maestro is installed.**
   - Run: `which maestro && maestro --version`
   - If missing: tell the user to run `curl -Ls "https://get.maestro.mobile.dev" | bash` and stop.

2. **Check `adb` is on PATH.**
   - Run: `which adb && adb version`
   - If missing: tell the user to run `brew install android-platform-tools` and stop.

3. **Confirm `${ACE_AVD_NAME}` (default `ACE_Pixel_API_34`) exists and has a front camera.**
   - Run: `emulator -list-avds`
   - If not present: print this guidance and stop —
     ```
     Create the AVD via Android Studio's AVD Manager:
       Device: Pixel 7
       System Image: API 34, ARM64 (or x86_64 if Intel Mac)
       Name: ACE_Pixel_API_34
     ```
   - If present: verify the front camera is emulated. Run
     `grep '^hw.camera.front' ~/.android/avd/${ACE_AVD_NAME}.avd/config.ini`.
     If it reads `hw.camera.front=none`, the photo-capture step at the end
     of registration silently no-ops (CameraX validation fails with
     "Camera LENS_FACING_FRONT verification failed"). Fix by editing the
     config to `hw.camera.front=emulated` and cold-booting the AVD.

4. **Boot the AVD using `mobile_ensure_avd_running`.**
   - Tool: `mcp__ace_mobile__mobile_ensure_avd_running`
   - Args: `{ "avdName": "${ACE_AVD_NAME}" }`

5. **Check the CommCare Android APK is installed on the AVD.**
   - **Important:** As of CommCare 2.62.0 (April 2026), Connect/ConnectID is integrated into the CommCare app itself — there is no separate `com.dimagi.connect` package. The single APK `org.commcare.dalvik` covers both flows.
   - Run: `adb shell pm list packages org.commcare.dalvik`
   - If missing, download from `https://github.com/dimagi/commcare-android/releases/download/commcare_2.62.0/app-commcare-release.apk` (or pin a different version), then call `mobile_install_apk` with the local path.

6. **Verify Playwright cookies for connect.dimagi.com.**
   - Check `${HOME}/.ace/playwright-userdata/` exists and contains a `Cookies` file.
   - If not: walk the user through the headed-login one-liner:
     ```
     ACE_PLAYWRIGHT_USER_DATA_DIR=~/.ace/playwright-userdata \
       PHASE9_HEADED=1 \
       npx tsx -e 'import { fetchOtp } from "ACE_PLUGIN_ROOT/mcp/mobile/auth/fetch-otp.ts"; fetchOtp("+74260000042", { userDataDir: process.env.ACE_PLAYWRIGHT_USER_DATA_DIR, headed: true });'
     ```
     The user signs in to Dimagi SSO; cookies persist.

7. **Verify all `ACE_E2E_*` env vars are populated.**
   - Read each from `process.env`. Any missing → tell the user to update 1Password and re-run `op inject -i .env.tpl -o .env`, then stop.

8. **Verify `${ACE_E2E_PHONE}` is pre-invited to a Connect opportunity (CRITICAL).**

   **DO NOT skip this check.** Connect-id's `/users/start_configuration`
   endpoint runs `check_number_for_existing_invites(phone)` synchronously
   and **the worker dies (SystemExit) when the number has no existing
   invite anywhere in Connect**. CommCare then receives an empty response
   and force-stops with NullPointerException. This isn't an integrity or
   OTP issue — it's a server-side timeout cascade. See Sentry `CONNECT-ID-3F`.

   - Sign in to https://connect.dimagi.com as a user with admin access to
     the test program (typically `connect-ace-prod`).
   - Navigate to any opportunity in that program.
   - Send an invite to `${ACE_E2E_PHONE}`.
   - The invite does NOT need to be accepted; its mere existence is what
     `check_number_for_existing_invites` checks.

   Future ACE-created opps (Phase 3 `connect-opp-setup` Step 8) will keep
   the invite alive automatically. This bootstrap step only matters for
   the very first registration on a fresh test user.

   Skip this step **only** if the operator has confirmed `${ACE_E2E_PHONE}`
   already has an invite somewhere in Connect.

9. **Register the ACE test user (if not already).**
   - Tool: `mcp__ace_mobile__mobile_register_test_user`
   - Args: `{ "avdName": "${ACE_AVD_NAME}", "phone": "${ACE_E2E_PHONE}", "phoneLocal": "${ACE_E2E_PHONE_LOCAL}", "countryCode": "${ACE_E2E_COUNTRY_CODE}", "pin": "${ACE_E2E_PIN}", "backupCode": "${ACE_E2E_BACKUP_CODE}", "name": "${ACE_E2E_NAME}" }`
   - If `alreadyRegistered: true`, fine.
   - If registration fails with `SystemExit` / NPE / "CommCare keeps stopping",
     the most likely cause is step 8 was skipped or the invite has been
     revoked. Re-verify and retry.

10. **Print success summary.**
    - Echo: AVD name, test-user phone, Playwright user-data dir, all ACE_E2E_* var presence.
