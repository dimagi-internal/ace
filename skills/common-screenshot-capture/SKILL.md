---
name: common-screenshot-capture
description: >
  Capture and publish common Connect platform screenshots for training deck
  common modules. Manual trigger only — not part of /ace:run.
disable-model-invocation: true
---

# Common Screenshot Capture

Capture platform-level screenshots (CommCare install, PersonalID signup,
Connect navigation) that are shared across ALL training decks. These are
the "how Connect works" screenshots every opp reuses — driven by the
Connect APK's own UI, not by any opp-specific config. Run manually when
the Connect app UI changes.

Replaces the broader `connect-baseline-screenshots` skill with a focused
scope aligned to the training deck common modules defined in
`templates/training-deck/_common/platform-setup.yaml`.

## When to run

Manual trigger only. **NOT** part of `/ace:run`. Run when:

- Connect app has a UI update (new APK version)
- PersonalID signup flow changes
- Common screenshots are missing or stale
- First-time setup for a new Connect app version
- A new common training-deck module adds a Connect surface not previously
  covered

The check-in cadence is operator-judgment, not automated.

## Prerequisites

- `ACE_WEB_PAT_TOKEN` set (per-machine; mint via `/ace:ace-web-pat-mint`).
  Required for Step 0 fork.
- AVD bootable via `mobile_ensure_avd_running` (this skill cold-boots
  itself; no pre-running AVD required).
- `op` 1Password CLI authenticated for any rotated secrets.

## Coverage table — what's reachable live, what needs static fixtures

| Alias | Source | Recipe | Verified live |
|-------|--------|--------|---------------|
| `commcare-welcome` | Live | `04-personal-id.yaml` (fresh-install state, no GO TO CONNECT MENU button) | ✓ 2026-05-24 |
| `connect-home` | Live | `00-connect-home.yaml` | ✓ 2026-05-24 |
| `sync-button` | Live | `03-sync-button.yaml` | ✓ 2026-05-24 |
| `claim-opp` | Live | `01-claim-opp.yaml` (requires OPP_NAME) | ✓ 2026-05-24 |
| `learn-install` | Live | `02-learn-install.yaml` | ✓ 2026-05-24 |
| `personal-id-start` | Live | `04-personal-id.yaml` (nav-drawer Sign In/Register) | ✓ 2026-05-24 |
| `personal-id-phone` | Live | `04-personal-id.yaml` | ✓ 2026-05-24 |
| `personal-id-name` | Live | `04-personal-id.yaml` | ✓ 2026-05-24 |
| `personal-id-verify` | **Fixture** | n/a (demo-bypass — +7426 prefix skips OTP server-side) | placeholder PNG |
| `personal-id-photo` | **Fixture** | n/a (recovery returns existing server photo, never re-prompts) | placeholder PNG |
| `personal-id-id` | **Fixture** | n/a (may not exist in current APK; deck content was AI-imagined) | placeholder PNG |
| `personal-id-location` | **Fixture** | n/a (cached on recovery path) | placeholder PNG |
| `personal-id-done` | **Fixture** | n/a (recovery shows "Account Recovered", not "Profile complete!") | placeholder PNG |
| `play-store-search` | **Fixture** | n/a (Play Store requires Google sign-in; out of scope for automation) | placeholder PNG |
| `commcare-install` | **Fixture** | n/a (same) | placeholder PNG |
| `commcare-open` | **Fixture** | n/a (same) | placeholder PNG |

8 reachable via live recipes; 8 require operator-committed static
fixtures at `templates/training-deck/_common/fixtures/<alias>.png`.

## Process

### Step 0: Fork a known-good run to pin OPP_NAME

The `claim-opp` and `learn-install` captures require an UNCLAIMED Connect
opp whose Learn CCZ installs cleanly. The ACE demo user's invite list
accumulates stale pre-Nova-fix opps that hit *"A part of your
application is invalid"* when claimed (reproduced live 2026-05-24
against LEEP run 20260506-1440). To guarantee a clean capture target,
fork a recent successful run BEFORE invoking the baseline recipes.

