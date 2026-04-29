# Mobile Integration

## Overview

The ACE↔CommCare-Android integration layer is the `ace-mobile` MCP server.
It drives a local Android emulator (AVD) on the operator's Mac/Linux/Windows
workstation through a small set of atomic capabilities, backed by Maestro,
adb, and Playwright.

This is dev-machine-only — no cloud device farms, no shared CI emulators.
The only consumer in production is Phase 5 `training-prep`, which uses the
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
| `connect-claim-opp.yaml` | scaffold (REPLACE_*) | `${OPPORTUNITY_NAME}` |
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

### Face-capture gate (2.62.0+)

CommCare 2.62.0 added an in-app face-capture screen
(`org.commcare.fragments.MicroImageActivity` aka "Capture Face Picture")
between the Backup Code step and registration completion. The screen
shows a live viewfinder with a `face_overlay` and uses face detection to
auto-trigger the shutter — there is no manual capture button.

**The AVD's emulated front camera does not show a face.** `emulated`
shows a moving gray test pattern; `virtualscene` shows an empty 3D
office. Neither triggers the face detector, so the recipe's final
`save_photo_button` assertion fails and registration cannot complete on
the device. The phone number IS registered server-side at this point
(name + backup code submitted), but the local CommCare app session is
blocked.

**Live-verified workarounds:** none in 0.10.x. Three hypothetical paths,
none implemented:

1. `hw.camera.front=webcam0` — uses the host Mac webcam. Requires a real
   human in front of the camera; defeats automation.
2. Stream a synthetic face image via the emulator gRPC API on port 8554.
   Complex, not yet prototyped.
3. Use a CommCare build flag or Connect-id demo-user provision to skip
   face capture entirely. Would need a server-side change.

**Implication for ACE Phase 5 `training-prep`:** screenshot capture of a
*deployed CommCare app* (the Phase 5 use case) does NOT need a fully
registered PersonalID — `app-screenshot-capture` opens the deployed app
directly, not via the registration flow. So this gate doesn't block the
ACE production path. It only blocks an end-to-end "register a fresh
test user from scratch on a clean AVD" flow, which is a one-time
bootstrap task documented as a known limitation.

### Google Play Services phone-number hint

GMS-equipped AVDs surface a "Choose a phone number" bottom sheet on focus
of the `connect_primary_phone_input` `AutoCompleteTextView`. The sheet IS
visible to Maestro's view tree once shown, so the recipes dismiss it via
`runFlow.when` against `com.google.android.gms:id/cancel`. On non-GMS AVDs
the conditional is a no-op.

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

- `connect-claim-opp.yaml` selectors are scaffolded (REPLACE_*). Discovery
  pass deferred — the registered-test-user state required for capture is
  blocked by the face-capture gate (see Gotchas above). For the Phase 5
  `training-prep` use case this isn't a blocker because the deployed
  CommCare app is opened directly without going through PersonalID
  registration.
- The deliver-app navigation recipes (`generate_recipes_from_app_summary`)
  have been wired but not run live against a Nova-deployed app. The
  generator's parsing logic is unit-tested; the LLM contract isn't.
- Cross-platform support is implemented but only verified on macOS Apple
  Silicon. Linux and Windows paths are best-effort, awaiting first-run
  validation.
- A face-capture bypass for fully-automated PersonalID registration on
  AVDs. The recipe runs through 28/30 steps; the final two
  (`save_photo_button` after auto-shutter) require a face the emulated
  camera doesn't supply. See "Face-capture gate" in Gotchas.

## Sibling docs

- `commands/mobile-bootstrap.md` — operator-facing one-time setup script
- `docs/superpowers/specs/2026-04-28-ace-mobile-emulation-design.md` — design rationale
- `docs/superpowers/plans/2026-04-28-ace-mobile-emulation.md` — implementation plan (substantially shipped through 0.10.17)
