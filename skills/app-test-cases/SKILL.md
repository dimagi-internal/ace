---
name: app-test-cases
description: >
  Bind each PDD user journey to the Nova-built app structure and emit a
  Maestro recipe per journey with real selectors. Use after Nova
  finishes building, before app-release.
disable-model-invocation: false
---

# App Test Cases

Binds Phase 1 UX intent to Phase 3 built structure. Runs after Nova
finishes both apps, before `app-release` — so the recipes exist when
Phase 6 needs them.

## Related skills

- **Successor to:** `qa-plan` (retired in 0.10.x, replaced by this skill).
- **Consumes:** `pdd-to-app-journeys.md` from `pdd-to-app-journeys` (Phase 1).
- **Consumed by:** `app-screenshot-capture` (Phase 6, shallow) and
  `/ace:qa-deep` (full execution).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `2-scenarios/pdd-to-app-journeys.md` | journey list + persona + per-journey pass criteria |
| Phase 3 | `3-commcare/pdd-to-learn-app_summary.md` and `pdd-to-deliver-app_summary.md` | nova_app_id per app |
| Nova MCP | `get_app({app_id: <nova_app_id>})` | authoritative form/field IDs to resolve into real Maestro selectors |
| Static | `mcp/mobile/recipes/static/` | recipe palette / templates |
| **Atlas** | `docs/mobile-atlas/connect-2.62.0.md` | **ground-truth navigation map for every Connect-side surface.** Use it as the authoritative reference for screen IDs, transitions, and selector behavior — DO NOT improvise selectors that contradict the atlas. |

## Products

- `3-commcare/app-test-cases.yaml` — the full journey **catalog**: per-journey test entries for EVERY journey (smoke + deep), one per journey, exactly one `is_smoke: true` per app. The catalog documents the intended coverage; it lists every journey regardless of whether its recipe file exists yet.
- `3-commcare/recipes/journey-<app>[-<slug>].yaml` — a Maestro recipe **only for the `is_smoke: true` journeys** (the two smokes: `journey-learn-pass` → `journey-learn.yaml`, `journey-deliver-submit` → `journey-deliver.yaml`). The single `is_smoke: true` journey per app uses the bare name (`journey-learn.yaml`, `journey-deliver.yaml`). Each journey's `id` in `app-test-cases.yaml` is a meaningful `journey-`-prefixed kebab-case slug (`journey-learn-pass`, `journey-deliver-submit`) — see § Journey id convention; for a smoke journey, `recipe:` points at the descriptive file.

**Deep recipes are generated lazily — NOT at Phase 3.** Phase 6 (shallow, inside `/ace:run`) only ever walks the `is_smoke: true` journeys, one per app. The non-smoke (deep) journeys are consumed exclusively by `/ace:qa-deep`, which is a manual gate that is frequently not run. Authoring + persisting a Maestro recipe for every deep journey up front is therefore wasted work + clutter. So:

- This skill writes recipe files **only** for the smoke journeys.
- For every non-smoke (deep) journey, the catalog entry's `recipe:` value is the literal string `deferred` (NOT a path). `/ace:qa-deep` generates the missing deep recipes on demand — using the SAME composition rules in this SKILL.md (static palette + live `get_form` labels + selector-resolution gate) — the first time it runs against the run, because the Nova `app_id` and `get_form` still return the as-built app structure within a run (the "author before app-release freezes it" concern does not apply within a single run). See `commands/qa-deep.md § Stage B`. This is tracked as jjackson/ace#605.

### Journey id convention

Each journey's `id` is a **`journey-`-prefixed, meaningful kebab-case slug
derived from the journey's intent** — NOT a cryptic `J<n>` ordinal. The
form is `journey-<app>-<intent>`: the `id` **MUST begin with the literal
prefix `journey-`**, then the app (`learn` or `deliver`), then a short
kebab-case intent slug. The slug must be unique within the opp and stable
across re-runs. The `journey-` prefix makes the id self-describing
wherever it is listed — run artifacts, dashboards, screenshot labels,
smoke-subset lists, and verdicts all read meaningfully.

Canonical examples (use these verbatim when the journey matches; coin a
new intent-derived slug otherwise):

| `id` | What it covers |
|---|---|
| `journey-learn-pass` | Learn smoke — walk all modules + pass the final assessment first try |
| `journey-learn-retry` | answer a quiz question wrong, then retry and pass |
| `journey-deliver-submit` | Deliver smoke — a positive/eligible service-delivery visit |
| `journey-deliver-alt-answer` | a negative/ineligible visit (the "No" branch) |
| `journey-deliver-multiple` | multiple visits in one session (multi-stage archetype) |
| `journey-deliver-locked` | confirm Deliver is locked until Learn is complete |

Rules:
- The `id` always starts with the literal `journey-` prefix, then the
  app (`learn` / `deliver`), so both the journey-ness and the app
  membership are legible from the id alone.
- The `is_smoke: true` journey per app conventionally uses the simplest
  happy-path slug (`journey-learn-pass` for Learn,
  `journey-deliver-submit` for Deliver).
- Keep slugs ≤ ~40 chars, lowercase, hyphen-separated, no spaces.
- Slugs are derived from the journey's intent (the journey `name` /
  goal in `pdd-to-app-journeys.md`), not from ordinal position.

**Filename vs id — related but NOT identical.** The recipe *filenames*
stay `journey-<app>[-<slug>].yaml`, and the smoke recipes use the bare
`journey-learn.yaml` / `journey-deliver.yaml` (they do NOT get an extra
`journey-` — they already start with it). The *id* is the fuller
`journey-<app>-<intent>` form (e.g. id `journey-learn-pass` →
recipe `journey-learn.yaml`; id `journey-deliver-submit` → recipe
`journey-deliver.yaml`). Filename and id share the `journey-` prefix but
are otherwise distinct — do NOT assume they must match exactly.

## Process

### Step 1: Read inputs

- `pdd-to-app-journeys.md`
- `app-summaries/learn-app-summary.md`
- `app-summaries/deliver-app-summary.md`
- The Nova blueprints (call `get_app` with each
  app id) for real form/field IDs
- The static-recipe library at `mcp/mobile/recipes/static/`

### Step 2: For each journey, decide its app + smoke flag

Map each journey from `pdd-to-app-journeys.md` to either Learn or Deliver
based on whether the journey describes assessment behavior (Learn) or
visit/delivery behavior (Deliver). Multi-stage opps may have both.

**Smoke flag rules:**
- Exactly ONE journey per app gets `is_smoke: true`
- The smoke journey is the simplest happy-path that exercises the
  app's primary submission/completion flow
- If two journeys could plausibly be the smoke, pick the one with the
  smallest `pdd_time_budget_seconds`

