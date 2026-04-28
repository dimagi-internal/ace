# ACE Mobile Emulation — Design

**Date:** 2026-04-28
**Status:** Draft for review
**Owner:** Jon

## Context

ACE generates CommCare apps and ConnectOps end-to-end without anyone touching a phone. That's a problem for two reasons. First, the apps eventually run on Android — flows that look correct in CommCare's web preview can fail on a real device (offline sync, Connect mobile-app handoff, camera/GPS capture). Second, the existing `training-materials` skill promises "step-by-step instructions for using the Learn and Deliver apps, with screenshots/descriptions of each form" but has no way to produce the screenshots, so today they're either omitted or invented. The downstream `llo-onboarding` email pipes those incomplete guides to LLOs.

This spec adds an **Android emulation layer** to ACE that runs on the operator's Mac, drives the Connect mobile and CommCare Android apps through a scripted flow, and captures raw PNGs at every step. The captures land in Drive at `ACE/<opp>/screenshots/` and become inputs to a future training-assembly skill.

Closely related prior art exists in the `commcare-ios` repo (Phase 9 E2E suite). It uses **Maestro** (declarative YAML mobile-test flows), drives the iPhone Simulator, and solves the ConnectID OTP-bypass problem via the `+7426` test-number prefix and a Playwright-based scrape of `connect.dimagi.com/users/connect_user_otp/`. We adopt the same patterns but **do not depend** on that repo — everything is reimplemented inside ACE so the plugin stays self-contained.

### What this is not

This is not a cross-platform mobile testing framework, a CI gate, a regression suite for Nova, or a substitute for human UAT. It is a one-machine-only utility for the ACE operator that produces screenshot artifacts as a byproduct of walking the apps once per opportunity.

## Goals

1. Add an `ace-mobile` MCP server exposing ten atomic capabilities (device, app, test-user, recipe-execution, debug) backed by a single Maestro implementation.
2. Ship four static reusable Maestro flows (`connect-register-to-otp`, `connect-register-from-otp`, `connect-login`, `connect-claim-opp`) plus an LLM-driven generator that produces per-Learn-module / per-Deliver-form recipes from existing `app-summaries/*.md` artifacts.
3. Add a new **Phase 5 `training-prep` agent** between current Phase 4 (`ocs-setup`) and current Phase 5 (`llo-manager`). The phase contains the new `app-screenshot-capture` skill plus the existing `training-materials` skill (relocated from current Phase 5). It runs end-to-end automated with no LLO contact, restoring the "Phases 1–N agent-only, then LLO contact" invariant. Existing `llo-manager` becomes Phase 6, existing `closeout` becomes Phase 7.
4. Make the new `training-prep` phase a true synthesis step: it consumes artifacts from **every prior phase** (PDD + test prompts + archetype from Phase 1, app summaries + deployment URLs from Phase 2, opp identifiers + invite URL + payment/delivery details from Phase 3, OCS chatbot embed URL + token from Phase 4) so the screenshots reference the right opp and the training docs include real URLs and context.
5. Reuse the `+7426` ConnectID test-prefix and Dimagi SSO OTP scrape as a **one-time bootstrap** (`/ace:mobile-bootstrap`), entirely within ACE — no shared state with `commcare-ios`.
6. Make every dependency surface introspectable by `/ace:doctor` (Maestro version, AVD presence, Playwright cookies, env-var resolution, APK install state).
7. Treat the mobile MCP capability map as a stable interface — even though there's only one backend today, the route table exists so a future cloud-device or Appium backend slots in without skill changes.

## Non-goals

- Cloud device farms (BrowserStack, Firebase Test Lab). Local AVD only.
- Headless CI runs. The operator's Mac is the only target.
- Linux/Windows host support. Mac only (Apple Silicon optimized).
- iOS support. Android only — the Connect mobile app and CommCare Android client.
- Driving the existing CommCare web-apps preview from inside `ace-mobile`. That stays inside `ace-web`.
- Visual annotation of screenshots (callout arrows, captioned footers, video stitching). Raw frames + a manifest only — annotation/training-doc assembly is a separate future skill.
- Acting as a regression test gate for Nova-built apps in general. ACE is the consumer; Nova has its own CI.
- Replacing `app-test`. `app-test` keeps inspecting form structure via the CommCare API; mobile capture is additive.
- Multi-test-user concurrency. One ACE test user, one AVD, one run at a time.

