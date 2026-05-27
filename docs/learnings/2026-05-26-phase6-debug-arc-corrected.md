# Phase 6 debug arc — 4 wrong hypotheses, 1 corrected map

**Date:** 2026-05-26  
**Opp:** `malaria-rdt` run `20260525-2029`  
**Session outcome:** 3 PRs shipped (each fixed a real-but-stacked bug); 4th hypothesis was wrong, probed and reverted; root cause for the remaining Phase 6 blocker is still **unknown**.

## TL;DR

If you're debugging Phase 6 after this and seeing `mobile_ensure_avd_running` time out at `assertVisible id: rvJobList`, **do NOT blame the same things I blamed.** All 4 of these were wrong-or-incomplete diagnoses; only 3 were real bugs to fix. The actual root cause of the demo-user snackbar not appearing after CONTINUE tap is still uncharacterised.

## What got fixed (real bugs, not the topic of this doc)

| Attempt | Symptom | Hypothesis | Real cause | Fix | Ship |
|---|---|---|---|---|---|
| 1 | `mobile_ensure_avd_running` fails with `Unknown Property: textRegex` at Maestro parse time | Bug class self-explanatory | `textRegex:` is not a Maestro 2.5.1 property | `textRegex:` → `text:` (regex by default) | v0.13.434 (PR #513) |
| 2 | After textRegex fix: `extendedWaitUntil text: "Work History"` times out 60s | Server-side `start_configuration` failure | "Work History" doesn't render on Connect 2.63.0 post-registration screen (jobs list with toolbar "Connect" + id `rvJobList` only) | Anchor on `id: org.commcare.dalvik:id/rvJobList` (resource-id, immune to label drift) | v0.13.435 (PR #514) |
| 3 | After rvJobList fix: `scrollUntilVisible` times out even though tile IS fully on-screen | Bug class self-explanatory after UI dump | Maestro 2.5.1's default `visibilityPercentage=100` is too strict for RecyclerView tiles | Drop to `visibilityPercentage: 60` on every scrollUntilVisible in the static palette + retryTapIfNoChange + 4 sibling fixes | v0.13.441 (PR #522 et al) |

Each of those was a real bug, surfaced one at a time as the previous one stopped masking it. The pattern itself is fine — fix one thing, see what surfaces next.

## The wrong hypothesis (this is the topic of this doc)

| Attempt | Symptom | Hypothesis I proposed | Why wrong | Cost if shipped |
|---|---|---|---|---|
| 4 | After all above fixes: `mobile_ensure_avd_running` STILL fails. Agent diagnosed "CONTINUE button greyed-out, gated by 'Using your location' warning — APK 2.63.0 location-permission gate" | Pre-grant `ACCESS_FINE_LOCATION` + `ACCESS_COARSE_LOCATION` in `mobile_ensure_avd_running` pre-flight, mirroring existing CAMERA grant | Both location permissions ARE granted at runtime (`dumpsys package` shows `granted=true` on both AVDs; `appops get FINE_LOCATION` returns `allow; foreground`); GPS provider IS active; the "greyed CONTINUE" interpretation was a misread of a STALE post-failure screenshot | Would ship a useless `adb shell pm grant` that does nothing on permissions that are already granted, and the next person hits the same blocker again with one more failed-hypothesis to debug past |

### What I missed when proposing the wrong fix

1. **Didn't check if the permission was actually granted.** Should have run `dumpsys package org.commcare.dalvik | grep -A5 'runtime permissions'` BEFORE proposing the fix. Would have shown `granted=true` and immediately invalidated the hypothesis.

2. **Trusted a screenshot interpretation without verifying.** Looked at the failure PNG and called the CONTINUE button "greyed". When I looked at the same PNG more carefully after pushback, the button was **clearly blue/active**, not greyed at all.

3. **Conflated timestamps across attempts.** Read the maestro log from attempt 3 (07:41) against the screenshot from attempt 4 (15:02). They were different attempts with different states. The "greyed CONTINUE" PNG was actually from attempt 4 part B, but part A had crashed at startup with `Failed to record heartbeat — sleep interrupted` and never typed anything — so part B was looking at a stale leftover UI from earlier abandoned runs.

4. **Made up registration latency numbers from logcat timestamps that weren't continuous.** Claimed "demo bypass takes 2 minutes" based on `07:42 CONTINUE → 07:59 App Lock` gap in logcat. That 16-minute gap probably included multiple agent retries driving the device between the CONTINUE tap and the App Lock screen — not a single slow transition.

## Corrected map for next debugger

### What's actually known about the remaining Phase 6 blocker

- AVD setup is fine: location permissions granted, GPS provider active, demo phone (`+74260000100`) is invited to opp `3163ccb8-e8f8-4b30-92a0-fbd94f51b71e` per Phase 4 write-back
- Recipe parses correctly (v0.13.441 has all 3 prior bug fixes shipped)
- Maestro part A drives through the phone-entry form: countryCode `+7`, phone `4260000100`, privacy checkbox checked, CONTINUE tapped
- Maestro reports `tapOn personalid_phone_continue_button COMPLETED` and `Something has changed in the UI judging by view hierarchy. Proceed.` — but this is just Maestro confirming the tap was REGISTERED (a click ripple counts as "hierarchy changed"). It does NOT mean the screen transitioned.
- `waitForAnimationToEnd 8000ms` completes in 328ms (no animation actually happened — no screen transition)
- Part B starts on the SAME phone-entry screen and times out at `assertVisible id: rvJobList`

### What's NOT known (the real question)

**Why does the CONTINUE tap not surface the demo-user snackbar within 60s?**

The recipe expects `+7426`-prefix phones to skip OTP via the demo-bypass snackbar (`org.commcare.dalvik:id/snackbar_action`) that says "I see you're a demo user, so we'll skip the OTP." None of the prior 3 fixes addressed why the snackbar fails to appear.

Candidate root causes I can't distinguish without more probe data:

1. **`start_configuration` server latency or failure.** The Connect-id `start_configuration` endpoint that the CONTINUE tap fires might be:
   - Returning slowly (>60s) for the demo-bypass phone
   - Returning a 500 that the app silently swallows
   - Returning success but not triggering the snackbar surface for an unrelated reason
2. **Demo-bypass prefix not honored.** Connect-id might not be recognising `+74260000100` as a demo phone (server-side config drift since the recipe header was written), so the OTP screen IS appearing but the recipe's snackbar `when:` guard skips and the recipe never enters the OTP path either.
3. **GMS instability eating the location-fix-acquired callback the app waits on.** The earlier logcat showed multiple GMS services in crashed/restart state. If the app is waiting for a first GPS fix from GMS Fused Location Provider before enabling the post-CONTINUE transition, and GMS is in degraded state, the wait would silently fail.
4. **Phone-invite expiry or missed propagation.** Phase 4 invited the phone at 04:30Z; Phase 6 retried at ~15:00Z (over 10 hours later). If invites have a TTL, the phone might no longer be invited when CONTINUE fires.

Each is a probe away from confirmation; none is shipped.

### The probe that should run before any more Phase 6 fixes

Write a `scripts/probe-phase6-continue.ts` that:

1. Cold-boots the AVD via `mobile_ensure_avd_running` (no demo-bypass recipe — just the AVD).
2. Drives the device to the PersonalID phone entry screen via Maestro (`connect-register-to-otp.yaml` minus the final CONTINUE tap).
3. Captures a baseline: `dumpsys activity top`, `dumpsys package org.commcare.dalvik`, `appops get` for FINE_LOCATION, screenshot, full logcat.
4. Taps CONTINUE.
5. Every 5 seconds for 90 seconds:
   - Screenshot
   - `dumpsys activity top`
   - `adb logcat -d` since the previous capture, filtered to PersonalID + Connect-id + GMS tags
6. Final capture: same as baseline, plus uiautomator dump.

That data set would distinguish (1) (logcat shows the start_configuration response time + status) from (2) (UI hierarchy shows OTP screen vs phone-entry) from (3) (logcat shows GMS fused-location-provider stalls) from (4) (logcat shows a 401/403 from Connect-id rejecting the phone).

### Anti-patterns this debug arc surfaced

1. **Trusting an agent's diagnosis without verifying.** The agent that ran attempt 4 wrote a confident "Connect-id server-side issue" report. The user pushed back. Probe showed the agent was wrong about which screen was being looked at AND about the button being greyed. Default reflex should be: probe the device state before believing the diagnosis.

2. **Reading a screenshot as "greyed" without staring at the actual pixels.** The button was blue with white text on a darker page. Visually it could read as "less prominent than the keyboard" but the button itself was fully saturated blue. Look at the SCREENSHOT, not your prior assumption about what it shows.

3. **Cross-referencing maestro logs and screenshots from different attempts.** Multiple Maestro test directories get created during a single `/ace:run`. The screenshot you click on might be from a different `~/.maestro/tests/<timestamp>/` than the log you're reading. Always check the timestamp on both.

4. **Inferring registration latency from non-contiguous logcat timestamps.** Logcat shows events but doesn't say "this was the natural latency vs this was driven by an external agent." A 16-minute gap is almost certainly not a single transition latency.

## Related fixes shipped this session (for context, not for repeat)

- v0.13.434 PR #513 — `textRegex` → `text` 
- v0.13.435 PR #514 — `rvJobList` anchor
- v0.13.441 PR #522 — visibilityPercentage 60 + 4 sibling fixes
- v0.13.444 PR #526 — decisions strict-write invariant (orthogonal to Phase 6 but landed same session)

## Status

Phase 6 of `malaria-rdt/20260525-2029` is still `error/blocked-on-platform`. The 4th hypothesis is documented as wrong here. Phases 7-8 of that run shipped via the "skip Phase 6, proceed to 7-8" branch since they don't depend on Phase 6 outputs.

To unblock Phase 6 on the next /ace:run, the probe above needs to actually run. No more guess-and-PR cycles until there's real device-side evidence.
