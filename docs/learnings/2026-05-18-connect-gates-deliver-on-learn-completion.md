# Connect gates the Deliver app behind Learn-assessment completion

**Date:** 2026-05-18
**Surfaced by:** malaria-itn-app run 20260517-1829 Phase 6 (app-screenshot-capture)
**Class:** Connect UI invariant + Phase 2/3/6 contract gap

## The invariant

Connect's mobile UI **only surfaces the Deliver app after the FLW
completes the Learn-app modules AND passes the final assessment AND
that assessment-pass syncs to Connect.** There is no UI affordance
that lets a user jump from claim-opp → Deliver without walking Learn
to completion first.

Concretely, post-claim the device lands on the Learn-mode
StandardHomeActivity (atlas § 5). Tapping `Start` launches the Learn
suite root (§ 6). The user must:

1. Tap each Learn module row → form list → form → fill content forms
2. Tap each module's assessment row → take the quiz → pass with the
   required `passing_score`
3. Submit the final assessment, return to the suite root
4. Tap `Sync with Server` (Learn-side home) to push the assessment
   pass to Connect
5. Navigate back to Connect's opp list (system back / "GO TO CONNECT
   MENU" via the in-app return)
6. Tap `Resume` on the now-In-Progress card → certificate screen
   (atlas § 8)
7. Tap `VIEW OPPORTUNITY DETAILS` → Download Delivery gate (§ 9)
8. Tap `DOWNLOAD` → Deliver CCZ installs → Deliver-mode
   StandardHomeActivity (§ 10) with the `id/viewJobCard` widget

The opp-detail screen in Connect makes this explicit:

> "Once you have completed the learning assessment, you will
> transition to delivery."

This is intentional product behavior — Connect uses Learn completion
as a quality gate on FLWs before they can submit paid visits.

## Why this trapped Phase 6

Phase 6 (`app-screenshot-capture`) reads smoke recipes from Phase 3's
`app-test-cases.yaml`. The malaria-itn-app run's smoke set was:

```yaml
smoke_journeys_per_app:
  learn: 0   # No Phase 2 journeys target the Learn app
  deliver: 1
```

Phase 2 (`pdd-to-app-journeys`) had generated 9 journeys, all
targeting the Deliver app (V1/V2 field-visit flows). Phase 3 wrote
the master yaml with `learn: 0` (a known-incomplete state) and the
single Deliver smoke recipe (J1) used the Learn-side palette chain:

```
connect-login → connect-claim-opp → learn-launch → tap "V1 Long Visit"
```

`learn-launch.yaml` lands on the Learn suite root (the only thing
`Start` can target post-claim when training is incomplete), and the
"V1 Long Visit" text-match resolved against the Learn modules
("Module 1 - Malaria + ITN Basics", etc.), not the Deliver-side
"V1 — Identification and Consent" form. The recipe failed at the
final tap with `verdict: fail` and `recipe_failure_reason: "Maestro
could not find the text 'V1 Long Visit' in the suite root."`

The actual UI dump at failure confirmed `actionBar=Malaria ITN SBC
Training (Learn)` — the recipe was sitting in the Learn app, not
Deliver. That's not a recipe bug per se; it's a contract gap:

1. Phase 2 didn't emit a Learn smoke journey
2. Phase 3's pre-flight didn't halt on `learn: 0` (the rule was
   documented but the producer skill rationalized past it)
3. Phase 6's pre-flight didn't halt either (the rule was documented
   but the agent rationalized past it because the recipes were on
   disk)
4. The Deliver smoke recipe physically couldn't reach Deliver because
   Connect gates it behind Learn completion

## What changed (this PR)

1. **Phase 2 (`pdd-to-app-journeys`) coverage rules.** Added a fourth
   blocking rule: every PDD with a Learn app MUST emit a
   `training-completion-smoke` journey with `app: learn` and
   `is_smoke: true`. Deeper Learn journeys move to `/ace:qa-deep`.

2. **Phase 3 (`app-test-cases`) Step 2 + Step 5.** Codified the
   two-app coverage invariant: `smoke_journeys_per_app: {learn: 1,
   deliver: 1}` is mandatory for every two-app opp. Halt with a
   `[BLOCKER]` pointing at Phase 2 rather than writing `learn: 0`.
   Documented the faithful Deliver-smoke composition: walk all Learn
   modules to completion, sync, then chain `deliver-launch.yaml` to
   reach Deliver — there is no shortcut.

3. **Phase 6 (`app-screenshot-capture`) Step 2.** Strengthened the
   pre-flight commentary to make it harder for the agent to
   rationalize past a `learn: 0` count. The table itself was already
   correct; the table-driver was undisciplined.

4. **New static palette `deliver-launch.yaml`.** Drives the §§ 8/9/10
   transitions. Anchors on text labels at § 8 and § 9 (resource-IDs
   not yet captured live — palette includes coordinate fallbacks
   from the 2026-05-14 turmeric delivery-walk session). Lands on
   Deliver mode and assertion-anchors on `id/viewJobCard` (verified
   resource-ID per atlas § 10).

## Outstanding work (filed as follow-up)

- Atlas § 8 + § 9 resource-IDs are TBD. A future Phase 6 run mid-
  window between Learn-pass and Deliver-download will need to
  `ui_dump` these surfaces and back-fill `selectors/connect-2.62.0.yaml`.
- The "walk all Learn modules to completion" composition in Phase 3
  is currently described in prose, not codified as a generator. For
  multi-stage opps with 6+ modules, the Deliver smoke recipe ends up
  long — there's room for a `walk-learn-to-completion` helper palette
  that takes a manifest of module/form names and emits the linear
  walk. Defer until we have at least one passing multi-stage smoke
  to characterize the composition shape.

## How to verify

Re-run `/ace:step app-screenshot-capture malaria-itn-app/20260517-1829`
after the next `/ace:run` with these contracts in force. Expected:

- Phase 2 produces 10 journeys (9 Deliver + 1 Learn smoke)
- Phase 3 emits `smoke_journeys_per_app: {learn: 1, deliver: 1}` and
  the Deliver J1 recipe walks Learn to completion before tapping
  Deliver's V1 form
- Phase 6 captures Learn-app screenshots (Module 1 entry +
  assessment) AND Deliver-app screenshots (V1 form), producing a
  training deck with both apps' UX surfaces

## Related

- atlas `docs/mobile-atlas/connect-2.62.0.md` §§ 5, 6, 8, 8.5, 9, 10
- skill `skills/pdd-to-app-journeys/SKILL.md § Coverage rules` rule 4
- skill `skills/app-test-cases/SKILL.md § Step 2` + § Step 5
- skill `skills/app-screenshot-capture/SKILL.md § Step 2`
- palette `mcp/mobile/recipes/static/deliver-launch.yaml`