---

## Key findings from prior art

### `commcare-ios` Phase 9 proves the OTP path

`commcare-ios/.maestro/scripts/playwright/fetch-otp.js` uses Playwright's `launchPersistentContext` to maintain a Chromium user-data directory. First run is headed (the operator signs in to Dimagi SSO once); subsequent runs are headless and complete in a few seconds. The script navigates to `https://connect.dimagi.com/users/connect_user_otp/`, finds the OTP for a given phone number, prints it to stdout, and exits.

This works because connect-id's `TEST_NUMBER_PREFIX = "+7426"` (`users/const.py`) suppresses SMS delivery for matching numbers but still generates the OTP token in the database. Any `@dimagi.com` SSO user can read it via the staff-only OTP page.

**Implication for ACE:** we copy the *approach* (TS reimplementation), not the *file* (no commcare-ios dependency). Cookies live under `${CLAUDE_PLUGIN_DATA}/playwright-userdata/` so they persist across plugin upgrades.

### Self-service test-user creation, no Dimagi ops involvement

A misreading of `commcare-ios/docs/phase9/fixture-user.md` initially suggested ACE would need a Dimagi ops ticket to provision test phone numbers. That's wrong:

- **Creating a `+7426...` ConnectID account** is fully self-service via the in-app registration flow + the OTP scrape. Maestro types phone + PIN, the script fetches the OTP, Maestro types it back, sets a backup code. Done.
- **The pre-invite gate** (`check_number_for_existing_invites` in `users/views.py:955`) only blocks `send_session_otp` — it gates *opportunity-related session flows after registration*. ACE creates opportunities and controls invites itself, so this gate passes naturally once `connect-setup` invites the ACE test user to the new opp.

**Implication for ACE:** no external coordination required. The bootstrap step registers the ACE test user once per machine; per-opp setup invites that user to its own opp.

### Maestro vs Appium: Maestro fits ACE better

| Property | Maestro | Appium |
|---|---|---|
| Recipe shape | declarative YAML | programmatic code |
| Server lifecycle | none | Appium server + driver install |
| Built-in screenshots | yes (`takeScreenshot:`) | yes (`driver.takeScreenshot()`) |
| Cross-platform | iOS + Android | iOS + Android |
| Install on Mac | one-line | Node + drivers |
| `commcare-ios` precedent | proven | none |

Maestro's YAML model matches ACE's idiom (PDD frontmatter, `.env.tpl` config, generated artifacts in Drive). It also produces simpler LLM-generation prompts: the model emits a small list of well-known step types (`tapOn`, `inputText`, `takeScreenshot`, `assertVisible`) rather than imperative WebDriver code.

### `commcare-ios` is iOS-only — selectors do not transfer

