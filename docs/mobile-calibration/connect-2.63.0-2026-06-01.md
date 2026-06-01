# Selector-map calibration report — connect-2.63.0 — 2026-06-01

**Mode:** Snapshot (read-only) — the only live device available (`emulator-5580`)
was a **shared, in-flight** device (signed-in test user, mid-Learn on another
run's opp). Per `selector-map-calibrate`'s cardinal rule, the destructive full
state-walk was NOT run here; only read-only captures + re-confirmation.

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

The convergent fix (clear the 10-row backlog, finish #650's recipe migration,
calibrate #666's camera surface, confirm #618's Learn-home gesture) requires the
**destructive full state-walk on a throwaway device** — a dedicated/secondary
AVD (`ACE_Pixel_API_34_PS`) with a fresh user, or a throwaway `/ace:run` opp.
It could not be run on the shared in-flight `emulator-5580` without consuming
another run's one-way preconditions.

**Next action:** `/ace:step selector-map-calibrate` on a throwaway device (full
walk). The framework, the doctor pointer, and this report now make that a
single deterministic session instead of archaeology.
