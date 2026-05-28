# Phase 6 Learn/Deliver decoupling + Deliver-recipe hardening — design

**Status:** Design approved. Implementation plan pending.
**Date:** 2026-05-27
**Touches:** ACE plugin only — `skills/app-test-cases`, `skills/app-screenshot-capture`, `skills/training-deck-generate`, `agents/qa-and-training.md`, `agents/commcare-setup.md`, `lib/verdict-schema.ts`, `lib/phase-closeout.ts`, `templates/app-test-cases-template.yaml`, `mcp/mobile/recipes/static/`, `mcp/mobile/selectors/connect-2.63.0.yaml`, `mcp/mobile/recipe-sanity-probe.ts`, plus paired tests + the `CRISPR-Test-001` fixture.

## Motivation

On `leep-paint-collection` run `20260527-1528`, Phase 6 shipped a training deck with **no mobile app screenshots for Learn or Deliver**. Root cause traced across three layers:

1. **Phase 3 (`app-test-cases`) deferred the Deliver smoke (J2).** Connect gates the Deliver app behind Learn-assessment completion (`docs/learnings/2026-05-18-connect-gates-deliver-on-learn-completion.md`), so the current contract forces the Deliver smoke to re-walk **all of Learn** inside one ~60–80 step monolith, *or* halt the whole phase with a `[BLOCKER]`. Faced with that binary, the run's Phase 3 agent took the forbidden shortcut: shipped a login+claim scaffold + `composition_status: DEFERRED` (a field the skill explicitly bans).
2. **Phase 6 (`app-screenshot-capture`) is all-or-nothing.** It runs "Learn first, then Deliver" and halts on the first failing recipe. A deferred/broken Deliver leg therefore suppresses Learn capture too.
3. The combined effect surfaces as "one gigantic failure" with no per-app attribution, and (in this run) an operator-authorized whole-step skip.

The recipe filenames (`J1.yaml`, `J2.yaml`) are also opaque.

This design fixes all three layers plus naming.

## Decisions (locked with operator)

| # | Decision | Choice |
|---|---|---|
| 1 | Scope on the Deliver side | **Also harden Deliver authoring** (not just resilience) |
| 2 | Recipe naming convention | **`journey-learn` / `journey-deliver`** (app-prefixed, descriptive) |
| 3 | Behavior when a Deliver leg is missing/un-composable | **Per-app fail that blocks the phase** — Learn is captured first regardless; a Deliver gap is isolated and surfaced, and the phase does **not** get a clean pass |
| 4 | Deliver-leg ordering dependency on the Learn leg | **Accepted** — Deliver is no longer independently cold-runnable; runners execute Learn→Deliver in order within one dispatch |
| 5 | Live selector calibration of the post-Learn transition | **Do it end-to-end now** against a live AVD (option b) |

## Part 1 — Naming convention

Recipes become app-prefixed and descriptive, written to `3-commcare/recipes/`:

```
journey-learn.yaml            # the Learn smoke (is_smoke: true, app: learn)
journey-deliver.yaml          # the Deliver smoke (is_smoke: true, app: deliver)
journey-learn-<slug>.yaml     # additional non-smoke Learn journeys (qa-deep)
journey-deliver-<slug>.yaml   # additional non-smoke Deliver journeys
```

- `<slug>` derives from the journey title in `pdd-to-app-journeys.md` (kebab-case, deduped).
- The **one smoke per app** uses the bare `journey-learn.yaml` / `journey-deliver.yaml` name (no slug) — these are the canonical files Phase 6 reads.
- Screenshot folders mirror the recipe base name: `6-qa-and-training/screenshots/journey-learn/…`, `…/journey-deliver/…`.
- `takeScreenshot` labels mirror it: `journey-learn-module-list`, `journey-learn-quiz`, `journey-learn-complete`, `journey-deliver-first-form`, etc. (Drops the `sc-J<n>-` prefix.)
- `app-test-cases.yaml` keeps the stable internal `id: J<n>` field (traceability to the journeys doc + ordering) but `recipe_path` now points at the descriptive filename. So the master yaml is the id↔recipe map; filenames are human-readable.

The deep `app-ux-eval` rubric grades the final screenshot of each journey; it must key on the new label (`journey-<app>-final` or the per-journey base name) rather than `sc-J<n>-final`.

## Part 2 — Decouple capture into two independent legs

`app-screenshot-capture` Step 5 stops being one halt-on-first-failure loop. New shape:

