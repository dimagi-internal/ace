# Mobile Integration

## Overview

The ACE↔CommCare-Android integration layer is the `ace-mobile` MCP server.
It drives a local Android emulator (AVD) on the operator's Mac/Linux/Windows
workstation through a small set of atomic capabilities, backed by Maestro,
adb, and Playwright.

This is dev-machine-only — no cloud device farms, no shared CI emulators.
The only consumer in production is Phase 5 `qa-and-training`, which uses the
mobile MCP to capture screenshots of a deployed CommCare app for inclusion
in training material.

See the design spec: `docs/superpowers/specs/2026-04-28-ace-mobile-emulation-design.md`.

This doc is the operational reference: what atoms exist, which skill uses
each, what's verified vs. what's still scaffolded, and the gotchas worth
remembering.

## Running the MCP server

```bash
npm run mcp:mobile
```

The server auto-registers via `.claude-plugin/plugin.json` `mcpServers` when
the plugin is installed. Required environment: see `.env.tpl` for
`ACE_E2E_*` variables (test phone, PIN, name) and `ACE_AVD_NAME`.

## Capability map

`ace-mobile` ships **12 atoms**, plus a programmatic-only generator atom
that's invoked from skill code rather than via MCP (it requires a Drive
adapter + LLM function as inputs).

### AVD lifecycle (7 atoms)

| Atom | Backend | Description |
|---|---|---|
| `mobile_ensure_avd_running` | adb/emulator | Boot the AVD if cold; idempotent. Auto-patches `hw.camera.front=emulated` before boot. |
| `mobile_stop_avd` | adb | `adb emu kill` |
| `mobile_list_avds` | emulator | `emulator -list-avds` |
| `mobile_install_apk` | adb | `adb install -r <path>` |
| `mobile_uninstall_apk` | adb | `adb uninstall <pkg>` |
| `mobile_save_snapshot` | adb | `adb emu avd snapshot save <name>` — register-once, reuse-many |
| `mobile_load_snapshot` | adb | `adb emu avd snapshot load <name>` |

### Recipe execution (2 atoms)

| Atom | Backend | Description |
|---|---|---|
| `mobile_run_recipe` | maestro | `maestro test <recipe.yaml>` with env vars + screenshot dir |
| `mobile_capture_ui_dump` | adb | `adb shell uiautomator dump` + element parse — primary tool for selector discovery |

### Composite (2 atoms)

| Atom | Backend | Description |
|---|---|---|
| `mobile_register_test_user` | maestro + Playwright | Two-recipe flow that drives PersonalID registration end-to-end against the `+7426` demo-bypass phone range |
| `mobile_fetch_otp` | Playwright | Scrape OTP from connect.dimagi.com inbox (kept for legacy uses; the demo-user path skips OTP entirely) |

### Programmatic-only (1, not registered as an MCP tool)

| Capability | Backend | Description |
|---|---|---|
| `generate_recipes_from_app_summary` | LLM + Maestro | Synthesize per-module Maestro YAML from a Nova-generated app summary in Drive. Used by `app-screenshot-capture`. |

## Static recipes

The `mcp/mobile/recipes/static/` directory holds the recipes whose selectors
have been live-verified against CommCare 2.62.0 on `ACE_Pixel_API_34_PS`.

| Recipe | Status | Variables |
|---|---|---|
| `connect-register-to-otp.yaml` | **verified** (0.10.17) | `${COUNTRY_CODE}`, `${PHONE_LOCAL}` |
| `connect-register-from-otp.yaml` | **verified** (0.10.17) | `${NAME}`, `${BACKUP_CODE}`, `${PIN}` |
| `connect-claim-opp.yaml` | **verified** (0.10.38) — driven end-to-end against `+74260000100` invited via `connect_send_flw_invite` once the opp is active (the previous "create → finalize" two-step collapsed into a single `connect_create_opportunity` since 0.10.47) | `${OPP_NAME}`, `${PIN}` |
| `connect-login.yaml` | scaffold (REPLACE_*) | — |

