---
name: mobile-bootstrap
description: One-time per-machine setup for ACE mobile emulation (Maestro, AVD, Playwright cookies, ACE test user).
---

# `/ace:mobile-bootstrap`

Run this **once per workstation** before the `qa-and-training` phase can capture screenshots.

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

## Multi-user macOS hosts

When two Mac user accounts share one machine and both run ACE, the default
adb server (port 5037) and the default emulator console pair (5554/5555)
collide. Pin both per user in each account's `.env`
(`${CLAUDE_PLUGIN_DATA}/.env`):

| Var | User A | User B | Notes |
|---|---|---|---|
| `ANDROID_ADB_SERVER_PORT` | unset (5037) | `5038` | Honored natively by `adb` + `emulator`; ACE inherits via `process.env`. |
| `ACE_MOBILE_EMULATOR_PORT` | unset (5554) | `5580` | Wired through `mcp/mobile/backends/avd.ts` as `emulator -port <N>`. Serial becomes `emulator-<port>`. |

`.env` is per-user on macOS (`${CLAUDE_PLUGIN_DATA}` resolves under
`~/Library/...`), so each account's `op inject` lands in a separate file.
Re-run `/ace:doctor` after editing — its `[Mobile]` block confirms adb +
emulator wake on the pinned ports.

## Where to put throwaway probe scripts

If any step below needs a one-off Playwright / adb / shell probe (e.g. to
sanity-check a cookie jar or selector), **write it to `./tmp/ace-debug/<name>.ts`
in the current git worktree** — never to `~/.claude/plugins/cache/`. The
plugin cache is managed by `/ace:update`; writing into it is the "local
patching" anti-pattern that ACE's CLAUDE.md explicitly forbids and creates
version drift that's hard to diagnose later.

`./tmp/` is gitignored at the repo root, so probes won't accidentally end
up in a commit. A `git status` in the worktree should still come back clean
after a successful run — see Step 12 below for cleanup.

Durable, repeatable probes belong under `scripts/` and get committed; only
true one-shot debugging artifacts go to `./tmp/ace-debug/`.

## Steps the agent should execute, in order

1. **Check Maestro is installed; auto-install on macOS/Linux if missing.**
   - Run: `which maestro && maestro --version` (Unix) or `Get-Command maestro` (Windows PS).
   - Also accept `~/.maestro/bin/maestro` as installed (the official installer
     lands here without always patching the active shell's PATH for the
     current process). Add `~/.maestro/bin` to `PATH` for the rest of this
     session if it exists: `export PATH="$HOME/.maestro/bin:$PATH"`.
   - If still missing AND the platform is macOS or Linux, attempt the
     auto-install once:
     ```bash
     curl -Ls "https://get.maestro.mobile.dev" | bash
     export PATH="$HOME/.maestro/bin:$PATH"
     ```
     Re-run `maestro --version`. If it succeeds, proceed. If the installer
     itself fails (network, sudo, disk), surface the installer's stderr and
     stop — do NOT loop or retry silently.
   - On Windows, or if the auto-install failed, print the install command
     from the platform table above and stop.

2. **Check `adb` is on PATH; auto-install Java prerequisite on macOS if missing.**
   - Run: `which adb && adb version` (Unix) or `Get-Command adb` (Windows PS).
   - If missing: print the install command from the platform table above and stop.
     adb itself is part of the Android platform-tools / Studio install — we
     don't auto-install it because the right install path depends on whether
     the operator already has a Studio setup.
   - Then check Java: `java -version 2>&1`. If Java is missing AND the platform
     is macOS AND `which brew` succeeds, attempt `brew install openjdk` once,
     then re-check `java -version`. If Java still fails or auto-install errored,
     surface the stderr and stop with the platform table's manual command.

3. **Confirm `${ACE_AVD_NAME}` (default `ACE_Pixel_API_34`) exists.**
   - Run: `emulator -list-avds`
   - If not present: print this guidance and stop —
     ```
     Create the AVD via Android Studio's AVD Manager:
       Device: Pixel 7
       System Image: API 34, ARM64 (Apple Silicon / Linux ARM) or x86_64 (Intel/AMD)
       Name: ACE_Pixel_API_34
     ```
   - The front-camera config check is automatic —
     `mobile_ensure_avd_running` auto-patches `hw.camera.front=emulated`
     before booting (0.10.18+). Pre-0.10.18 AVDs that were booted with
     the old config need a one-time stop + ensure-running cycle to pick
     up the change.
   - **Note on system image choice:** Both `google_apis` and
     `google_apis_playstore` ship with a functional GMS package on
     macOS Apple Silicon, so the choice doesn't change the face-capture
     auto-shutter behavior. The actual face-capture bypass is a runtime
     `pm disable-user com.google.android.gms` call (handled by
     `mobile_ensure_avd_running` in 0.10.21+). Either image works.