1. **Learn leg (always runs first).** Run `journey-learn.yaml` to completion against the AVD. Upload every screenshot it reaches. Determine `learn` outcome independently. A Learn failure records a Learn sub-verdict and does not abort the dispatch — the Deliver leg is then unrunnable (gate), but that's recorded, not crashed.
2. **Deliver leg (runs second, depends on Learn completion).** Only attempt if the Learn leg reached completion (Connect's gate is satisfied). Run `journey-deliver.yaml`, which **resumes from the now-unlocked state** (see Part 4) within the same device session. Upload screenshots. Determine `deliver` outcome independently.

The two legs' outcomes are independent records. Learn screenshots always ship to the deck even when Deliver breaks.

## Part 3 — Per-app verdict + failure policy

`lib/verdict-schema.ts` already has `per_item: [{ ref, score, verdict, note }]`. We make it the load-bearing carrier of per-app outcomes. `app-screenshot-capture` writes `per_item` with `ref: learn` and `ref: deliver`, each `verdict: pass | fail | incomplete`.

Top-level verdict mapping (the "per-app fail, phase blocks" policy):

| Learn leg | Deliver leg | Top-level `verdict` | Phase proceeds clean? | Deck content |
|---|---|---|---|---|
| pass | pass | `pass` | yes | Learn + Deliver shots |
| pass | fail (recipe ran, broke) | `fail` | **no — blocks** | Learn shots + Deliver placeholder + named remediation |
| pass | incomplete (recipe missing/scaffold) | `incomplete` | **no — blocks** | Learn shots + Deliver placeholder + `/ace:step app-test-cases` remediation |
| fail | blocked-by-learn (gate unmet) | `fail` | **no — blocks** | partial Learn shots; Deliver `note: blocked — Learn did not complete` |
| incomplete (recipe missing) | incomplete | `incomplete` | **no — blocks** | common-pool only |

Key invariants:
- A non-pass top-level verdict still ships whatever Learn screenshots were captured — failure is **attributed to a specific leg**, never a generic "smoke failed."
- `verdict: fail` keeps `severity: BLOCKER` semantics for AVD/Maestro-health failures (unchanged from current rules). Upstream-gap (missing recipe) stays `incomplete`, not `fail`.
- Operator-authorized whole-step skip remains a separate explicit escape (what the leep run used) and is unchanged.

The shallow smoke-judge verdict keeps its existing per-app `per_item` shape.

## Part 4 — Harden Deliver authoring (the real J2 fix)

Replace the "Deliver smoke re-walks all of Learn in one monolith, or BLOCKER" rule with a **two-recipe split that shares device state**:

- **`journey-learn.yaml` walks Learn to completion.** This both (a) produces the Learn training screenshots we want (module list → content → quiz → completion/certificate) and (b) unlocks Deliver as a side effect. The Learn smoke is therefore a *complete* walk, not a thin land-at-M1 walk.
- **`journey-deliver.yaml` resumes from the unlocked state** within the same dispatch's device session: Resume the opp → certificate (atlas §8) → VIEW OPPORTUNITY DETAILS → Download gate (§9) → DOWNLOAD → Deliver `StandardHomeActivity` (§10) → Start → Deliver `MenuActivity` (§11) → first Deliver form → screenshot. ~12 steps, no Learn duplication.

Consequences:
- `app-test-cases` can now compose a faithful Deliver smoke in the common case, so the `[BLOCKER]`-or-monolith binary is gone. The hard `[BLOCKER]` is retained only for genuinely un-composable structures (e.g., Learn blueprint missing expected modules). The `composition_status` escape stays banned.
- The Deliver recipe assumes warm state from the immediately-preceding Learn leg in the same dispatch (Connect session persists; no re-login). This is the accepted ordering dependency (Decision 4). The recipe header comment must state this assumption.
- `mcp/mobile/recipes/static/deliver-launch.yaml` is the palette entry for the post-Learn transition. Its certificate + download-gate steps are **coordinate-fallback-only today**.

### Live selector calibration (Decision 5)

The certificate and Download-Delivery-gate screens currently lack stable resource-IDs in `mcp/mobile/selectors/connect-2.63.0.yaml`. Calibration requires a **live AVD dump captured mid-window** — after Learn passes and before Deliver downloads — on a real opp claim. Procedure:

1. Bootstrap/verify the AVD (`mobile_ensure_avd_running`), claim the existing `leep-paint-collection` run `20260527-1528` opp (test user `+74260000101`, already invited).
2. Run `journey-learn.yaml` to completion.
3. At the certificate screen and the Download gate, capture `mobile_capture_ui_dump` and harvest stable resource-IDs.
4. Add the calibrated logical-selector rows to `connect-2.63.0.yaml`; replace the coordinate fallbacks in `deliver-launch.yaml`.
5. Re-run `journey-deliver.yaml` to verify it reaches the first Deliver form, capturing real screenshots.

This is the one piece that cannot be verified statically. Everything else (composition logic, naming, decoupling, verdict model, contracts) is verifiable via `mobile_validate_recipe` lint + `mobile_resolve_selectors` + unit tests.

## File-by-file changes

- **`skills/app-test-cases/SKILL.md`** — naming convention (§3 + §Products + §5); replace the Deliver-smoke "monolith-or-BLOCKER" composition rule (§2) with the Learn-to-completion + Deliver-resume split; Learn smoke is now a full walk; keep the `composition_status` ban; update the two-app coverage invariant wording.
- **`skills/app-screenshot-capture/SKILL.md`** — Step 5 two-leg structure; per-app verdict mapping (Part 3 table); Learn-always-first; Deliver ordering dependency; new paths/labels; verdict examples.
- **`skills/training-deck-generate/SKILL.md`** — consume `screenshots/journey-learn/` + `journey-deliver/` dirs; handle Learn-present/Deliver-missing partial gracefully (placeholders for the missing app).
- **`agents/qa-and-training.md`** — pre-flight recipe-presence check becomes per-app (Learn recipe present else Learn-incomplete; Deliver missing → Deliver-incomplete but still run Learn); failure-policy wording; paths.
- **`agents/commcare-setup.md`** — recipe-path references updated to new names.
- **`lib/verdict-schema.ts`** — no schema change required (`per_item` already supports it); add a doc comment naming `learn`/`deliver` as the canonical `ref` values for this skill. No new helper unless PR 2 surfaces real duplication.
- **`lib/phase-closeout.ts`** + `test/lib/phase-closeout.test.ts` — update any recipe-name / screenshot-path assertions.
- **`templates/app-test-cases-template.yaml`** — `recipe_path` examples to new names.
- **`mcp/mobile/recipes/static/deliver-launch.yaml`** — finalize post-Learn transition; swap coordinate fallbacks for calibrated selectors. Possibly a small `learn-complete-walk` helper if composition is cleaner factored out.
- **`mcp/mobile/selectors/connect-2.63.0.yaml`** — add calibrated certificate + download-gate rows (LIVE).
- **`mcp/mobile/recipe-sanity-probe.ts`** + `test/mcp/mobile/recipe-sanity-probe.test.ts` — add a check that the Deliver smoke does **not** contain a full Learn re-walk (anti-monolith), and that Learn/Deliver legs are named per convention.
- **`test/fixtures/CRISPR-Test-001/3-commcare/app-test-cases.yaml`** — rename `recipe_path` values.
- **`test/mcp/mobile/static-palette-health.test.ts`** — palette additions parse + lint + selectors resolve.

## Staged PR plan

Per the staged-PR convention (one batch per PR, merge before the next):

- **PR 1 — Naming convention.** Rename `J<n>.yaml` → `journey-<app>[-<slug>].yaml` across skill docs, agent docs, template, fixture, and `phase-closeout` + tests. Mechanical, lowest risk. No behavior change.
- **PR 2 — Decoupling + per-app verdicts + failure policy.** `app-screenshot-capture` two-leg structure, per-app verdict mapping, `qa-and-training` per-app pre-flight, `training-deck-generate` partial handling, verdict-schema doc + tests.
- **PR 3 — Deliver authoring hardening.** `app-test-cases` Learn-to-completion + Deliver-resume split, `deliver-launch.yaml` finalize, **live selector calibration** of `connect-2.63.0.yaml`, recipe-sanity anti-monolith check, end-to-end verification on the AVD against the leep opp.

Each PR bumps VERSION via `scripts/version-bump.sh`, ships via auto-merge, and is followed by `/ace:update` in-session. PR 3 additionally requires a Claude restart if the calibration touches MCP-bound selector loading (verify whether selector maps are read at subprocess start).

## Testing

- **Static (PR 1–2):** `npm test` — recipe-sanity-probe, static-palette-health, phase-closeout, artifact-manifest fixtures, skill-atom-references.
- **Recipe-level (PR 3):** `mobile_validate_recipe` + `mobile_resolve_selectors` (`unresolved: []`) on both smoke recipes.
- **Live E2E (PR 3, the calibration run):** Learn-to-completion → certificate/download-gate dump → Deliver-resume → first Deliver form, against `leep-paint-collection/20260527-1528`. Produces real `journey-learn/` + `journey-deliver/` screenshots and a `pass` per-app verdict — the acceptance evidence.

## Risks & open questions

- **Heavier Learn smoke.** Making the Learn smoke a full walk-to-completion adds AVD wall-clock (~several min for 6 modules + quizzes). Accepted: Deliver requires Learn completion regardless, and incremental capture means a mid-walk Learn failure still yields partial Learn shots + "failed at module N" attribution.
- **Live calibration dependency.** PR 3's calibration needs a healthy AVD + a claimable opp. If the AVD is unavailable on the implementing machine, PR 3 splits: static composition lands first; calibration + E2E verification follows on an AVD-enabled run. (Decision 5 is to attempt the full E2E now.)
- **Selector-map staleness across APK versions.** Calibration targets `connect-2.63.0.yaml` (current default per recipe-sanity notes). If the active APK differs, copy-and-calibrate the matching version map.
- **`app-ux-eval` label coupling.** Confirm the deep UX-eval keys on the new screenshot labels, not `sc-J<n>-final`, before relying on qa-deep gating.