**Two-app coverage is REQUIRED.** Every PDD with both a Learn and a
Deliver app (every archetype except a hypothetical Learn-less mode)
MUST emit one `is_smoke: true` journey per app — Phase 6 reads BOTH
smokes to capture training-deck screenshots of each app. If
`pdd-to-app-journeys` did not produce a Learn-app journey, halt with
a structured error pointing at Phase 2 (`pdd-to-app-journeys`) rather
than writing `smoke_journeys_per_app.learn: 0` — the upstream coverage
rule (added 2026-05-18) requires the Learn smoke. The
`smoke_journeys_per_app: {learn: 1, deliver: 1}` invariant is
load-bearing for Phase 6's pre-flight; emitting `learn: 0` produces a
silent downstream halt at Phase 6 (see malaria-itn-app
run 20260517-1829 for the canonical incident).

**Deliver-smoke composition — Learn leg completes Learn, Deliver leg
resumes.** Connect gates the Deliver app behind Learn-assessment
completion (`docs/learnings/2026-05-18-connect-gates-deliver-on-learn-completion.md`).
Rather than re-walk Learn inside the Deliver recipe (the old ~80-step
monolith that was fragile and got deferred — leep 20260527 J2), the
two smoke recipes share device state within one Phase 6 dispatch:

- **`journey-learn.yaml` walks Learn to completion.** All modules
  (content form + assessment per module) through the final
  assessment-pass + sync. This both produces the Learn training
  screenshots (module list → content → quiz → completion/certificate)
  AND unlocks Deliver as a side effect. The Learn smoke is a *complete*
  walk, not a land-at-M1 thin walk.
- **`journey-deliver.yaml` resumes from the unlocked state.** It assumes
  the immediately-preceding `journey-learn` leg (same dispatch, warm
  session) completed Learn. Compose it from the static palette:
  `runFlow: connect-resume-opp.yaml` (opp list → Resume the In-Progress
  card; also backs out of the post-Learn CommCare home to the Connect
  jobs list — #618) → `runFlow: deliver-launch.yaml` (certificate/
  opp-detail → Download gate → Deliver home `viewJobCard`, ID-anchored in
  `connect-2.63.0.yaml`) → `runFlow: deliver-form-walk.yaml` (3-level
  Deliver menu: Start → module list → module row → form list → form row →
  first form question) → answer the journey's question(s) → `runFlow:
  form-submit.yaml`. ~12 steps, NO Learn duplication.

  **Menu-row taps use `id: org.commcare.dalvik:id/row_txt`, NOT
  `text: "<label>"`.** A `text:` match hits the non-clickable action-bar
  title (same label) first in document order, so the tap is a silent
  no-op (validated live, bednet-spot-check/20260602-1345 deliver-leg pass).
  `deliver-form-walk.yaml` already encodes this; if you ever inline a
  menu-row tap instead of composing the palette recipe, use `row_txt` —
  same as the Learn side's `learn-tap-module.yaml`.

State the warm-state dependency in `journey-deliver.yaml`'s header
comment: it is NOT independently cold-runnable; runners execute
journey-learn → journey-deliver in order.

**The `composition_status` escape stays banned.** Do NOT write
`composition_status: <anything>` on any `is_smoke: true` journey — its
presence is a contract violation (it self-declares a known-broken
recipe). With the Learn-completes / Deliver-resumes split, the common
case IS composable, so the old "monolith or BLOCKER" binary is gone.

Halt with a `[BLOCKER]` only when the structure genuinely can't be
composed — e.g. the Learn blueprint is missing the modules the walk
needs, or `deliver-launch.yaml`'s anchors don't resolve against the
active selector map. A `journey-deliver.yaml` that re-walks Learn
(`learn-launch` or ≥2 `learn-tap-module`) is rejected by the
`deliver-smoke-rewalks-learn` recipe-sanity check (Step 3.4-adjacent) —
re-compose it as resume-only.

Caught in vivo on malaria-itn-app run 20260517-1829 (the second time —
PR #354 fixed the Phase 6 pre-flight; the composition contract change
here closes the upstream Phase 3 escape that produced the legacy recipe
in the first place). With the split model, composition is the default
path; Defer only by halting with a `[BLOCKER]`; never by writing a
known-broken recipe.

### Step 3: For the SMOKE journeys, compose the Maestro recipe

**Compose recipes ONLY for the `is_smoke: true` journeys** (the two
smokes: `journey-learn-pass` → `journey-learn.yaml`,
`journey-deliver-submit` → `journey-deliver.yaml`). For every non-smoke
(deep) journey, do NOT author a recipe file at Phase 3 — set the catalog
entry's `recipe: deferred` instead (see § Products and Step 4). The
composition rules below apply to the smoke recipes; `/ace:qa-deep` reuses
these exact rules to generate the deferred deep recipes on demand.

Compose each smoke recipe using the static palette pattern (one Maestro
step per UI interaction, with `${SELECTOR:logical-name}`
placeholders resolved at write time, and `takeScreenshot` calls
between major form sections):

- Recipes are named by app + intent, not journey-id: `journey-learn.yaml` / `journey-deliver.yaml` for the smokes, `journey-<app>-<slug>.yaml` for the (lazily-generated) deep recipes. The journey `id` (a `journey-`-prefixed meaningful kebab-case slug like `journey-learn-pass` / `journey-deliver-submit` — see § Journey id convention) lives in `app-test-cases.yaml`, not the filename.
- Each journey's recipe MUST include a final `takeScreenshot: "<recipe-base>-final"` (e.g. `journey-learn-final`, `journey-deliver-final`) for the deep UX judge to grade
- Resolve any `${SELECTOR:logical-name}` placeholders via
  `mobile_resolve_selectors` against the current APK selector map
  before validating (see Step 3.4 below — selector-resolution is a
  fail-loud gate, not just a substitution pass)
- Validate via `mobile_validate_recipe` before writing

#### Maestro inputText: scalar vs mapping form

`inputText` has two valid shapes — pick the right one based on
whether you need any options:

```yaml
# Scalar form — text only, no options
- inputText: "Apcolite Stores"

# Mapping form — REQUIRED when you need any inputText option
# (optional, label, id, point, etc.)
- inputText:
    text: "Apcolite Stores"
    optional: true
```

The combination that **does not parse** is the scalar form with
a sibling option key under the same list item:

```yaml
- inputText: "Apcolite Stores"
    optional: true            # ← Maestro rejects this at parse time
```

This is invalid YAML — the `-` opens a list item that's *both* a
scalar (`inputText: "..."`) and a mapping (`optional: true`).
Maestro's parser surfaces it as:
`expected <block end>, but found '<block mapping start>'`.

The same rule applies to every Maestro command that has both a
scalar and a mapping form (`tapOn`, `assertVisible`,
`extendedWaitUntil`, etc.): use the mapping form whenever you need
*any* option beyond the bare value.

Caught in vivo on leep Phase 6 attempt 8 (2026-05-12) — the Learn
smoke recipe (`journey-learn.yaml`, id `journey-learn-pass`)
emitted the broken sibling form, Phase 6 halted, the cloud
emulator stack returned a full structured error envelope with the
Maestro parse-error frame which named this exact pattern.

#### Entry-point template — Connect-integrated flow

ACE-Phase-5 recipes drive a CommCare install that's **Connect-
integrated**, not standalone. The post-`launchApp` surface on
CommCare 2.62.0 is `screen_first_start_main` (Welcome to CommCare)
with buttons like `GO TO CONNECT MENU`, `Scan Barcode`,
`Enter Code` — there is **no app-name tile** to tap. Apps reach
the device via Connect's claim → Start workflow.

The mistake to avoid (caught on leep Phase 5 attempt 10):

```yaml
# WRONG — assumes the standalone-CommCare model, which doesn't exist
- launchApp
- tapOn:
    text: "ACE - LEEP Paint Surveillance - Deliver"   # ← no such tile
