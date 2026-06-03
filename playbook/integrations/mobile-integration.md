# Mobile Integration

## Overview

The `ace-mobile` MCP server drives a CommCare Android emulator — either a local AVD on the operator's workstation, or a cloud emulator via ace-web — through a small set of atomic capabilities backed by Maestro + adb + Playwright.

The only production consumer is Phase 6 `qa-and-training`, which captures screenshots of a deployed CommCare app for walkthroughs and training material. Phase 3's `app-test-cases` generates per-journey Maestro recipes that Phase 6 then runs.

See the design spec: `docs/superpowers/specs/2026-04-28-ace-mobile-emulation-design.md`.

## Running the MCP server

```bash
npm run mcp:mobile
```

Auto-registers via `.claude-plugin/plugin.json` `mcpServers` when the plugin is installed. Required environment: `.env.tpl` `ACE_E2E_*` variables (test phone, PIN, name), `ACE_AVD_NAME`, and `ACE_CONNECT_APK_VERSION` (default 2.63.0).

## Capability map

16 atoms registered. **`docs/atom-schemas.md` is the canonical Zod-schema catalog** — grep there for current atom signatures rather than paraphrasing here. The atom names + roles:

**AVD lifecycle:** `mobile_ensure_avd_running`, `mobile_stop_avd`, `mobile_list_avds`, `mobile_install_apk`, `mobile_uninstall_apk`.

**Recipe execution:** `mobile_run_recipe` (auto-resolves `${SELECTOR:...}` + auto-injects `${ACE_E2E_*}` env vars), `mobile_validate_recipe`, `mobile_resolve_selectors`, `mobile_capture_ui_dump`.

**Composite:** `mobile_register_test_user` (two-recipe PersonalID registration against the `+7426` demo-bypass phone range).

**Diagnostic / debug:** `mobile_probe_maestro_driver`, `mobile_diagnose`, `mobile_restart_runner`, `mobile_patch_launch_script`.

**Ad-hoc snapshot (debugging only):** `mobile_save_snapshot`, `mobile_load_snapshot` — NOT on the Phase 6 heal path; useful for operator-driven state captures during interactive debugging.

## Static recipes

`mcp/mobile/recipes/static/` holds the recipes that compose into every per-opp generated recipe. Live-verified against the active CommCare APK (2.62.0 / 2.63.0). The directory listing is the source of truth — `ls mcp/mobile/recipes/static/` for the current set. As of this writing: `connect-login`, `connect-claim-opp`, `connect-register-to-otp`, `connect-register-from-otp`, `learn-launch`, `learn-tap-module`, `form-advance`, `form-submit`, `deliver-launch`.

Naming note: `to-otp` / `from-otp` filenames are historical. Today's flow uses the `+7426` demo-bypass prefix; the snackbar `"I see you're a demo user, so we'll skip the OTP"` replaces the OTP screen. See `docs/learnings/2026-05-14-demo-user-no-otp.md`.

Selector substitution: every static recipe uses `${SELECTOR:logical-name}` placeholders resolved against `mcp/mobile/selectors/connect-<apk-version>.yaml` at `mobile_run_recipe` time. Add a new APK version by copying that file.

Structural preventers run before AVD wall-clock burns:
- `mobile_validate_recipe` → `lintRecipeText` catches `inputtext-scalar-with-sibling-option`.
- `mcp/mobile/recipe-sanity-probe.ts` catches `form-advance-without-answer-tap` and `brief-label-drift`.
- `test/mcp/mobile/static-palette-health.test.ts` asserts every static recipe parses, declares `appId:`, passes lint, and resolves every selector ref against the active map.

See `docs/learnings/2026-05-25-recipe-static-preventer-suite.md` for the shift-left principle behind these checks.

## Device-state heal: always cold-boot per dispatch

`mobile_ensure_avd_running` is the single funnel for landing the AVD on a Phase-6-ready state. Callers make ONE call and trust the return. Read-only probes (`mobile_probe_maestro_driver`) cannot heal — halting on them defeats the auto-heal.

**The contract is "always restore the precondition, never adapt to whatever state is in front of us"** (per `CLAUDE.md § Phase preconditions are restored, not adapted`).

Local AVD: kill emulator → cold-boot AVD with `-wipe-data -no-snapshot-load -no-snapshot-save` → install APK from host-side SHA256-validated cache → register demo-prefix test user via the two registration recipes → apply environment baseline (front camera, CAMERA permission, GMS toggle around the registration boundary) → reinstall Maestro driver → verify. Steady-state cost ~60–90s per dispatch. See `mcp/mobile/client.ts:restoreDeviceUserState` and `mcp/mobile/backends/avd.ts:ensureAvdRunning`.

