# Capturing transient AVD surfaces — side-channel monitoring doesn't work

**Date:** 2026-05-14
**Context:** Trying to capture the § 8 (post-Learn-complete certificate) and § 9 (Download Delivery gate) surfaces during a Phase 6 J5 re-dispatch, after shipping PR #295 + #296 with those surfaces flagged as coordinate-only TBD.
**Outcome:** Both attempts failed for structural reasons. Two findings worth carrying forward.

## Finding 1 — concurrent ADB sessions lose to Maestro

**Attempted pattern:** background bash script polling `adb shell uiautomator dump` every 3s while Phase 6 J5's Maestro recipe walked the Learn→Deliver transition. The idea was to capture the dump XML the moment distinctive surface markers ("VIEW OPPORTUNITY DETAILS", "DOWNLOAD") appeared on screen.

**What happened:** every dump call in the monitor returned `ERROR: could not get idle state` or simply hung. The monitor log shows ~90 consecutive `adb dump failed (AVD likely busy or down); sleep` lines for the full ~7 minute duration of the Maestro run. Zero captures landed.

**Why:** Maestro's gRPC driver (`dev.mobile.maestro`) holds the on-device `uiautomator` service exclusively while a `maestro test` run is active. A separate `adb shell uiautomator dump` from a parallel adb session contends for the same Android service and loses — the driver doesn't surrender the lock between Maestro's own dump calls.

**Structural fix:** the dump step must be **embedded inside the Maestro recipe**, not run from a side channel. Two options:

1. **Maestro `runScript:` step** that shells out to `adb -e shell uiautomator dump` between two `tapOn` steps. The script runs from the host Maestro CLI process, which already has the driver exclusively — so no contention.
2. **Extend `app-screenshot-capture`** to call `mobile_capture_ui_dump` (the MCP atom) after every `takeScreenshot` step. This sits at the harness layer, between Maestro recipe executions, when the driver is idle. Pairs the PNG with an XML dump for every captured surface.

Option 2 is the cleaner long-term path — it's a one-time skill change that automatically captures dumps for every future Phase 6 surface across every opp. Filed as a follow-up.

## Finding 2 — atlas-walk taps "consume" the opp from a demo user's perspective

**Attempted pattern:** earlier in the same session, I manually walked the AVD through the Learn→Deliver transition (Final Assessment pass → Certificate → Download Delivery → Vendor Visits) to capture surface screenshots and coordinates for the atlas. Demo user was `+7426…` from the heal layer's `registerTestUser` (using `ACE_E2E_PHONE`). Hours later I tried to re-dispatch Phase 6 J5 against the same opp and run-id.

**What happened:** J5's `connect-claim-opp.yaml` recipe halted at `scrollUntilVisible` for the opp's tile. Pre-recipe `mobile_capture_ui_dump` confirmed the tile was present at position 5/5 (stale local Connect cache). After `connect-login` re-launched the app and tapped `action_sync`, post-sync dump showed the tile **gone** — only older turmeric tiles from prior runs remained. Server-side `connect_get_opportunity` confirmed the opp was still `active`.

**Why:** Connect's opp list shows opps the FLW is invited to AND hasn't already completed (with some nuance around delivery progress). My manual walk earlier in the session completed the Learn portion of the opp from this demo user's perspective AND downloaded the Deliver app. After the next sync, the server returned "this user has progressed on this opp; don't show it as an unclaimed opportunity" — exactly the design intent. From J5's perspective, the precondition "claimable opp visible to demo user" was violated.

**Structural implication:** atlas-walk taps and Phase 6 re-dispatches against the same opp aren't idempotent from the test user's perspective. To get a clean J5 re-dispatch after an atlas walk you need ONE of:

- **A fresh demo user phone** (different `+7426...` number) plus an invite for that phone via `connect_send_flw_invite`. The heal layer's `registerTestUser` doesn't auto-do this — it uses the static `ACE_E2E_PHONE`.
- **Server-side reset of the demo user's progress on that opp** (no MCP atom currently exposes this).
- **A fresh opp** — but that requires Phase 4 to run again, which creates a new Connect opportunity entity on labs.

The validation arc's 5-successful-J5-in-a-row pattern (`docs/learnings/2026-05-14-phase6-validation-arc.md`) worked because no manual atlas walk intervened between dispatches — every dispatch started from "fresh `pm clear` device, never-claimed user state for this opp."

**Anti-pattern to avoid:** doing manual atlas-walk taps on the same AVD/test-user/opp you intend to re-dispatch Phase 6 against later. If you must atlas-walk, do it on a throwaway opp or accept that the next Phase 6 J5 dispatch on that opp will halt at claim-opp.

## Practical recommendation for closing the § 8 / § 9 atlas gap

Given both findings, the cheapest reliable capture path is:

1. **Add `mobile_capture_ui_dump` calls to `app-screenshot-capture`** alongside the existing `takeScreenshot` capture (or as an additional MCP atom call inserted at every screenshot point). One-time skill change.
2. **Wait for a natural fresh Phase 6 J5 dispatch** on any opp — turmeric or otherwise. The dumps for § 8 / § 9 will fall out as routine Phase 6 artifacts, paired with the screenshots that are already captured. No special atlas-walk session required.

The side-channel monitor pattern in `/tmp/ace-deliver-walk/monitor-deliver-surfaces.sh` (this session's experiment) does NOT work and should not be re-attempted. The script is preserved as a reference but its approach is structurally broken for any AVD interaction that involves Maestro.

## Files involved

- `mcp/mobile/recipes/static/J*.yaml` — where a `runScript:` dump step would land if pursuing fix-option-1
- `skills/app-screenshot-capture/SKILL.md` — the change site for fix-option-2
- `mcp/mobile-server.ts` — already exposes `mobile_capture_ui_dump`; no MCP work required
- `docs/mobile-atlas/connect-2.62.0.md § 8`, `§ 9` — atlas sections that remain coordinate-only until a Phase 6 dispatch captures their dumps as a side-effect