Phase 9 flows reference iOS accessibility IDs (`signup_link`, `phone_number_field`, `country_code_field`). Our target is the **Android** Connect mobile app and CommCare Android client. We rediscover Android-side selectors via `maestro studio` (interactive inspector) when authoring the four static recipes. The flow *structure* in Phase 9 transfers as a reference; the selectors do not.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ ACE plugin                                                       │
│                                                                  │
│ skills/                            mcp/                          │
│ ├── app-screenshot-capture/        ├── mobile-server.ts          │
│ │   └── SKILL.md                   │   (registered inline in     │
│ │                                  │    plugin.json mcpServers)  │
│ └── (future) training-from-        │                             │
│     screenshots/                   └── mobile/                   │
│                                        ├── capability-map.ts     │
│                                        ├── client.ts             │
│                                        ├── types.ts              │
│                                        ├── auth/                 │
│                                        │   └── fetch-otp.ts      │
│                                        ├── recipes/              │
│                                        │   └── static/           │
│                                        │       ├── connect-register.yaml  │
│                                        │       ├── connect-login.yaml     │
│                                        │       └── connect-claim-opp.yaml │
│                                        └── backends/             │
│                                            ├── maestro.ts        │
│                                            ├── avd.ts            │
│                                            └── recipe-generator.ts│
│                                                                  │
│ commands/mobile-bootstrap.md                                     │
└──────────────────────────────────────────────────────────────────┘
              │                       │                   │
              ▼                       ▼                   ▼
     ┌─────────────────┐    ┌─────────────────┐   ┌──────────────────┐
     │ Android SDK     │    │ Maestro CLI     │   │ Playwright       │
     │ (avdmanager,    │    │ (~/.maestro)    │   │ (npm dep)        │
     │  emulator, adb) │    └─────────────────┘   └──────────────────┘
     └─────────────────┘             │                   │
              ▲                      ▼                   ▼
              │            connects via ADB     connect.dimagi.com
              │            to the running       /users/connect_user_otp/
       ┌──────────────┐    AVD                  (Dimagi SSO)
       │ AVD          │
       │ ACE_Pixel_   │
       │ API_34       │
       └──────────────┘
              │
              │  installed APKs
              ▼
       ┌──────────────────────┐
       │ Connect mobile (apk) │
       │ CommCare Android (apk)│
       └──────────────────────┘
```

### Why a new MCP, not skills shelling out directly to Maestro

Three reasons, in priority order:

1. **Same pattern as the rest of ACE.** `ace-ocs` and `ace-gdrive` both wrap external systems behind atomic MCP tools. Skills don't shell out — they call atoms. Mobile work shouldn't break that.
2. **Atomic interface insulates skills from backend swaps.** Today the only backend is Maestro on a local AVD; tomorrow it might be Appium against BrowserStack. The capability map already has a `backend` field per atom (mirroring `ace-ocs/capability-map.ts`) so adding a route is a one-line change.
3. **Centralized error surface.** Mobile errors are noisy (AVD didn't boot, ADB connection lost, Maestro flaked, OTP page returned no rows). The MCP boundary catches them once and converts them to structured errors that `/ace:doctor` and skill-level retries can handle uniformly.

### Capability map

Ten atoms split into five concerns:

```ts
// mcp/mobile/capability-map.ts
export type Backend = 'MAESTRO' | 'AVD' | 'COMPOSITE';

export type Capability =
  // Device lifecycle (3)
  | 'ensure_avd_running'
  | 'stop_avd'
  | 'list_avds'
  // App lifecycle (2)
  | 'install_apk'
  | 'uninstall_apk'
  // Test-user lifecycle (2)
  | 'register_test_user'
  | 'fetch_otp'
  // Recipe execution (2)
  | 'run_recipe'
  | 'generate_recipes_from_app_summary'
  // Inspection (1)
  | 'capture_ui_dump';

