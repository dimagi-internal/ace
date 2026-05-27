# Demo users skip OTP — registration is fast (~20-30s), not 3-5 min

**Status:** Architectural anchor. Foundational fact about ACE's test-user pipeline. Cited by `mobile-integration.md` and any future work that touches AVD heal or registration.

## The fact

ACE's test users are **demo users**, identified by the `+7426` phone-number prefix (`${ACE_E2E_PHONE}` starts with `+74260...`). Connect's backend recognizes this prefix and **bypasses the SMS OTP step entirely**. After the user taps Continue on the phone-entry screen, Connect immediately shows a snackbar:

> "I see you're a demo user, so we'll skip the OTP"

The user taps OK and advances directly to App Lock / PIN setup — no SMS wait, no OTP code entry.

**Concrete cost of a fresh demo-user registration:**

- `pm clear` on Connect app: ~0.5s
- Launch Connect: ~2s
- Phone entry + Continue: ~2s
- Demo snackbar OK: ~1s
- App Lock / PIN setup: ~5s
- Backup code: ~3s
- Verify post-register: ~3s
- **Total: ~15-25 seconds** for a registered, authenticated, clean-state demo user.

A snapshot-load takes ~3s. The difference is ~20s, not 4 minutes.

## Where the misleading 3-5 min number came from

CLAUDE.md's "Phase preconditions are restored, not adapted" section quoted:

> ~3-5 min wall-clock on fresh-machine first dispatch

That figure is correct *only* when:

- The Connect APK is not cached locally and must be downloaded from the GitHub release (~1-2 min for the ~40MB APK over a slow link), AND
- A real-phone-number registration path is used (real OTP delivery + retrieval).

Neither applies in steady state. After the first dispatch the APK is cached in `<tmp>/ace-mobile-apk-cache/`; demo users skip OTP entirely. So the steady-state cost is the ~20s above, not the 3-5 min worst-case.

Quoting the 3-5 min number as a generic justification for snapshot-load-as-cache is **wrong** and has led to architectural choices that prefer stale-snapshot-with-band-aids over deterministic-cold-start. The relevant data point is steady-state, not first-dispatch.

## Why this matters

The snapshot-as-cache approach has a recurring failure mode: snapshots silently age. The device wall-clock freezes at capture time; the cached Connect Token's expiration is real-time; eventually the cached state is real-time-stale and the next snapshot-load surfaces as "empty opp list + 401 'You are not authorized'" (the bug fixed by `syncDeviceClockToHost` in PR #281, the band-aid).

**The simpler, more correct answer:** on every heal, run the deterministic fresh-bootstrap path — `pm clear` + register fresh — for a guaranteed clean state. Costs ~20s per dispatch in exchange for never relying on cached state that could be stale.

For rapid dev iteration (5 Phase 6 runs in 10 minutes), that's ~100s of total extra heal time vs the snapshot approach. Worth it; the user explicitly said so 2026-05-14.

## What the recipes look like

The recipes that implement demo registration are committed at:

- `mcp/mobile/recipes/static/connect-register-to-otp.yaml` — launch Connect, enter phone, tap Continue.
- `mcp/mobile/recipes/static/connect-register-from-otp.yaml` — handle the demo-user snackbar, App Lock / PIN setup, backup code, finalize.

Both recipes explicitly comment the `+7426` demo bypass. The `-to-otp` / `-from-otp` naming is historical (from when ACE supported real-phone OTP scraping via `/users/connect_user_otp/`); for demo users the "OTP" is a snackbar tap, not a code entry.

## The non-demo path (for posterity)

If ACE ever needs a non-demo registration:

- Real phone numbers go through the SMS OTP flow.
- Connect exposes `GET /users/connect_user_otp/?phone=<E164>` for test environments where the test bench owns the phone — the OTP is server-side dispensed and can be scraped into the recipe via `${OTP}`.
- This path is `~3-5 min` because SMS delivery takes a moderate fraction of that and the OTP can rate-limit retries.
- **None of this is on ACE's automated path.** All `ACE_E2E_*` test users are `+7426` demo users by convention.

## Operator action: when to be wary

If you read or hear any of these claims, stop and check this doc:

- "Snapshot is faster than re-registering — we should keep the snapshot."
- "Re-registering takes 3-5 minutes; we can't do it per dispatch."
- "Tier-1 is the fast path; tier-2 is the slow fallback for fresh machines."
- "The snapshot is just stale, we can patch around it."

The first three are wrong for the demo-user steady state. The fourth treats a structural problem as a per-instance fix. Re-read the "Phase preconditions are restored, not adapted" principle in CLAUDE.md — the snapshot-as-cache is exactly the "tolerance for whatever starting state" anti-pattern.

## Snapshot atoms today

`mobile_save_snapshot` / `mobile_load_snapshot` MCP atoms still exist for **ad-hoc debugging only** — operator-driven "save this exact UI state so I can come back to it later." They are NOT part of `restoreDeviceUserState` and not on the Phase 6 heal path. The heal path is always cold-boot per dispatch (`-wipe-data -no-snapshot-load -no-snapshot-save`).
