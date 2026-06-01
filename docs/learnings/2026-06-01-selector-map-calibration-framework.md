# Selector-map calibration is a state-walk, not a snapshot — and the doctor pointed at the wrong skill

**Date:** 2026-06-01
**Tags:** mobile, selectors, atlas, calibration, 2.63.0, #650, #666, #618, #593, #591

## The frustration that surfaced this

After months of mobile work, ACE was still shipping one-off "ticky-tacky"
selector/recipe fixes (a wrong id here, a missing back-press there) instead of
having a calibrated foundation. The question was: *are we missing a massive
atlas run?* Yes. We were.

## Root cause — two compounding problems

**1. The selector map for 2.63.0 was never actually calibrated.** When the AMI
bumped CommCare 2.62.0 → 2.63.0, `connect-2.63.0.yaml` was copied verbatim from
`connect-2.62.0.yaml` and its header literally says `PLACEHOLDER STATE … 
UNVERIFIED against a live 2.63.0 device`. Only ~10 of 56 rows carried live
provenance; the rest were inherited guesses. Every recipe touching the map sat
on unverified ground, and failures surfaced one surface at a time as each got
exercised in production — exactly the anti-pattern CLAUDE.md warns against
(*"New-APK-version maps are calibrated against a live device as a first-class
step, not discovered wrong in production"*).

**2. The remediation pointed at a skill that doesn't calibrate the map.**
`bin/ace-doctor`'s `selector_map_currency` probe told everyone to *"run
`/ace:step connect-baseline-screenshots` to calibrate against the live APK."*
But `connect-baseline-screenshots` captures **training-deck PNGs** — its products
are images + a deck manifest. It never reconciles the selector map, never runs
`probe-atlas-drift`, never promotes `unverified` rows, never migrates recipes.
So the documented "fix the map" path led to a skill that doesn't fix the map.
Calibration had no owner.

## The structural insight — why reactive calibration never converges

**Unverified rows live in distinct, mutually-exclusive device states**, and you
cannot verify them from a single snapshot:

- `app-first-start-main` → only on the cold-start screen
- `learn-home-screen` (`nsv_home_screen`) → only on the post-download CommCare
  Learn home (the #618 surface)
- `form-question-input` → only inside a form
- `deliver-start-button` / `opp-detail-start-delivering` → only on a
  **Learn-complete** opp
- the registration photo surface (#666) → only during a **fresh** PersonalID
  registration (`com.android.camera2`)

Several of these states are **one-way** (Learn completion is irreversible per
`(user, opp)`) or **destructive** (fresh registration de-registers the user).
So whatever surface a given run happened to touch is the only one that ever got
calibrated. Sampling a random live device — as we did this session, finding it
mid-Learn on a shared opp — can only **re-confirm** the rows reachable from that
state; it cannot clear the backlog.

**The only convergent procedure is to walk a throwaway user through every state
in order, dump each, then reconcile the whole map in one pass.**

## What we did about it

1. **Built `skills/selector-map-calibrate/SKILL.md`** — a dedicated, repeatable
   calibration procedure: a 10-state walk on a throwaway device →
   `probe-atlas-drift` harvest → map reconciliation (promote/correct/add/remove
   with dated provenance) → recipe migration off raw ids (#650) → **on-device
   re-validation** (the close-the-loop step piecemeal fixes skipped) → a
   calibration report. Explicitly distinct from `connect-baseline-screenshots`.
2. **Repointed the doctor remediation** at the calibration skill, so
   `selector_map_currency` tells you to run the thing that actually calibrates.
3. **Reconciled the baseline-recipe drift** — the skill, the README, and the
   on-disk `recipes/baseline/` files listed three different recipe sets.
4. **Snapshot-mode increment** against the live shared device: re-confirmed
   `home-jobs-list`, `opp-list-resume-button`, and `connect_learning_button` on a
   fresh 2.63.0 dump (read-only; no preconditions consumed).

## The cardinal rule

**Never run the destructive full walk on a shared/in-flight device** — it
consumes another run's one-way preconditions. Use a dedicated/secondary AVD with
a throwaway user, or a throwaway `/ace:run` opp. On a device you don't own,
read-only snapshot mode only.

## Residual / follow-up

The full state-walk that clears the **14-row** unverified backlog (and
calibrates #666's camera surface + confirms #618's Learn-home gesture)
**requires a dedicated throwaway-user session** — it could not be run this
session without clobbering the shared in-flight emulator. (#650's static-recipe
migration off raw ids landed separately in #665 while this work was in flight,
leaving only `connect-register-from-otp.yaml`'s 7 camera ids raw — the #666
surface; so #650 is now reduced to live-verifying the promoted rows, which IS
this walk.) The framework now makes that a single `/ace:step
selector-map-calibrate` run instead of archaeology. That walk is the immediate
next action.

## Related

- `skills/selector-map-calibrate/SKILL.md` — the framework
- `skills/connect-baseline-screenshots/SKILL.md` — the (distinct) training-PNG skill
- `docs/learnings/2026-05-14-atlas-side-channel-capture.md` — the ui-dump sidecar
- `docs/learnings/2026-05-26-deliver-atlas-coverage.md` — id anchors > coordinates
- `docs/learnings/2026-05-25-recipe-static-preventer-suite.md` — shift-left lint gates
- jjackson/ace#650 (raw-id migration), #666 (camera surface), #618 (Learn-home gesture), #591/#593 (prior reactive 2.63.0 fixes)
