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

- AVD running via `mobile_ensure_avd_running`
- Connect APK installed via `mobile_install_apk`
- Test user registered (demo-prefix phone, `ACE_E2E_PHONE`)
- At least one demo opportunity claimable (for claim/learn-install shots)

If any precondition fails, halt with a pointer at `/ace:mobile-bootstrap`.
Do NOT auto-bootstrap from this skill — operator intent should be explicit
when re-baselining.

## Process

### Step 1: Determine Connect APK version

Extract the running Connect APK version from the device:

```
adb shell dumpsys package org.commcare.dalvik | grep versionName
```

This version string keys the output folder and manifest.

### Step 2: Create target folder

Create the versioned output folder on Drive:

```
ACE/_common/connect-screenshots/<version>/
```

via `drive_create_folder`. The folder must live on a Shared Drive (SA
quota is 0 in My Drive — `assertParentOnSharedDrive` guards this).

### Step 3: Run baseline recipes

Run baseline recipes via `mobile_run_recipe` to capture screenshots
covering the three common flows. Recipe files live in
`mcp/mobile/recipes/baseline/` and are calibrated against the live
Connect APK selectors palette (`mcp/mobile/selectors/connect-<version>.yaml`).

| Flow | Recipe(s) | Aliases captured |
|------|-----------|------------------|
| **Connect navigation** | `00-connect-home.yaml`, `01-claim-opp.yaml`, `02-learn-install.yaml` | `commcare-welcome`, `connect-home`, `claim-opp`, `learn-install` |
| **Syncing** | `03-sync-button.yaml` | `sync-button` |
| **Install flow** | TBD — Play Store driving | `play-store-search`, `commcare-install`, `commcare-open` |
| **PersonalID signup** | TBD — composite driving the full registration | `personal-id-start`, `personal-id-name`, `personal-id-phone`, `personal-id-verify`, `personal-id-photo`, `personal-id-id`, `personal-id-location`, `personal-id-done` |

Total: 16 required aliases (5 currently captured by shipped recipes).

#### OPP_NAME pinning (claim-opp + learn-install)

`01-claim-opp.yaml` accepts an `OPP_NAME` env var (substring match
against the tile title) so the recipe deterministically targets one
specific opp. **First-match-by-scroll is fragile** because the ACE demo
user accumulates invites across every `/ace:run`, including older
pre-Nova-fix builds that hit *"A part of your application is invalid"*
when claimed (reproduced live 2026-05-24 against LEEP run 20260506-1440
on a fresh AVD). Pin to a known-good recent opp.

The caller skill should pick the OPP_NAME by **forking a known-good
recent run** via `/ace:fork-run` before invoking baseline recipes. The
fork guarantees a fresh Connect opp with current Nova-build CCZ that
installs cleanly. Use `/ace:fork-run --opp_slug <slug> --from_run_id <id>
--from_skill connect-program-setup --mode keep-all` to fork at the
Phase 4 boundary, then pass the new opp's `opportunity.name` as
`OPP_NAME`. Falling back to "first unclaimed match" is a known-fragile
shortcut and should only be used in interactive debugging.

### Step 4: Upload screenshots

For each captured screenshot:

1. **Verify file size > 100 KB** — reject blank/corrupt captures. A
   sub-100 KB PNG from a full-screen AVD capture is almost certainly
   empty, a solid color, or a partial render.
2. **Upload** to the version folder via `drive_upload_binary` with
   `mimeType: "image/png"` and `shareAnyoneWithLink: true`.
   The `shareAnyoneWithLink` flag is **required** — Slides' `createImage`
   fetches PNGs via Google's image-import service, which doesn't carry
   the SA's auth. An SA-only file gets "image cannot be reached" and
   the deck slide comes out blank. See `app-screenshot-capture` Step 5
   for the canonical explanation.
3. **Verify sharing** — if uploaded without the flag (legacy path), call
   `drive_set_anyone_with_link` retroactively.

### Step 5: Write manifest

Write `manifest.yaml` to the same version folder with format:

```yaml
connect_apk_version: "<version>"
captured_at: "<ISO timestamp>"
screenshots:
  play-store-search: "drive:<fileId>"
  commcare-install: "drive:<fileId>"
  commcare-open: "drive:<fileId>"
  commcare-welcome: "drive:<fileId>"
  personal-id-start: "drive:<fileId>"
  personal-id-name: "drive:<fileId>"
  personal-id-phone: "drive:<fileId>"
  personal-id-verify: "drive:<fileId>"
  personal-id-photo: "drive:<fileId>"
  personal-id-id: "drive:<fileId>"
  personal-id-location: "drive:<fileId>"
  personal-id-done: "drive:<fileId>"
  connect-home: "drive:<fileId>"
  claim-opp: "drive:<fileId>"
  learn-install: "drive:<fileId>"
  sync-button: "drive:<fileId>"
```

Upload the manifest to the version folder via `drive_create_file`.

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

Three criteria. All must pass for `verdict: pass`:

1. **Coverage**: All 16 required aliases present in manifest. **FAIL** if
   any missing.
2. **Image quality**: All screenshots > 100 KB. **FAIL** if any below
   threshold.
3. **Sharing**: All files set to `anyone-with-link`. **FAIL** if any not
   shared (Slides image import will fail with "image cannot be reached").

Write verdict to `ACE/_common/connect-screenshots/<version>/verdict.yaml`:

```yaml
skill: common-screenshot-capture
target: _common
ran_at: <ISO timestamp>
connect_apk_version: "<version>"

overall_score: 9.0           # 0.0–10.0
verdict: pass | fail

dimensions:
  coverage:       { score: 10.0, weight: 0.40 }   # 16/16 aliases present
  image_quality:  { score: 9.0,  weight: 0.35 }   # all PNGs > 100 KB
  sharing:        { score: 8.0,  weight: 0.25 }   # all anyone-with-link

per_item:
  - ref: "play-store-search"
    score: 10
    verdict: pass
    note: "423 KB, shared"
  # ... one per alias

auto_surfaced: []
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
- **Recipe selector mismatch (Connect APK rebuilt with new resource-ids).**
  Surface the failing recipe + step. Operator runs `maestro studio` to
  re-calibrate the recipe before re-running.
- **Drive upload fails (Shared-Drive guard).** Verify `ACE/_common/` lives
  on a Shared Drive; SA quota is 0 in My Drive.
- **Screenshot < 100 KB.** Likely a blank or corrupt capture. Re-run the
  specific recipe or investigate AVD rendering state.

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-23 | Initial version. Focused common-screenshot skill for training deck common modules, aligned to `platform-setup.yaml` alias contract. Complements `connect-baseline-screenshots` (broader baseline) and `app-screenshot-capture` (per-opp). | ACE team |
