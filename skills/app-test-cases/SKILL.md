---
name: app-test-cases
description: >
  Bind each PDD user journey to the Nova-built app structure and emit a
  Maestro recipe per journey with real selectors. Use after Nova
  finishes building, before app-release.
disable-model-invocation: true
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

- `3-commcare/app-test-cases.yaml` — per-journey test entries (one per journey, exactly one `is_smoke: true` per app)
- `3-commcare/recipes/J<n>.yaml` — one Maestro recipe per journey (real selectors, no `REPLACE_*` placeholders)

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

**Deliver-smoke composition for two-app opps.** Connect's UI gates the
Deliver app behind Learn-assessment completion (see
`docs/learnings/2026-05-18-connect-gates-deliver-on-learn-completion.md`).
A Deliver smoke that drives `connect-claim + Start + tap V1` lands in
Learn, not Deliver — the recipe physically cannot reach Deliver
without completing Learn first. The faithful composition (the only
one that works) is:

  connect-login → connect-claim-opp → learn-launch → walk all Learn
  modules (content form + assessment per module) → return to Connect
  opp list → tap Resume → certificate (atlas § 8) → tap
  VIEW OPPORTUNITY DETAILS → Download Delivery gate (atlas § 9) →
  tap DOWNLOAD → Deliver StandardHomeActivity (atlas § 10) → tap
  Start → Deliver MenuActivity (atlas § 11) → tap first Deliver
  module → first form-field screenshot.