```

Right pattern: chain the static palette to land at the per-journey
form, then add journey-specific steps:

```yaml
# RIGHT — composes the static palette
appId: org.commcare.dalvik
---
# (a) Connect login, navigates to Opportunities home
- runFlow:
    file: connect-login.yaml
# (b) For each opp's first journey, claim+Start the opp once
- runFlow:
    file: connect-claim-opp.yaml
    env:
      OPP_NAME: ${OPP_NAME}
# (c) For Learn journeys: learn-launch.yaml lands on the Learn suite root.
#     Walk all Learn modules to completion (all content forms + assessments)
#     through the final assessment-pass + sync. This is a complete walk,
#     not a thin land-at-M1 walk — it both produces Learn screenshots and
#     unlocks the Deliver app as a side effect.
#
#     For Deliver journeys: `journey-deliver.yaml` resumes from the
#     unlocked state (warm session, journey-learn leg just completed).
#     Do NOT re-walk Learn inside the Deliver recipe — use the split:
#       connect-resume-opp.yaml  (opp-list → tap Resume → cert/opp-detail)
#       runFlow: deliver-launch.yaml  (cert → Download gate → Deliver home)
#       … first Deliver module + form screenshot
#     The Deliver recipe is NOT independently cold-runnable; state the
#     warm-state dependency in the YAML header comment.
- runFlow:
    file: learn-launch.yaml
# ... journey-specific module/form steps below, using live labels
#     from Nova get_form (see "Use live labels" section below)
- takeScreenshot: "journey-learn-final"
```

The static palette lives at `mcp/mobile/recipes/static/`:
- `connect-login.yaml` — splash → nav drawer → Sign In → Opportunities home
- `connect-claim-opp.yaml` — opp-list → tap opp's View Opportunity button (scoped by `below: text`) → Start → handoff to StandardHomeActivity
- `learn-launch.yaml` — post-claim StandardHomeActivity (Start tile) → MenuActivity suite root
- `learn-tap-module.yaml` — MenuActivity row tap (generic — handles ANY level of the 3-level suite tree)
- `form-advance.yaml` — `nav_btn_next` ImageButton tap (NOT text-match "Next" — see atlas §7)
- `form-submit.yaml` — branched: explicit Submit button if visible, otherwise auto-finalize via `nav_btn_next`
- `content-form-finish.yaml` — **the canonical Learn CONTENT-form finalize.** A bounded multi-screen advance loop that taps `nav_btn_next` until the form auto-finalizes back to StandardHomeActivity, exits on the `learn-home-start-tile` home anchor (NOT the suite menu), handles the score-gated two-screen FINISH, and asserts the home grid post-finalize. Use this for every label-only content/lesson form — NOT for required-input quizzes (those still need per-field answer-taps + `form-advance` + `form-submit`). Requires `SCREENSHOT_NAME`. See § Multi-screen content forms below.
- `learn-suite-reentry.yaml` — **the between-modules suite re-entry.** Tap the home Start tile → wait `screen_suite_menu_list`. A Learn form finalizes to StandardHomeActivity (the home grid), NOT to the suite menu, so this MUST run after each module's form-finalize and before the next module's `learn-tap-module`. Same surface contract as `learn-launch.yaml` (the first, post-claim suite entry); split out under a distinct name to document the between-modules intent at the call site. See § Suite re-entry between modules below.
- `connect-resume-opp.yaml` — opp-list → scroll to the target opp's In-Progress card → tap Resume → lands on the certificate/opp-detail surface (atlas § 8) that `deliver-launch.yaml` expects. Pre-state: Connect opp-list visible, opp already Learn-in-progress or complete. Warm-session only (journey-learn leg completed Learn in this dispatch). Requires `OPP_NAME` env var (same value as `connect-claim-opp.yaml`).
- `deliver-launch.yaml` — post-Learn-complete certificate (atlas § 8) → tap VIEW OPPORTUNITY DETAILS → Download Delivery gate (§ 9) → tap DOWNLOAD → Deliver-mode StandardHomeActivity (§ 10) anchored on `id/viewJobCard`. All surfaces ID-anchored (verified 2026-05-26 against bednet J2 dumps; no coordinate fallbacks). Chain after `connect-resume-opp.yaml` in the Deliver smoke recipe.

**CRITICAL — Learn-app navigation is 2 menu levels deep.** After `learn-launch.yaml` lands you on the module list (atlas §6a), reaching a form means drilling two levels:

1. Tap module-list row (e.g. `"1. Survey Background & Adulteration Basics"`) → drills 6a → 6b (form list).
2. Open the form-list row (e.g. `"Background & Adulteration Basics"` for the lesson, or `"Module 1 Quiz"` for the quiz) → launches FormEntryActivity (6b → §7).

**Pass BOTH `MODULE_NAME` and `FORM_NAME` to a SINGLE `learn-tap-module` invocation.** `learn-tap-module` is robust to all three landing states in one call:

- **Auto-skip** (module-name != form-name, CommCare skips the one-row list) → lands directly on the form; no further action.
- **Same-name intermediate list** (module-name == form-name) → Branch B taps the one row by `${MODULE_NAME}` to open the form.
- **Distinct-form-name intermediate list** (module-name != form-name, CommCare does NOT auto-skip) → Branch C taps the form row by `${FORM_NAME}` to open the form.

The single-call form is the canonical pattern. (The legacy two-call drill — one `learn-tap-module` with the module name, then a second with the form name — still works because `FORM_NAME` is optional, but prefer the single call: it removes the authoring guess about whether CommCare will auto-skip, which was the malaria-itn-app/20260528-1607 Phase 6 halt class.)

Earlier-authored recipes that fired only ONE module-level `learn-tap-module` (no `FORM_NAME`) and then immediately tapped a form-internal option landed on the form LIST, not the form — the form-internal `tapOn` then found no target and hard-failed with `selector-not-found`. This is exactly the malaria-itn-app/20260528-1607 halt: module "Visit Purpose & Ethics" → form "Purpose, Consent & Do-No-Harm" (distinct, descriptive names — good authoring), CommCare left the device on the one-row form-list, and the recipe assumed it was already inside the form. Passing `FORM_NAME` in the single call (Branch C) opens the form structurally. (Also verified live on turmeric run 20260513-2243 retry #4 for the no-second-tap class — see atlas §6.)

For the canonical Learn-app smoke recipe template:

```yaml
- runFlow:
    file: learn-launch.yaml