```
/ace:fork-run \
  --opp_slug <recent-good-slug> \
  --from_run_id <YYYYMMDD-HHMM> \
  --from_skill connect-program-setup \
  --mode keep-all \
  --feedback "Common-screenshot baseline capture: fresh opp for claim-opp + learn-install."
```

Pick a `<recent-good-slug>` / `<from_run_id>` whose most recent run
went through Phase 4 successfully on a post-2026-05-22 build. The fork
re-runs Phase 4 + downstream — fresh Connect opp + fresh invite to
`ACE_E2E_PHONE`. Read the new opp's name from
`run_state.yaml.phases.connect-setup.products.connect.opportunity.name`
and use it verbatim as `OPP_NAME` in Step 3.

**Skip Step 0** only when interactively debugging — pass an
operator-chosen OPP_NAME and accept that "first unclaimed match"
fallback may hit stale broken invites.

### Step 1: Cold-boot the AVD

```
mobile_ensure_avd_running({ avdName: process.env.ACE_AVD_NAME })
```

Auto-bootstrap registers the demo user (`ACE_E2E_PHONE`) and applies
the environment baseline. Per CLAUDE.md "Phase preconditions are
restored, not adapted" — always cold-boot per dispatch.

### Step 2: Determine Connect APK version

After the AVD is up:

```
adb -s <serial> shell dumpsys package org.commcare.dalvik | grep versionName
```

This version string keys the output folder and manifest (e.g.
`2.63.0`).

### Step 3: Create target Drive folder

```
ACE/_common/connect-screenshots/<version>/
```

via `drive_create_folder`. Parent MUST live on a Shared Drive (SA
quota is 0 in My Drive — `assertParentOnSharedDrive` guards this).

### Step 4: Run baseline recipes in sequence

All 5 shipped recipes live at `mcp/mobile/recipes/baseline/`. Run in
order — each leaves the AVD in a state the next can build on.

#### 4a. `04-personal-id.yaml` (FIRST — requires wiped CommCare)

Prep before invoking:

```bash
# Re-enable GMS — bootstrap disables it for face-capture ManualMode,
# but CommCare 2.63.0's PersonalID launch blocks on a no-dismiss
# "Enable Google Play services" dialog when GMS is disabled.
adb -s <serial> shell pm enable com.google.android.gms

# Wipe local CommCare data — fresh-install state shows the authentic
# Welcome screen (without the post-registration GO TO CONNECT MENU
# button).
adb -s <serial> shell pm clear org.commcare.dalvik
adb -s <serial> shell am force-stop org.commcare.dalvik
```

Then:

```ts
mobile_run_recipe({
  recipePath: 'mcp/mobile/recipes/baseline/04-personal-id.yaml',
  screenshotDir: '/tmp/ace-baseline-capture/04-personal-id/',
  envVars: {
    COUNTRY_CODE: env.ACE_E2E_COUNTRY_CODE.replace(/^\+/, ''), // "7"
    PHONE_LOCAL: env.ACE_E2E_PHONE_LOCAL,                       // "4260000100"
    PIN: env.ACE_E2E_PIN,                                       // "111111"
    NAME: env.ACE_E2E_NAME,                                     // "ACE Test"
    BACKUP_CODE: env.ACE_E2E_BACKUP_CODE,                       // "222222"
  },
});
```

Produces: `commcare-welcome.png`, `personal-id-start.png`,
`personal-id-phone.png`, `personal-id-name.png` (+ bonus
`personal-id-app-lock.png`, `personal-id-backup-code.png`,
`personal-id-done.png` which currently shows "Account Recovered" —
treat as bonus, not the deck alias).

Leaves AVD on the recovery-completed Connect home.

#### 4b. `00-connect-home.yaml` (navigation entry)

```ts
mobile_run_recipe({
  recipePath: 'mcp/mobile/recipes/baseline/00-connect-home.yaml',
  screenshotDir: '/tmp/ace-baseline-capture/00-connect-home/',
  envVars: { PIN: env.ACE_E2E_PIN },
});
```