Naming note: the `to-otp` / `from-otp` filenames are historical. Today's
flow uses the `+7426` demo-bypass prefix and skips OTP entry entirely;
the snackbar `"I see you're a demo user, so we'll skip the OTP"` replaces
the OTP screen. The filenames are kept for backward compatibility with
existing skills and `mobile_register_test_user`.

## How `register_test_user` works

```
ensure AVD running
  ↓
maestro test connect-register-to-otp.yaml
  (launch CommCare → nav drawer → Sign In/Register
   → country code → phone → consent → Continue)
  ↓
maestro test connect-register-from-otp.yaml
  (snackbar OK → App Lock → Configure PIN
   → system PIN setup → lock-screen interstitial
   → AGREE & CONTINUE → unlock prompt → name
   → backup code → photo capture)
```

Idempotent: if the phone is already registered, the recipe surfaces a
sentinel string `PHONE_ALREADY_REGISTERED` which the client converts into
`{ alreadyRegistered: true }` instead of a failure. Re-running with a
registered user is a 5-second no-op.

## Gotchas (the durable-knowledge section)

### Pre-invite gating (CRITICAL)

Connect-id's `/users/start_configuration` endpoint runs an `@app_integrity`
decorator that synchronously calls `check_number_for_existing_invites(phone)`
over HTTP. For phone numbers with no existing invite, this lookup hangs
past the gunicorn worker timeout, the worker dies with `SystemExit`, and
CommCare receives an empty body and force-stops. Filed as **CI-643**
(server) and **CI-644** (client NPE).

The mitigation: every `${ACE_E2E_PHONE}` must be pre-invited to a Connect
opportunity before its first `start_configuration` call. The `connect-opp-setup`
skill auto-invites in step 8 for every new ACE opp; for the very first
bootstrap registration on a fresh test phone, do it manually via
connect.dimagi.com or via the `connect_send_llo_invite` atom.

### Front camera

CommCare's photo-capture step uses CameraX with `LENS_FACING_FRONT`. The
default Pixel 7 AVD template ships `hw.camera.front=none`, which silently
fails CameraX validation: logcat shows
`CameraValidator: Camera LENS_FACING_FRONT verification failed`, and
`take_photo_button` does nothing.

`mobile_ensure_avd_running` auto-patches `~/.android/avd/<NAME>.avd/config.ini`
to `hw.camera.front=emulated` before booting. If the AVD was already
running with the bad config, stop it (`mobile_stop_avd`) and re-run
`mobile_ensure_avd_running` to apply the fix and cold-boot.

### Face-capture gate (2.62.0+) — solved by disabling GMS at runtime

CommCare 2.62.0 added an in-app face-capture screen
(`org.commcare.fragments.MicroImageActivity`, title "Capture Photo")
between the Backup Code step and registration completion. The screen
shows a live viewfinder with a `face_overlay`. Behavior depends on
whether Google Play Services is available **at runtime**:

```java
// MicroImageActivity.onCreate, commcare-android master
isGooglePlayServicesAvailable = AndroidUtil.isGooglePlayServicesAvailable(this);
if (isGooglePlayServicesAvailable) {
    faceCaptureView.setImageStabilizedListener(this);  // ML Kit auto-shutter
} else {
    faceCaptureView.setCaptureMode(FaceCaptureView.CaptureMode.ManualMode);
    cameraShutterButton.setVisibility(View.VISIBLE);   // manual shutter
}
```

* **GMS available:** ML Kit face detection auto-triggers the shutter
  when a face stabilizes in the viewfinder. The AVD's emulated front
  camera shows a gray test pattern, never a real face, so the
  auto-shutter never fires and registration hangs.
