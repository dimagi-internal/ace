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

**Diagnostic / debug:** `mobile_probe_maestro_driver`, `mobile_diagnose`, `mobile_restart_runner`.

`mobile_diagnose` is **dual-mode** (ace#961) — discriminate its result on the
`backend` field. On **cloud** it returns the in-VM `CloudDiagnostics` (SSM
state, runner-ready marker, adb devices). On **local** it returns
`LocalDiagnostics`: `adb_server_port` (the port this session actually
allocated — typically 5039), `adb_env_hint` (the copy-pasteable
`ANDROID_ADB_SERVER_PORT=<n>` prefix), the devices visible on *that* port,
and the running AVD's serial + name. **Run it first whenever a raw
`adb devices` shows nothing** — the local backend never uses the default
5037, so an empty list from a bare `adb` proves nothing about the emulator.
Read-only: it never boots, kills, or wipes. `mobile_restart_runner` and
remains cloud-only.

**Ad-hoc snapshot (debugging only):** `mobile_save_snapshot`, `mobile_load_snapshot` — NOT on the Phase 6 heal path; useful for operator-driven state captures during interactive debugging.

## Static recipes

`mcp/mobile/recipes/static/` holds the recipes that compose into every per-opp generated recipe. Live-verified against the active CommCare APK (2.62.0 / 2.63.0). The directory listing is the source of truth — `ls mcp/mobile/recipes/static/` for the current set. As of this writing: `connect-login`, `connect-claim-opp`, `connect-register-to-otp`, `connect-register-from-otp`, `learn-launch`, `learn-tap-module`, `form-advance`, `form-submit`, `deliver-launch`.

Naming note: `to-otp` / `from-otp` filenames are historical. Today's flow uses the `+7426` demo-bypass prefix; the snackbar `"I see you're a demo user, so we'll skip the OTP"` replaces the OTP screen. See `docs/learnings/2026-05-14-demo-user-no-otp.md`.

Selector substitution: every static recipe uses `${SELECTOR:logical-name}` placeholders resolved against `mcp/mobile/selectors/connect-<apk-version>.yaml` at `mobile_run_recipe` time. Add a new APK version by copying that file.

Structural preventers run before AVD wall-clock burns:
- `mobile_validate_recipe` → `lintRecipeText` catches `inputtext-scalar-with-sibling-option`.
- `mcp/mobile/recipe-sanity-probe.ts` catches `form-advance-without-answer-tap`, `answer-tap-before-leading-label-advance` (its inverse — too FEW advances past a form's leading `label` screens, ace#1045) and `brief-label-drift`. It also reports `verdict.warnings[]` for checks that were inert on these inputs (`module-form-checks-not-run`, ace#1068) — read those before treating `ok: true` as a clean pass.
- `test/mcp/mobile/static-palette-health.test.ts` asserts every static recipe parses, declares `appId:`, passes lint, and resolves every selector ref against the active map.

See `docs/learnings/2026-05-25-recipe-static-preventer-suite.md` for the shift-left principle behind these checks.

## Validating a palette fix pre-merge (`ACE_MOBILE_STATIC_RECIPES_DIR`)

CLAUDE.md's self-heal gate says a mobile recipe/selector fix must be proven on a live device **before** it merges, and separately forbids writing into `~/.claude/plugins/cache/`. Until dimagi-internal/ace#1062 those two rules had no satisfiable intersection: `prepareRecipeForMaestro` resolved every palette file — and therefore every `runFlow: file:` ref — from the plugin's own install dir, with no override. **A caller-staged palette was silently ignored, which produces a false negative, not an error.** On 2026-07-29 (#1058) a staged fix was ignored, the Maestro trace showed the OLD blocks executing, and the run read exactly like a failed fix.

The recipe:

1. Point the palette dir at your worktree. Either export it before launching Claude Code:
   ```bash
   export ACE_MOBILE_STATIC_RECIPES_DIR=/abs/path/to/ace/mcp/mobile/recipes/static
   ```
   …or (more reliable — doesn't depend on how Claude was launched) add the same line to the installed `${CLAUDE_PLUGIN_DATA}/.env`, which the MCP loads via dotenv at startup. Expand the path yourself: an unexpanded `${...}` is rejected, not guessed at.
2. **Restart Claude Code (full process restart).** MCP subprocesses bind their env at spawn — `/ace:update` + `/reload-plugins` will NOT pick this up. See CLAUDE.md § MCP changes need a full Claude restart.
3. Confirm the override actually took. Two independent signals, both added by #1062:
   - the MCP startup banner: `[ace-mobile] startup … palette_dir=<your dir> palette_source=override:ACE_MOBILE_STATIC_RECIPES_DIR`
   - every `mobile_run_recipe` result carries `paletteDir` + `paletteDirSource: 'override'`, and the run logs `recipe-resolver: palette dir OVERRIDE in force`.
4. Run the blocked leg. A green result now means the *staged* palette is green — that's the live validation the self-heal gate wants.
5. Merge, `/ace:update`, restart, unset the override.

Fails closed on purpose: a path that doesn't exist, isn't a directory, holds no `.yaml`, or still contains a `${...}` reference throws `MobileError('STATIC_RECIPES_DIR_INVALID')` at client construction — the MCP refuses to start rather than quietly serving the install palette. An empty/whitespace value means "unset."

Related hardening: if the top recipe's own directory holds sibling YAMLs that the palette dir shadows, the run logs `SHADOWED` and names them. Staging a palette *next to the recipe* never wins — the palette dir does. That was the #1058 misconception.

**Alternative (the previously-undocumented workaround):** drive the repo's own `MobileClient` under `npx tsx` from the checkout, so `import.meta.url` resolves to the repo palette. Still valid, and useful when you want to bypass the MCP layer entirely — but it doesn't exercise the atom path, so prefer the env var when what you're validating is a Phase 6 leg.

## Stalled-dispatch capture rescue

A `maestro test` chunk runs under a wall-clock ceiling sized by `lib/maestro-chunk-timeout.ts` — floor 10 min, `PER_STEP_MS` per step, capped, overridable with `ACE_MOBILE_CHUNK_TIMEOUT_MS` ([ace#1570](https://github.com/dimagi-internal/ace/issues/1570)). When it expires, [ace#1164](https://github.com/dimagi-internal/ace/issues/1164) throws a typed `MobileError('MAESTRO_STALL')` naming how far the dispatch got, and `runRecipeWithDriverHeal` keys on the code so a wedge never triggers a silent full-journey replay.

Those two fix the *budget* and the *diagnosis*. Neither recovers the **captures** of a walk that does stall — and because the stall THROWS, no `RecipeRunResult` is built, so `collectScreenshots` never runs and every PNG the dispatch earned is reported as nothing at all. Live twice: turmeric-market-study/20260807-1903 (57 real PNGs stranded, `screenshots_shipped: 0`) and hh-poverty-targeting/20260819-1435 (59).

`mcp/mobile/maestro-debug-harvest.ts` closes that. On a stall **or** any non-zero chunk exit, PNGs Maestro wrote into its own debug bundle (`~/.maestro/tests/<ts>/<flow>/takeScreenshot/`, honouring `MAESTRO_CLI_HOME`) are copied into the dispatch dir along with `maestro.log`, and the thrown error's `diagnostics` carries `rescued_screenshots[]` + `rescued_log`.

Bounded on both sides so [#756](https://github.com/jjackson/ace/issues/756) freshness holds:

- only bundle dirs touched at/after **this** invocation started are eligible, so a previous dispatch's bundle can never be pulled in;
- every rescued file is renamed `rescued--<flow>--<name>.png`, so it can never be mistaken for a step capture the recipe actually completed;
- an existing same-named PNG in the dispatch dir is never overwritten, and zero-byte files are skipped.

**Rescued captures are evidence, not a pass.** `status` stays `fail` / the stall still throws, and #756 still forbids presenting them as one clean journey set.

Triage tip: read `rescued--maestro.log` first — its last `COMMAND` line is where the walk actually died. `journey-*-FAILURE.xml` is dumped *after* the app returns to the Connect jobs list, so it reads like a claim/resume stall regardless of the real cause.

## Dispatch-scoped output dirs

`screenshotDir` is a run-scoped **root**, not the literal output directory. Each `mobile_run_recipe` dispatch owns `<screenshotDir>/<recipeId>/` — PNGs, ui-dump XMLs, `*-FAILURE.*` forensics, provenance sidecars, mp4s — and the start-of-run wipe ([#756](https://github.com/jjackson/ace/issues/756)) targets **only** that subdirectory. Read artifacts back from the returned `screenshotsDir` / `screenshots[].path`; a glob over the root spans every recipe the phase ran.

Why it's built this way ([dimagi-internal/ace#1130](https://github.com/dimagi-internal/ace/issues/1130)): two journeys used to be handed one directory, so the Deliver leg's legitimate wipe deleted the Learn leg's finished, PASSING screenshots + video (bednet-spot-check/20260731-1353). That evidence is not re-capturable — Learn completion is one-way per (test user, opportunity) (#568/#570), so the only remediation is a fresh `/ace:run`. Namespacing makes the wipe's blast radius equal the dispatch **by construction**; the alternative fix — sparing journey PNGs from the wipe — would have re-opened #756's stale-capture class.

Namespacing is by **recipe id**, not by the unique-per-invocation `dispatch_id`: a unique-per-invocation directory would make the wipe vacuous and strand every superseded attempt's ordinary PNGs in sibling directories, which is the same stale-carryover class one level up. `dispatch_id` remains the per-invocation identity, carried in each artifact's provenance sidecar. Re-running the SAME recipe still clears that recipe's prior ordinary output (#756 intact), while `00-*` ground truth and `*-FAILURE.*` forensics inside it still survive ([#1034](https://github.com/dimagi-internal/ace/issues/1034)).

The caller-supplied root is guarded exactly as the wipe target always was — filesystem root, single-segment paths (`/tmp`), `$HOME` and the cwd are refused — so the extra path segment cannot be used to smuggle a shallow path past the check. (Constraining the wipe to an allow-listed base is [#1111](https://github.com/dimagi-internal/ace/issues/1111), still open.)

Implementation: `mcp/mobile/screenshot-dir.ts` (`dispatchOutputDir`, `resetScreenshotDir`), called from `MobileClient.runRecipe`. Tests: `test/mcp/mobile/screenshot-dir.test.ts` + the `dispatch-scoped output` block in `test/mcp/mobile/client.test.ts`.

## Recording

Every local `mobile_run_recipe` call records an mp4 via on-device
`adb shell screenrecord --time-limit 0`, started and stopped by
`mcp/mobile/screen-recorder.ts` around each attempt. Videos land in the
dispatch's own output dir — `<screenshotDir>/<recipeId>/<recipeId>.mp4`,
plus `<recipeId>-attempt<N>.mp4` when a driver heal forced a retry (see
§ Dispatch-scoped output dirs) — and are copied into a per-session spool
at `~/.ace/mobile-videos/<ppid>/` for skill-side upload.

Skills reach the spool through `mobile_list_session_videos` /
`mobile_clear_session_videos`, never by hand-resolving the path — the
ppid keys the spool and belongs to the MCP process, so a skill that
globs `mobile-videos/*/` reads (and then deletes) a CONCURRENT session's
recordings. Note the spool holds EVERY recorded video, including the ones
`mobile_run_recipe` also returns in `result.videos[]`; an uploading skill
must de-duplicate on `recipeId` + `attempt` or it uploads each journey
twice.

**Why on-device and not the emulator console.** `adb emu screenrecord`
authenticates against `~/.emulator_console_auth_token`, which is
per-macOS-user. ACE workstations run emulators under more than one account
— probed live 2026-07-30, an `adb emu screenrecord` against a sibling
account's emulator returns `KO: authentication token does not match`. The
console recorder would work for emulators we spawned and fail on any we
merely attach to. On-device `screenrecord` is owner-agnostic.

**`--time-limit 0` is load-bearing.** screenrecord's default limit is 180
seconds; Maestro runs are allowed up to 10 minutes. Without the flag a long
journey silently records only its first three minutes.

**Stop with SIGINT, never SIGKILL.** screenrecord writes the mp4 moov atom
on a clean interrupt; SIGKILL leaves an unplayable file.

**Off switch:** `ACE_MOBILE_RECORD=off`. Tuning: `ACE_MOBILE_RECORD_BITRATE`
(default `1M`), `ACE_MOBILE_RECORD_SIZE` (default `540x1140`) — roughly
5–8 MB per journey-minute at the defaults.

**Cloud backend does not record yet** (Phase 2 — see
`docs/superpowers/specs/2026-07-30-avd-session-recording-design.md`).

## Device-state heal: always cold-boot per dispatch

`mobile_ensure_avd_running` is the single funnel for landing the AVD on a Phase-6-ready state. Callers make ONE call and trust the return. Read-only probes (`mobile_probe_maestro_driver`) cannot heal — halting on them defeats the auto-heal.

**What the return does and does not assert (ace#1067).** A successful return means *the restore sequence ran to completion without a typed error* — it is NOT a guarantee that every step was independently confirmed. The `heal.deviceUserState` block is what carries the confidence, and it is honest about its own limits: `verified_as` reports the post-restore probe's actual verdict (`unknown` included, and `unknown` is ordinary), and unconfirmed registration steps carry an explicit `-unverified` suffix. So don't read `status: "booted"` as "everything downstream is guaranteed" — read the heal block. The atom's job is to make the *uncertainty* legible, not to hide it; the funnel previously reported `bootstrap_steps: [..., "registered"]` next to `verified_as: "unknown"`, and a caller that trusted the step name over the verdict burned a full recipe cycle finding out.

**The contract is "always restore the precondition, never adapt to whatever state is in front of us"** (per `CLAUDE.md § Phase preconditions are restored, not adapted`).

Local AVD: kill emulator → cold-boot AVD with `-wipe-data -no-snapshot-load -no-snapshot-save` → install APK from host-side SHA256-validated cache → register demo-prefix test user via the two registration recipes → apply environment baseline (front camera, CAMERA permission, GMS toggle around the registration boundary) → reinstall Maestro driver → verify. Steady-state cost ~60–90s per dispatch. See `mcp/mobile/client.ts:restoreDeviceUserState` and `mcp/mobile/backends/avd.ts:ensureAvdRunning`.

Cloud: `/api/mobile/ensure-running` cold-boots from AMI on every call. Same contract, different mechanism — the AMI's baked registration scripts produce a fresh demo user on every cold-boot.

**Boot gates are two-stage and the pm stage retries (#1072, #1067).** Before touching `pm`, `installDriverApks` waits up to 180s for the device to be *present on the adb server* and report `sys.boot_completed=1` (`AVD_BOOT_TIMEOUT` on failure — sized for a real `-wipe-data` cold boot). Only then does it spend the short `package`-service budget (`AVD_PM_SERVICE_TIMEOUT`), which is scoped to the ~5–15s post-boot service race and now gets **two** 30s attempts, re-confirming device presence between them. Both classes exist separately on purpose: "never appeared", "appeared but never booted", and "booted but pm never bound" have different causes and different fixes, and collapsing them into the pm message is what made this read as a stuck emulator for two sessions.

**Why no snapshot fast-path:** the snapshot-load path silently aged (device wall-clock froze at capture; Connect token's expiration was real-time; 401s ensued). Cold-boot is deterministic. See `docs/learnings/2026-05-14-demo-user-no-otp.md` for the cost analysis (~20s fresh registration, not the often-quoted 3–5 min).

**Demo user OTP bypass:** test phone numbers prefixed `+7426` skip SMS OTP entirely; Connect's backend recognizes the prefix and emits a snackbar `"I see you're a demo user, so we'll skip the OTP"`. The recipe pair is named `to-otp` / `from-otp` for historical reasons; today these are pre-snackbar and post-snackbar.

## Classifier states

`classifyDeviceUserState` runs after heal to verify the precondition was reached. It's a verification step only — recovery is always cold-boot, never "adapt based on what state we found."

| `DeviceUserStateClass` | Recovery | When you'll see it |
|---|---|---|
| `ready` | none | Connect nav-drawer items present OR opp/visit activity foregrounded |
| `commcare-not-installed` | cold-boot funnel (installs APK) | `org.commcare.dalvik` absent from a **successful** `pm list packages` |
| `needs-personal-id` | cold-boot funnel (re-registers) | "Logged out of PersonalID" banner, OR no positive Connect-nav signal + first-start markers |
| `app-crash-looping` | none — APK/app-side fix | `FATAL EXCEPTION` with `org.commcare.dalvik` in the crash block |
| `uiautomation-unavailable` | **kill the competing automation client** | `uiautomator dump` wrote no `window_dump.xml`, and/or `logcat -b crash` carries `UiAutomation.connectWithTimeout` / `registerUiTestAutomationServiceLocked` |
| `device-unreachable` | fix the probe path first | the probe's own adb server had no device attached — nothing was observed |
| `probe-failed` | fix the probe path first | a device was reachable but `pm list packages` errored — package state UNKNOWN |
| `unknown` | treated as ready | classifier couldn't read the dump — accept rather than reject |

Order matters: the PersonalID-wipe banner is checked **before** Connect-nav-positive signals (stacked-state precedence — a freshly logged-out user may still have nav-drawer items cached on screen). First-match wins.

**A failed query is not a negative answer** (ace#1155). The probe's package
list is `string[] | null`; `null` means the query threw, and the classifier is
structurally forbidden from returning `commcare-not-installed` from it. Before
this, `listPackages` degraded an errored `adb` call to `[]` and the first line
of the classifier read that as a confident "CommCare is absent" — which is
exactly what shipped on `hh-poverty-targeting/20260730-2210`, twice, against a
device with CommCare installed, booted, and foregrounded on
`PersonalIdActivity`. It is the most believable wrong answer available, because
it names a concrete checkable thing, and it sent two investigations at
reinstall/re-bootstrap dead ends.

**Android allows ONE `UiAutomation` client per device.** A second one (a
sibling ACE session's Maestro/uiautomator, an IDE inspector) starves the
first, and the loser's `uiautomator dump` dies with `RuntimeException: Bad
file descriptor`. That is `uiautomation-unavailable`, and its remediation is
the *opposite* of `commcare-not-installed`'s. Because each session talks to
its OWN adb server, the competing client is invisible from inside one session
— so on this class the funnel enumerates the host's adb fork-servers
(`AvdBackend.listAdbServerPortsSeeing`) and names every port attached to the
same serial in the failure text. The incident host had **four** (5038, 5040,
5041, 5042) on a single `emulator-5556`.

Related: `mobile_capture_ui_dump` returning `elements: []` is ambiguous on its
own — `UiDumpResult.failed` is the field that distinguishes "the screen has no
hierarchy" from "the dump never happened."

## Gotchas (durable knowledge)

- **CommCare's form-submission-to-server behaviour is NOT deterministic across
  dispatches — sometimes it auto-sends on finalize, sometimes it does not.**
  Both were observed on the SAME opportunity within 24h
  (`bednet-spot-check/20260729-1239`, CommCare 2.63.0):

  | run | after `form-submit` | on tapping "Sync with Server" |
  |---|---|---|
  | Phase 6 | `Daily Visits 0/5`, `last synced: never` | manual sync produced the visit |
  | validation | counter already advanced `1/5 -> 2/5` | toast: `No forms sent to server!` |

  So **`No forms sent to server!` is a benign no-op, not a failure** — it means
  the outbox was already empty because auto-send had beaten you to it. Do not
  "fix" a recipe that reports it.

  The practical consequence for any Deliver journey: a trailing sync tap is
  belt-and-braces and cannot be the thing you assert on, because on an
  auto-sent run it legitimately uploads nothing. Assert the SERVER-DERIVED
  outcome instead — `Daily Visits` non-zero on-device (`deliver-sync.yaml`),
  and authoritatively `connect_get_deliver_progress().approved >= 1`
  (dimagi-internal/ace#1066). This is why the device-side gate and the
  Connect-side read-back both exist and neither replaces the other.

- **`verified_as: "unknown"` from the heal funnel is the ORDINARY
  post-bootstrap state on a healthy device — not a fault.**
  `classifyDeviceUserState`'s `ready` definition is deliberately broad, and the
  legitimate post-register/pre-claim state falls outside it. Two runs that
  returned `STATUS: pass exit 0` (the #1058 claim-leg validation and the #1074
  deliver-sync validation) both logged `restored to unknown via
  local-bootstrap` immediately beforehand. Treating `unknown` as fatal would
  fail working runs — see ace#1067, where that was requested and deliberately
  declined. What WAS wrong was the log claiming `bootstrap_steps: [...,
  "registered"]` alongside it; that now reports `registered-unverified`.

  **Read the step suffix, not the step name, to know what was confirmed.**
  `registered` / `register-already` mean a post-bootstrap probe classified the
  device `ready`. The `-unverified` forms mean the registration call returned
  but nothing confirmed the resulting device state — an ordinary outcome, not a
  failure. One vocabulary, one implementation
  (`markRegistrationUnverified` in `mcp/mobile/client.ts`), both backends.

- **The CLOUD heal never verifies anything, and now says so.** `cloudBootstrapHeal`
  has no lightweight probe (its only UI-dump route is a full Maestro
  round-trip), so it returns `classified_as: 'unknown'`, **omits `verified_as`
  entirely**, and always suffixes its registration step `-unverified`. It used
  to hardcode `classified_as: 'ready'` + `verified_as: 'ready'` while probing
  nothing — a strictly larger claim than the local defect above, since local at
  least reported what its probe said. So: **on cloud, absence of `verified_as`
  is the contract, not a bug**, and it is NOT evidence the device is unhealthy.
  If a real cloud probe is ever added, feed its verdict in and drop the suffix
  on confirmation, exactly as the local path does.

- **Connect's PM-side tables hide integers inside Alpine/htmx attributes — a
  naive `/<[^>]+>/g` tag-strip reads numbers OUT OF THE JAVASCRIPT.**
  The worker-deliver table wraps Delivered/Approved/Rejected in
  `x-data="{ ... }"` containing both angle brackets
  (`window.innerHeight - rect.bottom < rect.height`) and digits, plus an
  `hx-get="...?status=approved&payment_unit_id=..."` URL. Measured on the live
  fragment: naive yields Approved=1/Rejected=1 where the truth is 2/0. It does
  not throw — it silently returns wrong counts. Use
  `stripTagsAttributeAware` (`mcp/connect/backends/html-scrape.ts`); enforced
  by `test/mcp/connect/worker-deliver-table.test.ts`.

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

### Geopoint (GPS) capture — mock-location + Capture flow

A CommCare `geopoint` question is a **Capture-button widget** that reads the device GPS provider — NOT a free-text field. (The #593/#686 "GPS is a plain text box by design, type a `lat lon alt accuracy` string" conclusion was **wrong**: that render came from a stale build whose XForm bind compiled to `type="xsd:string"` instead of `type="geopoint"`. `app-release-qa` now hard-gates that class, so a correct build always renders the real Capture widget. See jjackson/ace#686.)

On an emulator the GPS provider never acquires a fix on its own, so the Capture button would hang. Two mechanisms make it work:

- **Cold-boot baseline mock fix (automatic).** `AvdBackend.applyEnvironmentBaseline` seeds `DEFAULT_MOCK_LOCATION` (Kano, Nigeria — `adb emu geo fix <lon> <lat> <alt> <sats>`, **longitude FIRST**) on every cold-boot, so any geopoint Capture has a provider fix to read out of the box. Live-verified the emulator GPS provider then reports `hAcc≈5m` (well under a typical 50 m gate). It's part of the baseline fingerprint (`mock_location_fix`).
- **`mobile_set_location` atom (per-opp override).** Pass `{longitude, latitude, altitude?, satellites?}` to set opp-specific coordinates for realistic screenshots. **Longitude is the first coordinate** (emulator console convention — the classic transposition footgun). Local-AVD only today; the cloud backend throws `CLOUD_MOCK_LOCATION_UNSUPPORTED` (a `/api/mobile` location-set route is a follow-up).

**Recipe authoring + the not-yet-calibrated selector (TODO).** The geopoint Capture-button *selector* is **not yet in the selector map** — it must be dumped live against a correct on-device build (we have not had one yet; this run's build was stale). When calibrating, also check whether `auto_gps_capture: true` (set at the app level) means CommCare auto-fills the fix in the background — if so the recipe may only need a `mobile_set_location` + a wait, with no explicit Capture tap. Until calibrated, `app-test-cases` Step 3 item 4.5 marks the geopoint step `deferred`; never `inputText` a coordinate string (the `recipe-sanity-probe` `inputtext-geopoint-as-string` rule flags that).

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

### Two different ports, both correct — read the label (ace#1818)

`mobile_probe_maestro_driver` reports `adbPort`; `mobile_diagnose` reports `adb_server_port`. They are routinely different numbers and that is **not** a contradiction:

| Field | What it is | Where it comes from |
|---|---|---|
| `mobile_probe_maestro_driver.adbPort` (`portKind: emulator-adbd-direct-tcp`) | the EMULATOR'S OWN adbd port — `emulator-5558` -> **5559** | `adbPortFromSerial(serial)`; Maestro dials it on the `Dadb.create(localhost, port)` direct-TCP path |
| `mobile_diagnose.adb_server_port` | the adb **fork-server** port this session allocated | `port-allocator.ts`, walking upward from 5037 |

Seeing `adbPort: 5559` next to `adb_server_port: 5040` is expected. Reading it as evidence the probe "isn't connecting through the port it reports" cost a triage on `bednet-check-2-visit/20260828-0629`.

The real defect on that run was the other half: the probe answered `healthy: true` on a serial with **no `dev.mobile.maestro` installed**. `maestro hierarchy` runs over a HOST-keyed TCP port, so a zero exit proves "something answered on localhost:N", not "the driver is on this serial" — and this host runs two macOS accounts' emulators (ace#1819). The probe now asserts `pm list packages dev.mobile.maestro` first (~50ms), and `assertMaestroDriverHealthy` skips its stage-1 liveness probe entirely when the packages are known absent, so a false-healthy verdict can no longer short-circuit the driver install. `driverPackages.queryOk: false` means the query could not be answered — per ace#1155 that is **not** an absence, and the health verdict is flagged UNVERIFIED rather than forced to `false`.

Also worth knowing: the cold boot is `-wipe-data`, so **the driver is removed on every boot** and must be re-installed per dispatch. `Not able to reach the gRPC server` on a fresh AVD is usually literal — there is no server, because the app hosting it is absent.

### Chunking follows `runFlow: file:` into the palette (ace#1570)

`mobile_run_recipe` splits a recipe into chunks and runs each as its own `maestro test`, dumping the UI hierarchy XML in the quiet window between them (that window is the only place `uiautomator dump` can run — Maestro holds the service exclusively). Each chunk also gets its own watchdog budget.

The splitter used to look **only** at the parent recipe's own top-level `takeScreenshot:` steps. ACE's Phase-3 authoring idiom composes journeys almost entirely out of `runFlow: file: <palette>.yaml`, and every palette file screenshots internally — so a Learn journey saw **zero** split points and ran as `chunk 1/1`. On hh-poverty-targeting/20260819-1435 that single chunk was killed by the then-flat 600s watchdog mid-walk, and Connect's Learn completion is one-way per (test user, opportunity), so the run was gone.

It now reads the subflow. A top-level `runFlow: file:` opens a boundary where the subflow itself screenshots at an edge:

- **leading** (subflow's first non-assertion step is `takeScreenshot`, e.g. `form-advance.yaml`) → boundary **before** the runFlow;
- **trailing** (subflow's last non-assertion step is `takeScreenshot`, e.g. `learn-launch.yaml`, `form-submit.yaml`) → boundary **after** it.

Only assertions count as screen-neutral padding around that screenshot. A palette that opens with `extendedWaitUntil` (`learn-tap-module.yaml`) reports **no** leading boundary on purpose: a wait exists because the surface is still changing, so the screen at the parent's boundary need not be the one in the PNG — and a mismatched dump is worse than a missing one. A trailing boundary meeting the next call's leading one collapses into a single window (nothing runs in between; it would be the same screen at full cost).

`<name>.xml` is named from the caller's own `env:` binding, so it pairs with the `<name>.png` Maestro writes. An unbound call site still gets its chunk boundary but no dump — never a literal `${SCREENSHOT_NAME}.xml`.

**Cost, and the knob.** More chunks means more Maestro cold-starts at ~10–12s each (see above). A 6-module Learn journey goes from 1 chunk to ~79. Set `ACE_MOBILE_SPLIT_AT_SUBFLOW_SCREENSHOTS=off` to fall back to top-level-only splitting without a plugin update. Every dispatch logs `maestro: <recipe> → N chunk(s), M dump window(s), S top-level step(s)`, so the real cost is readable from any run's log.

*Enforced:* `test/mcp/mobile/recipe-splitter-subflow.test.ts` pins the leading/trailing contract of every file in `recipes/static/`, so a palette that moves or adds a screenshot the splitter cannot act on fails CI instead of silently switching chunking off again.

### A subflow's own `env:` block OVERRIDES caller-passed `runFlow: env:` (Maestro 2.5.1)

Maestro's `env:` block reads like "defaults you can override." It is the
opposite: **a flow's own top-level `env:` wins over anything the caller
passed** — both `runFlow: env:` from a parent flow and `-e KEY=VALUE` on the
CLI. Traced through the pinned 2.5.1 source:

1. `MaestroFlowParser.parseFlow` turns the flow's own `env:` into a
   `DefineVariablesCommand` and prepends it *inside* the flow body:
   `[ApplyConfiguration, DefineVariables(ownEnv), ...body]`.
2. `YamlFluentCommand.runFlow` (and `TestRunner`, for CLI `-e`) wraps that list
   with `Env.withEnv`, which prepends **another** `DefineVariablesCommand` in
   front: `[DefineVariables(callerEnv), ApplyConfiguration,
   DefineVariables(ownEnv), ...body]`.
3. `Orchestra.runSubFlow` / `Orchestra.runFlow` execute every
   `DefineVariablesCommand` **in list order**, and `GraalJsEngine.putEnv`
   assigns unconditionally.

Last write wins → the flow's own block clobbers the caller's value.

Consequence for the ACE palette: **palette subflows must never declare `env:`
defaults for caller-supplied parameters.** A "fallback" there is not a
backstop — it is a silent override of every call site. This is exactly how
dimagi-internal/ace#852's fix (screenshot-name defaults in `form-submit.yaml`)
went on to defeat the per-journey naming it was added to enable, observed live
on bednet-spot-check/20260728-2222 and refiled as ace#1033. Screenshot names
are now caller-bound only, gated at authoring time by the
`runFlow-unbound-screenshot-name` rule in `mcp/mobile/recipe-lint.ts` (run by
`mobile_validate_recipe`) plus the palette/SKILL.md invariants in
`test/mcp/mobile/static-recipe-invariants.test.ts`.

Corollary: an **unset** placeholder is not empty — Maestro renders `${FOO}`
with `FOO` undefined as the literal string `undefined`, so
`takeScreenshot: "${SCREENSHOT_NAME}"` writes `undefined.png` rather than
failing.

## Selector discovery loop

When extending recipes or building atlas coverage for a new APK version:

1. Cold-boot a fresh AVD via `mobile_ensure_avd_running`. **Do not load a snapshot** — they're for ad-hoc debugging only.
2. Drive the AVD into the state of interest. If you tap through far enough to consume the opp (e.g. complete Learn flow), expect that the next Phase 6 dispatch on the same opp will halt at claim-opp — see `docs/learnings/2026-05-14-atlas-side-channel-capture.md` Finding 2.
3. `mobile_capture_ui_dump` returns parsed elements + XML in one call. Prefer this over `adb shell uiautomator dump` + `adb pull` + `grep`.
4. **Use `maestro studio` for new selector capture.** Interactive selector picker against the live AVD: tap an element in the browser, it shows the resource-id and a copy-pasteable Maestro snippet. Far faster than dump-and-grep.
5. Add the next 5–10 steps to the recipe in one batch (not one-at-a-time), re-run, dump at the next checkpoint.
6. After Phase 6 runs, `scripts/probe-atlas-drift.ts` harvests selector-drift signal from accumulated `runRecipeWithDumps` XMLs — read-only, surfaces candidate new logical-selector rows for the selector map. It walks `*-FAILURE.xml` dumps too and surfaces ids seen on a failure screen but absent from the map as a **priority "Drift suspects on FAILURE screens"** section — each is a candidate root cause for a recipe failure in this run. `app-screenshot-capture` Step 6.5 runs this automatically at end of Phase 6.

**Anti-pattern:** screencap + Read PNG + dump + grep after every single tap. PNG reads are expensive in tokens. Almost every CommCare/PersonalID selector is resource-id-driven; uiautomator XML has all the info. Reserve screenshots for genuinely visual states (camera UI, where AOSP elements lack resource-ids).

## A teardown exception is not a verdict, and a failure never discards artifacts (ace#1822)

Maestro closes its session on a shutdown thread. When that close throws — `Broken pipe` out of `AdbWriter.writeClose` -> `AndroidDriver.close` -> `MaestroSession.close` — the JVM exits non-zero even though every step already ran. `Broken pipe` is a `driver` pattern, so pre-#1822 that read as a driver death, which is the ONE class the heal-and-retry envelope acts on.

Two things now hold:

1. **A teardown-only fault on a walk that reached the end is a `warnings[]` entry on a `pass`, not a `fail`.** `lib/maestro-teardown.ts` decides this and is deliberately conservative — it requires a non-main-thread banner AND teardown frames AND the absence of any in-walk failure evidence (`Element not found`, `Assertion is false`, `[Failed]`, `UNAVAILABLE`, `Not able to reach the gRPC server`, a step timeout, a parse error…). A chunked run that stopped part-way is `walkCompleted: false` and stays a failure no matter how clean the stack looks — the chunks after the failing one genuinely never ran. `exitCode` is never rewritten, so a warning-carrying `pass` with a non-zero exit is the audit trail.

2. **A failed dispatch still hands back what it captured.** `runRecipeWithDriverHeal` no longer lets a throwing `heal()` discard the attempt's result, and `client.runRecipe` attaches a `partialResult` (`screenshots` with `takenAt`, `videos`, `screenshotsDir`, `recipeId`, `dispatchId`) to the error it rethrows; `mobile_run_recipe` surfaces that in the `isError: true` payload.

**Why this class is worth a section.** Learn completion is one-way per `(test user, opportunity)` (#568/#570) and #573 rules out a mid-run opportunity re-mint. So a walk that genuinely completed and is reported as failed cannot be re-run, and the two obvious responses are both dead ends — a false failure there costs a whole fresh `/ace:run`. On `bednet-check-2-visit/20260828-0629` the Learn leg submitted (Connect flipped `learn_complete: true`, 35 non-zero PNGs landed, zero `*-FAILURE.*` forensics were written), the teardown stack triggered a cold-boot heal, the heal's own registration failed, and the unguarded `await opts.heal()` replaced all of it with `register_test_user part A failed: …` — an error from the cold boot, for a walk that had already done its unrepeatable work.

**Reading the result:** `status` and `failure.failureClass` describe the WALK. `exitCode` describes the PROCESS. `warnings[]` is where a fault that did not decide the verdict goes. When they disagree, that is the design, not a bug.

## Failure forensics — read them on any recipe failure

This is the canonical reference for the screenshot-on-error capture; the per-skill notes point here so the contract lives in one place.

**What's captured (cross-backend, automatic).** On a recipe failure, `mobile_run_recipe` captures the device state at the moment it died and surfaces it as `failureForensics`:

- `screenshotPath` → `<recipe-id>-FAILURE.png` — the offending screen.
- `uiDumpPath` → `<recipe-id>-FAILURE.xml` — the element tree (resource-ids / text / bounds): the highest-signal artifact for "wrong selector vs wrong screen".
- `elements` → the parsed ui-dump rows.

Both files land in the failing dispatch's own output dir (`<screenshotDir>/<recipeId>/` — see § Dispatch-scoped output dirs), so they're uploaded + provenance-stamped alongside the smoke PNGs and Read-able from local disk on **both** the local-AVD and cloud backends (cloud pulls the S3 artifact down).

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