Cloud: `/api/mobile/ensure-running` cold-boots from AMI on every call. Same contract, different mechanism — the AMI's baked registration scripts produce a fresh demo user on every cold-boot.

**Why no snapshot fast-path:** the snapshot-load path silently aged (device wall-clock froze at capture; Connect token's expiration was real-time; 401s ensued). Cold-boot is deterministic. See `docs/learnings/2026-05-14-demo-user-no-otp.md` for the cost analysis (~20s fresh registration, not the often-quoted 3–5 min).

**Demo user OTP bypass:** test phone numbers prefixed `+7426` skip SMS OTP entirely; Connect's backend recognizes the prefix and emits a snackbar `"I see you're a demo user, so we'll skip the OTP"`. The recipe pair is named `to-otp` / `from-otp` for historical reasons; today these are pre-snackbar and post-snackbar.

## Classifier states

`classifyDeviceUserState` runs after heal to verify the precondition was reached. It's a verification step only — recovery is always cold-boot, never "adapt based on what state we found."

| `DeviceUserStateClass` | Recovery | When you'll see it |
|---|---|---|
| `ready` | none | Connect nav-drawer items present OR opp/visit activity foregrounded |
| `commcare-not-installed` | cold-boot funnel (installs APK) | `org.commcare.dalvik` absent from `pm list packages` |
| `needs-personal-id` | cold-boot funnel (re-registers) | "Logged out of PersonalID" banner, OR no positive Connect-nav signal + first-start markers |
| `unknown` | treated as ready | classifier couldn't read the dump — accept rather than reject |

Order matters: the PersonalID-wipe banner is checked **before** Connect-nav-positive signals (stacked-state precedence — a freshly logged-out user may still have nav-drawer items cached on screen). First-match wins.

## Gotchas (durable knowledge)

### Pre-invite gating (CRITICAL)

Connect-id's `/users/start_configuration` endpoint runs an `@app_integrity` decorator that synchronously calls `check_number_for_existing_invites(phone)` over HTTP. For phone numbers with no existing invite, this lookup hangs past the gunicorn worker timeout, the worker dies with `SystemExit`, and CommCare receives an empty body and force-stops.

Mitigation: every `${ACE_E2E_PHONE}` must be pre-invited to a Connect opportunity before its first `start_configuration` call. The `connect-opp-setup` skill auto-invites in step 8 for every new ACE opp, so a clean `/ace:run` satisfies this precondition automatically before Phase 6 dispatches. For one-off `/ace:step` invocations on a fresh test phone, do it manually via connect.dimagi.com or via the `connect_send_llo_invite` atom.

### Front camera

CommCare's photo-capture step uses CameraX with `LENS_FACING_FRONT`. Default Pixel AVD templates ship `hw.camera.front=none`, which silently fails CameraX validation. `mobile_ensure_avd_running` auto-patches `~/.android/avd/<NAME>.avd/config.ini` to `hw.camera.front=emulated` before booting.

### Face-capture gate — runtime GMS toggle

CommCare 2.62.0+ added an in-app face-capture screen between Backup Code and registration completion. Behavior branches on runtime GMS availability:

- **GMS available:** ML Kit auto-triggers the shutter when a face stabilizes. The AVD's emulated front camera shows a gray test pattern, never a real face, so the auto-shutter never fires and registration hangs.
- **GMS unavailable:** falls back to `ManualMode` with a tappable `camera_shutter_button`. The server accepts any non-empty base64 payload without face validation.

The lever is **runtime GMS toggle**, not AVD image selection (both `google_apis` and `google_apis_playstore` images ship with functional GMS on macOS Apple Silicon). The recipe pair `registerTestUser` toggles GMS around itself:

- Before part A: `setGmsEnabled(true)` — CommCare 2.62.0's launch check needs GMS present or it shows a blocking "Enable Google Play services" dialog.
- Between part A and part B: `setGmsEnabled(false)` — face-capture in part B picks ManualMode.

Doing this at boot — or leaving GMS persistently disabled — broke CommCare 2.62.0 launch in any flow outside `registerTestUser`. If you're writing a new recipe that needs ManualMode face-capture, follow the same enable-launch / disable-pre-capture pattern.

```sh
adb shell pm disable-user --user 0 com.google.android.gms
adb shell pm grant org.commcare.dalvik android.permission.CAMERA
```

The CAMERA grant runs as part of `AvdBackend.runPostBootPrep`. The GMS toggle lives at the recipe-pair boundary in `MobileClient.registerTestUser`.

### Multi-user dadb landmine

dadb-1.2.10 (bundled with Maestro 2.3.0+) does NOT wrap per-device `createDadb()` calls in a try/catch. The first device that the local adb-server flags as "unauthorized" throws an `IOException` that aborts the whole device enumeration. On a shared Mac where user A's emulator is up and user B's adbkey isn't authorized on it, user B's `maestro test` reports zero connected devices.

Workaround: ACE invokes `maestro --host=localhost --port=<adbd>` for every recipe run. With both flags set Maestro takes the direct-TCP `Dadb.create(host, port)` path, never touching `Dadb.list`. Plumbed in `MaestroBackend.runRecipe` + `MobileClient.runRecipe` / `registerTestUser` (serial resolved via `findRunningAvd`, `adbPort = consolePort + 1` via `AvdBackend.adbPortFromSerial`).

`bin/ace-doctor` flags any `unauthorized` `emulator-NNNN` entries in `adb devices` output as a WARN with a fix hint.

### Stuck-FallbackHome recovery

Some `google_apis*` AVD cold-boots wedge with `mFocusedApp=com.android.settings/.FallbackHome` and the real launcher (NexusLauncher) never resolves as the default `HOME` activity. Once FallbackHome is registered as the home activity, only a wipe resets the package manager's HOME resolution.

The cold-boot funnel's `-wipe-data` flag means this class is now structurally rare. If you somehow get a stuck FallbackHome state (e.g. an operator-loaded snapshot from before the cold-boot model), recover with:

```sh
adb emu kill
emulator -avd ACE_Pixel_API_34_PS -no-window -no-audio -no-snapshot-load -no-snapshot-save -wipe-data
```

### Unlock PersonalID gate

After registration, navigating to any Connect-protected screen triggers an Android `BiometricPrompt` with device-credential fallback. The prompt belongs to `com.android.systemui`, not `org.commcare.dalvik`, so a Maestro `tapOn` against the CommCare nav row briefly drops out of the app and the next `assertVisible` on a CommCare element fails unless the recipe answers the prompt first.

The credential is the registration PIN (`111111` for the ACE test user). Selector for the password field is `com.android.systemui:id/lockPassword`. Robust pattern (from `connect-claim-opp.yaml`):

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

Portable across PersonalID configurations that expect biometric (skipping the prompt entirely on AVDs without a fingerprint sensor) and configurations that fall back to PIN.

### `aapt` required by `mobile_install_apk`

`AvdBackend.installApk` parses APK metadata via `aapt dump badging` to recover the package id and version. `aapt` ships with Android `build-tools/<version>/`, which is **not** installed by default on homebrew's `android-commandlinetools`.

Quick fix on macOS:
```
yes | sdkmanager "build-tools;34.0.0"
ln -sf /opt/homebrew/share/android-commandlinetools/build-tools/34.0.0/aapt /opt/homebrew/bin/aapt
```

If you hit `spawn aapt ENOENT` from any mobile MCP atom, this is the gap. Long-term fix: have the backend search `$ANDROID_HOME/build-tools/*/aapt` rather than relying on PATH.

### Google Play Services phone-number hint

GMS-equipped AVDs surface a "Choose a phone number" bottom sheet on focus of the `connect_primary_phone_input` `AutoCompleteTextView`. The sheet IS visible to Maestro's view tree once shown, so the recipes dismiss it via `runFlow.when` against `com.google.android.gms:id/cancel`. On non-GMS AVDs the conditional is a no-op.

### Maestro requires Java 17

Maestro's CLI is a JVM app. `mobile_ensure_avd_running` resolves `JAVA_HOME` automatically:

- macOS: `/usr/libexec/java_home -v 17`, falling back to homebrew prefixes
- Linux: `/usr/lib/jvm/java-17-openjdk-*` or `temurin-17-jdk`
- Windows: globs `%ProgramFiles%\Eclipse Adoptium\jdk-17.*`

If the resolver fails, `export JAVA_HOME=/path/to/jdk17` before launching Claude Code.

### Maestro v2.x cold-start is ~10–12s

probe1 timeout budget is 20s in `mcp/mobile/client.ts` to accommodate Maestro v2's slower JVM cold-start. Don't tighten it — v1's faster startup is no longer the reference. See `docs/learnings/2026-05-19-maestro-v2-probe-timeout.md`.

## Selector discovery loop

When extending recipes or building atlas coverage for a new APK version:

1. Cold-boot a fresh AVD via `mobile_ensure_avd_running`. **Do not load a snapshot** — they're for ad-hoc debugging only.
2. Drive the AVD into the state of interest. If you tap through far enough to consume the opp (e.g. complete Learn flow), expect that the next Phase 6 dispatch on the same opp will halt at claim-opp — see `docs/learnings/2026-05-14-atlas-side-channel-capture.md` Finding 2.
3. `mobile_capture_ui_dump` returns parsed elements + XML in one call. Prefer this over `adb shell uiautomator dump` + `adb pull` + `grep`.
4. **Use `maestro studio` for new selector capture.** Interactive selector picker against the live AVD: tap an element in the browser, it shows the resource-id and a copy-pasteable Maestro snippet. Far faster than dump-and-grep.
5. Add the next 5–10 steps to the recipe in one batch (not one-at-a-time), re-run, dump at the next checkpoint.
6. After Phase 6 runs, `scripts/probe-atlas-drift.ts` harvests selector-drift signal from accumulated `runRecipeWithDumps` XMLs — read-only, surfaces candidate new logical-selector rows for the selector map. It walks `*-FAILURE.xml` dumps too and surfaces ids seen on a failure screen but absent from the map as a **priority "Drift suspects on FAILURE screens"** section — each is a candidate root cause for a recipe failure in this run. `app-screenshot-capture` Step 6.5 runs this automatically at end of Phase 6.

**Anti-pattern:** screencap + Read PNG + dump + grep after every single tap. PNG reads are expensive in tokens. Almost every CommCare/PersonalID selector is resource-id-driven; uiautomator XML has all the info. Reserve screenshots for genuinely visual states (camera UI, where AOSP elements lack resource-ids).

## Failure forensics — read them on any recipe failure

This is the canonical reference for the screenshot-on-error capture; the per-skill notes point here so the contract lives in one place.

**What's captured (cross-backend, automatic).** On a recipe failure, `mobile_run_recipe` captures the device state at the moment it died and surfaces it as `failureForensics`:

- `screenshotPath` → `<recipe-id>-FAILURE.png` — the offending screen.
- `uiDumpPath` → `<recipe-id>-FAILURE.xml` — the element tree (resource-ids / text / bounds): the highest-signal artifact for "wrong selector vs wrong screen".
- `elements` → the parsed ui-dump rows.

Both files land in the run's `screenshotDir`, so they're uploaded + provenance-stamped alongside the smoke PNGs and Read-able from local disk on **both** the local-AVD and cloud backends (cloud pulls the S3 artifact down).

**Two failure shapes — both capture now:**

1. **Returned `status: 'fail'`** (clean recipe failure: assertion miss, selector not found). `failureForensics` is set on the result. *Since 0.13.538.*
2. **Thrown failure** (driver death that exhausts the heal-and-retry envelope, gRPC transport crash). These never produce a result, so the status-gated capture can't fire — the throw arm captures the same forensics, attaches them to the thrown error as `error.failureForensics`, and rethrows the original error untouched. The ui-dump is adb-based, so it usually still works even when the Maestro gRPC driver is dead.

**The rule: image/dump-read first, infer second.** The screen + the resource-ids present on it usually name the failure mode literally and resolve "wrong selector" vs "wrong screen" in one step — skipping it produced an inverted-conclusion bug live (turmeric 20260513-0616). On any recipe failure, **Read `failureForensics.screenshotPath` and `failureForensics.uiDumpPath` before writing a verdict or probing packages/processes.** The full recognized-failure-mode table + manual-debug fallback live in `skills/app-screenshot-capture/SKILL.md` (the Phase 6 smoke skill); every other recipe-running skill should at minimum read the two artifacts on failure before halting.

## Sibling docs

- `docs/learnings/2026-05-14-demo-user-no-otp.md` — registration cost model, why no snapshot fast-path
- `docs/learnings/2026-05-14-phase6-validation-arc.md` — durable lessons + the still-open recipe-provenance gap
- `docs/learnings/2026-05-14-atlas-side-channel-capture.md` — UI dumps embed in recipes; atlas-walks consume the opp
- `docs/learnings/2026-05-19-maestro-v2-probe-timeout.md` — read the trace before agreeing with the diagnosis
- `docs/learnings/2026-05-25-recipe-static-preventer-suite.md` — shift-left principle for recipe lint
- `docs/learnings/2026-05-25-bednet-smoke-phase6-install-rejection.md` — `commcare_validate_ccz` install gate + session-rescan governance rule
- `commands/mobile-bootstrap.md` — operator-facing one-time setup
- `docs/superpowers/specs/2026-04-28-ace-mobile-emulation-design.md` — design rationale
- `docs/atom-schemas.md` — canonical Zod-schema catalog (regenerate via `npx tsx scripts/dump-atom-schemas.ts`)