* **GMS unavailable:** falls back to `ManualMode` and shows
  `camera_shutter_button`. Maestro can tap it. The captured "photo"
  is whatever the camera currently shows — gray test pattern is fine.
  The server (`POST /users/complete_profile`) accepts any non-empty
  base64 string (`if not (name and recovery_pin and photo): 400`) and
  uploads the bytes to S3 without content validation.

**Surprising finding:** *both* `google_apis` and `google_apis_playstore`
system images on macOS Apple Silicon ship with a functional
`com.google.android.gms` package, and both return `SUCCESS` from
`GoogleApiAvailability.isGooglePlayServicesAvailable`. Picking a
"non-Play-Store" AVD is not sufficient. The actual lever is **runtime
disable**:

```sh
adb shell pm disable-user --user 0 com.google.android.gms
adb shell pm grant org.commcare.dalvik android.permission.CAMERA
```

The CAMERA grant runs as part of `AvdBackend.runPostBootPrep`. The
GMS disable used to live there too, but **0.10.68 moved it** to the
recipe-pair boundary inside `MobileClient.registerTestUser`:

* Before part A: `setGmsEnabled(true)` so CommCare 2.62.0's launch
  check passes (a disabled GMS at app start triggers a blocking
  "Enable Google Play services" dialog with no dismiss option).
* Between part A and part B: `setGmsEnabled(false)` so face-capture
  in part B picks ManualMode. CommCare doesn't re-check GMS
  mid-session, so the late disable doesn't relaunch the dialog.

Doing this at boot — or leaving GMS persistently disabled — broke
CommCare 2.62.0 launch in any flow outside `registerTestUser` (e.g.,
`connect-baseline-screenshots`). If you're writing a new recipe that
needs ManualMode face-capture, follow the same enable-launch /
disable-pre-capture pattern.

### Multi-user dadb landmine (0.10.65 workaround)