export const CAPABILITY_MAP: Record<Capability, { backend: Backend }> = {
  ensure_avd_running:                { backend: 'AVD' },
  stop_avd:                          { backend: 'AVD' },
  list_avds:                         { backend: 'AVD' },
  install_apk:                       { backend: 'AVD' },        // adb install
  uninstall_apk:                     { backend: 'AVD' },        // adb uninstall
  register_test_user:                { backend: 'COMPOSITE' },  // Maestro + Playwright
  fetch_otp:                         { backend: 'COMPOSITE' },  // Playwright only
  run_recipe:                        { backend: 'MAESTRO' },
  generate_recipes_from_app_summary: { backend: 'MAESTRO' },    // LLM + YAML emit
  capture_ui_dump:                   { backend: 'AVD' },        // adb uiautomator
};
```

The split is conceptual: `AVD` operations shell to `adb` / `emulator` directly; `MAESTRO` operations shell to `maestro test`; `COMPOSITE` operations chain Maestro and Playwright with state passed through env vars and stdout.

---

## Atoms — detail

### Device lifecycle

**`ensure_avd_running(avd_name?)`**
- Defaults `avd_name` to `${ACE_AVD_NAME}` env var (default `ACE_Pixel_API_34`).
- If `adb devices` already reports the AVD as `device`, no-op.
- Otherwise spawns `emulator -avd <name> -no-window -no-snapshot-save` in the background, polls `adb devices` until ready or 90s timeout.
- Returns `{ avd_name, serial, boot_time_ms }`.

**`stop_avd(avd_name?)`**
- `adb -s <serial> emu kill`. Idempotent.

**`list_avds()`**
- Returns the output of `emulator -list-avds`. Used by `/ace:doctor`.

### App lifecycle

**`install_apk(path | url, opts?)`**
- Accepts a local path or http(s) URL. URLs are downloaded to a tmp file first.
- Runs `adb install -r <path>` (replace existing).
- Returns `{ package_id, version }` parsed from `aapt dump badging`.

**`uninstall_apk(package_id)`**
- `adb uninstall <pkg>`. Returns `{ uninstalled: bool }`.

### Test-user lifecycle

**`register_test_user(phone, pin, backup_code, opts?)`**
- Composite: runs `static/connect-register-to-otp.yaml`, then `fetch_otp` internally, then `static/connect-register-from-otp.yaml`.
- Idempotent: if registration fails because the account already exists, returns `{ already_registered: true }` instead of erroring.
- The opts include `name` (display name on the ConnectID account, default `"ACE Test"`).
- **Side effect:** persists the chosen backup code to `${CLAUDE_PLUGIN_DATA}/ace-test-user.json` so `/ace:doctor` can verify the env-var-stored copy matches what was actually set on the server.

**`fetch_otp(phone)`**
- Runs the TS Playwright fetcher. Headed if cookies missing (with a clear error pointing the operator at `/ace:mobile-bootstrap`). Headless otherwise.
- Returns `{ otp, fetched_at }`.

### Recipe execution

**`run_recipe(recipe_path, env_vars?, screenshot_dir?)`**
- Resolves `recipe_path` relative to `mcp/mobile/recipes/static/` for static recipes or absolute for generated.
- Runs `maestro test --no-ansi -e KEY=VALUE ... --output <screenshot_dir> <recipe_path>`.
- Default `screenshot_dir` is a tmp folder; the skill chooses where to put final artifacts.
- Returns `{ status, screenshots: [{ step_name, path, taken_at }], stderr, exit_code }`.

**`generate_recipes_from_app_summary(opp_name, app_kind: 'learn' | 'deliver')`**
- Reads `ACE/<opp>/app-summaries/<kind>-app-summary.md` from Drive.
- Calls a small in-process LLM helper (Claude SDK, model = `claude-sonnet-4-6`) with:
  - the summary text,
  - a Maestro vocabulary cheatsheet (constrained to a known step subset),
  - one few-shot example showing module-level traversal.
- Validates the YAML output (`maestro hierarchy --no-device --validate <yaml>` — Maestro has a syntax-check mode).
- Writes one YAML per module to Drive at `ACE/<opp>/mobile-recipes/<kind>/module-N.yaml` and a `manifest.yaml` listing them.
- Returns `{ recipe_paths, manifest_path }`.

### Inspection

**`capture_ui_dump()`**
- Runs `adb shell uiautomator dump /sdcard/window_dump.xml && adb pull /sdcard/window_dump.xml`. Returns the XML and a parsed list of element IDs / text labels. Used by recipe-authoring debugging and for failure post-mortems.

---

## Recipe model

### Static recipes (4 files, in `mcp/mobile/recipes/static/`)

| File | Purpose | Inputs (env-var) |
|---|---|---|
| `connect-register-to-otp.yaml` | Launch app → tap signup → enter phone → enter PIN → land on OTP screen | `${PHONE_LOCAL}`, `${COUNTRY_CODE}`, `${PIN}` |
| `connect-register-from-otp.yaml` | Type OTP → verify → enter name → set backup code → land on home | `${OTP}`, `${NAME}`, `${BACKUP_CODE}` |
| `connect-login.yaml` | Launch app → enter phone → enter PIN → home | `${PHONE_LOCAL}`, `${PIN}` |
| `connect-claim-opp.yaml` | Browse opportunity list → tap target opp → accept invite → handoff to CommCare | `${OPP_NAME}` |

(That's four files, not three — the registration is split into pre-OTP and post-OTP halves so the OTP fetch can land between them. This is exactly the pattern phase9 uses.)

These ship checked into the repo because they're shared across every opp and don't change with content. They reference Android selectors discovered via `maestro studio` during initial authoring; selector drift is caught by an `assertVisible` end-of-flow check that fails fast rather than producing wrong screenshots.

### Generated recipes (per-opp, in Drive)

The generator's input is the app summary that `pdd-to-learn-app` / `pdd-to-deliver-app` already write today. Existing summaries are markdown like:

```markdown
## Module 1 — Pre-test

