# Connect Baseline Recipes

Maestro recipes that drive the standard Connect-app navigation surfaces
(home, claim, sync, PersonalID, etc.). These are **NOT per-opp** — they
capture surfaces that look identical across every ACE opportunity because
they're driven by the Connect APK's own UI.

Two skills consume these recipes:

- **`connect-baseline-screenshots`** — captures per-Connect-version training
  PNGs into `ACE/_common/connect-screenshots/<version>/` for reuse across
  training decks.
- **`selector-map-calibrate`** — drives the same surfaces to harvest ui-dumps
  and calibrate `mcp/mobile/selectors/connect-<apk>.yaml` (promote `unverified`
  rows, fix drift, then migrate static recipes off raw ids). This is the skill
  the `selector_map_currency` doctor probe points at.

## Recipes (actual on-disk set)

| File | Surface(s) driven |
|------|-------------------|
| `00-connect-home.yaml` | Connect home / jobs-list (`connect_fragment_jobs_list`, `rvJobList`) |
| `01-claim-opp.yaml` | New Opportunities → claim flow → confirmation |
| `02-learn-install.yaml` | Opp detail → start/download Learn → CommCare Learn home |
| `03-sync-button.yaml` | Toolbar sync action, sync state |
| `04-personal-id.yaml` | PersonalID registration flow aliases |

> **Drift note (2026-06-01):** earlier versions of this README and
> `connect-baseline-screenshots/SKILL.md` listed an aspirational `01-sign-in …
> 08-settings` set that never matched disk. The table above is the real set.
> Surfaces not yet covered by a recipe (logged-out login, registration photo
> capture, Deliver-home, payments, settings) are tracked as residual coverage in
> the `selector-map-calibrate` state-walk table — add a recipe there as each
> surface gets a calibrated walk. Don't reintroduce the phantom 8-recipe list.

## Calibration

Calibrate each recipe against a **live** target Connect APK (drive it on-device
and confirm it navigates — don't transcribe from a sibling APK version). Prefer
stable text anchors (e.g. `text: "New Opportunities"`) over resource-ids where
the label is stable, so recipes survive minor APK rebuilds. The
`selector-map-calibrate` walk + `probe-atlas-drift` harvest are how new/ drifted
selectors get found and promoted into the map.