That's not "shallow" — it's a faithful FLW walk-through. Phase 6
budgets ~5–10 min per Deliver smoke on multi-stage opps as a
consequence. Compose the Learn-walk-to-completion as inline
`runFlow: { file: learn-launch.yaml }` + per-module
`learn-tap-module.yaml` + `form-advance.yaml` + `form-submit.yaml`
chains; the post-Learn → Deliver transition uses the
`deliver-launch.yaml` palette (see § 3's entry-point template).

**Emitting the legacy Learn-launch-only Deliver smoke is a `[BLOCKER]`,
not a tolerated deferral.** Earlier versions of this section allowed
the skill to write a `composition_status: legacy-learn-launch` escape
field in `app-test-cases.yaml` that documented "the faithful walk
isn't written yet — defer to a later run." That escape is now closed:

- **Do NOT write `composition_status: legacy-learn-launch`** (or any
  similar `composition_status` field naming a known-broken shape) on
  any `is_smoke: true` journey. The field's presence is itself a
  contract violation.
- If you cannot compose the faithful walk-Learn-to-completion +
  `deliver-launch.yaml` chain (e.g., the Learn-app blueprint has
  fewer / more modules than expected, the static palette can't be
  composed cleanly, etc.), halt with a `[BLOCKER]` and a structured
  `auto_surfaced` entry naming the specific composition step that
  blocked you. Do NOT ship a placeholder Deliver smoke that lands in
  Learn — the load-bearing assertion of this skill is that every
  `is_smoke: true` recipe physically reaches its target app's first
  form. A recipe that demonstrably cannot do so is a structural
  failure, not a deferred-work item.
- The `mobile_validate_recipe` syntactic check is necessary but not
  sufficient: a Learn-launch-only recipe validates clean and still
  lands in the wrong app. The contract is "reaches Deliver's first
  form," not "validates as YAML."

Caught in vivo on malaria-itn-app run 20260517-1829 (the second time —
PR #354 fixed the Phase 6 pre-flight; this tightening closes the
upstream Phase 3 escape that produced the legacy recipe in the first
place). The faithful composition is non-trivial (~60+ Maestro steps
across 6 Learn modules + assessments + the Connect transition + the
Deliver entry) but it IS what the contract requires. Defer only by
halting; never by writing a known-broken recipe.

### Step 3: For each journey, compose the Maestro recipe

Compose each recipe using the static palette pattern (one Maestro
step per UI interaction, with `${SELECTOR:logical-name}`
placeholders resolved at write time, and `takeScreenshot` calls
between major form sections):

- Recipes here are journey-keyed, not module-keyed (`J1.yaml`, `J2.yaml`)
- Each journey's recipe MUST include a final
  `takeScreenshot: "sc-J<n>-final"` for the deep UX judge to grade
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

Caught in vivo on leep Phase 6 attempt 8 (2026-05-12) — J1.yaml
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
#     For Deliver journeys: Connect gates Deliver behind Learn-assessment
#     completion (see docs/learnings/2026-05-18-connect-gates-deliver-on-
#     learn-completion.md). Walk all Learn modules to completion first via
#     learn-launch + per-module learn-tap-module + form-advance + form-
#     submit, THEN chain deliver-launch.yaml which drives the post-Learn
#     certificate (atlas § 8) → Download Delivery gate (§ 9) → Deliver
#     StandardHomeActivity (§ 10) → Deliver MenuActivity (§ 11).
- runFlow:
    file: learn-launch.yaml
# ... journey-specific module/form steps below, using live labels
#     from Nova get_form (see "Use live labels" section below)
- takeScreenshot: "sc-J<n>-final"
```

The static palette lives at `mcp/mobile/recipes/static/`:
- `connect-login.yaml` — splash → nav drawer → Sign In → Opportunities home
- `connect-claim-opp.yaml` — opp-list → tap opp's View Opportunity button (scoped by `below: text`) → Start → handoff to StandardHomeActivity
- `learn-launch.yaml` — post-claim StandardHomeActivity (Start tile) → MenuActivity suite root
- `learn-tap-module.yaml` — MenuActivity row tap (generic — handles ANY level of the 3-level suite tree)
- `form-advance.yaml` — `nav_btn_next` ImageButton tap (NOT text-match "Next" — see atlas §7)
- `form-submit.yaml` — branched: explicit Submit button if visible, otherwise auto-finalize via `nav_btn_next`
- `deliver-launch.yaml` — post-Learn-complete certificate (atlas § 8) → tap VIEW OPPORTUNITY DETAILS → Download Delivery gate (§ 9) → tap DOWNLOAD → Deliver-mode StandardHomeActivity (§ 10) anchored on `id/viewJobCard`. Chains immediately after a full Learn walk-to-completion in the Deliver smoke recipe. Resource-IDs at the certificate + gate screens are coordinate-fallback-only (see palette file for remediation: live dump capture from a future Phase 6 run mid-window between Learn-pass and Deliver-download).

**CRITICAL — Learn-app navigation is 2 menu levels deep.** After `learn-launch.yaml` lands you on the module list (atlas §6a), reaching a form requires **TWO** `learn-tap-module` invocations:

1. Tap module-list row (e.g. `"1. Survey Background & Adulteration Basics"`) → drills 6a → 6b (form list).
2. Tap form-list row (e.g. `"Background & Adulteration Basics"` for the lesson, or `"Module 1 Quiz"` for the quiz) → launches FormEntryActivity (6b → §7).

Earlier-authored recipes that chained only ONE `learn-tap-module` between `learn-launch` and `nav_btn_next` landed on a menu list, not a form — subsequent `nav_btn_next` taps then found no button. Verified live on turmeric run 20260513-2243 retry #4 (2026-05-14) — see atlas §6.

For the canonical Learn-app smoke recipe template:

```yaml
- runFlow:
    file: learn-launch.yaml
# Drill from module list to the target form via two row-taps.
- runFlow:
    file: learn-tap-module.yaml
    env:
      MODULE_NAME: "1. Survey Background & Adulteration Basics"  # the module
- runFlow:
    file: learn-tap-module.yaml
    env:
      MODULE_NAME: "Background & Adulteration Basics"  # the form (lesson) or "Module 1 Quiz"
# Now on FormEntryActivity for that form.
- tapOn:
    ${SELECTOR:form-nav-next}
# ... rest of form-question handling
```

Read live module + form names from Nova's `get_form` per the "Use live labels" section below — the pre-claim teaser at `tv_learn_modules_list` lists module names verbatim, but form names inside each module are only visible via Nova.

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
guidance landed, J1.yaml and J7.yaml emitted the broken `launchApp +
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

For each form-walk segment of a recipe:

1. Call `get_form({app_id, moduleIndex, formIndex})` and inspect each
   field's `kind` + required-ness.
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
on malaria-rdt run 20260522-1002 — every quiz step in J1's recipe
chained `form-advance` without an answer tap, stalling on
`warning_root` ("Sorry, this response is required!") before the
recipe could reach `deliver-launch.yaml`. The recipe validated as YAML
but could not advance past the first required quiz question.

Caught in vivo on malaria-rdt run 20260522-1002 Phase 6 (2026-05-22).
Both smoke recipes carried this class of defect: J5 referenced an
unresolved `${SELECTOR:radio-first-option}` placeholder, and J1
chained `form-advance.yaml` across 10+ required-input quiz questions
with zero answer-selection steps in between.

**Write recipes to `ACE/<opp>/runs/<run-id>/3-commcare/recipes/J<n>.yaml`**
(NOT `app-test-cases/recipes/` — earlier drafts of this SKILL.md had
the wrong path and the recipes silently weren't being created;
[#106 finding 3](https://github.com/jjackson/ace/issues/106) fixed
this. The path must mirror the output spec at the top of the file so
Phase 6's `app-screenshot-capture` can find them.)

Create the `3-commcare/recipes/` subfolder via `drive_create_folder`
(idempotent — `findOrCreate: true` is the default) BEFORE writing the
first recipe.

### Step 3.4: Selector-resolution gate

Before writing any recipe to Drive, run a recipe-wide
`mobile_resolve_selectors` pass against the current APK selector map
(`mcp/mobile/selectors/connect-<ACE_CONNECT_APK_VERSION>.yaml`,
default `2.62.0`). For each composed recipe, call:

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
     recipe_path: <path/to/J<n>.yaml>,
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

Write `ACE/<opp>/runs/<run-id>/app-test-cases.yaml` per the template
in `templates/app-test-cases-template.yaml`.

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
- **Every `is_smoke: true` journey has a `recipes/J<n>.yaml` file
  written under `3-commcare/recipes/`.** Confirm via
  `drive_list_folder` against the recipes folder — count must equal
  the number of `is_smoke: true` journeys. Phase 6's
  `app-screenshot-capture` reads from this folder; a missing recipe
  silently degrades the deck-build to placeholder screenshots
  ([#106 finding 3](https://github.com/jjackson/ace/issues/106) — the
  leep-paint-collection run hit this exact gap and required two
  manual `/ace:step` retries to recover).
- Every recipe passes `mobile_validate_recipe`
- Every recipe's `mobile_resolve_selectors` pass returned
  `unresolved: []` (Step 3.4 gate; non-empty means the APK selector
  map is missing rows and Phase 6 will block)
- Every `forms_exercised` entry resolves to a real Nova form ID
- **No `composition_status: legacy-*` (or any composition-escape
  field) on any `is_smoke: true` journey entry.** Per § Step 2's
  closed-escape rule, ship a faithful walk-Learn-to-completion +
  `deliver-launch.yaml` Deliver smoke or halt with a `[BLOCKER]`.
  Writing `composition_status: legacy-learn-launch` (the malaria-itn-app
  20260517-1829 incident shape) is a structural failure — the recipe
  validates as YAML but cannot reach its target app's first form, and
  the field's presence is the agent self-declaring the contract
  violation. Reject pre-write; never tolerate.

**If any check fails, halt with a `[BLOCKER]` in the gate brief.**
Do NOT write `app-test-cases.yaml` until the recipe coverage matches
the `is_smoke` count. This is a pre-write structural gate — no
verdict file is emitted (no LLM-as-Judge in this skill; the deep UX
judging happens later in `app-ux-eval`).

## Mode behavior

- Auto: write everything, halt on blocker
- Review: pause to show the journey→form bindings before composing recipes
- Dry-run: write the yaml + journey bindings; stub recipe paths; state
  tracks as `dry-run-success`

## Failure modes

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
