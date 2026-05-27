# Atlas capture — embed in the recipe, don't side-channel

**Date:** 2026-05-14
**Status:** Finding 1 resolved (`mcp/mobile/recipe-splitter.ts` + `MaestroBackend.runRecipeWithDumps` ship UI dumps alongside every screenshot). Finding 2 is durable architecture.

## Finding 1 — Don't run concurrent ADB sessions while Maestro is running

**Why:** Maestro's gRPC driver (`dev.mobile.maestro`) holds the on-device `uiautomator` service exclusively while a `maestro test` run is active. A parallel `adb shell uiautomator dump` contends for the same Android service and silently loses — every dump returns `ERROR: could not get idle state` or hangs.

**Anti-pattern (do not re-attempt):** Background bash script polling `adb shell uiautomator dump` during a long Maestro recipe to capture surface markers. The script in `/tmp/ace-deliver-walk/monitor-deliver-surfaces.sh` (now historical) captured ~90 consecutive failures and zero dumps in 7 minutes.

**Resolution:** dumps now embedded inside Maestro recipes via recipe-splitting. `runRecipeWithDumps` pairs every `takeScreenshot` with a `<step-name>.xml` UI dump, captured between recipe chunks when the driver is idle. No skill-level changes required for new surfaces — dumps fall out as routine artifacts.

## Finding 2 — Atlas-walks are not idempotent from a demo user's perspective

**Class:** A demo user who walks far enough through an opp (e.g. completes Learn-side flow) is no longer eligible to *claim* that opp from a fresh dispatch. The server-side "show unclaimed opportunities" query excludes opps where the user has progressed. From the next `connect-claim-opp.yaml` dispatch's perspective, the precondition "claimable opp visible" is violated.

**Implication:** If you must manually atlas-walk for selector discovery, do it on a **throwaway opp** or accept that the next Phase 6 dispatch on that opp will halt at claim-opp.

**Recovery options** (all expensive; pick one):
- Fresh demo user phone (different `+7426...` number) + new invite via `connect_send_flw_invite`
- Server-side reset of the demo user's progress on that opp (no MCP atom currently exposes this)
- Fresh opp (requires Phase 4 to run again, creates a new Connect opportunity)

The validation arc's 5-successful-J5-in-a-row pattern (`2026-05-14-phase6-validation-arc.md`) worked because no manual atlas walk intervened between dispatches.