### Form 1.1: Identification
- Q1: First name (text)
- Q2: Last name (text)
- Q3: Age (integer, 18-65)

### Form 1.2: Health background
- Q1: Have you been diagnosed with hypertension? (yes/no)
- Q2: If yes, when? (date)
```

The generator emits one YAML per module:

```yaml
appId: org.commcare.dalvik
---
- launchApp: { clearState: false }
- assertVisible: { id: "home_screen_root" }
- tapOn: "Module 1 — Pre-test"
- takeScreenshot: "module-1-landing"
- tapOn: "Form 1.1: Identification"
- takeScreenshot: "form-1-1-q1-first-name"
- inputText: "Test"
- tapOn: { id: "form_next" }
- takeScreenshot: "form-1-1-q2-last-name"
- inputText: "Worker"
- tapOn: { id: "form_next" }
- takeScreenshot: "form-1-1-q3-age"
- inputText: "30"
- tapOn: { id: "form_finish" }
- takeScreenshot: "form-1-1-submitted"
# ... continues for 1.2 ...
- assertVisible: "Module 1 complete"
```

**Why LLM-generated rather than hand-coded compiler:** the summary format is unstable (it'll evolve with Nova) and contains free-text questions that need plausible answers. An LLM handles both better than a structured parser. The output is small (a few hundred lines per module), validated structurally before run, and stored as data — easy to inspect, easy to re-run, easy to hand-edit if a single recipe goes wrong.

### Variable interpolation and secret hygiene

Maestro supports `${VAR}` substitution via `-e KEY=VALUE` on the CLI. ACE passes credentials and opp identifiers through that mechanism; **no secrets ever land inside YAML files**. Generated YAMLs are safe to commit to Drive.

---

## Lifecycle and orchestration

### One-time machine bootstrap (`/ace:mobile-bootstrap`)

```
1. Check Maestro is installed.
   → If not: print install command (`curl -Ls "https://get.maestro.mobile.dev" | bash`)
     and stop.

2. Check `adb` is on PATH.
   → If not: print `brew install android-platform-tools` and stop.

3. Check ${ACE_AVD_NAME} exists in `emulator -list-avds`.
   → If not: prompt to create with avdmanager, with one-line instruction.

4. Boot the AVD.

5. Check Connect mobile + CommCare Android APKs are installed on the AVD.
   → If not: install from a known internal artifacts URL or local path.

6. Check Playwright cookies for connect.dimagi.com.
   → If missing: launch headed Chromium pointed at the OTP page, wait for sign-in,
     persist cookies.

7. Check ${ACE_E2E_PHONE} is registered.
   → If not: run `register_test_user` to register and capture the backup code into
     ${CLAUDE_PLUGIN_DATA}/ace-test-user.json.