# Drill from module list to the target form in ONE call — learn-tap-module
# opens the form whether CommCare auto-skips, shows a same-name one-row
# list, or shows a distinct-form-name one-row list.
- runFlow:
    file: learn-tap-module.yaml
    env:
      MODULE_NAME: "1. Survey Background & Adulteration Basics"  # the module-list row
      FORM_NAME: "Background & Adulteration Basics"              # the form (lesson) row, or "Module 1 Quiz"
# Now on FormEntryActivity for that form.
- tapOn:
    ${SELECTOR:form-nav-next}
# ... rest of form-question handling
```

Read live module + form names from Nova's `get_form` per the "Use live labels" section below — the pre-claim teaser at `tv_learn_modules_list` lists module names verbatim, but form names inside each module are only visible via Nova. `FORM_NAME` MUST be the form's live `label` from `get_form` (verbatim), not the PDD-brief name.

##### Multi-screen content forms — use `content-form-finish.yaml`

**Learn CONTENT forms are paginated, multi-screen, and label-only — walk
each one with `content-form-finish.yaml`, NOT a single `form-submit.yaml`.**
A Learn content/lesson form (e.g. "Program Orientation", "Identifying RDTs",
"Photo Protocol") is a multi-screen form: the first screen shows BOTH
`nav_btn_prev` and `nav_btn_next` and the progress bar is not full. A single
`form-submit.yaml` (one `nav_btn_next` tap) advances exactly ONE page and
then looks for FINISH — so it **stalls on page 2 of the first content form**,
and the next `learn-tap-module` hard-fails asserting `screen_suite_menu_list`.
This was the malaria-rdt/20260601-0929 Phase 6 Learn-walk blocker
(jjackson/ace#646).

`content-form-finish.yaml` is the class-level fix: a bounded multi-screen
advance loop that taps `nav_btn_next` until the form auto-finalizes, then
**exits on the StandardHomeActivity home anchor (`learn-home-start-tile`),
NOT on the suite menu.** Learn forms finalize back to the home grid (Start /
View Job Status / Sync / Log out, "1 form sent to server!"), not to
`screen_suite_menu_list` — so an advance loop keyed on the suite menu as its
exit never fires and spins past finalize into a maestro-process timeout
(observed live). The recipe also handles the score-gated two-screen FINISH
(#569) and asserts the home grid post-finalize so any miss fails loud with a
named anchor.

Call it once per content form (pass `SCREENSHOT_NAME`):

```yaml
- runFlow:
    file: learn-tap-module.yaml
    env:
      MODULE_NAME: "1. Program Orientation"
      FORM_NAME: "Program Orientation"
- runFlow:
    file: content-form-finish.yaml
    env:
      SCREENSHOT_NAME: "journey-learn-m0-orientation-finished"
# device is now back on StandardHomeActivity home — re-enter the suite
# before the next module (see § Suite re-entry between modules).
- runFlow:
    file: learn-suite-reentry.yaml
