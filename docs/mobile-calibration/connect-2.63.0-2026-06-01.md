# Selector-map calibration report — connect-2.63.0 — 2026-06-01

Two passes this date: **(A) a read-only snapshot** (before the framework was
fixed) and **(B) a cold-boot walk** (the real first run of `selector-map-calibrate`).

---

## Pass B — cold-boot walk (states 1–5)

`mobile_ensure_avd_running` cold-booted `ACE_Pixel_API_34` (`emulator-5580`):
`-wipe-data` → reinstall 2.63.0 APK → re-register the demo user → baseline. The
registration ran `connect-register-from-otp.yaml` to completion (`maestro.log`
ends `Assert id: rvJobList visible COMPLETED`), so **states 1–3 were walked by
the cold-boot's own registration** — a live on-device validation (framework
Step 6) of every selector on the demo-bypass path.

**Confirmed-live live: device fresh, opp state persists.** After the wipe +
re-register, the jobs list showed the SAME in-progress opps (LEEP/Malaria/
Turmeric, 14–42% Learn) — proving the corrected framing: the device is fresh but
`(phone, opp)` Learn-completion is server-side and survives the wipe (#568).

**Rows promoted `unverified: true` → live-verified** (exercised + COMPLETED in
the passing registration run, per `~/.maestro/tests/.../maestro.log`):

| Row | id | Evidence |
|---|---|---|
| `personalid-name-continue` | `personalid_name_continue_button` | tapped + navigated |
| `personalid-message-button` | `connect_message_button` | tapped |
| `personalid-backup-code-view` | `backup_code_view` | "is visible" guard matched |

**Left `unverified`** (not confirmable from the demo-bypass path):
- `personalid-confirm-code-view` (`confirm_code_view`) — +7426 skips OTP confirm;
  only evaluated as "not visible". Needs a real OTP registration.
- `personalid-login-button` (`connect_login_button`) — sign-in button; the
  demo-bypass registration path didn't traverse it.

**State 4 (jobs-list)** re-confirmed on the post-boot dump (`00-landed.xml`):
`connect_fragment_jobs_list`, `rvJobList`, `btn_resume`, `btn_view_info`.
**State 5 (opp-detail)** already covered by Pass A.

**States 6–10 NOT walked.** They need a Learn-incomplete opp; the only available
opps are stale prior-run opps (driving Learn on them would consume their state
and risks the #629 Start-handoff wedge). The clean continuation is a fresh
`/ace:run` opp — then states 6–10 (incl. #618's `learn-home-screen` gesture and
the form/quiz/deliver rows) calibrate in one pass.

**Net Pass B:** 3 rows promoted; backlog 14 → 11 unverified.

---

## Pass A — snapshot (read-only)

`emulator-5580` was running warm (signed-in test
user, mid-Learn) — a leftover/human session I chose not to cold-boot over
without a heads-up. NOTE: the full walk is NOT blocked by this — the standard
fix is `mobile_ensure_avd_running` (cold-boot wipes + re-registers a fresh user;
states 1–5 follow) plus a Learn-incomplete opp for states 6–10. The device is
always fresh; only the opp's server-side Learn-completion needs to be fresh
(#568). I ran snapshot mode here purely as operator courtesy to the warm AVD.

**Device:** `emulator-5580`, CommCare `org.commcare.dalvik` **2.63.0** (confirmed
via `dumpsys package … versionName`).

## Surfaces captured (read-only)

| Surface | How reached | Dump |
|---|---|---|
| Opp detail / job card (Learn 3/6, pre-pass) | device's existing foreground (`ConnectActivity`) | `opp-detail.xml` (16.7 KB) |
| Jobs list (In Progress section) | BACK from opp detail (non-destructive, re-enterable) | `jobs-list.xml` (24.0 KB) |

`probe-atlas-drift.ts --apk 2.63.0` was run against both dumps.

## Rows re-confirmed live (no change needed)

These were already live-verified earlier today via #663; this snapshot
independently re-confirmed them on a fresh dump:

- `home-jobs-list` → `connect_fragment_jobs_list` ✓ present (jobs-list)
- `home-jobs-recycler` → `rvJobList` ✓ present (jobs-list)
- `opp-list-resume-button` → `btn_resume` ✓ present on In-Progress cards
- `connect_learning_button` ✓ present on opp-detail; live label "DOWNLOAD LEARN
  APP" on the **pre-pass** branch — confirms the row's documented pre-pass label note

## Rows NOT adjudicable from this snapshot (need their state)

- `opp-list-view-opportunity-button` → `btn_view_opportunity`. The live
  **In-Progress** cards expose `btn_view_info`, NOT `btn_view_opportunity` — but
  `btn_view_opportunity` is the **New Opportunities** (unclaimed) card button,
  and the New Opportunities tab was **not** captured. Adjudicating this requires
  a dump of the New Opportunities list. **Left unchanged** (verifying it from the
  In-Progress section would be the "wrong-state" trap).

## Unverified backlog — entirely in unreached states (the full-walk targets)

All **14** `unverified: true` rows (count as of 2026-06-01, post-#665) live in
states this snapshot could not reach without destructive transitions. (#665
promoted the login/register/learn ids off raw recipe literals and flagged them
`unverified: true`, expanding the backlog from ~10 to 14; it also finished
#650's static-recipe migration except `connect-register-from-otp.yaml`'s 7
camera ids — the #666 surface.) Representative groupings:

| Row | Required state |
|---|---|
| `app-first-start-main` | cold start / first-run |
| `learn-home-screen` (`nsv_home_screen`) | post-download CommCare Learn home (#618) |
| `form-question-input` | inside a Learn form |
| `form-submit`, `assessment-result-passed`, `assessment-result-failed` | quiz / result screen |
| `opp-detail-start-delivering`, `deliver-start-button` | a **Learn-complete** opp |
| (registration photo `com.android.camera2` cluster, #666) | a **fresh** PersonalID registration |

`probe-atlas-drift`'s "in map but not in dumps" list (camera2, settings-PIN,
backup-code, `btn_start`) is consistent with this — those anchors belong to
states the 2-surface snapshot never visited. **None proposed for removal.**

## Map / recipe changes this run

- **Map rows promoted:** 0 (everything reachable was already verified; backlog
  unreachable). The map **header** was corrected from the alarmist "PLACEHOLDER
  / nothing verified" wording to an accurate partial-calibration status that
  points at `selector-map-calibrate`.
- **Recipes migrated off raw ids (#650):** 0 this run (migration requires
  on-device re-validation of the affected surfaces — `connect-login`,
  `connect-register-*`, `learn-*` — which the snapshot couldn't reach).

## Residual — the immediate next action

The convergent fix (clear the 14-row backlog, calibrate #666's camera surface,
confirm #618's Learn-home gesture) is the full state-walk: a standard
`mobile_ensure_avd_running` cold-boot (fresh device + re-registered user → states
1–5, including #666's registration photo surface) plus a **Learn-incomplete opp**
for states 6–10 (a fresh `/ace:run`, since Learn-completion is one-way per
(phone, opp) server-side and doesn't reset on device wipe — #568). No special
"throwaway device" is needed; the device is always fresh by design.

**Next action:** `/ace:step selector-map-calibrate` — cold-boot a fresh AVD and
walk it (point states 6–10 at a Learn-incomplete opp). The framework, the doctor
pointer, and this report make that a single deterministic session.