8. Print success summary with all paths and the test-user phone.
```

Idempotent end-to-end. Re-runnable any time something drifts.

### Phase renumbering

ACE's phases shift to make room for the new training-prep phase:

| New # | Phase | Status |
|---|---|---|
| 1 | `design-review` | unchanged |
| 2 | `commcare-setup` | unchanged |
| 3 | `connect-setup` | unchanged + new "invite ACE test user" final step |
| 4 | `ocs-setup` | unchanged |
| **5** | **`training-prep`** | **NEW — owns `app-screenshot-capture` and the relocated `training-materials` skill** |
| 6 | `llo-manager` | was Phase 5; loses `training-materials` (now upstream); first LLO contact still here |
| 7 | `closeout` | was Phase 6; otherwise unchanged |

The new agent lives at `agents/training-prep/AGENT.md`, follows the subagent topology rule (no nested `Agent` dispatches), and is invoked from the level-0 orchestrator the same way every other phase agent is. CLAUDE.md's phase-topology table, `/ace:status`, `/ace:eval`, and the orchestrator procedure doc all need touch-ups; the implementation plan sequences these.

### Per-opp wiring

**Phase 3 (`connect-setup`)**, new step at the end:
> Invite the ACE test user (`${ACE_E2E_PHONE}`) to the newly-created opportunity using the existing `connect_send_llo_invite` MCP tool. The test user is functionally an LLO from Connect's perspective; ACE flags it internally as `is_ace_test_user=true` for filtering on later analytics. Persist the resulting invite URL to `ACE/<opp>/connect-state.yaml` (existing artifact) under a new `ace_test_user_invite_url` field so `training-prep` can drive the claim flow.

**Phase 5 (`training-prep`)** runs two skills back-to-back, neither requiring LLO contact:

```
training-prep agent:
  1. app-screenshot-capture(opp_name):
       a. read upstream artifacts (see "Upstream input contract" below)
       b. ensure_avd_running()
       c. install_apk(connect-mobile)         # no-op if cached
          install_apk(commcare-android)
       d. generate_recipes_from_app_summary(opp_name, 'learn')
          generate_recipes_from_app_summary(opp_name, 'deliver')
       e. run_recipe(static/connect-login.yaml, {PHONE, PIN})
       f. run_recipe(static/connect-claim-opp.yaml, {OPP_NAME, INVITE_URL})
       g. for each generated recipe:
            run_recipe(<recipe>, {HQ_DOMAIN, ...})
            upload screenshots to ACE/<opp>/screenshots/<recipe>/<step>.png
       h. write ACE/<opp>/screenshots/manifest.yaml
            (lists every recipe, every step, every screenshot path, every step label)
  2. training-materials(opp_name):
       reads screenshots/manifest.yaml + every upstream artifact below;
       writes ACE/<opp>/training-materials/{llo-manager-guide,flw-training-guide,
       quick-reference,faq}.md.