```

Do NOT hand-chain `form-advance.yaml` + `form-submit.yaml` for content
forms — `content-form-finish.yaml` subsumes both the single-screen and the
multi-screen cases (the bounded loop no-ops its remaining advances once the
form auto-finalizes on its only/last screen). Reserve explicit
`form-advance` → answer-tap → `form-submit` sequencing for QUIZ /
assessment forms with required inputs (per the MANDATORY answer-tap rule
below) — `content-form-finish.yaml` deliberately does NOT select answers and
would stall on `warning_root` ("Sorry, this response is required!") if
pointed at a required-input quiz. Historical context: the single-screen
over-step on bednet-spot-check run 20260528-0556 Phase 6 (a `form-advance` +
`form-submit` over a one-screen "Introduction" form) is also subsumed —
`content-form-finish.yaml` handles one-screen and N-screen content forms
under one contract.

##### Suite re-entry between modules — use `learn-suite-reentry.yaml`

**A Learn form finalizes to StandardHomeActivity (the home grid), NOT to the
suite menu — so you MUST re-enter the suite between every module.** After a
module's form finalizes, the device is on the home tiles (Start / View Job
Status / Sync / Log out), not on `screen_suite_menu_list`. The next
`learn-tap-module` asserts `screen_suite_menu_list` as its pre-state and
hard-fails if called directly from the home grid (jjackson/ace#646 Gap 2).

Run `learn-suite-reentry.yaml` (tap Start → wait `screen_suite_menu_list`)
after each module's form-finalize and before the next module's
`learn-tap-module`. The per-module loop is therefore:

```
learn-tap-module → content-form-finish (or quiz answer-taps + form-submit)
                 → learn-suite-reentry → (next module's learn-tap-module)
```

The FIRST suite entry (post-claim) still uses `learn-launch.yaml`; every
subsequent re-entry uses `learn-suite-reentry.yaml`. They share the same
home-grid → suite-menu contract.

**Use the atlas (`docs/mobile-atlas/connect-2.62.0.md`) to verify each
transition you author.** Each section of the atlas documents one
screen with its stable resource-ids, the transitions out of it, and
side-effects (system prompts, network calls, screen replacements). If
a recipe needs a transition the atlas doesn't document, that's a gap
in the atlas — flag it in the recipe header comment AND in the atlas's
"Open questions" list for the next walk.

Each `is_smoke=true` journey's recipe **must** include the Connect-
login + opp-claim prefix so it can run from a cold boot (the cloud
backend's standard state). Non-smoke journeys can assume warm state
and skip the prefix — but flag that assumption in the YAML header
comment so a reviewer doesn't try to run them cold.

Caught in vivo on leep Phase 5 attempt 10 (2026-05-13). Before this
guidance landed, the smoke recipes (`journey-learn.yaml` /
`journey-deliver.yaml`) emitted the broken `launchApp +
tapOn:<app-name>` model, the live `tapOn` never found a target, and
the recipes failed with selector-miss errors — even though the
emulator + Maestro + cloud-stack were healthy.

#### Maestro feature-compat — local vs cloud parity

As of 2026-05-19, **both backends run Maestro on the v2.x line**
(local: v2.5.1 via the official installer; cloud AMI: v2.5.1 pinned
in `infra/mobile-ami/scripts/30-maestro.sh`). The lag table below
documents the historical drift class — it's NOT currently active.
Re-baseline if the versions ever diverge again (track local via
`maestro --version`, cloud via `ACE_MOBILE_AMI_VERSION`):

| Property | Local AVD | Cloud |
|---|---|---|
| `visibilityPercentage` | works | **historically rejected with `Unknown Property` on the v1.36-era AMI** |
| `point: "x,y"` | works | works |
| `id:` matcher | works | works |
| `text:` matcher | works | works |
| `index:` for multi-match | works | works |
| `optional: true` (under mapping form) | works | works |

Origin: leep Phase 5 attempt 10 — `connect-claim-opp.yaml` shipped
with `visibilityPercentage: 30`, the v1.36-era cloud Maestro rejected
the whole recipe with `Unknown Property` before the first step
executed. Property removed in 0.13.194; AMI bumped past the drift in
the 2026-05-12-2142 bake. Keep the prevention discipline regardless:
when in doubt, omit version-specific properties — the default
substring + visibility threshold is usually enough.

#### Selector placeholder gate — STRICT

Every `tapOn:text:` matcher in a generated recipe MUST be either:
- A **Nova-confirmed live form-field label** (read via `get_form`
  or `get_module` per the "Use live labels" section below), OR
- A `${SELECTOR:logical-name}` placeholder that resolves against
  `mcp/mobile/selectors/connect-<apk-version>.yaml` via
  `mobile_resolve_selectors` (Step 3.4)

The reason the placeholder path is mandatory for non-form-label
matchers: Connect-integrated CommCare has surface elements
(nav-drawer items, opp-card buttons, Start buttons, etc.) whose
labels are NOT in `get_form`. If a recipe hard-codes their text,
the matcher drifts silently when Connect's UI updates. The
selector map at `connect-<apk>.yaml` is the **single point of
calibration** — populate it via `connect-baseline-screenshots`,
then every recipe that references the same logical name updates
in lockstep.

The fallback rule: if you're tempted to write
`tapOn: { text: "Some Surface Label" }` and that label is NOT
from Nova's `get_form`, STOP. Add a logical name to the selector
map (or a placeholder for one) and use `${SELECTOR:<name>}`
instead. The agent at Step 3.4 will halt with `[BLOCKER]` if any
unresolved placeholder ships — that's the forcing function.

**Use live labels from Nova's `get_form` response, not the PDD
brief's labels** (per [#115 finding 2](https://github.com/jjackson/ace/issues/115)).
The PDD brief uses pre-build naming conventions (`L0 — Why this
matters`, `F1 — Shop Registration`, `Stage 1 — Market Analysis`)
that Nova's autobuild and CommCare's app-editor rewrite into different
strings on the live device (`1. Why this matters`, `Stage 1: shop
visits & interviews`, etc.). `tapOn:text` matchers calibrated against
the brief never hit live screens.

For every `tapOn:text` matcher in a recipe:
- Read the label from `get_form({app_id, form_id})`'s
  response — Nova returns each form's `label` and each field's `label`
  exactly as CommCare will render them after autobuild's scaffold pass.
- Use that string verbatim in the recipe's `tapOn:text` matcher.
- For module-list / form-list screens, read the parent module's `label`
  from `get_module` and apply the same rule.

`mobile_validate_recipe` is a static lint that accepts any
syntactically-valid string — it cannot detect a brief-vs-live drift.
Step 4 (below) adds a runtime smoke check that catches it.

#### Quiz / required-input answer-tap rule — MANDATORY

A `form-advance.yaml` (or any direct `nav_btn_next` tap) on a
required-input question with no answer selected surfaces
`warning_root` ("Sorry, this response is required!" per atlas §7),
stalling the recipe. Every required-input question in a Maestro
recipe **MUST** be preceded by an explicit answer-selection step:

```yaml
# CORRECT — answer is tapped before advancing
- tapOn:
    text: "Public hospital"      # literal option text from Nova get_form
- runFlow:
    file: form-advance.yaml

# WRONG — no answer tap; nav_btn_next stalls on warning_root
- runFlow:
    file: form-advance.yaml      # required-input question is unanswered
```

**Leading (and interior) display/label screens — MANDATORY (jjackson/ace#710).**
A form does NOT always open on its first *question*. A `kind: label` /
display node (an intro, instructions, or result screen with no input widget —
only `nav_btn_next`) renders as its OWN screen. If the recipe taps an answer
option while a leading display node is on screen, the option selector isn't
present and the tap fails `selector-not-found` (caught in vivo:
bednet-spot-check/20260605-0658 Phase 6 Learn leg — the "Connect Comprehension
Check" form opened on a one-question intro label, and the answer tap landed on
the intro screen). The rule: **walk the form's field list IN ORDER and emit one
bare `form-advance.yaml` for every display/label node — both leading ones
before the first input AND interior ones between inputs — with NO answer tap on
those advances** (a display node has nothing to select; it's the input-node
rule above, inverted). A form `[intro(label), q1(single_select, required)]`
therefore composes as: `form-advance` (past intro) → `tapOn: <q1 option>` →
`form-advance`/`form-submit`.

For each form-walk segment of a recipe:

1. Call `get_form({app_id, moduleIndex, formIndex})` and inspect each
   field's `kind` + required-ness, **in document order**.
1.5. Walk the fields in order. For every leading or interior **display/label
   node** (`kind: label` / a display-only node with no input widget), emit one
   bare `runFlow: { file: form-advance.yaml }` with NO preceding answer tap —
   it advances past the intro/instructions/result screen to the next node
   (jjackson/ace#710). Do this BEFORE the first answer tap when the form's
   first node(s) are display nodes.
2. For every `kind: single_select` field that's required, emit a
   `tapOn: text: "<literal option label>"` BEFORE the
   `form-advance.yaml` step. The option label comes from the field's
   `options[].label` in the Nova blueprint — verbatim, not paraphrased,
   not derived from the PDD brief.
3. For `kind: image` required fields, emit the photo-capture sequence
   (`camera-take-photo` → `camera-shutter-button` → `camera-save-photo`)
   before advance.
4. For `kind: text` / `kind: decimal` required fields, emit `inputText`
   with a plausible sample value before advance.
4.5. For `kind: geopoint` required fields, do **NOT** `inputText` a
   `"lat lon alt accuracy"` string. A native CommCare geopoint is a
   **Capture-button widget** that reads the device GPS — not a free-text
   field — and the hidden `selected-at(<gps>, 0|1|3)` lat/lon/accuracy
   calcs only resolve from a real captured fix. (Typing a string fails:
   the value can't be entered as multiple space-separated tokens, so
   `selected-at(<gps>, 1)` throws `Calculation Error … list with only 1
   element` at runtime — jjackson/ace#686. A build that renders the
   geopoint as a plain text box is a **stale / downgraded build**: bind
   `type="xsd:string"` instead of `type="geopoint"` — `app-release-qa`
   now hard-gates that class, so a correct build always renders the real
   Capture widget.) The correct recipe sequence is: (a) ensure the
   emulator has a mock location — the cold-boot baseline already seeds a
   default fix, and `mobile_set_location` overrides it with opp-specific
   coordinates (**longitude first**); see
   `playbook/integrations/mobile-integration.md`, (b) tap the geopoint
   Capture button, (c) wait for the accuracy readout. The geopoint
   Capture-button selector MUST be **calibrated live against this run's
   released build** (per "close the loop to the source of truth") — never
   transcribe it from a sibling build (that's exactly how the #593/#686
   "GPS is a plain text field" misdiagnosis propagated). Until the
   selector is calibrated live, mark the geopoint step `recipe: deferred`
   for live resolution rather than inlining a typed string.
5. Hidden / `calculate`-only fields are auto-populated by the form
   runtime — they don't need a per-question answer step. Skip them when
   composing the answer sequence.

**Anti-pattern: generic-positional placeholders.** Do NOT emit
`${SELECTOR:radio-first-option}`, `${SELECTOR:radio-first-answer}`,
`${SELECTOR:option-1}`, or any other generic-positional logical
selector. The selector map intentionally does not provide stable
rows for "the first option" because the right answer is always a
literal label from `get_form`. Generic positional placeholders:

- hide which answer is being selected (both from a code reviewer and
  from the live-screen Maestro matcher),
- silently drift when option ordering changes between Nova rebuilds,
- pass `mobile_validate_recipe` (which is syntactic) while failing at
  Step 3.4's `mobile_resolve_selectors` gate (which is what halts the
  recipe in Phase 3 — *if* the selector is absent from the map) or at
  runtime on the live AVD (if a future map adds a brittle positional
  row).

If the recipe author would have to guess at a positional selector,
they haven't read `get_form` yet — read it first, then emit the
literal label.

**Anti-pattern: form-advance before answering.** Do NOT chain
`form-advance.yaml` (or `${SELECTOR:form-nav-next}` taps) directly
after the question rendering with no answer-selection step in between
on a required-input field. This was the canonical structural failure
on malaria-rdt run 20260522-1002 — every quiz step in the Learn smoke
recipe (`journey-learn.yaml`, id `journey-learn-pass`)
chained `form-advance` without an answer tap, stalling on
`warning_root` ("Sorry, this response is required!") before the
recipe could reach `deliver-launch.yaml`. The recipe validated as YAML
but could not advance past the first required quiz question.

Caught in vivo on malaria-rdt run 20260522-1002 Phase 6 (2026-05-22).
Both smoke recipes carried this class of defect: a quiz-retry journey
referenced an unresolved `${SELECTOR:radio-first-option}` placeholder,
and the Learn smoke (`journey-learn.yaml`, id `journey-learn-pass`)
chained `form-advance.yaml` across 10+ required-input quiz questions
with zero answer-selection steps in between.

**Write the smoke recipes to `ACE/<opp>/runs/<run-id>/3-commcare/recipes/journey-<app>.yaml`**
(NOT `app-test-cases/recipes/` — earlier drafts of this SKILL.md had
the wrong path and the recipes silently weren't being created;
[#106 finding 3](https://github.com/jjackson/ace/issues/106) fixed
this. The path must mirror the output spec at the top of the file so
Phase 6's `app-screenshot-capture` can find them.) Only the two smoke
recipes are written here; deep journeys carry `recipe: deferred` and
their files are generated later by `/ace:qa-deep`.

Create the `3-commcare/recipes/` subfolder via `drive_create_folder`
(idempotent — `findOrCreate: true` is the default) BEFORE writing the
first recipe.

### Step 3.4: Selector-resolution gate

Before writing any recipe to Drive, run a recipe-wide
`mobile_resolve_selectors` pass against the current APK selector map
(`mcp/mobile/selectors/connect-<ACE_CONNECT_APK_VERSION>.yaml`,
default `2.62.0`). At Phase 3 this applies to the two smoke recipes
(the only recipes authored here); `/ace:qa-deep` runs the SAME gate over
each deep recipe it generates on demand. For each composed recipe, call:

```
mcp__plugin_ace_ace-mobile__mobile_resolve_selectors({
  yaml: <composed recipe body>,
  apkVersion: <ACE_CONNECT_APK_VERSION>,
})
```

If `unresolved` is non-empty for any recipe, halt with `[BLOCKER]`
naming:

- the logical selector names that didn't resolve
- the recipe(s) that referenced them
- the active selector-map version (`connect-<apkVersion>.yaml`)
- remediation: `Add missing rows to mcp/mobile/selectors/connect-<apkVersion>.yaml — see PR #249 for the calibration pattern (3 added rows + 5 re-verified for the connect-2.62.0 map). Until that lands, this opp cannot reach Phase 6 cleanly.`

This gate exists because Phase 6's `app-screenshot-capture` will
block on the same condition when it tries to run the recipes against
a live AVD. Shifting it left to Phase 3 — where Nova `get_form` /
`get_app` context is still in-scope — gives the author a chance to
fix the recipe's selector references (or surface the map gap for a
calibration PR) before the unresolved selectors reach the emulator.
Both `leep` and `turmeric` runs in early May 2026 hit this class at
Phase 6; this is the structural preventer.