Produces: `commcare-welcome.png` (re-capture; prefer the one from 4a
which is from a truly fresh-install state), `connect-home.png`.

Leaves AVD on the Connect opp list.

#### 4c. `03-sync-button.yaml` (from connect-home state)

```ts
mobile_run_recipe({
  recipePath: 'mcp/mobile/recipes/baseline/03-sync-button.yaml',
  screenshotDir: '/tmp/ace-baseline-capture/03-sync-button/',
});
```

Produces: `sync-button.png`. Also triggers a server sync so any
newly-forked opp (Step 0) pulls down to the device's invite list
before Step 4d.

#### 4d. `01-claim-opp.yaml` (requires OPP_NAME from Step 0 fork)

```ts
mobile_run_recipe({
  recipePath: 'mcp/mobile/recipes/baseline/01-claim-opp.yaml',
  screenshotDir: '/tmp/ace-baseline-capture/01-claim-opp/',
  envVars: { OPP_NAME: forkedOppName }, // verbatim from Step 0
});
```

Produces: `claim-opp.png` (opp-detail with Start button), bonus
`claim-opp-list.png` (the scrolled list view).

#### 4e. `02-learn-install.yaml` (taps Start, downloads Learn CCZ)

```ts
mobile_run_recipe({
  recipePath: 'mcp/mobile/recipes/baseline/02-learn-install.yaml',
  screenshotDir: '/tmp/ace-baseline-capture/02-learn-install/',
});
```

Produces: `learn-install.png` (the "Downloading Learn App" mid-flight
dialog — often <100KB because the screen is mostly solid blue;
threshold rule should not flag this), `learn-install-home.png` (the
post-install Learn StandardHomeActivity).

### Step 5: Upload to Drive

For each captured PNG mapped to a deck alias (see Coverage table
above for the canonical mapping):

1. **Verify file size > 30 KB** (lowered from 100 KB — `learn-install`
   is legitimately ~38 KB due to a mostly-blue Downloading dialog).
   PNGs below 30 KB are almost certainly corrupt.
2. **Upload** via `drive_upload_binary({ mimeType: "image/png",
   shareAnyoneWithLink: true })`. The `anyone-with-link` flag is
   REQUIRED for Slides `createImage` ingest. See `app-screenshot-capture`
   Step 5 for the canonical explanation.
3. **Target path:** `ACE/_common/connect-screenshots/<version>/<alias>.png`.

For each alias in the Coverage table marked **Fixture**:

1. Read `templates/training-deck/_common/fixtures/<alias>.png` from the
   repo (committed by an operator after a one-time manual capture).
2. Upload to the same Drive path as a live capture.
3. If the fixture file is missing, write the alias entry with
   `placeholder: true` and `note: "Awaiting manual capture"` — the
   manifest still records the gap so the deck-render skill emits a
   visible placeholder slot instead of failing silently.

### Step 6: Write `manifest.yaml`

```yaml
connect_apk_version: "2.63.0"
captured_at: "2026-05-24T15:42:36Z"
captured_by: "ace@dimagi-ai.com"
source_avd: "ACE_Pixel_API_34"
source_opportunity:
  slug: "<forked-slug>"
  run_id: "<forked-run-id>"
  opportunity_id: "<uuid>"

screenshots:
  # Live captures from recipes
  commcare-welcome:    { drive: "<fileId>", source: live,    recipe: "04-personal-id.yaml" }
  connect-home:        { drive: "<fileId>", source: live,    recipe: "00-connect-home.yaml" }
  sync-button:         { drive: "<fileId>", source: live,    recipe: "03-sync-button.yaml" }
  claim-opp:           { drive: "<fileId>", source: live,    recipe: "01-claim-opp.yaml" }
  learn-install:       { drive: "<fileId>", source: live,    recipe: "02-learn-install.yaml" }
  personal-id-start:   { drive: "<fileId>", source: live,    recipe: "04-personal-id.yaml" }
  personal-id-phone:   { drive: "<fileId>", source: live,    recipe: "04-personal-id.yaml" }
  personal-id-name:    { drive: "<fileId>", source: live,    recipe: "04-personal-id.yaml" }
  # Fixture aliases (committed PNGs OR placeholder gaps)
  personal-id-verify:  { drive: "<fileId>", source: fixture, note: "Demo +7426 phones bypass OTP; static fixture from real-OTP user flow" }
  personal-id-photo:   { drive: "<fileId>", source: fixture, note: "Recovery returns existing photo; static fixture from fresh-signup user flow" }
  personal-id-id:      { drive: "<fileId>", source: fixture, note: "Awaiting confirmation this screen exists in current APK" }
  personal-id-location:{ drive: "<fileId>", source: fixture, note: "Recovery caches permission; static fixture from fresh-signup user flow" }
  personal-id-done:    { drive: "<fileId>", source: fixture, note: "Recovery shows 'Account Recovered'; deck needs 'Profile complete!' equivalent" }
  play-store-search:   { drive: "<fileId>", source: fixture, note: "Play Store requires Google sign-in; out of scope for automation" }
  commcare-install:    { drive: "<fileId>", source: fixture, note: "Same" }
  commcare-open:       { drive: "<fileId>", source: fixture, note: "Same" }
```