```

### Upstream input contract for `training-prep`

The new phase is a synthesis step. It reads from every prior phase, not just Phase 2:

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 `design-review` | `ACE/<opp>/pdd.md` | overall context, opp goals, archetype |
| Phase 1 | `ACE/<opp>/test-prompts.md` | seed FAQs in training docs |
| Phase 1 | PDD `Archetype:` field | branching for atomic-visit / focus-group / multi-stage training docs |
| Phase 2 `commcare-setup` | `ACE/<opp>/app-summaries/learn-app-summary.md` | recipe generation; module/form names in docs |
| Phase 2 | `ACE/<opp>/app-summaries/deliver-app-summary.md` | recipe generation; module/form names in docs |
| Phase 2 | `ACE/<opp>/deployment-summary.md` | HQ domain + app version embedded in `connect-claim-opp.yaml` and quoted in docs |
| Phase 3 `connect-setup` | `ACE/<opp>/connect-state.yaml` (`opportunity_name`, `opportunity_id`, `payment_units`, `delivery_types`, `ace_test_user_invite_url`) | drives `connect-claim-opp` recipe; payment + verification details in LLO Manager Guide |
| Phase 4 `ocs-setup` | `ACE/<opp>/ocs-state.yaml` (`chatbot_widget_url`, `chatbot_embed_token`) | "where to ask questions" link embedded in FLW Training Guide and Quick Reference |

If any of these inputs are missing, `training-prep` exits with a structured error pointing at the upstream phase. This makes the dependency tree explicit and `/ace:status` can render a clear "blocked on phase N" message.

### Failure isolation

If `training-prep` fails (AVD wouldn't boot, login broke, recipe generation produced invalid YAML, missing upstream artifact), Phase 6 halts before any LLO contact. The phase emits structured verdicts (`verdicts/app-screenshot-capture.yaml` and `verdicts/training-materials.yaml`) so `opp-eval` rolls them up. **No real LLO ever sees an opp where training prep failed silently.**

---

## Setup, secrets, and operator surface

### `.env.tpl` additions

```
# ACE mobile emulation — local dev only
ACE_E2E_PHONE=op://ace/connect-test-user/phone               # +742601ACE01 or similar
ACE_E2E_PHONE_LOCAL=op://ace/connect-test-user/phone-local   # 742601ACE01 (no +)
ACE_E2E_COUNTRY_CODE=op://ace/connect-test-user/country-code # +7
ACE_E2E_PIN=op://ace/connect-test-user/pin                   # 6 digits
ACE_E2E_BACKUP_CODE=op://ace/connect-test-user/backup-code   # captured at bootstrap
ACE_E2E_NAME="ACE Test"
ACE_AVD_NAME=ACE_Pixel_API_34
```

1Password remains source of truth. The 1Password item `ace/connect-test-user` is created by the operator during `/ace:mobile-bootstrap` (the bootstrap prints the values it generated; the operator pastes them into 1Password and re-runs `op inject`).

### `/ace:setup` additions

The setup script grows three checks:
1. `which maestro` (with install hint)
2. `which adb` (with install hint)
3. Suggest `/ace:mobile-bootstrap` as the next step if any `ACE_E2E_*` env var is missing.

### `/ace:doctor` additions

```
[Mobile]
  Maestro:                /Users/jjackson/.maestro/bin/maestro    1.36.0     OK
  adb:                    /opt/homebrew/bin/adb                   34.0.5     OK
  AVD:                    ACE_Pixel_API_34                        booted     OK
  Playwright cookies:     ${CLAUDE_PLUGIN_DATA}/playwright-userdata    valid       OK
  ACE_E2E_PHONE:          +742601ACE01                            registered OK
  Connect mobile APK:     com.dimagi.connect      v3.4.1          installed  OK
  CommCare Android APK:   org.commcare.dalvik     v2.55           installed  OK