`unverified` entries are NOT a blocker — they substitute fine, they're
just flagged as not-yet-re-verified against the live APK. Surface the
list as `[WARN]` and continue.

### Step 3.5 (optional): Runtime smoke validator

Static `mobile_validate_recipe` cannot detect brief-vs-live label drift
(see Step 3). The runtime smoke validator catches it by attempting each
`is_smoke: true` recipe against a live AVD and confirming every
`tapOn:text` matcher resolves on a real screen.

**Run only when the operator has mobile bootstrap healthy and opts in.**
Set `--smoke-validate` to enable; default is OFF so non-mobile-bootstrapped
operators can run Phase 3 to completion without an AVD. When the flag is
set:

1. Confirm bootstrap health via `mobile_ensure_avd_running()`. If it
   returns `running: false` and the AVD can't auto-start, log
   `[INFO] smoke validator skipped: AVD unavailable` and continue —
   don't fail Phase 3 over a dev-machine state issue.
2. For each `is_smoke: true` journey's recipe, call:

   ```
   mcp__plugin_ace_ace-mobile__mobile_run_recipe({
     recipe_path: <path/to/journey-<app>[-<slug>].yaml>,
     dry_run_selectors: true,   // resolve every selector, don't actuate
     env_vars: { OPP_NAME, ... },
   })
   ```

3. If `dry_run_selectors: true` returns any unresolved `tapOn:text`
   matcher, halt with a `[BLOCKER]` naming the offending recipe + step
   + the missing string. The fix is usually to swap the brief label
   for the live `get_form`-derived label per Step 3.

This is a deferred fix — `mobile_run_recipe` doesn't ship a
`dry_run_selectors` mode today. Until it does, this step is a no-op
warning. Tracking: jjackson/ace#115 finding 2.

### Step 4: Emit the consolidated yaml

Write `ACE/<opp>/runs/<run-id>/3-commcare/app-test-cases.yaml` per the
template in `templates/app-test-cases-template.yaml`. **The path is
`3-commcare/`, NOT the run root** — it must match the Products section
above and the artifact manifest (`lib/artifact-manifest.ts`), which is
what `verify_phase_artifacts(phase=commcare)` checks at the Phase 3
boundary fence. Writing it to the run root passes the skill's own
self-eval (Step 5 lists the file by name) but fails the boundary fence
with `missing: 3-commcare/app-test-cases.yaml`. Reproducer:
malaria-itn-app/20260529-1124 — the master yaml landed at the run root
and the orchestrator had to `drive_move_file` it into `3-commcare/`.

### Step 5: Self-evaluate coverage

(Same shape as pdd-to-test-prompts.) Verify:
- Every journey from `pdd-to-app-journeys.md` has a binding
- Exactly one `is_smoke: true` per app
- **Two-app coverage invariant.** For any opp with both a Learn and a
  Deliver app (every archetype except a hypothetical Learn-less mode),
  `smoke_journeys_per_app.learn` MUST be `1` AND
  `smoke_journeys_per_app.deliver` MUST be `1`. **Do not write
  `app-test-cases.yaml` with `learn: 0` "because Phase 2 didn't
  produce a Learn journey"** — halt instead with a `[BLOCKER]` naming
  Phase 2 (`pdd-to-app-journeys`) as the remediation target. The
  Phase 6 pre-flight reads this field; emitting `learn: 0` produces
  a silent downstream halt with no Learn-app screenshots in the
  training deck. Caught in vivo on malaria-itn-app run 20260517-1829;
  Phase 2 contract tightened in the same PR.
