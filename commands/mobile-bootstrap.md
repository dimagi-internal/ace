---
name: mobile-bootstrap
description: One-time per-machine setup for ACE mobile emulation (Maestro, AVD, Playwright cookies, ACE test user).
---

# `/ace:mobile-bootstrap`

Run this **once per workstation** before the `training-prep` phase can capture screenshots.

This command is idempotent — re-run any time you suspect drift.

## Supported platforms

ACE mobile emulation has been live-validated on **macOS Apple Silicon** (the
primary developer platform). Linux and Windows path resolution is implemented
in `mobile_ensure_avd_running` but only tested via unit tests; first-run
operator validation is welcome.

The atom layer (Maestro + adb + emulator + Java) is platform-portable. The
only OS-specific bits are the install commands for those tools and the AVD
home directory; both are handled by the table below and `resolveJavaHome()`
in `mcp/mobile/backends/avd.ts`.

| Step prerequisite | macOS | Linux / WSL2 | Windows native |
|---|---|---|---|
| Maestro | `curl -Ls "https://get.maestro.mobile.dev" \| bash` | same as macOS | `iwr -useb https://get.maestro.mobile.dev/win \| iex` (PowerShell) |
| adb | `brew install android-platform-tools` | `apt install android-tools-adb` (Debian/Ubuntu) or `dnf install android-tools` | Bundled with Android Studio's `platform-tools/`; add to `Path` |
| emulator + AVDs | Android Studio installer | `sdkmanager "platform-tools" "emulator" "system-images;android-34;google_apis_playstore;arm64-v8a"` | Android Studio installer |
| JDK 17 | `brew install openjdk@17` | `apt install openjdk-17-jdk` | Adoptium Temurin 17 installer |
| AVD home | `~/.android/avd/` | `~/.android/avd/` (or `$ANDROID_AVD_HOME`) | `%USERPROFILE%\.android\avd\` |

`mobile_ensure_avd_running` resolves `JAVA_HOME` automatically using the
order in `resolveJavaHome()`. Operators can override with
`export JAVA_HOME=/path/to/jdk17` before launching Claude Code.

## Steps the agent should execute, in order

1. **Check Maestro is installed.**
   - Run: `which maestro && maestro --version` (Unix) or `Get-Command maestro` (Windows PS).
   - If missing: print the install command from the platform table above and stop.

2. **Check `adb` is on PATH.**
   - Run: `which adb && adb version` (Unix) or `Get-Command adb` (Windows PS).
   - If missing: print the install command from the platform table above and stop.

3. **Confirm `${ACE_AVD_NAME}` (default `ACE_Pixel_API_34`) exists.**
   - Run: `emulator -list-avds`
   - If not present: print this guidance and stop —
     ```
     Create the AVD via Android Studio's AVD Manager:
       Device: Pixel 7
       System Image: API 34, ARM64 (Apple Silicon / Linux ARM) or x86_64 (Intel/AMD)
       Name: ACE_Pixel_API_34
     ```
   - The front-camera config check is no longer manual — `mobile_ensure_avd_running`
     auto-patches `hw.camera.front=emulated` before booting (0.10.18+).
     Pre-0.10.18 AVDs that were booted with the old config need a one-time
     stop + ensure-running cycle to pick up the change.

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