```

`/ace:doctor` does not run Maestro. It only inspects state. Recipe execution health is measured indirectly via the most recent `verdicts/app-screenshot-capture.yaml` if one exists.

---

## Testing strategy

### Unit (`test/mcp/mobile/`, vitest)

- Capability-map routing: every atom has a backend; no orphans.
- Static recipe YAMLs validate against Maestro's schema (run `maestro hierarchy --validate` in pre-commit).
- Recipe generator: deterministic prompt structure; mocked LLM response → expected YAML.
- AVD lifecycle helpers: shell-out commands assembled correctly with no shell-injection risk.

### Integration (`MOBILE_INTEGRATION=1 npm run test:integration`)

Manual gate, mirroring `OCS_INTEGRATION=1`. Runs:
1. `ensure_avd_running` → AVD boots within 120s.
2. `register_test_user` → returns `already_registered` (since bootstrap was run earlier).
3. `run_recipe` against `connect-login.yaml` → produces at least 4 screenshots and exits clean.

CI does **not** run integration tests. They require a Mac with Android SDK, a registered test user, and Dimagi SSO cookies — none of which CI has.

### Recipe-generation evals (`test/eval/mobile-recipes/`, run via `npm run eval`)

Runs `generate_recipes_from_app_summary` against the existing `CRISPR-Test-001` (atomic-visit) and `CRISPR-Test-002` (focus-group) fixtures. Asserts:
- Output is valid Maestro YAML.
- Number of generated `takeScreenshot` steps equals the fixture's expected step count (a number captured in the fixture metadata).
- `assertVisible` is present at every recipe end (failure-fast guarantee).
- No secrets leaked into the generated YAML (regex-scan for `pin`, `backup`, phone-number patterns).

---

## Failure modes designed for

| Failure | How we handle it |
|---|---|
| AVD won't boot | `ensure_avd_running` returns structured error pointing at `/ace:mobile-bootstrap` |
| Connect/CommCare APK update breaks selectors | Static recipes pin element IDs (not text) and end with `assertVisible` of an expected end-state; broken recipe fails fast, doesn't produce wrong screenshots |
| OTP page returns stale OTP | Fetcher polls until OTP timestamp is within last 60s; errors after 30s |
| Test user backup-code lockout | Capture skill never enters backup-code-recovery flow; only login. Backup code is read-only after bootstrap |
| Drive upload partial-failure | Atomic upload via temp folder + rename; manifest written last so a half-failed run is detectable |
| Generated recipe is malformed YAML | `maestro hierarchy --validate` runs before `run_recipe`; invalid YAML rejected with diff |
| Generated recipe references nonexistent module/form | Generator's prompt grounds on the app summary's headings; LLM output cross-checked against summary heading set before write |
| Multiple ACE runs racing for the AVD | One AVD, advisory file lock at `${CLAUDE_PLUGIN_DATA}/avd.lock`; second runner fails fast with "AVD busy" |

---

## Open questions

These survived brainstorming and are flagged for resolution during implementation, not as blockers to the plan:

1. **Connect mobile APK source URL.** Where does the bootstrap step pull the Connect mobile Android APK from? CommCare Android is likely available via a known Dimagi release URL or HQ. The Connect mobile app may be on the Play Store (in which case `install_apk` becomes "open Play Store and install" — different shape) or distributed internally. Resolve before implementing the bootstrap APK-install step.
2. **1Password vault name and item path.** The spec uses `op://ace/connect-test-user/...` as a placeholder. Final vault and item paths confirmed during the bootstrap dry-run.
3. **AVD image specifics.** Spec defaults to `ACE_Pixel_API_34` (Pixel device profile, API 34, ARM64 system image). Validated when authoring the static recipes — if the Connect Android app has min-API requirements above that, bump to API 35.
4. **Static-recipe selector authoring.** Static recipes pin element IDs discovered via `maestro studio`. We won't know how stable those IDs are across Connect mobile releases until we author the first one — failure mode is covered (assertVisible at end of flow), but selector-drift cadence is unknown.

---

## Implementation outline (informational — full plan to follow)

A separate implementation plan (`docs/superpowers/plans/2026-04-28-ace-mobile-emulation.md`) will sequence:

1. MCP scaffold + capability map + types (no atoms implemented yet).
2. AVD backend (`ensure_avd_running`, `stop_avd`, `list_avds`, `install_apk`, `uninstall_apk`, `capture_ui_dump`).
3. TS port of the Playwright OTP fetcher.
4. Static recipe authoring against the Connect Android app (using `maestro studio` interactively).
5. `register_test_user` composite, `/ace:mobile-bootstrap` slash command.
6. Recipe generator + LLM prompt + validation.
7. `app-screenshot-capture` skill.
8. New `training-prep` phase agent at `agents/training-prep/AGENT.md`; relocate `training-materials` skill into it; teach `training-materials` to consume the new upstream artifacts (screenshots manifest + chatbot URL + invite URL + payment details).
9. Renumber `llo-manager` → Phase 6, `closeout` → Phase 7. Update CLAUDE.md phase-topology table, `agents/ace-orchestrator/`, `commands/{run,step,status,eval}.md`, and the orchestrator procedure doc accordingly.
10. Phase 3 wiring — invite ACE test user during `connect-setup`; persist invite URL to `connect-state.yaml`.
11. `/ace:setup` and `/ace:doctor` updates.
12. Tests (unit, integration, recipe-gen evals).