Upload the manifest via `drive_create_file` (mimeType `text/yaml`).

## Aliases

The manifest keys MUST match the aliases used in
`templates/training-deck/_common/platform-setup.yaml`. The platform-setup
module references these exact aliases via `@<alias>` syntax in its slide
definitions. Any mismatch causes the training-deck-render skill to emit
a placeholder instead of a screenshot.

Current required aliases (16):

| Alias | Template slide | Flow |
|-------|---------------|------|
| `play-store-search` | `install-commcare` | Install |
| `commcare-install` | `install-commcare` | Install |
| `commcare-open` | `install-commcare` | Install |
| `commcare-welcome` | `install-commcare` | Install |
| `personal-id-start` | `personal-id-start` | PersonalID |
| `personal-id-name` | `personal-id-start` | PersonalID |
| `personal-id-phone` | `personal-id-start` | PersonalID |
| `personal-id-verify` | `personal-id-start` | PersonalID |
| `personal-id-photo` | `personal-id-details` | PersonalID |
| `personal-id-id` | `personal-id-details` | PersonalID |
| `personal-id-location` | `personal-id-details` | PersonalID |
| `personal-id-done` | `personal-id-details` | PersonalID |
| `connect-home` | `connect-home` | Navigation |
| `claim-opp` | `claim-opportunity` | Navigation |
| `learn-install` | `install-learn` | Navigation |
| `sync-button` | `syncing` | Syncing |

## Self-eval

Four criteria. `verdict: pass` requires all four; `verdict: warn`
acceptable when only `gaps` flags fire (live recipe failures and
missing fixtures); `verdict: fail` when live captures violated
quality/sharing rules.

1. **Coverage**: All 16 required aliases present in manifest (even if
   `source: fixture` with `placeholder: true`). **FAIL** if any missing.
2. **Live capture quality**: All `source: live` PNGs ≥ 30 KB (lowered
   from 100 KB — `learn-install` is legitimately ~38 KB due to a
   mostly-solid-blue Downloading dialog). **FAIL** if any below
   threshold.
3. **Sharing**: All files set to `anyone-with-link`. **FAIL** if any not
   shared (Slides image import will fail with "image cannot be reached").
4. **Gaps** (warn-only): `source: fixture` entries with `placeholder:
   true` (no actual PNG committed yet). Warns the operator that a
   one-time manual capture is still needed for the deck to render fully.

Write verdict to `ACE/_common/connect-screenshots/<version>/verdict.yaml`:

```yaml
skill: common-screenshot-capture
target: _common
ran_at: <ISO timestamp>
connect_apk_version: "<version>"

overall_score: 8.5           # 0.0–10.0
verdict: pass | warn | fail

dimensions:
  coverage:           { score: 10.0, weight: 0.30 }  # 16/16 aliases present (live or fixture)
  live_capture_quality: { score: 9.0, weight: 0.30 } # all live PNGs >= 30 KB
  sharing:            { score: 10.0, weight: 0.20 }  # all uploaded with anyone-with-link
  gaps:               { score: 6.0,  weight: 0.20 }  # 8 live / 8 fixture; 0 placeholder

per_item:
  - ref: "commcare-welcome"
    source: live
    score: 10
    verdict: pass
    note: "111 KB, shared, captured from authentic fresh-install state"
  # ... one per alias

auto_surfaced:
  - severity: WARN
    message: "5 PersonalID + 3 install-flow aliases sourced from operator-committed fixtures; 0 placeholder gaps remaining."
```

## Output

- Screenshots in `ACE/_common/connect-screenshots/<version>/`
- `manifest.yaml` in the same folder
- `verdict.yaml` in the same folder

## MCP tools used

- **`ace-mobile`:** `mobile_ensure_avd_running`, `mobile_install_apk`,
  `mobile_run_recipe`
- **`ace-gdrive`:** `drive_create_folder`, `drive_upload_binary`,
  `drive_create_file`, `drive_set_anyone_with_link`

## Mode behavior

- **Auto:** run all recipes, upload all PNGs, write manifest + verdict.
- **Review:** show the connect-apk-version + recipe list before running;
  pause for confirmation.
- **Dry-run:** run recipes locally (capturing PNGs to /tmp) but skip the
  Drive upload. State tracks `dry-run-success`.

## Failure modes

- **AVD not running / test user not signed in.** Halt with a pointer at
  `/ace:mobile-bootstrap`.
- **Step 0 fork fails (ACE_WEB_PAT_TOKEN invalid/missing).** Halt with
  remediation `/ace:ace-web-pat-mint`. Without a fresh forked opp,
  `claim-opp` + `learn-install` captures may target stale broken
  invites.
- **Step 4a fails on "Enable Google Play services" dialog.** GMS prep
  step (`adb shell pm enable com.google.android.gms`) was skipped or
  ineffective. Re-run the prep + retry recipe.
- **`personal-id-name` doesn't render** (recipe completes but no
  `personal-id-name.png` captured). Demo user `+74260000100` was on a
  snapshot-reload path that skipped the Name screen. Use a different
  demo phone OR commit a fixture.
- **`claim-opp` / `learn-install` recipe times out OR hits
  "application invalid".** Forked OPP_NAME points at a stale build.
  Re-fork from a more recent successful run (Step 0).
- **Recipe selector mismatch (Connect APK rebuilt with new resource-ids).**
  Surface the failing recipe + step. Operator runs `maestro studio` to
  re-calibrate selectors in `mcp/mobile/selectors/connect-<version>.yaml`
  before re-running.
- **Drive upload fails (Shared-Drive guard).** Verify `ACE/_common/`
  lives on a Shared Drive; SA quota is 0 in My Drive.
- **Screenshot < 30 KB.** Likely a blank or corrupt capture (the
  `learn-install` mid-flight dialog is the only known sub-100KB
  legitimate capture; everything else >100KB).

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-23 | Initial version. Focused common-screenshot skill for training deck common modules, aligned to `platform-setup.yaml` alias contract. Complements `connect-baseline-screenshots` (broader baseline) and `app-screenshot-capture` (per-opp). | ACE team |
| 2026-05-24 | **Live-recipe baseline shipped.** 5 navigation+sync recipes (00-connect-home, 01-claim-opp, 02-learn-install, 03-sync-button) + 1 PersonalID recipe (04-personal-id) drive 8 of 16 alias captures end-to-end. SKILL.md rewritten with explicit per-recipe orchestration, Step 0 `/ace:fork-run` integration for deterministic OPP_NAME pinning, GMS-enable prerequisite, lowered 30KB quality threshold (was 100KB) to admit the legitimately-small `learn-install` mid-flight capture, and per-alias `source: live|fixture` manifest schema with `placeholder: true` warn-only gap reporting. 8 fixture aliases (5 PersonalID unreachable + 3 Play Store auth-blocked) documented in templates/training-deck/_common/fixtures/README.md. (0.13.361) | ACE team |
