# Connect Baseline Recipes

Eight Maestro recipes that drive the standard Connect-app navigation
surfaces (sign-in, claim opp, sync, payments, etc.). Run by the
`connect-baseline-screenshots` skill once per Connect APK version; output
lives at `ACE/_common/connect-screenshots/<connect-version>/` on Drive.

These are NOT per-opp. They capture surfaces that look identical across
every ACE opportunity because they're driven by the Connect APK's own UI.

## Recipes (TBD - calibrated against live Connect APK before first run)

- `01-sign-in.yaml` — splash → nav drawer → home
- `02-opp-list-view.yaml` — New / Claimed / detail tabs
- `03-claim-opportunity.yaml` — claim flow + confirmation
- `04-launch-learn-app.yaml` — opp detail → Start Learning → Learn home
- `05-launch-deliver-app.yaml` — opp detail → Start Delivering → Deliver home
- `06-sync-and-submit.yaml` — sync indicator, "All synced", queue
- `07-payments-tab.yaml` — payments tab, daily breakdown, total
- `08-settings-and-help.yaml` — settings, About, Sign Out, Help link

## Calibration

Before first run, calibrate each recipe via `maestro studio` against the
target Connect APK. Use stable text anchors where possible (e.g.,
`text: "New Opportunities"`) so the recipes survive minor APK rebuilds.
The `connect-baseline-screenshots` skill's verdict will catch any
selector-staleness regressions.