- **Exactly the SMOKE recipes exist as files; deep journeys carry
  `recipe: deferred`.** Confirm via `drive_list_folder` against the
  recipes folder — the file count must equal the number of
  `is_smoke: true` journeys (normally 2: `journey-learn.yaml` +
  `journey-deliver.yaml`). Do NOT require deep-journey recipe files to
  exist at Phase 3 — they are generated on demand by `/ace:qa-deep` (see
  § Products + jjackson/ace#605). For each non-smoke journey, assert the
  catalog entry's `recipe:` is the literal `deferred` (not a path and not
  an authored file). Phase 6's `app-screenshot-capture` reads only the
  smoke recipes from this folder; a missing SMOKE recipe silently
  degrades the deck-build to placeholder screenshots
  ([#106 finding 3](https://github.com/jjackson/ace/issues/106) — the
  leep-paint-collection run hit this exact gap and required two
  manual `/ace:step` retries to recover).
- Every authored (smoke) recipe passes `mobile_validate_recipe`
- Every authored (smoke) recipe's `mobile_resolve_selectors` pass returned
  `unresolved: []` (Step 3.4 gate; non-empty means the APK selector
  map is missing rows and Phase 6 will block). Deep journeys
  (`recipe: deferred`) are not checked here — `/ace:qa-deep` runs the
  same gate when it generates them.
- Every `forms_exercised` entry resolves to a real Nova form ID
- **No `composition_status` (or any composition-escape field) on any
  `is_smoke: true` journey entry.** Per § Step 2's closed-escape rule,
  the `composition_status` field is banned entirely. With the split
  model (Learn-to-completion + Deliver-resume), composition is the
  default path — the old "monolith or BLOCKER" binary is gone.
  Writing any `composition_status` value is a contract violation;
  reject pre-write; never tolerate.

**If any check fails, halt with a `[BLOCKER]` in the gate brief.**
Do NOT write `app-test-cases.yaml` until the recipe coverage matches
the `is_smoke` count (smoke recipes authored as files; deep journeys
carried as `recipe: deferred`). This is a pre-write structural gate — no
verdict file is emitted (no LLM-as-Judge in this skill; the deep UX
judging happens later in `app-ux-eval`).

## Mode behavior

- Auto: write everything, halt on blocker
- Review: pause to show the journey→form bindings before composing recipes
- Dry-run: write the yaml + journey bindings; stub recipe paths; state
  tracks as `dry-run-success`

## Failure modes

- **Any `mobile_run_recipe` failure → read the forensics first.** On a recipe
  `status: 'fail'` (or a thrown driver-death failure, where the artifacts ride
  on `error.failureForensics`), Read `failureForensics.screenshotPath` (the
  failure screen) + `failureForensics.uiDumpPath` (the element tree) before
  writing a verdict or escalating — the screen usually names the failure mode
  literally. Canonical contract: `playbook/integrations/mobile-integration.md
  § Failure forensics`; full failure-mode table in `app-screenshot-capture`.
- pdd-to-app-journeys.md missing or empty → Phase 1 hasn't completed; halt
- Nova blueprint missing for one of the apps → Phase 3 build hasn't
  succeeded; halt with pointer to upstream skill
- mobile_validate_recipe rejects more than 2× per journey → escalate
  with the validator output

## MCP tools used

- ace-gdrive: drive_read_file, drive_create_file, drive_create_folder
- ace-mobile: mobile_resolve_selectors, mobile_validate_recipe
- nova: get_app

## Decisions Log

This skill writes load-bearing defaults to the per-run
`ACE/<opp-name>/runs/<run-id>/decisions.yaml`. The bar criterion and
schema live in `skills/idea-to-pdd/SKILL.md § Decisions Log Convention`
(canonical authority). The list below catalogs decisions that commonly
qualify under the bar for this phase — a working template, not a
required set. The skill applies the bar criterion and emits whatever
rows meet it; the catalog is a teaching device that improves over time.

### Common load-bearing decisions for Phase 3

| ID | Question | Map to surface |
|---|---|---|
| `test-scenario-count` | How many app-walkthrough scenarios feed the qa+eval pair? | `pdd-to-app-journeys-eval` coverage_completeness dimension |
| `test-archetype-coverage` | Are all archetypes in the PDD covered by at least one scenario? | `pdd-to-app-journeys-eval` archetype_alignment dimension |

The orchestrator's Phase Write-Back Verifier (`agents/ace-orchestrator.md`
§ Phase Write-Back Contract § Decisions log clause) enforces the
contract; the renderer (`skills/decisions-render`) regenerates the gdoc
at end of every phase.