dadb-1.2.10 (bundled with Maestro 2.3.0–2.5.1) does NOT wrap the
per-device `createDadb()` call inside `AdbServer.listDadbs` in a
try/catch. The first device returned by `adb devices` that the local
adb-server flags as "unauthorized" throws an `IOException` that
aborts the whole device enumeration. Result: on a shared Mac where
user A's emulator is up and user B's adbkey isn't authorized on it,
user B's `maestro test` reports zero connected devices — even when
`adb -s emulator-NNNN shell` works fine for user B (the adb server's
session-cached transport still works, but dadb does its own AUTH on
a fresh direct connection and fails on user A's emulator first).

Workaround: ACE invokes `maestro --host=localhost --port=<adbd>` for
every recipe run since 0.10.65. With both flags set Maestro takes
the `Dadb.create(host, port)` direct-TCP path, never touching
`Dadb.list` / the local adb server. Plumbing lives in
`MaestroBackend.runRecipe` (accepts `opts.adbPort`) and
`MobileClient.runRecipe` / `MobileClient.registerTestUser`
(resolve the running AVD's serial via `findRunningAvd`, derive
`adbPort = consolePort + 1` via `AvdBackend.adbPortFromSerial`).
The `--host`/`--port` flags are picocli-defined on `App.class` but
omitted from `--help` — effectively undocumented, but stable across
2.3.0 → 2.5.1.

`bin/ace-doctor` flags any `unauthorized` `emulator-NNNN` entries in
your `adb devices` output as a WARN with a fix hint. The
0.10.65 patch keeps ACE recipes working under that condition; the
WARN exists because plain `adb shell` calls without `-s` may still
pick the wrong device.

**Why the photo content doesn't matter:**

```python
# connect-id users/views.py
photo = request.data.get("photo")
if not (name and recovery_pin and photo):
    return JsonResponse({"error": ErrorCodes.MISSING_DATA}, status=400)
# ...
upload_photo_to_s3(photo, user.username)
```

The server requires the field to be present and non-empty, then uploads
to S3 without face validation. Face detection lives entirely in the
client as the auto-shutter trigger.

**Implication for ACE Phase 5 `qa-and-training`:** screenshot capture of a
*deployed CommCare app* (the Phase 5 use case) does NOT need a fully
registered PersonalID — `app-screenshot-capture` opens the deployed app
directly, not via the registration flow. The face-capture gate only
matters for the one-time fresh-AVD bootstrap.

### Google Play Services phone-number hint

GMS-equipped AVDs surface a "Choose a phone number" bottom sheet on focus
of the `connect_primary_phone_input` `AutoCompleteTextView`. The sheet IS
visible to Maestro's view tree once shown, so the recipes dismiss it via
`runFlow.when` against `com.google.android.gms:id/cancel`. On non-GMS AVDs
the conditional is a no-op.

### Stuck-FallbackHome recovery

Some `google_apis*` AVD cold boots wedge with
`mFocusedApp=com.android.settings/.FallbackHome` and the real launcher
(NexusLauncher) never resolves as the default `HOME` activity. Symptoms:
`mCurrentFocus=NotificationShade`, `/sdcard` access denied to the shell
uid even though the device says `sys.boot_completed=1`, all Maestro
`launchApp` calls timing out.

`runPostBootPrep` tries best-effort recoveries (status-bar collapse,
keyguard dismiss, KEYCODE_HOME) but they don't always work — once
FallbackHome is the registered home activity, only a wipe will reset
the package manager's HOME resolution.

**Recovery: cold-boot with `-wipe-data`.**

```sh
adb emu kill
emulator -avd ACE_Pixel_API_34_PS \
  -no-window -no-snapshot-load -no-snapshot-save -wipe-data
```

This flushes user data (so CommCare needs to be reinstalled and the
test user re-registered after) but reliably brings up NexusLauncher
as the default home. Verified live on `ACE_Pixel_API_34_PS` after a
3-reboot stuck-FallbackHome cycle on 2026-04-29.

For a freshly-wiped AVD, the bootstrap sequence is:
`mobile_ensure_avd_running` → `mobile_install_apk` (CommCare) →
`mobile_register_test_user` → `mobile_save_snapshot`. Future sessions
can `mobile_load_snapshot` to skip the first three.

### Unlock PersonalID gate

After registration, navigating to any Connect-protected screen
(e.g. tapping the "Opportunities" nav-drawer item) triggers an
Android `BiometricPrompt` with device-credential fallback. The
prompt belongs to the `com.android.systemui` package, not
`org.commcare.dalvik`, so a Maestro `tapOn` against the CommCare
nav row briefly drops out of the app and the next `assertVisible`
on a CommCare element will fail unless the recipe answers the
prompt first.

The credential is the registration PIN (`111111` for the ACE test
user). Selector for the password field is
`com.android.systemui:id/lockPassword`. The robust pattern in
`connect-claim-opp.yaml` is a `runFlow.when` that fires only when
the prompt is present:

```yaml
- runFlow:
    when:
      visible:
        id: "com.android.systemui:id/lockPassword"
    commands:
      - tapOn:
          id: "com.android.systemui:id/lockPassword"
      - inputText: ${PIN}
      - pressKey: Enter
```

This makes the recipe portable across PersonalID configurations
that expect biometric (skipping the prompt entirely on AVDs without
a fingerprint sensor) and configurations that fall back to PIN.

### `aapt` is required by `mobile_install_apk`

`AvdBackend.installApk` parses APK metadata via `aapt dump badging`
to recover the package id and version. `aapt` ships with
`build-tools/<version>/`, which is **not** installed by default on
homebrew's `android-commandlinetools`.

Quick fix on macOS:
```
yes | sdkmanager "build-tools;34.0.0"
ln -sf /opt/homebrew/share/android-commandlinetools/build-tools/34.0.0/aapt \
  /opt/homebrew/bin/aapt
```

If you hit `spawn aapt ENOENT` from any mobile MCP atom that
parses APK metadata, this is the gap. Long-term fix: have the
backend search `$ANDROID_HOME/build-tools/*/aapt` rather than
relying on PATH. Tracked separately.

### Selector discovery loop

When extending recipes, the discovery loop is:

1. Drive the AVD into the state of interest. **Snapshot it** with
   `mobile_save_snapshot` once you reach a stable, costly-to-rebuild state
   (e.g. registered test user). Subsequent iterations load the snapshot
   in ~3s instead of replaying the whole prefix recipe.
2. `mobile_capture_ui_dump` returns parsed elements + xml in one call —
   prefer this over `adb shell uiautomator dump` + `adb pull` + `grep`.
3. **Use `maestro studio` for new selector capture.** It's an interactive
   selector picker against the live AVD: tap an element in your browser,
   it shows you the resource-id and a copy-pasteable Maestro snippet. Far
   faster than dump-and-grep, and it shows you the *correct* selector
   (resource-id vs text vs id-and-bounds) for each element. Run
   `maestro studio` after `mobile_ensure_avd_running`.
4. Add the next 5-10 steps to the recipe in one batch (not one-at-a-time),
   re-run, dump again at the next checkpoint.

**Anti-pattern:** screencap + Read PNG + dump + grep after every single tap.
The PNG read is expensive in tokens and rarely necessary — almost every
CommCare/PersonalID selector is resource-id-driven, and uiautomator XML
has all the info. Reserve screenshots for genuinely visual states (camera
UI, where AOSP elements lack resource-ids).

### Performance & efficiency

A full registration replay is ~4 minutes (Part A ~90s, Part B ~120s, plus
CommCare cold-launch and animation waits). Selector discovery against
fresh registration each iteration is the single biggest time sink.

**Snapshot-driven discovery:**
1. Run `mobile_register_test_user` once on a clean AVD.
2. `mobile_save_snapshot` with name `registered-test-user`.
3. For each new recipe (claim-opp, deliver-app navigation, etc.):
   `mobile_load_snapshot` → drive forward from registered state → discover
   selectors → repeat without re-registering.

**Maestro flow time** is dominated by `waitForAnimationToEnd` and
`extendedWaitUntil` timeouts. Don't tighten timeouts to "speed things up"
— they exist because CommCare's transitions are genuinely flaky. Speed
comes from running fewer end-to-end replays, not from making each replay
faster.

### Maestro requires Java 17

Maestro's CLI is a JVM app. `mobile_ensure_avd_running` resolves a
`JAVA_HOME` automatically:

- macOS: `/usr/libexec/java_home -v 17`, falling back to homebrew prefixes
- Linux: `/usr/lib/jvm/java-17-openjdk-*` or `temurin-17-jdk`
- Windows: globs `%ProgramFiles%\Eclipse Adoptium\jdk-17.*`

If the AVD/Maestro can't find a JDK, the operator override is to
`export JAVA_HOME=/path/to/jdk17` before launching Claude Code.

## What's not yet built

- The deliver-app navigation recipes (`generate_recipes_from_app_summary`)
  have been wired but not run live against a Nova-deployed app. The
  generator's parsing logic is unit-tested; the LLM contract isn't.
- Cross-platform support is implemented but only verified on macOS Apple
  Silicon. Linux and Windows paths are best-effort, awaiting first-run
  validation.
- Live verification of the manual-shutter path (0.10.21) on a non-GMS
  AVD. The selectors come straight from the commcare-android source
  (`MicroImageActivity.onCreate` + `micro_image_widget.xml`) so the
  recipe is correct by construction, but a registration end-to-end
  on `ACE_Pixel_API_34` needs CommCare 2.62.0 installed there first.

## Sibling docs

- `commands/mobile-bootstrap.md` — operator-facing one-time setup script
- `docs/superpowers/specs/2026-04-28-ace-mobile-emulation-design.md` — design rationale
- `docs/superpowers/plans/2026-04-28-ace-mobile-emulation.md` — implementation plan (substantially shipped through 0.10.17)