4. **Boot the AVD using `mobile_ensure_avd_running`.**
   - Tool: `mcp__ace_mobile__mobile_ensure_avd_running`
   - Args: `{ "avdName": "${ACE_AVD_NAME}" }`

5. **Check the CommCare Android APK is installed on the AVD.**
   - **Important:** As of CommCare 2.62.0 (April 2026), Connect/ConnectID is integrated into the CommCare app itself — there is no separate `com.dimagi.connect` package. The single APK `org.commcare.dalvik` covers both flows.
   - Run: `adb shell pm list packages org.commcare.dalvik`
   - If missing, download from `https://github.com/dimagi/commcare-android/releases/download/commcare_2.62.0/app-commcare-release.apk` (or pin a different version), then call `mobile_install_apk` with the local path.

6. **Seed Playwright cookies for connect.dimagi.com (headless).**
   - Check `${HOME}/.ace/playwright-userdata/Default/Cookies` exists *and* the
     directory contains `Local State` (Chromium-initialized profile).
   - If missing or empty: run the headless seeder. It uses `ACE_HQ_USERNAME`
     and `ACE_HQ_PASSWORD` from `.env` to drive the Connect→CommCareHQ OAuth
     flow programmatically; no operator interaction needed:
     ```
     cd "$ACE_PLUGIN_ROOT" && npx tsx scripts/seed-connect-cookies.ts
     ```
     Success line: `LOGIN_OK total_cookies=… dimagi=…`. Verify the dimagi
     count is ≥ 5 (covers `connect.dimagi.com`, `www.commcarehq.org`,
     `.commcarehq.org`).
   - **Fallback only if HQ creds fail or the account requires interactive
     SSO/MFA:** `/ace:connect-login` (headed Playwright).

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

   **Programmatic check (best-effort):** with cookies seeded in step 6,
   `npx tsx scripts/probe-find-phone-invite.ts` will scan every org the
   cached session can see for opportunities whose `/user_invite/` page
   contains the target phone. A match is conclusive proof; a miss is *not*
   — the Connect-id check is global, the probe is org-scoped. If the probe
   misses, either confirm via the UI or fall back to
   `npx tsx scripts/probe-flw-invite.ts` to add an invite to a known
   turmeric opp.

9. **Register the ACE test user (if not already).**
   - Tool: `mcp__ace_mobile__mobile_register_test_user`
   - Args: `{ "avdName": "${ACE_AVD_NAME}", "phone": "${ACE_E2E_PHONE}", "phoneLocal": "${ACE_E2E_PHONE_LOCAL}", "countryCode": "${ACE_E2E_COUNTRY_CODE}", "pin": "${ACE_E2E_PIN}", "backupCode": "${ACE_E2E_BACKUP_CODE}", "name": "${ACE_E2E_NAME}" }`
   - If `alreadyRegistered: true`, fine.
   - If registration fails with `SystemExit` / NPE / "CommCare keeps stopping",
     the most likely cause is step 8 was skipped or the invite has been
     revoked. Re-verify and retry.
   - In 0.10.23+ the GMS-disable + CAMERA-grant + NotificationShade
     recovery all run automatically as part of `mobile_ensure_avd_running`
     (see `AvdBackend.runPostBootPrep`); no operator action needed.

10. **Save a `registered-test-user` snapshot (recommended).**
    - Tool: `mcp__ace_mobile__mobile_save_snapshot`
    - Args: `{ "avdName": "${ACE_AVD_NAME}", "name": "registered-test-user" }`
    - Future selector-discovery sessions can `mobile_load_snapshot` to
      this state in ~3s instead of replaying the 4-minute registration
      flow. Skip this step if `alreadyRegistered: true` was returned in
      step 9 — the existing snapshot is already good.

11. **Print success summary.**
    - Echo: AVD name, test-user phone, Playwright user-data dir, all ACE_E2E_* var presence.

12. **Clean up `./tmp/ace-debug/`.**
    - Run: `rm -rf ./tmp/ace-debug` from the worktree root.
    - This removes any one-off probe scripts written during the run. Skip
      with no error if the directory doesn't exist (steady-state case where
      no probes were needed).
    - Confirm with `git status` — the working tree should be clean apart
      from any intentional edits the operator made.