Each row this skill writes uses `phase: 3-commcare` and
`skill: app-test-cases`. The convention is the phase the skill is
dispatched in, not the phase its outputs are consumed in — this skill is
dispatched from `agents/commcare-setup.md § Step 2.6` even though
`app-test-cases.yaml` + per-journey recipes are consumed by Phase 6's
`app-screenshot-capture`. Aligns with the artifact manifest, which
already maps the producer to `3-commcare/` (see
`lib/artifact-manifest.ts`).

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-04 | Initial version. Phase 3 producer for app-test-cases.yaml; binds pdd-to-app-journeys.md to Nova-built structure with Maestro recipe stubs. Successor to qa-plan (retired in same release). | ACE team |
| 2026-05-08 | Add `## Decisions Log` section: 2 anchor rows (test-scenario-count, test-archetype-coverage) + bar-criterion reference. Pairs with decisions-log PR #4 (Phase 3-10 writes). | ACE team (decisions-log PR #4) |
| 2026-05-22 | Fix `phase:` tag in Decisions Log footer: was `6-qa-and-training` (the consuming phase), now `3-commcare` (the dispatching phase, matching the artifact manifest's existing `3-commcare/` path mapping). Follow-up to issue #399. | ACE team |
| 2026-05-12 | Add Step 3.4 — recipe-wide `mobile_resolve_selectors` gate. Halts `[BLOCKER]` on any unresolved logical selector before recipes are written to Drive. Shifts left a class of Phase 6 blockers (leep + turmeric runs both hit this in early May) to Phase 3, where Nova form/field context is still in-scope. Follows PR #249's `connect-2.62.0.yaml` calibration. | ACE team |
| 2026-05-22 | Add § Quiz / required-input answer-tap rule — MANDATORY. Forbids `${SELECTOR:radio-first-option}` and other generic-positional placeholders; mandates per-required-field answer steps (literal `tapOn: text:` from Nova `get_form` options) before `form-advance.yaml`. Closes the malaria-rdt run 20260522-1002 Phase 6 BLOCKER class: both smoke recipes chained `form-advance` across required quiz questions with zero answer-selection steps, stalling on `warning_root`. Step 3.4's selector-resolution gate already catches the positional-placeholder half; this section adds the author-side rule that prevents emission in the first place. | ACE team |
| 2026-05-27 | Recipe naming convention: `J<n>.yaml` → `journey-<app>[-<slug>].yaml` (smokes use bare `journey-learn`/`journey-deliver`). `id: J<n>` retained as internal key. Screenshot labels `sc-J<n>-*` → `<recipe-base>-*`. See spec 2026-05-27-phase6-learn-deliver-decoupling. | ACE team |
| 2026-05-27 | Deliver-smoke composition: split the 80-step Learn-re-walk monolith into journey-learn (walks Learn to completion) + journey-deliver (resumes from unlocked state via connect-resume-opp -> deliver-launch). Closes the leep 20260527 J2 deferral class — composition is now the default, BLOCKER reserved for genuinely un-composable structures. | ACE team |
| 2026-05-29 | Fix Step 4 output-path bug: was `ACE/<opp>/runs/<run-id>/app-test-cases.yaml` (run root), contradicting the Products section + artifact manifest (`3-commcare/app-test-cases.yaml`). The run-root write passed the skill's own Step 5 self-eval but failed the Phase 3 boundary fence's `verify_phase_artifacts(commcare)` with `missing: 3-commcare/app-test-cases.yaml`. Step 4 now writes to `3-commcare/` and calls out the mismatch explicitly. Reproducer: malaria-itn-app/20260529-1124 (orchestrator had to drive_move_file the master yaml into 3-commcare/). | ACE team |
| 2026-05-31 | **Meaningful journey ids.** Journey `id` in `app-test-cases.yaml` is now a short intent-derived kebab-case slug (`learn-happy-path`, `learn-wrong-retry`, `deliver-yes`, `deliver-no`, `deliver-multi-visit`, `deliver-gated-on-learn`) instead of the cryptic `J<n>` ordinal — so run artifacts, screenshot labels, smoke-subset lists, and verdicts all read meaningfully and pair with the descriptive recipe filenames. Added § Journey id convention; updated every example/snippet, the template, the fixture, and downstream readers (`app-screenshot-capture`, `app-ux-eval`). Recipe filenames already descriptive (2026-05-27); this completes the convention by making the ids themselves meaningful. | ACE team |
| 2026-05-31 | **`journey-` prefix on every journey id.** Amended the convention so the `id` now carries the literal `journey-` prefix (`journey-learn-pass`, `journey-learn-retry`, `journey-deliver-submit`, `journey-deliver-alt-answer`, `journey-deliver-multiple`, `journey-deliver-locked`) — `id = journey-<app>-<intent>`, always starting with `journey-` — so the id is self-describing wherever it is listed. Recipe *filenames* are unchanged (still `journey-<app>[-<slug>].yaml`; smokes still `journey-learn.yaml` / `journey-deliver.yaml`); the doc now states the filename-vs-id distinction explicitly. Producer + downstream readers (`app-screenshot-capture`, `app-ux-eval`, `app-test-cases-template.yaml`, `ACE-Test-001` fixture) updated. (follow-up to PR #597) | ACE team |
| 2026-05-31 | **Intent-based journey-id slugs (replace answer-value names).** Renamed the canonical intent slugs from answer-value names to test-intent names — the learn smoke is now `journey-learn-pass`, learn retry `journey-learn-retry`, the deliver smoke `journey-deliver-submit`, the alternate-answer journey `journey-deliver-alt-answer`, the multi-visit journey `journey-deliver-multiple`, and the gate-locked journey `journey-deliver-locked`. The old slugs named a raw domain answer value (e.g. a literal `yes`/`no` response), which is meaningless unless you already know the question and doesn't generalize across opps; the intent names describe the behavior being verified, so they read clearly for any opportunity (bednet, vaccination, anything). The `journey-` prefix rule, the `journey-<app>-<intent>` shape, and the filename-vs-id nuance (PR #603) are all unchanged. Example/canonical slug rename only — no lazy-generation / deep-recipe-timing changes. Updated every example/snippet here plus downstream readers (`app-screenshot-capture`, `app-ux-eval`), `app-test-cases-template.yaml`, and the `ACE-Test-001` fixture. | ACE team |
| 2026-05-31 | **Lazy deep-recipe generation (closes #605).** Phase 3 now authors Maestro recipe files ONLY for the two `is_smoke: true` journeys; every non-smoke (deep) journey stays in the `app-test-cases.yaml` catalog with `recipe: deferred` (the literal string, not a path). Phase 6 (shallow, in `/ace:run`) only ever walks the smokes, so pre-authoring deep recipes was wasted work + clutter when `/ace:qa-deep` isn't run. `/ace:qa-deep` now generates the deferred deep recipes on demand using the SAME composition rules here (static palette + live `get_form` labels + selector-resolution gate) — safe because Nova `app_id` + `get_form` still return the as-built structure within a run. Step 3 scoped to "smoke journeys"; Step 5 coverage invariant changed from "every journey has a recipe file" to "exactly the smoke recipes exist as files; deep journeys carry `recipe: deferred`" (two-app smoke invariant + selector-resolution gate for the smokes KEPT). Updated `commands/qa-deep.md`, `app-screenshot-capture`, `app-test-cases-template.yaml`, and the `ACE-Test-001` fixture. | ACE team |
| 2026-06-01 | **Learn content forms are multi-screen + finalize to StandardHomeActivity (closes #646).** Two new static palette pieces: `content-form-finish.yaml` (bounded multi-screen advance loop that taps `nav_btn_next` until a Learn CONTENT form auto-finalizes, exits on the `learn-home-start-tile` home anchor — NOT the suite menu — handles the score-gated two-screen FINISH, and asserts the home grid post-finalize) and `learn-suite-reentry.yaml` (the explicit "tap Start → wait `screen_suite_menu_list`" re-entry that MUST run between every module, because a Learn form finalizes to the home grid not the suite menu). Added §§ "Multi-screen content forms" + "Suite re-entry between modules"; the prior single-screen-only content-form note is subsumed. Closes the malaria-rdt/20260601-0929 Phase 6 Learn-walk blocker (recipe walked each content form as single-screen and called the next `learn-tap-module` directly, stalling on page 2 then hard-failing the suite-menu assert). Validated structurally (`mobile_validate_recipe` + selector-resolution gate against connect-2.63.0); full live re-walk lands on the next fresh-run Phase 6 (this run consumed its one-way Learn state). | ACE team |
| 2026-07-01 | **Template ids caught up to the journey-id convention.** `templates/app-test-cases-template.yaml` still carried the pre-convention example ids (`learn-happy-path`, `deliver-yes`, `deliver-no`) even though its own comment block and § Journey id convention here mandate `journey-<app>-<intent>`. The three example entries now use the canonical intent slugs (`journey-learn-pass`, `journey-deliver-submit`, `journey-deliver-alt-answer`), matching the `ACE-Test-001` fixture, which was already correct. Supersedes stale PR #602 (which added the `journey-` prefix to the since-renamed answer-value slugs). No convention change — the template just now complies with it. | ACE team |
