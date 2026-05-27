# Phase 6 registration "stall" — actually a system permission dialog (twice misdiagnosed)

**Status:** Architectural anchor. Fixes a Phase 6 halt class that two consecutive agents misread as "registration didn't advance past phone entry." Foundational for any future debugging of `mobile_ensure_avd_running` / `registerTestUser` failures.

## Symptom

`/ace:run` reaches Phase 6 (`qa-and-training`). `mobile_ensure_avd_running` cold-boots the AVD, installs CommCare, then runs `connect-register-to-otp.yaml` + `connect-register-from-otp.yaml`. Part B fails its terminal-state assertion (`assertVisible: rvJobList`, 60s timeout). Maestro captures a failure screenshot showing the PersonalID phone-entry screen with phone populated + consent checked. Phase 6 halts with `[BLOCKER]`, classification `needs-personal-id`.

Operator narrative at this point (what two agents wrote):

> "Registration never advanced past phone entry. The +7426 demo-user OTP-skip mechanism must be broken server-side."

That narrative is **wrong**. Registration completed; the recipe just couldn't see it.

## What actually happened

`pm clear org.commcare.dalvik` (which `launchApp clearState=true` triggers at the start of `connect-register-to-otp.yaml`) **revokes every runtime permission CommCare declared `USER_SENSITIVE`**. On the next launch, Android surfaces a `com.android.permissioncontroller/GrantPermissionsActivity` dialog **before** `CommCareSetupActivity` for each ungranted permission, one at a time, in the order:

1. `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION`
2. `RECORD_AUDIO`
3. `CAMERA`
4. `READ_PHONE_STATE`
5. `CALL_PHONE`
6. `READ_MEDIA_AUDIO`
7. `POST_NOTIFICATIONS`
8. `NEARBY_WIFI_DEVICES`

The recipes had **zero** handling for this dialog. The first one stalls everything — Maestro's `extendedWaitUntil(str_setup_message)` times out 30s later because the welcome screen never renders behind the system dialog.

In bednet-spot-check run `20260526-2310`, the AVD got through the dialog at some pre-recipe step (probably an earlier interactive session), registration completed, and the device landed on `connect_fragment_jobs_list`. But then **another** transient dialog appeared — CommCare's own `Location Data Disabled` dialog (`org.commcare.dalvik:id/dialog_title_text` = "Location Data Disabled") which fires when Connect tries to fetch GPS for opp eligibility. THAT dialog overlaid `rvJobList`, and the recipe's terminal-state assertion timed out.

The recipe's failure screenshot was captured AFTER `assertVisible` exhausted — at which point the activity in focus had already paused-and-resumed past the phone-entry layer underneath. Maestro snapshotted the back layer (phone-entry), not the dialog. The screenshot was misleading evidence.

## Why two agents both got it wrong

The misdiagnosis is structural, not "agent X was sloppy":

1. **`mobile_capture_ui_dump` returned stale state.** When I called it post-failure to investigate, it showed the `Location Data Disabled` dialog overlaying the activity. The fresh-from-device `adb shell uiautomator dump` showed `rvJobList` with multiple opp cards rendered — no dialog. The cached MCP dump was hours stale and contradicted the live device. Both agents trusted the cached dump.
2. **The recipe failure screenshot showed phone-entry.** Maestro takes the screenshot at the time of failure, but a paused-and-resumed activity rendering doesn't reflect the actual surface that blocked progress — only whatever the last full-screen draw was. Phone-entry was the last full draw before the dialogs cascaded; that's what got captured.
3. **The "needs-personal-id" classifier didn't have a "dialog-blocked" branch.** Its only signals were "phone screen visible" and "rvJobList visible." Any third state (dialog overlay) fell into the more general "registration never completed" bucket.

These are symptoms of a single underlying issue: **the recipe contract treats post-CONTINUE as a deterministic "registered → rvJobList visible" transition, with zero handling for transient system dialogs that fire in that window.**

## The fix

Three changes, in this order of load-bearing-ness:

1. **`AvdBackend.grantRuntimePermissions(avdName)` — pre-grant the full perm set.** New method. Idempotent. Granted from THREE callsites:
   - `runPostBootPrep` (boot-time, defensive — broadened from the prior CAMERA-only grant)
   - `clearConnectAppData` (post-`pm clear`, the actual revoke event)
   - `registerTestUser` (right before launching CommCare, covers the fresh-install path where neither boot nor clear has fired)

2. **`connect-register-to-otp.yaml` — single defensive `runFlow.when`** for the foreground-only-allow button. Belt-and-suspenders for paths that bypass the MCP wrapper (manual `maestro test`, AMI-side cold-boot, etc.). Single-shot, not a `repeat` loop — ACE's recipe-validator allowlist doesn't include `repeat`, and the pre-grant covers the cascading-9-dialog case. If the pre-grant ever silently fails and the cascade reaches the recipe, the first dialog dismisses cleanly; the rest cause a clear `welcome-screen-timeout` diagnostic rather than a silent stall.

3. **Learning + classifier hint** — this doc. Future agents reading the "needs-personal-id" classification should check whether the device is actually past phone-entry first; if `dumpsys window` shows `ConnectActivity` rather than `CommCareSetupActivity`, the registration completed and the issue is downstream (probably a dialog overlay).

## Where this could surface again

The same class would hit any future CommCare permission that's `USER_SENSITIVE` and not in the pre-grant list. The list is canonical against CommCare 2.62.0/2.63.0; if a future CommCare release adds (e.g.) `BLUETOOTH_CONNECT` to its declared runtime perms, the recipe would stall at the BLUETOOTH dialog. Detection: `dumpsys package org.commcare.dalvik | grep -E "USER_SENSITIVE_WHEN_GRANTED"` lists every perm Android will dialog-prompt for. Diff against the pre-grant list in `AvdBackend.grantRuntimePermissions` whenever CommCare APK is bumped.

## Bonus: `mobile_capture_ui_dump` staleness

Separate bug, surfaced during investigation. `mobile_capture_ui_dump` returned a stale UI tree (the dialog) when the live `uiautomator dump` showed the loaded jobs list with no dialog. Filed separately — the staleness made debugging this issue substantially harder than it needed to be. Recommended check: cross-verify any `mobile_capture_ui_dump` reading against `adb -s <serial> shell uiautomator dump /sdcard/x.xml && adb pull /sdcard/x.xml` before treating it as authoritative state.

## Reproducer

Local AVD with CommCare installed but ungranted perms:

```bash
adb shell pm clear org.commcare.dalvik
adb shell am start -n org.commcare.dalvik/org.commcare.activities.DispatchActivity
adb shell dumpsys window | grep mCurrentFocus
# Output: ...com.google.android.permissioncontroller/...GrantPermissionsActivity
```

The recipe-side reproducer is `mobile_register_test_user` on a freshly-cleared CommCare. Pre-fix: stalls at perm dialog → 30s welcome-screen timeout → `needs-personal-id`. Post-fix: pre-grant fires before recipe → no dialog → recipe walks to `rvJobList` cleanly.

## Related

- `docs/learnings/2026-05-14-demo-user-no-otp.md` — `+7426` demo-bypass mechanism (still works; not the cause)
- `docs/learnings/2026-05-25-bednet-smoke-phase6-install-rejection.md` — `entity_id` literal-XPath workaround (different bug, same opp)
- `docs/learnings/2026-05-14-phase6-validation-arc.md` — the broader "Phase preconditions are restored, not adapted" principle this fix embodies
