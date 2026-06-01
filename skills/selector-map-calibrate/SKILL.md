---
name: selector-map-calibrate
description: >
  Calibrate the mobile selector map (mcp/mobile/selectors/connect-<apk>.yaml)
  against a live device for a Connect APK version: cold-boot a fresh device and
  walk it through every state, harvest ui-dumps, reconcile the map (promote
  unverified rows, fix drift), migrate static recipes off raw resource-ids,
  and re-run on-device to confirm. Manual, cross-opp, per-APK-version.
disable-model-invocation: true
---

# Selector-Map Calibration

Calibrate `mcp/mobile/selectors/connect-<apk>.yaml` against a **live device**
when a new Connect APK ships (or an existing map is still a placeholder). This
is the **systematic** counterpart to the reactive, one-surface-at-a-time
selector fixes that have historically failed to converge.

**This is NOT `connect-baseline-screenshots`.** That skill captures training-deck
PNGs (its products are images + a deck manifest). This skill calibrates the
*selector map* — its products are verified map rows, migrated recipes, and a
calibration report. They share the live device and overlap on which surfaces
they drive, but their success criteria are different. (The `selector_map_currency`
doctor probe's remediation points HERE, not at the screenshot skill.)

## Why this skill exists — the convergence problem

When the AMI bumps the Connect APK (e.g. 2.62.0 → 2.63.0), the convention is to
**copy** `connect-<old>.yaml` → `connect-<new>.yaml` and mark every row
`unverified: true` until a live dump confirms it. In practice the copy ships as
a permanent placeholder and rows get verified **reactively** — only when a
Phase 6 run hits a surface, finds the selector wrong, and someone patches that
one row live (the 2.63.0 history: #591, #593, #650/#663, deliver-atlas #526).

That never converges, for a structural reason:

> **Unverified rows live in distinct, mutually-exclusive device states.**
> `app-first-start-main` is only on the cold-start screen. `learn-home-screen`
> is only on the post-download CommCare Learn home. `form-question-input` is
> only inside a form. `deliver-start-button` is only on a Learn-complete opp.
> You cannot verify them from one snapshot. So whichever surface a given run
> happened to touch is the only one that gets calibrated; the rest stay guesses.

The fix is to stop sampling and **drive a single cold-booted device through
every state in order**, dumping each, then reconcile the whole map in one pass.
That is this skill.

## The device is always fresh — the *opp* is what needs to be fresh

ACE never reuses device state: `mobile_ensure_avd_running` **cold-boots every
dispatch** (`-wipe-data -no-snapshot-load -no-snapshot-save` → reinstall APK →
re-register the demo-prefix user → verify; `mobile-integration.md:54`). So
there is **no shared device to protect and no "throwaway device" to find** — you
just cold-boot, exactly like every phase. Two consequences for calibration:

- **States 1–3 (cold-start, login, registration — incl. #666's photo surface)
  are walked by the cold-boot's own registration recipes.** Capture ui-dumps
  during/right after `mobile_ensure_avd_running` and you've calibrated them; no
  special setup.
- **States 6–10 (Learn home, form, quiz, Deliver) need a Learn-NOT-complete
  opp.** Learn-completion is one-way **per (phone, opp) and tracked
  server-side** — the device wipe does NOT reset it (#568,
  `docs/learnings/2026-05-18-connect-gates-deliver-on-learn-completion.md`). So
  the "fresh" thing the Learn-dependent states require is a **fresh opp**, which
  a fresh `/ace:run` provides (it mints a new opp + invites `${ACE_E2E_PHONE}`).
  If the configured demo phone already completed Learn on its invited opp, walk
  6–10 against a freshly-invited opp, not a reused one.

The only real caution is **operator courtesy**: `mobile_ensure_avd_running`
kills + wipes the running emulator, so don't cold-boot over an AVD a human is
actively driving by hand. That's coordination, not architecture. When you only
need to confirm reachable rows without disrupting a running emulator (or before
a fresh opp is available), use **read-only snapshot mode** (§ Snapshot mode).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Operator | Target Connect APK version | which `connect-<apk>.yaml` to calibrate |
| Static | `mcp/mobile/selectors/connect-<apk>.yaml` | the map being calibrated (rows + `unverified` flags) |
| Static | `mcp/mobile/recipes/static/*.yaml` | recipes to migrate off raw ids (#650) |
| Tool | `scripts/probe-atlas-drift.ts` | harvest dump-vs-map drift |

## Products

- Updated `mcp/mobile/selectors/connect-<apk>.yaml` — rows promoted from
  `unverified: true` to live-verified (with `Live-verified <date> (<apk>)`
  provenance), drifted rows corrected, placeholder header removed.
- Migrated `mcp/mobile/recipes/static/*.yaml` — remaining raw
  `org.commcare.dalvik:id/*` literals replaced with `${SELECTOR:...}` for rows
  the map now covers, recipe-lint-clean and on-device re-validated.
- `docs/mobile-calibration/connect-<apk>-<date>.md` — the calibration report
  (state walk coverage, rows changed, recipes migrated, what was validated
  on-device, residual gaps).

## Process

### Step 0 — Precondition (restore, don't adapt)

Declare and restore the precondition; do not probe-then-branch:

- **Full walk:** **cold-boot a fresh device via `mobile_ensure_avd_running`** —
  same restore every phase uses (`-wipe-data` → reinstall APK → re-register the
  demo user). That deterministically gives states 1–5. For the Learn-dependent
  states 6–10, the demo phone must be invited to a **Learn-NOT-complete opp**
  (fresh `/ace:run` opp, or a freshly-invited one) — the device wipe does not
  reset server-side Learn-completion (#568). Don't probe-then-adapt; cold-boot,
  then verify the precondition was reached (`classifyDeviceUserState`).
- **Snapshot mode:** any live device on the target APK, read-only — to
  re-confirm reachable rows without cold-booting over a running emulator.

Operator courtesy: `mobile_ensure_avd_running` kills + wipes the running AVD, so
confirm before cold-booting over an emulator a human may be driving by hand.

Confirm the APK: `adb -s <serial> shell dumpsys package org.commcare.dalvik | grep versionName` MUST equal the map you're calibrating. Mismatch → halt.

### Step 1 — Inventory the gap (headless)

1. Parse `connect-<apk>.yaml`; list every row with `unverified: true` (these are
   the calibration backlog) and note each row's expected **device state**
   (cold-start / logged-out / jobs-list / opp-detail / learn-home / form-entry /
   quiz-result / deliver-home).
2. Run `bin/ace-doctor`'s `selector_map_currency` (or read its logic) to get the
   raw-resource-id inventory across `recipes/static/*.yaml` — the #650 surface.
3. Write the backlog into the calibration report as a checklist, grouped by
   device state. This is the walk plan.

### Step 2 — Walk the states, dump each (live)

Drive the cold-booted device through the state sequence, capturing a ui-dump at
each surface. Every recipe-driven capture already leaves a `.xml` sidecar next to
its PNG (the atlas side-channel, shipped since 0.13.229) — point the harvester at
that directory. The canonical state sequence and the rows each state yields:

| # | Device state | How to reach | Rows it verifies |
|---|---|---|---|
| 1 | Cold start / first-run | fresh install, launch | `app-first-start-main` |
| 2 | Logged out / nav drawer | pre-sign-in | `nav-drawer-sign-in`, login-surface ids (`connect-login.yaml`) |
| 3 | Registration + photo | fresh PersonalID register → photo capture | `connect-register-*` ids incl. the `com.android.camera2` photo surface (#666) |
| 4 | Jobs list | post-login home | `home-jobs-list`, `home-jobs-recycler`, `home-toolbar-sync`, `opp-list-*-button` |
| 5 | Opp detail (pre-Learn) | tap an In-Progress card | `opp-detail-*`, `connect_learning_button` |
| 6 | Learn home | tap Download/Start Learn → CommCare home | `learn-home-screen` (the #618 surface) |
| 7 | Form entry | open a Learn content form | `form-question-input`, `form-*` nav |
| 8 | Quiz result | answer a score-gated quiz | `assessment-result-passed/failed`, `form-submit` |
| 9 | Opp detail (Learn-complete) | post-Learn | `opp-detail-start-delivering`, `deliver-start-button` |
| 10 | Deliver home | Start Delivering | deliver-side ids |

Capture each dump to `<dump-dir>/<NN>-<state>.xml`. States 1–3 fall out of the
cold-boot registration itself. States 6–10 consume the opp's one-way
Learn-completion — so they must run against a **Learn-NOT-complete opp** (don't
reuse one whose Learn the demo phone already finished; #568).

### Step 3 — Harvest drift (headless)

```
npx tsx scripts/probe-atlas-drift.ts <dump-dir> --apk <apk> --out <report>.md
```

Read the two sections: **resource-ids in dumps but NOT in the map** (candidate
new rows) and **`id:` matchers in the map but NOT in any dump** (drifted or
dead rows). Coverage summary gives the counts.

### Step 4 — Reconcile the map (headless, judgment)

For each backlog/drift row:

- **Confirmed live:** set `value:` to the on-device id/text, **drop
  `unverified: true`**, and append `Live-verified <date> (<apk>)` to `purpose:`.
- **Drifted:** correct `value:` to what the dump shows; stamp the same provenance.
- **New candidate id:** add a row **only if a recipe needs it** (don't author
  rows no recipe references — the resolver + doctor track real usage). Prefer a
  **text anchor** over a resource-id where the label is stable (survives APK
  rebuilds); use `id:` only when text is dynamic/ambiguous. For card-scoped
  matchers use the **value-position** `"${SELECTOR:x}"` form (see
  `recipe-resolver.ts`), not key-position.
- **Dead row:** if a mapped `id:` never appears and no recipe references it,
  remove it (note the removal in the report).

When the backlog is empty, **remove the PLACEHOLDER header** from the map file.

### Step 5 — Migrate recipes off raw ids (#650, headless)

For each `recipes/static/*.yaml` still carrying raw `org.commcare.dalvik:id/*`
literals, replace them with `${SELECTOR:...}` for rows the map now covers.
Then:
- `mobile_validate_recipe` (recipe-lint must stay clean — watch the
  `runFlow-guard-scope-mismatch` rule).
- `mobile_resolve_selectors` and diff the resolved output against HEAD —
  byte-identical except the intended substitutions.

### Step 6 — Validate on-device (live — close the loop)

**Non-negotiable, and the step prior piecemeal fixes skipped.** Re-run each
migrated recipe on the live device and confirm it navigates. A row "verified" by
a static dump but never re-run is still a guess about whether the recipe *acts*
on it correctly (substitution into nested `below:`/`when:` positions has bitten
us — #663). If a recipe can't be re-run (one-way state already consumed), record
exactly that in the report rather than claiming validation.

### Step 7 — Report + verdict

Write `docs/mobile-calibration/connect-<apk>-<date>.md`:
- State-walk coverage table (which of the 10 states were reached).
- Rows promoted / corrected / added / removed.
- Recipes migrated + on-device validation result per recipe.
- **Residual gaps** — any state not reached and why (be precise; this is the
  next run's start point).

Then re-run `bin/ace-doctor`; `selector_map_currency` should report 0 unverified
(or name exactly which remain).

## Snapshot mode (read-only)

When you don't want to cold-boot over a running emulator (a human may be driving
it), or no Learn-incomplete opp is available yet: capture ui-dumps of the
surfaces reachable **without a state-changing tap** (BACK navigation is
acceptable — non-destructive and re-enterable), run `probe-atlas-drift`, and
**re-confirm** the rows those surfaces cover (refresh their `Live-verified
<date>` provenance). Do NOT clear unverified rows for states you didn't reach,
and do NOT migrate recipes you can't on-device validate. Record the snapshot's
coverage + the backlog that still needs the full cold-boot walk.

## MCP tools used

- **`ace-mobile`:** `mobile_ensure_avd_running`, `mobile_run_recipe`,
  `mobile_capture_ui_dump`, `mobile_validate_recipe`, `mobile_resolve_selectors`
  (`adb ... uiautomator dump` directly is fine for read-only snapshot captures).
- **`scripts/probe-atlas-drift.ts`** — the drift harvester.

## Failure modes

- **Reusing a Learn-complete opp for states 6–10.** The device cold-boots fresh
  every dispatch, but Learn-completion is server-side per (phone, opp) and does
  NOT reset on wipe (#568). Walking the Learn states needs a Learn-incomplete
  opp (fresh `/ace:run`), not just a fresh device.
- **Cold-booting over a human's live emulator.** `mobile_ensure_avd_running`
  kills + wipes — fine for automation, rude mid-manual-session. Confirm first,
  or use snapshot mode.
- **Verifying a row from the wrong state.** A row marked verified from a dump
  that didn't actually contain it. The state-walk table is the guard: a row is
  only verifiable from its declared state.
- **Skipping Step 6.** A statically-reconciled map that was never re-run
  on-device recreates the #663 class (substitution looks right, navigation
  fails). Validate live or record that you couldn't.
- **Authoring unused rows.** Adding map rows no recipe references bloats the map
  and gives false coverage. Add only what a recipe needs.

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-06-01 | Initial version. Created to make selector-map calibration a systematic state-walk instead of reactive one-surface-at-a-time fixes that never converge (the 2.63.0 placeholder problem; #591/#593/#650). Distinct from `connect-baseline-screenshots` (training PNGs). | ACE team |
