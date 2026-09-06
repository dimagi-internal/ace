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
| **Selector map** | `mcp/mobile/selectors/connect-<apkVersion>.yaml` (default `2.63.2`) | **the authoritative, live-calibrated source for screen IDs and selector behavior.** Rows carry `unverified: true` or a `Live-verified` note, so the map states its own confidence per row — DO NOT improvise selectors that contradict it. |
| **Atlas** (partial) | `docs/mobile-atlas/connect-2.63.2.md` | narrative transition/side-effect notes only — sequence and side-effects, never identity. Its `## Provenance and coverage` table tags every surface `calibrated-2.63.2`, `carried-from-2.62.0-unverified`, or `uncovered`; read that tag before relying on a section. Where the atlas and the selector map disagree, **the selector map wins**; where the atlas says a surface is uncovered, check the palette recipes in `mcp/mobile/recipes/static/` before believing it. The carried-over surfaces are reproduced by reference from the older 2.62.0 atlas (its §§ 1-11) rather than restated. |

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
  form-submit.yaml` → `runFlow: deliver-sync.yaml`. ~14 steps, NO Learn
  duplication.

  **`deliver-sync.yaml` is MANDATORY as the last step of every Deliver
  journey (dimagi-internal/ace#1066) — a Deliver journey without it is
  not a test.** `form-submit.yaml` finalizes a plain Deliver form via its
  `nav_btn_next` auto-finalize branch, which writes to the LOCAL OUTBOX
  and asserts nothing about the server; only its score-gated branch
  (`form-nav-finish`, the Learn quiz) asserts `".*form.*sent to
  server.*"`. So a Deliver leg ending at `form-submit` proves only "the
  form walked and finalized locally" — an opp whose Deliver→Connect path
  was completely broken would still pass. Observed live on
  bednet-spot-check/20260729-1239: `status: pass`, then `Daily Visits
  0/5` and `last synced: never`.

  `deliver-sync.yaml` closes that by asserting the SERVER-DERIVED `Daily
  Visits` counter is non-zero. Note the tap on "Sync with Server" is a
  belt-and-braces upload, not the load-bearing step: CommCare sometimes
  auto-sends on finalize (in which case the sync reports "No forms sent
  to server!" — benign) and sometimes does not. The assertion is what
  makes the leg honest either way. This mirrors what jjackson/ace#897
  established for Learn: the device is not authoritative about
  completion. A Connect-side read-back is still the stronger gate and
  remains open on #1066 pending an atom.

  **Menu-row taps use `id: org.commcare.dalvik:id/row_txt`, NOT
  `text: "<label>"`.** A `text:` match hits the non-clickable action-bar
  title (same label) first in document order, so the tap is a silent
  no-op (validated live, bednet-spot-check/20260602-1345 deliver-leg pass).
  `deliver-form-walk.yaml` already encodes this; if you ever inline a
  menu-row tap instead of composing the palette recipe, use `row_txt` —
  same as the Learn side's `learn-tap-module.yaml`.

#### Registration-then-followup Deliver apps — bind `MODULE_NAME` / `FORM_NAME` (dimagi-internal/ace#1138)

**Most ACE Deliver apps are MULTI-MODULE, and that is by construction —
not an accident to design around.** One form per module is a deliberate,
load-bearing ACE pattern: Connect dedups deliver units by module slug
(`get_or_create(DeliverApp, slug)`), so two forms in one module collapse
into a SINGLE `DeliverUnit` and only one of them can ever be payable. Any
Deliver app that registers an entity and then files repeat visits against
it therefore has **at least two modules** — e.g. `CBF Registration` and
`Community Meeting Record` on Deliver app
`657a4bb7-fb2f-4a10-af43-8414707b2c43`
(spark-facilitator/20260731-0656).

`deliver-form-walk.yaml` used to tap the FIRST menu row at each level. On
a multi-module app that walks into the registration module and never
reaches the payable form — which is why that run could not author
`journey-deliver.yaml` at all and Phase 6 got zero Deliver screenshots.
**Always bind the target module (and the form, when its label differs)**,
exactly as you already do for `learn-tap-module.yaml`:

```yaml
- runFlow:
    file: deliver-form-walk.yaml
    env:
      MODULE_NAME: "Community Meeting Record"   # the PAYABLE module
      FORM_NAME: "Community Meeting Record"     # omit when it equals MODULE_NAME
      WALK_LABEL: "-deliver"                    # REQUIRED even on a lone leg (ace#1668)
```

`MODULE_NAME` / `FORM_NAME` are optional and default to the legacy
tap-first-row behavior when unbound, so single-module callers are
unchanged — but a Deliver app with
more than one module MUST bind `MODULE_NAME`, or the walk is silently
wrong rather than loudly broken. Enforced structurally by
`test/mcp/mobile/static-recipe-invariants.test.ts § positional row taps`.

**The payable module is the one Connect pays for, not the first one.**
Read the deliver units (`connect_list_deliver_units` /
`connect_list_payment_units`) or the Nova blueprint to pick it — do not
assume ordering.

##### Ordering: a followup form needs its case to already exist (#1138 Gap 2 — CLOSED)

When the payable form is a `followup` on a case type (the normal shape
for register-then-visit apps), reaching it forces a three-step order:

1. walk the **registration** module's form first, so a case of that type
   exists on the device;
2. **select that case** from CommCare's `EntitySelectActivity` case list;
3. only then answer the payable form.

**All three are authorable.** Step 2 is
`mcp/mobile/recipes/static/deliver-case-select.yaml`, and
`deliver-form-walk.yaml` composes it for you — you never call it
directly. Bind **`CASE_NAME`** alongside `MODULE_NAME` / `FORM_NAME` and
the walk crosses the case list on its own:

```yaml
# 1. Registration module — creates the case. No CASE_NAME (no case list).
- runFlow:
    file: deliver-form-walk.yaml
    env:
      MODULE_NAME: "CBF Registration"
      FORM_NAME: "CBF Registration"
      WALK_LABEL: "-register"                     # per-invocation frame suffix
# ...answer the registration fields, then:
- runFlow:
    file: form-submit.yaml
    env:
      SCREENSHOT_NAME_PRE_SUBMIT: "journey-deliver-reg-pre"
      SCREENSHOT_NAME_POST_SUBMIT: "journey-deliver-reg-post"

# 1b. RETURN TO THE DELIVER HOME. Not optional — see below.
- runFlow:
    when: {notVisible: {id: "${SELECTOR:deliver-home-job-card}"}}
    commands: [back, {waitForAnimationToEnd: {timeout: 3000}}]
- runFlow:
    when: {notVisible: {id: "${SELECTOR:deliver-home-job-card}"}}
    commands: [back, {waitForAnimationToEnd: {timeout: 3000}}]
- extendedWaitUntil:
    visible: {id: "${SELECTOR:deliver-home-job-card}"}
    timeout: 20000

# 2. Payable followup — CASE_NAME selects the case just registered.
- runFlow:
    file: deliver-form-walk.yaml
    env:
      MODULE_NAME: "Community Meeting Record"      # the PAYABLE module
      FORM_NAME: "Village Monitoring Record"
      CASE_NAME: "Thandiwe Banda.*"                # the case_name you entered
      WALK_LABEL: "-followup"                      # MUST differ from leg A's
```

**`WALK_LABEL` is REQUIRED at every call site — including a lone one
(ace#1651, corrected by ace#1668).** `deliver-form-walk.yaml` names three of its captures from
FIXED strings — `deliver-form-walk-module-list`, `-form-list`,
`-form-question`. Two invocations in one recipe therefore wrote the same
three filenames twice, and leg B's frames **silently overwrote leg A's**:
measured on bednet-check-2-visit/20260825-1310 (a PASSING run) the stdout
reported all three captures COMPLETED in both legs while exactly one file
of each name survived, carrying leg B's `takenAt`. The registration
evidence the training deck and `app-ux-eval` read was destroyed, and if
leg B fails it destroys precisely the frames an operator needs to see how
the case got created.

Bind a short `[a-z0-9-]` slug **including the leading separator**, and a
DIFFERENT one per call site.

**Do not omit it on a single-invocation walk.** The #1651 fix said you
could, on the premise that an unbound `${WALK_LABEL}` substitutes to the
empty string and keeps byte-identical names. That premise is false:
Maestro evaluates `${...}` in a JS engine, so an unbound variable
stringifies to the literal text `undefined`. The very next run's Deliver
leg wrote `deliver-form-walk-module-listundefined.png`,
`-form-listundefined.png`, `-form-questionundefined.png` and
`deliver-form-walk-module-row-Household poverty surveyundefined.png`
(hh-poverty-targeting/20260824-1404) — names that reach the screenshot
manifest, the training deck and the FLW guide, where they read as a
defect in the deliverable (ace#1668). And a default inside the palette's
own `env:` block is NOT the fix — a subflow `env:` OVERRIDES the caller's
`runFlow.env` in Maestro (ace#1033), so it would force both legs to the
same value and silently restore the #1651 overwrite.

*Enforced two ways, both run by `mobile_validate_recipe`:*
`lintRecipeText`'s `runFlow-unbound-screenshot-name` rule fails **any**
call site that omits `WALK_LABEL` (or binds it empty), and
`repeat-palette-invocation-without-discriminator` fails a recipe that
invokes the palette twice with a duplicated one.
`test/mcp/mobile/static-recipe-invariants.test.ts § deliver-form-walk
per-invocation frame names` pins the palette side, including the literal
`undefined` expansion that #1651's own test suite had assumed away.

**Step 1b exists because the two recipes' own contracts do not meet
(ace#1191).** `deliver-form-walk.yaml`'s header declares
*"Pre-state: Deliver home (deliver-home-job-card / viewJobCard visible)"* and
its first action taps `Start`; `form-submit.yaml`'s header declares
*"Post-state: depends on the form … Deliver forms (TBD)"*. `deliver-sync.yaml`
records the real behaviour in passing — *"form-submit returns to the form list
(or the module list) rather than the app home"* — which is exactly why
deliver-sync itself opens with four guarded `back` steps (a case-bound Deliver
form sits one level deeper — ace#1494).

Without 1b the second leg starts inside a form. Live on
`spark-facilitator/20260813-2126` the Deliver smoke walked leg A, then died at
the inter-leg back-navigation on CommCare's unmapped **"Exit Form?"** dialog
(ace#1290) — having already taken its POST_SUBMIT screenshot and reported
success.

The guarded form above is a **no-op when the device is already home**, and it
mirrors `deliver-sync.yaml`'s proven pattern rather than inventing a new one.
It is inlined rather than shipped as a palette recipe because a palette
recipe must be proven on a live device before it merges, and the
`deliver-home-reentry.yaml` entry is still pending that validation (#1191).

*Enforced:* `test/mcp/mobile/static-recipe-invariants.test.ts § two-leg Deliver
chain continuity` runs `checkChainContinuity` (`lib/recipe-state-contract.ts`)
over the real palette files and fails if the un-bridged sequence ever starts
looking connected.

**`CASE_NAME` must be the value you actually typed into the registration
form's `case_name` field** — it is what renders in the case list's first
column. Pass it as a literal prefix plus `.*` (Maestro `text:` is a
FULL-match regex and case-list cells are routinely truncated — and on any
app built before 2026-08-14, language-stacked as well). Omit it on a followup and the walk fails loud on the case
list rather than silently picking a row.

Two things worth knowing, both live-established on 2.63.2 and both
already handled inside the palette — do not re-derive them:

- CommCare collects the **case before the form**: module row → case list
  → case detail → CONTINUE → form list → form. The detail screen is a
  real screen with its own CONTINUE button, not a dialog.
- The case list's **column headers reuse the row cells' resource-id**,
  and the toolbar carries the module name, so a case tap is scoped to the
  list container. Never hand-roll a case tap; compose the palette.

**Do NOT substitute the registration form for the payable one** and call
the journey a Deliver smoke — that produces a green journey that never
exercises the payable unit, which is the entire thing Phase 6's Deliver
leg exists to prove. If the payable form genuinely cannot be reached,
halt with a `[BLOCKER]` naming what stopped the walk; do not downgrade
the target.

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

**Groups are field-lists — one screen, NOT one screen per question.**
A Nova `kind: group` compiles to a CommCare **field-list**: every child
(labels *and* questions) renders on ONE scrollable screen. Composing a
per-child `tapOn option → nav_btn_next` walk inside a group is
structurally wrong — the first advance fires while the screen's other
required children are still unanswered, so the form stalls on
`warning_root` ("Sorry, this response is required!"), and later options
may sit above/below the fold. Read `nova_get_form` and check for
`children[]` before composing. For each group emit a **single-screen
walk**:

1. `takeScreenshot` on entering the screen.
2. Per select child: `scrollUntilVisible` the question, then `tapOn` its
   option anchored `below:` that question label. **`centerElement` is
   chosen BY POSITION, not set uniformly** (ace#1814):

   | Position in the group | `centerElement` | Why |
   |---|---|---|
   | Any question except the last | `false` | It is already on screen when its turn comes. Centering it displaces the NEXT question below the fold, so that question's lookup enters a *search* phase — and one search step clears the remaining (short) group content, landing past the target. `scrollUntilVisible` only scrolls DOWN, so it can never recover. |
   | The **last** question | `true` | Nothing follows it to overshoot past, and centering is what lifts its answer options above the fold. Left `false`, the label stops flush at the pane bottom with its options below it and the `tapOn` dies `selector-not-found`. |

   ```yaml
   # every question EXCEPT the last one in the group
   - scrollUntilVisible:
       element:
         text: "[\\s\\S]*<question label>[\\s\\S]*"
       direction: DOWN
       speed: 15
       timeout: 20000
       visibilityPercentage: 30
       centerElement: false
   - tapOn:
       text: "<literal option label>"
       below:
         text: "[\\s\\S]*<same question label>[\\s\\S]*"

   # the LAST question in the group — centerElement flips to true
   - scrollUntilVisible:
       element:
         text: "[\\s\\S]*<last question label>[\\s\\S]*"
       direction: DOWN
       speed: 15
       timeout: 20000
       visibilityPercentage: 30
       centerElement: true
   - tapOn:
       text: "<literal option label>"
       below:
         text: "[\\s\\S]*<same last question label>[\\s\\S]*"
   ```

   **Uniformly `true` breaks at question 2; uniformly `false` breaks at
   the last one.** Both halves are device-proven on
   `hh-poverty-targeting/20260828-0702` (2026-08-29, `emulator-5554`,
   dispatch `1788015366397-zbmkn0`), on TWO independent field-list groups
   in the same passing walk: `consumption` (BREAD / EGGS / MILK `false`,
   SACHET WATER `true`) and `assets` (sofa / FAN `false`, IRON `true`).
   The walk completed all 29 chunks, submitted, and synced a registered
   visit.

   **`speed` and `visibilityPercentage` are NOT the lever here** — that
   was the first hypothesis on ace#1814 and it was disproved on-device:
   re-running the overshoot at `speed: 15` / `visibilityPercentage: 30`
   with `centerElement: true` throughout failed at the identical step
   with an identical dump. Do not re-propose tuning them for this class.
3. Per label-less EditText child: **`below:` anchored on the question
   label is NOT reliable and is inert whenever the question has a hint
   (ace#1299).** The calibrated layout order is

       label TextView  ->  optional hint TextView  ->  EditText

   so `below: <question label>` selects the **hint**, and tapping a
   TextView does nothing. The tap reports success, focus never moves, and
   every subsequent `inputText` appends into whichever field was already
   focused. Live on `spark-facilitator/20260813-2126` that produced
   `cbf_name = "Thandiwe Banda0991234567"` with `phone_number` empty and
   required — silent data corruption, not a visible failure.

   The idiom appears to work on questions WITHOUT a hint, which is why it
   was recorded as live-validated: the failure is per-question, not
   per-form.

   Two live facts to compose against instead (CommCare 2.63.2 /
   `ACE_Pixel_API_34`, ui-dump 2026-08-14):

   - **CommCare AUTOFOCUSES the first input of a field-list at form
     open** — `focused=true` with zero taps — so the first value needs no
     tap at all, just `inputText`.
   - **The answer EditText carries NO resource-id** on this build.
     `org.odk.collect.android:id/answer_text` (the old
     `form-question-input` guess) does not exist; match by class
     (`android.widget.EditText`) and position.

   **The focus anchor is the element immediately above the `EditText` —
   the field's `hint` when it has one, the question label when it does
   not** (ace#1299, follow-up comment: Nova's authoritative `hint` map
   diffed against all 14 inputs of both Deliver forms on
   `spark-facilitator/20260813-2126`; 3 anchors were wrong and all 3 were
   hint-carrying fields anchored on their label, which is why this read as
   intermittent rather than systematic).

   So for every input the autofocus does NOT cover — i.e. every input
   after the first on a field-list — emit (validated on-device, ace#1299:
   an isolated probe on that live registration screen landed `cbf_name` =
   `'PROBE-NAME'` and `phone_number` = `'0991234567'` in their OWN fields,
   where the label-anchored idiom had put both into one):

   ```yaml
   - scrollUntilVisible:
       element:
         text: "[\\s\\S]*<hint if present, else question label>[\\s\\S]*"
       direction: DOWN
       speed: 30
       timeout: 20000
       visibilityPercentage: 60
       centerElement: true
   - tapOn:
       below:
         text: "[\\s\\S]*<same anchor>[\\s\\S]*"
   - eraseText
   - inputText: "<value>"
   - hideKeyboard
   ```

   **Guarded vs unconditional — the discriminator is whether the anchor IS
   the tap target.** Both shapes are correct, in different places, and
   picking by habit rather than by this test reintroduces one of the two
   bugs (ace#1070, ace#1299):

   - **Anchor IS the tap target** (a unique option label, a named button)
     → keep the `when: notVisible` **guarded** scroll of § Quiz /
     required-input answer-tap rule. ace#1070 stands: an unconditional
     scroll on an option that already fits reads as backward form
     navigation and walks the flow out of the form.
   - **Anchor is a DIFFERENT element from the tap target** (an `EditText`
     reached via the hint above it; a field-list option addressed via its
     question label) → **unconditional** centring scroll, as in the
     snippet above. The failure mode there is "anchor visible, its
     `EditText` still below the fold", which `notVisible: <anchor>` is
     structurally blind to — so the guard suppresses the one scroll that
     was needed. That half affected all 14 inputs, not just the 3 with
     wrong anchors (ace#1299).

   `speed: 30`, not 80: at 80 the centring scroll overshot a ~300px radio
   band and halted the leg (ace#1299).

   Index-based anchoring within the field-list is still **uncalibrated** —
   use the hint/label anchor above, which is proven (ace#1299); do not
   guess an index.
4. Exactly **ONE** trailing form-advance, after every REQUIRED child is
   answered.

Two matcher traps on that screen:

- **Regex metacharacters break Maestro's full-match `text:`.** Question
  labels routinely contain parentheses. Compose the matcher as
  `"<literal prefix>.*"` rather than the full label.
- **N identical option labels are not text-matchable.** A field-list
  carrying nine `"Option A"`s cannot be disambiguated by text. Leave
  OPTIONAL children unanswered until the labels are distinct, and say so
  in the recipe header.

`recipe-sanity-probe` enforces this statically as
`group-field-list-per-question-walk` when Step 2.6's caller supplies
`fields` (ace#862).

**Both halves of item 3 are statically enforced too** (ace#1554):

- `input-anchor-skips-hint` — a focus tap anchored on the QUESTION LABEL
  of a field that carries a `hint`. Hint-gated: it reads only fields that
  positively carry a hint, so a caller that did not supply `hint` gets a
  no-op, never an assumed "no hint". Supply `hint` alongside `label` in
  Step 2.6's `fields` for it to run at all.
- `input-focus-scroll-is-guarded` — a `when: notVisible: <anchor>` wrapper
  around the centring scroll for a `tapOn: below:` + `inputText` pair.
  This one needs no Nova data; it is the guarded-vs-unconditional
  discriminator below, made non-optional.

**Every `- inputText` is immediately preceded by `- eraseText`** — on a
field-list, a standalone question, anywhere. Maestro's `inputText`
*appends at the cursor*; it does not replace, so a field already carrying
a Nova casedb preload, an XForm default, or a stray character receives the
two values concatenated. Live: `spark-facilitator/20260828-0703` typed
`40` into `hh_represented_at_the_meeting`, submitted `140`, and the form's
cross-field constraint refused to advance — the leg then died two screens
later on an unrelated scroll, reading as a selector fault it was not. And
wherever it does *not* happen to trip a constraint the corruption is
SILENT: the leg reports `pass` on wrong data. A redundant erase on an
empty field is a runtime no-op, so there is never a reason to omit it.
Enforced statically as `input-without-erase` (ace#1844) — needs no Nova
data, so it runs on every recipe.

**Anchor every shared option label.** The probe attributes a step to a
group by the strings the step selects on, and a bare `tapOn: text: "Yes"`
names no screen — on the normal shape (a consumption block plus an assets
block, both Yes/No) it is a child of two groups at once. Since ace#1548 an
ambiguous matcher attributes to NOTHING rather than to whichever group
enumerates first, so the check simply goes quiet on unanchored option taps.
Keep the `below:` anchor naming the question
(`"[\\s\\S]*<question label>[\\s\\S]*"` — two backslashes, as in the
snippet above; `\s` is not a legal escape in a YAML double-quoted scalar)
on every option tap — it is what makes the check able to see your screen
at all.

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
- Validate via `mobile_validate_recipe` before writing.
  *Enforced:* since ace#1690, `mobile_run_recipe` runs the same linter on
  every recipe it dispatches and refuses a failing one with
  `RECIPE_LINT_FAILED`. Calling `mobile_validate_recipe` first is still
  right — it fails in one cheap static call instead of at device dispatch —
  but skipping it no longer lets a malformed recipe reach a device

#### The accepted step-key dialect (ace#1008)

`mobile_validate_recipe` rejects any step key outside
`ALLOWED_STEP_KEYS` in `mcp/mobile/backends/maestro.ts`. **That list is
the source of truth — grep it rather than guessing**, and note that
**no step is deliberately banned for agent-authored recipes.** The
allowlist exists to catch typos and Maestro-version drift, not to hold
journey recipes to a narrower dialect than the shipped static palette.

The invariant (pinned by
`test/mcp/mobile/palette-step-allowlist.test.ts`): the allowlist is a
superset of every step key used under `mcp/mobile/recipes/static/`.
Palette files never pass through the validator, so before ace#1008 the
two silently diverged — `scrollUntilVisible` (used by
`connect-resume-opp.yaml` and `connect-claim-opp.yaml`) was rejected in
agent-authored recipes, forcing authors to either drop legitimate
scroll-into-view behaviour or ship an unvalidated recipe. If a
validator rejection ever looks like that again — the palette uses the
step, the validator refuses it — **that is an ACE defect: file it and
add the key**, don't work around it.

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

**MENU ANCHORS ARE DISPLAY-MODE-AGNOSTIC — never hardcode a container id (dimagi-internal/ace#1127).** CommCare renders the same MenuActivity rows (`row_img` + `row_txt`) inside a DIFFERENT container depending on the app's menu display setting: `screen_suite_menu_list` (ListView, list mode) or `grid_menu_grid` (GridView, grid mode). Phase 3 `app-hq-settings` applies **grid** display app-wide (#1082/PR #1100), so grid is the live shape for every ACE opp. Always reference `${SELECTOR:learn-suite-menu}` / `${SELECTOR:deliver-suite-menu}`, whose map values are regex alternations accepting either container (Maestro matches `id:` as a regex). Writing a raw `id: "org.commcare.dalvik:id/screen_suite_menu_list"` into a generated recipe is how the ENTIRE palette became unexecutable on 2026-07-31 (bednet-spot-check/20260731-1353: Learn halted at `learn-launch.yaml`, Deliver walled identically, Phase 6 `verdict: blocked`). Prose below that names `screen_suite_menu_list` is describing the original list-mode incident, not prescribing the anchor. Enforced by `test/mcp/mobile/static-recipe-invariants.test.ts § menu-container anchors`.

The static palette lives at `mcp/mobile/recipes/static/`:
- `connect-login.yaml` — splash → nav drawer → Sign In → Opportunities home
- `connect-claim-opp.yaml` — opp-list → tap opp's View Opportunity button (scoped by `below: text`) → Start → handoff to StandardHomeActivity
- `learn-launch.yaml` — post-claim StandardHomeActivity (Start tile) → MenuActivity suite root
- `learn-tap-module.yaml` — MenuActivity row tap (generic — handles ANY level of the 3-level suite tree)
- `form-advance.yaml` — `nav_btn_next` ImageButton tap (NOT text-match "Next" — see atlas §7). **Every `runFlow` of this palette MUST pass `SCREENSHOT_NAME`** — see § Screenshot names are caller-bound.
- `form-submit.yaml` — branched: explicit Submit button if visible, otherwise auto-finalize via `nav_btn_next`. **Every `runFlow` of this palette MUST pass `SCREENSHOT_NAME_PRE_SUBMIT` + `SCREENSHOT_NAME_POST_SUBMIT` env params** with per-journey names (e.g. `deliver-final-review` / `deliver-submitted-confirmation`) — see § Screenshot names are caller-bound. There are NO palette-side fallbacks: the `env:` defaults added for ace#852 turned out to SHADOW the caller's names and were removed in ace#1033.
- `content-form-finish.yaml` — **the Learn CONTENT-form finalize, home-grid variant.** A bounded multi-screen advance loop that taps `nav_btn_next` until the form auto-finalizes back to StandardHomeActivity, exits on the `learn-home-start-tile` home anchor (NOT the suite menu), handles the score-gated two-screen FINISH, and asserts the home grid post-finalize. Correct ONLY on a multi-module Learn app whose forms are `post_submit: module`; on `post_submit: previous` (Nova's default) the finalize lands on the module form list and this recipe's terminal home assert cannot fire (dimagi-internal/ace#1566). Use it for label-only content/lesson forms — NOT for required-input quizzes (those still need per-field answer-taps + `form-advance` + `form-submit`). Requires `SCREENSHOT_NAME`. See § Multi-screen content forms below.
- `learn-suite-reentry.yaml` — **the between-modules suite re-entry, home-grid variant.** Tap the home Start tile → wait `screen_suite_menu_list`. Correct ONLY when the form is `post_submit: module`, which finalizes to StandardHomeActivity. Same surface contract as `learn-launch.yaml` (the first, post-claim suite entry); split out under a distinct name to document the between-modules intent at the call site.
- `learn-suite-reentry-from-module.yaml` — **the between-modules suite re-entry, form-list variant.** `back` → wait `screen_suite_menu_list`. Correct when the form is `post_submit: previous` (**Nova's default**) AND the form's own module renders a form list to come back to. Composing the home-grid variant here hangs the walk for 30s on a "Start" tile that never renders (dimagi-internal/ace#1071); firing this one from the suite root instead — which is where `previous` lands for a module CommCare auto-skipped — walks back out of the suite (dimagi-internal/ace#1633), so **always call it guarded on the next module's row**. Both are per-FORM decisions: see § Suite re-entry between modules.
- **Pick between those two PER FORM, from `get_form().post_submit` plus the owning module's form count** — see § Suite re-entry between modules below for the table, the per-form rule (dimagi-internal/ace#1633), the guarded call site, and the reason the two recipes cannot be merged into one. **NOTE:** both are for MULTI-module Learn apps. For a **single-module** Learn app (one CommCare module holding all forms), forms finalize back to the suite list — use `content-form-finish-to-suite.yaml` and OMIT the re-entry step entirely. See § SINGLE-MODULE Learn app below (jjackson/ace#894).
- `content-form-finish-to-suite.yaml` — **the Learn CONTENT-form finalize, menu variant.** `content-form-finish.yaml` re-keyed on `${SELECTOR:learn-suite-menu}` (a display-mode-agnostic alternation that matches the suite root AND a module's own form list, #1127) instead of the home tile. Correct for a **single-module** Learn app (one CommCare module holding all forms — proven live hh-poverty-targeting/20260722-1341, jjackson/ace#894) AND for a **multi-module** app whose forms are `post_submit: previous` (dimagi-internal/ace#1566). Requires `SCREENSHOT_NAME`. See § Multi-screen content forms and § SINGLE-MODULE Learn app below.
- `connect-resume-opp.yaml` — opp-list → scroll to the target opp's In-Progress card → tap Resume → lands on the certificate/opp-detail surface (atlas § 8) that `deliver-launch.yaml` expects. Pre-state: Connect opp-list visible, opp already Learn-in-progress or complete. Warm-session only (journey-learn leg completed Learn in this dispatch). Matches the tile on **`OPP_RUN_ID`** (`text: ".*${OPP_RUN_ID}.*"`), not `OPP_NAME` — the recipe header is the contract, don't restate its parameters here (ace#974).
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

##### Multi-screen content forms — pick the finalize variant from `post_submit`

**Learn CONTENT forms are paginated, multi-screen, and label-only — walk
each one with a `content-form-finish*` recipe, NOT a single
`form-submit.yaml`.**
A Learn content/lesson form (e.g. "Program Orientation", "Identifying RDTs",
"Photo Protocol") is a multi-screen form: the first screen shows BOTH
`nav_btn_prev` and `nav_btn_next` and the progress bar is not full. A single
`form-submit.yaml` (one `nav_btn_next` tap) advances exactly ONE page and
then looks for FINISH — so it **stalls on page 2 of the first content form**,
and the next `learn-tap-module` hard-fails asserting the suite menu.
This was the malaria-rdt/20260601-0929 Phase 6 Learn-walk blocker
(jjackson/ace#646).

The class-level fix is a bounded multi-screen advance loop that taps
`nav_btn_next` until the form auto-finalizes, then exits on the anchor of
**wherever that finalize actually lands**. There are two of them, and they
differ ONLY in that exit anchor:

- `content-form-finish.yaml` — exits + asserts on the StandardHomeActivity
  home grid (`${SELECTOR:learn-home-start-tile}`, the Start / View Job
  Status / Sync / Log out surface, "1 form sent to server!").
- `content-form-finish-to-suite.yaml` — exits + waits on
  `${SELECTOR:learn-suite-menu}`, a display-mode-agnostic regex alternation
  over the MenuActivity containers (dimagi-internal/ace#1127) that matches
  the suite root AND a module's own one-level-in form list.

**Which one is correct is decided by the same `get_form().post_submit` field
that decides the re-entry recipe** — the two are one 2x2, not two independent
choices (dimagi-internal/ace#1566, the finalize half of the #1071 class):

| Learn app shape | `post_submit` | finalize recipe | re-entry recipe |
|---|---|---|---|
| multi-module | `module` | `content-form-finish.yaml` | `learn-suite-reentry.yaml` |
| multi-module | `previous` (**Nova's default**) | `content-form-finish-to-suite.yaml` | `learn-suite-reentry-from-module.yaml` |
| single-module | any | `content-form-finish-to-suite.yaml` | none (see § SINGLE-MODULE Learn app) |

**The finalize column reads per APP; the re-entry column reads per FORM
(dimagi-internal/ace#1633).** `content-form-finish-to-suite.yaml` exits on
`${SELECTOR:learn-suite-menu}`, a regex alternation that matches the module
form list AND the suite root, so it is correct wherever a `previous` finalize
lands. The re-entry is not: `learn-suite-reentry-from-module.yaml` is an
unconditional `back`, which is right only when the finalize actually landed
one level in. Pick it per form, from the OWNING MODULE's shape, and call it
guarded — see § Suite re-entry between modules.

**Read `post_submit` off the blueprint before you pick.** On a multi-module
app whose forms are `post_submit: previous`, the finalize lands on the
module's own form list, one level inside the suite — the home grid never
renders. `content-form-finish.yaml` cannot terminate there: its advance loop
is guarded on `notVisible: ${SELECTOR:learn-home-start-tile}` (true forever
on a menu screen) while the inner `visible: ${SELECTOR:form-nav-next}` guard
no-ops on a menu, so all 12 bounded slots burn doing nothing and the terminal
`assertVisible ${SELECTOR:learn-home-start-tile}` dies with
`Assertion is false: "Start" is visible` — the same signature #1071 observed
live for the re-entry half on spark-facilitator/20260728-1338, one step
earlier in the loop. Live repro of the finalize half:
bednet-check-2-visit/20260820-0832 (2 CommCare modules, 5 forms, all
`post_submit: previous`; workaround recorded in that run's
`journey-learn.yaml` header). `content-form-finish-to-suite.yaml` is correct
there because `learn-suite-menu` matches that module form list, and
`learn-suite-reentry-from-module.yaml` (`back` → suite root) then restores
`learn-tap-module`'s pre-state.

Call the chosen recipe once per content form (pass `SCREENSHOT_NAME`):

```yaml
# ── multi-module, post_submit: module ────────────────────────────────
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

```yaml
# ── multi-module, post_submit: previous (Nova's default) ─────────────
- runFlow:
    file: learn-tap-module.yaml
    env:
      MODULE_NAME: "1. Program Orientation"
      FORM_NAME: "Program Orientation"
- runFlow:
    file: content-form-finish-to-suite.yaml
    env:
      SCREENSHOT_NAME: "journey-learn-m0-orientation-finished"
# device is now on the MODULE's own form list (or, if THIS module held one
# auto-skipped form, already at the suite root) — so the `back` is GUARDED
# on the next module's row (see § Suite re-entry between modules, ace#1633).
- runFlow:
    when:
      notVisible:
        text: "2. Spot-check training"
        below:
          id: "${SELECTOR:learn-suite-menu}"
    commands:
      - runFlow:
          file: learn-suite-reentry-from-module.yaml
```

Do NOT hand-chain `form-advance.yaml` + `form-submit.yaml` for content
forms — both `content-form-finish*` recipes subsume the single-screen and the
multi-screen cases (the bounded loop no-ops its remaining advances once the
form auto-finalizes on its only/last screen). Reserve explicit
`form-advance` → answer-tap → `form-submit` sequencing for QUIZ /
assessment forms with required inputs (per the MANDATORY answer-tap rule
below) — neither `content-form-finish*` recipe selects answers, so pointing
one at a required-input quiz stalls on `warning_root` ("Sorry, this response
is required!"; jjackson/ace#646).

##### Screenshot names are caller-bound — never rely on a palette default (dimagi-internal/ace#1033)

Four palette pieces name their screenshot from a caller-supplied env var:
`form-advance.yaml` (`SCREENSHOT_NAME`), `content-form-finish.yaml`
(`SCREENSHOT_NAME`), `content-form-finish-to-suite.yaml` (`SCREENSHOT_NAME`),
and `form-submit.yaml` (`SCREENSHOT_NAME_PRE_SUBMIT` +
`SCREENSHOT_NAME_POST_SUBMIT`). **Every single `runFlow` into one of them MUST
bind every one of those keys in its own `env:` block, with a name unique to
that call site.** An unbound call now FAILS `mobile_validate_recipe` with the
`runFlow-unbound-screenshot-name` lint rule.

**Why there are no palette-side defaults.** A Maestro flow's own top-level
`env:` block does not default *under* caller-passed env — it **overrides** it.
Measured against the pinned Maestro 2.5.1 source: the subflow's `env:` becomes
a `DefineVariablesCommand` prepended inside the subflow body, the caller's env
becomes another one prepended in front of that, and `Orchestra.runSubFlow`
executes both in list order with an unconditional `putEnv` — so the subflow's
block writes last and wins. Live-confirmed on
bednet-spot-check/20260728-2222: the journey passed `journey-learn-result` /
`journey-learn-submitted` and the files that landed on disk were
`form-submit-pre.png` / `form-submit-post.png` (the palette defaults). The
ace#852 `env:` fallbacks therefore *defeated* per-journey naming rather than
backstopping it, and were removed.

Unbound, Maestro renders the unset placeholder as the literal string
`undefined`, so the frame lands as `undefined.png` — and two unbound shots in
the same subflow overwrite each other. Both symptoms were observed live.

**Name `SCREENSHOT_NAME_PRE_SUBMIT` for the LAST QUESTION, never for a result
(dimagi-internal/ace#1853).** `form-submit.yaml` shoots that frame *before* the
tap that advances, so it is always a question — and on a score-gated quiz it is
the last item, not the score. Naming it `…-result` / `…-score` / `…-passed` is
therefore always false, and false in the direction that misleads: anything
reading the manifest by name captions it as the certification screen. It has
gone wrong three times — `journey-learn-m6-assessment-result` on
spark-facilitator/20260828-0703 (an ordinary assessment item),
`journey-learn-gate-result` on hh-poverty-targeting/20260828-0702 (filed in the
manifest between `…-gate-q9-answered` and `…-gate-submitted`), and once in this
repo's own lint fixture.

It is also now a collision. The score screen **is** captured: the score-gated
FINISH branch derives it as `<PRE_SUBMIT>-result`. So binding PRE_SUBMIT to
`…-assessment-result` puts the genuine outcome at `…-assessment-result-result`
while the misleading name keeps the clean one. Use `…-last-item` (or any name
describing the question), bind nothing extra for the score screen, and let the
palette derive it. *Enforced:* the `pre-submit-screenshot-name-claims-outcome`
rule in `mcp/mobile/recipe-lint.ts`, run by `mobile_validate_recipe`.

Historical context: the single-screen
over-step on bednet-spot-check run 20260528-0556 Phase 6 (a `form-advance` +
`form-submit` over a one-screen "Introduction" form) is also subsumed —
`content-form-finish.yaml` handles one-screen and N-screen content forms
under one contract.

##### Suite re-entry between modules — pick the variant PER FORM, then guard the call

**You MUST re-enter the suite root between every module** — the next
`learn-tap-module` asserts `screen_suite_menu_list` at the SUITE ROOT as its
pre-state and hard-fails otherwise (jjackson/ace#646 Gap 2).

**Where a finalize lands is NOT fixed — read it off the blueprint
(dimagi-internal/ace#1071).** `get_form` reports `post_submit` per form, and
it decides which re-entry recipe to compose:

| `post_submit` | Where the finalize lands | Re-entry recipe |
|---|---|---|
| `module` | StandardHomeActivity — the home grid (Start / View Job Status / Sync / Log out) | `learn-suite-reentry.yaml` (tap Start → wait `screen_suite_menu_list`) |
| `previous` (**Nova's default**) | the screen the form was entered FROM: the MODULE's own form list when that module HAS one, else the suite ROOT | `learn-suite-reentry-from-module.yaml` (`back` → wait `screen_suite_menu_list`), **called guarded** — see below |

**The choice is per FORM, not per APP (dimagi-internal/ace#1633).**
`post_submit: previous` means "the screen you came from", and on a
multi-module app that is **not the same screen for every module**: CommCare
**auto-skips** a module's intermediate one-row form list when the module
holds exactly ONE form whose display name DIFFERS from the module name
(`learn-tap-module.yaml`'s header records that behaviour as live-observed).
So for each form, read the shape of the module that OWNS it:

- **The module renders a form list** — it holds TWO OR MORE forms, or exactly
  one form whose name EQUALS the module name (no auto-skip). `previous` lands
  on that form list, one level inside the suite →
  `learn-suite-reentry-from-module.yaml` (`back` → suite root).
- **The module was auto-skipped** — exactly ONE form, whose name DIFFERS from
  the module name. There was no form list on the way in, so there is none to
  come back to and `previous` is the suite ROOT → the walk is already at the
  re-entry postcondition, and the re-entry must be a **no-op**. An
  unconditional `back` fired from the suite root exits the suite entirely and
  the following 15s wait then expires — the same signature #1071 records for
  the wrong variant.

**One app can be BOTH shapes at once,** which is exactly what a per-app
reading cannot express. Live: `bednet-check-2-visit/20260825-1310`, Nova Learn
app `80145765-6ad8-4617-8b5b-9ec2a4fa4bc1` — module "Baseline check" holds ONE
form ("What you know now", a different name → auto-skipped), module
"Spot-check training" holds TWO ("Training", "Final check" → a real form
list), and every form is `post_submit: previous`. Following the table per app
and firing an unconditional `back` after module 1 walks back OUT of the suite
before module 2 is ever entered — Learn never reaches 100% and Deliver stays
locked (the #897 consequence).

**Compose the call GUARDED POSITIVELY on the row you need next** — the next
module's suite-root row — so it is a no-op when the finalize already landed at
the root:

```yaml
# after the last form of module N, before module N+1's learn-tap-module
- runFlow:
    when:
      notVisible:
        text: "<NEXT MODULE ROW LABEL>"        # verbatim from get_app
        below:
          id: "${SELECTOR:learn-suite-menu}"
    commands:
      - runFlow:
          file: learn-suite-reentry-from-module.yaml
```

Guard on the row you WANT (`notVisible` the next module row ⇒ we are not at
the root yet ⇒ go back), never on the absence of the other branch's surface —
the same lesson `connect-resume-opp.yaml` and `deliver-form-walk.yaml` Level 1
already encode. This composition is also what makes the rule safe under the
one fact here that is an INFERENCE rather than a live observation: the
blueprint shapes above are quoted verbatim from `get_app`, but "an
auto-skipped module's `previous` lands on the suite root" is derived from
`learn-tap-module.yaml`'s recorded auto-skip plus the plain meaning of
`previous`, and has not been re-observed on a device. The guard is correct
under either landing; a second unconditional variant would not be.

Composing the wrong VARIANT hangs the walk. `learn-suite-reentry.yaml` opens
with a 30s `extendedWaitUntil` on the home "Start" tile; from a module form
list that tile never renders, so a multi-module walk dies after form 1 with
`Assertion is false: "Start" is visible`. Live repro:
spark-facilitator/20260728-1338 (9 modules, all `post_submit: previous`) —
the pre-test finalized and synced cleanly, then the walk hung, with the dump
showing action bar "Baseline check" and a single row "Pre-test (baseline)".

The per-module loop is therefore:

```
learn-tap-module → content-form-finish (or quiz answer-taps + form-submit)
                 → <re-entry variant per the table, GUARDED per above>
                 → (next module's learn-tap-module)
```

The FIRST suite entry (post-claim) still uses `learn-launch.yaml` regardless
of `post_submit` — it enters from the Connect handoff, not from a finalize.

**Do not try to collapse the two variants into one guarded recipe.** The
module form list and the suite root share the same `screen_suite_menu_list`
id, so no on-screen signal distinguishes "one level in" from "already at the
root"; a guard keyed on that id would press `back` out of the suite entirely
on a `post_submit: module` app. The app-metadata branch above is the reliable
discriminator. (See the header of `learn-suite-reentry-from-module.yaml`.)
That is NOT in tension with the call-site guard above: the guard there is
keyed on the NEXT ROW'S NAME — a per-journey value the palette cannot know —
not on the shared container id. Parameterising the recipe on a
`${NEXT_ROW_NAME}` would move the guard back into the palette; until it does,
the guard lives at the call site.

##### SINGLE-MODULE Learn app — use `content-form-finish-to-suite.yaml`, NOT the home round-trip (jjackson/ace#894)

The home-grid contract above holds when each Learn module is its OWN CommCare
module. But Nova frequently builds a Learn app as **one CommCare module holding
ALL N forms** (proven live on hh-poverty-targeting/20260722-1341: one module
"Poverty Targeting Enumerator Training" with 7 forms). In that shape, finishing
a form returns to the **N-form suite list (`screen_suite_menu_list`)**, NOT to
the StandardHomeActivity home grid — so `content-form-finish.yaml`'s terminal
`assertVisible learn-home-start-tile` fails, and `learn-suite-reentry.yaml`
(home→suite) mis-navigates. This was the ace#894 Deliver-blocked-Phase-6 class.

Detect single-module by reading the Nova blueprint (`get_app`): if the Learn
app has exactly ONE module containing every form, author `journey-learn.yaml`
as **drill suite-root → the module → its form list ONCE**, then per form:

```
learn-tap-module (taps the FORM ROW directly from the suite list)
  → answer any quiz inputs
  → content-form-finish-to-suite   (finalizes back to screen_suite_menu_list)
  → (next form's learn-tap-module — NO learn-suite-reentry)
```

`content-form-finish-to-suite.yaml` is `content-form-finish.yaml` re-keyed on
`${SELECTOR:learn-suite-menu}` (the suite list) instead of the home tile: a
bounded guarded advance loop (`tapOn form-nav-next` while the suite list is not
visible), a `form-nav-finish` fallback for the score-gated two-screen FINISH
(#569), then `assertVisible learn-suite-menu`. **Omit `learn-suite-reentry`
entirely** — there is no home round-trip in a single-module app. Multi-module
apps keep the finalize + re-entry loop above, whose BOTH halves are picked
from `post_submit` (dimagi-internal/ace#1566) — a multi-module
`post_submit: previous` app also finalizes with
`content-form-finish-to-suite.yaml`, but unlike the single-module shape it
still needs `learn-suite-reentry-from-module.yaml` between modules.

**Verify each transition you author against the selector map for the
active APK (`mcp/mobile/selectors/connect-<apkVersion>.yaml`, default
`2.63.2`), and against the palette recipes in
`mcp/mobile/recipes/static/`** — those two are live-calibrated and carry
per-row provenance. `docs/mobile-atlas/connect-2.63.2.md` is the narrative
companion — which screen replaces which, what fires in between, what a
transition changes as a side-effect. It is written against the default APK,
but it is **partial**: read a section's provenance tag before relying on it
(`calibrated-2.63.2` vs `carried-from-2.62.0-unverified` vs `uncovered`),
and note that its carried-over § 5 surfaces point back into the older
2.62.0 atlas, whose "Open questions" are stale — several have since been
answered in recipe headers rather than in either atlas. If a recipe needs
a transition neither source documents, flag it in the recipe header
comment and file it, rather than treating an atlas's silence as evidence.

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
- Read the label from `get_form({app_id, moduleUuid, formUuid})`'s
  response — Nova returns each form's `label` and each field's `label`
  exactly as CommCare will render them after autobuild's scaffold pass.
  Nova is **uuid-addressed** (2026-07-31; see
  `playbook/integrations/nova-integration.md § The 2026-07-31
  uuid-addressing migration`) — no tool accepts `moduleIndex` /
  `formIndex` / a bare `form_id`. Resolve the whole map with ONE
  `get_app({app_id})` (its blueprint prints `[uuid …]` on every module,
  form, and field) and reuse it for every read below; for a single
  semantic name, `search_blueprint({query, app_id})`.
- Use that string verbatim in the recipe's `tapOn:text` matcher.
- For module-list / form-list screens, read the parent module's `label`
  from `get_module` and apply the same rule.

`mobile_validate_recipe` is a static lint that accepts any
syntactically-valid string — it cannot detect a brief-vs-live drift.
Step 4 (below) adds a runtime smoke check that catches it.

#### Score-gated assessments DO render a result screen — both branches (ace#1302, confirms #569)

`spark-facilitator/20260813-2126` reported that a score-gated Learn assessment
**auto-finalized on the last answer** and went straight to `1 form sent to
server!`, so the CBF completed a payment gate with no on-screen confirmation.
The report was explicit that it had observed the **pass path only** and could
not say whether the platform or the app was at fault.

**Settled on-device, both branches** — CommCare 2.63.2 / `ACE_Probe_API_34`,
2026-08-14, on a single-question score-gated quiz with trailing
relevance-gated `result_pass` / `result_retry` labels:

| answer | `user_score` | what rendered |
|---|---|---|
| correct | 100 | `PASSED. You scored 100 percent.` + `FINISH` |
| wrong | 0 | `NOT PASSED. Go back to module 1 and read it again.` + `FINISH` |

```
cc:nav_btn_finish       [126,293][1059,419]
cc:nav_btn_finish_text  'FINISH'
TextView                'NOT PASSED. Go back to module 1 and read it again.'
```

Two consequences for how you diagnose this:

1. **A missing result screen is an APP-SHAPE defect, not platform behaviour.**
   The platform renders trailing relevance-gated labels on both branches, so
   if a walk never sees one, look at the app: are the labels reachable in form
   order, is `user_score` computed before they are evaluated, are their
   `relevant` expressions exhaustive? Do not record it as a CommCare
   limitation.
2. **ace#569's two-screen finalize needs NO qualifier.** #1302 suggested the
   rule might only hold for multi-question quizzes. It held on a
   SINGLE-question score-gated quiz: `nav_btn_next` advanced to the result
   screen, and `nav_btn_finish` was present there. So `form-submit.yaml`'s
   score-gated branch is correct as written, and a walk that reports
   `nav_btn_finish` not visible has not reached the result screen — that is
   the thing to investigate, not the rule.

#### CommCare's CHOICE DIALOG — repeat junctures and the form-exit prompt (ace#1007, #1290)

Two surfaces ACE had zero coverage for turn out to be **the same component**,
live-verified on CommCare 2.63.2 / `ACE_Pixel_API_34` 2026-08-14. Branch on
`${SELECTOR:form-choice-dialog-title}` to tell them apart — and note the
buttons are addressed DIFFERENTLY on each, which is the trap:

| Dialog | Title | Buttons |
|---|---|---|
| form exit | `Exit Form?` | **TWO buttons sharing ONE id** `choice_dialog_panel` — `STAY IN FORM`, `EXIT WITHOUT SAVING`. Disambiguate by TEXT (it is CommCare chrome, stable across apps). |
| repeat juncture | `Add a new <repeat label>?` | **THREE INDEXED buttons** — `_1` GO BACK, `_2` ADD A NEW …, `_3` DO NOT ADD. Prefer the INDEX: `_2`'s label interpolates the repeat's own name, so a text matcher is app-specific and brittle. |

**Repeat junctures (ace#1007).** A `kind: repeat` field brackets each
repetition with an entry prompt and an "add another?" exit prompt. Until now
neither had a selector, an atlas section, or a palette recipe, so
`app-test-cases` could not author the roster leg at all and MARKED the region
instead — and the Deliver leg then hard-failed there on-device. To walk PAST a
repeat without entering it, tap `${SELECTOR:form-repeat-juncture-skip}`
(`DO NOT ADD`); verified live to land on the question following the repeat. To
enter one, tap `${SELECTOR:form-repeat-juncture-button}`.

**The form-exit prompt (ace#1290).** A back-press from inside a form lands
here, NOT on the previous screen. That is what killed the Deliver smoke on
`spark-facilitator/20260813-2126`: `form-submit` did not finalize the
registration form, the inter-leg back-walk pressed back twice, and the walk
asserted `Start` while sitting on `Exit Form?`. Any guarded back-walk between
Deliver legs MUST handle this dialog — see the two-leg re-entry snippet above
(ace#1191) — and a `form-submit` that leaves the device here has NOT submitted,
whatever its POST_SUBMIT screenshot shows.

#### `kind: date` questions and the inline DatePicker — MANDATORY (ace#1081, #1300)

The skill's answer-tap rule enumerates `single_select`, `image`, `text`,
`decimal`, `geopoint` and hidden fields. It says nothing about
`kind: date`, and the selector map carried no date row until 2026-08-14.

**The widget, live-calibrated** (CommCare 2.63.2 / `ACE_Pixel_API_34`,
portrait 1080x2400):

```
DatePicker                  [214,1208][865,1765]      (no resource-id — match by class)
  NumberPicker  month       [235,1250][403,1723]      numberpicker_input "Aug"
  NumberPicker  day         [445,1250][613,1723]      numberpicker_input "14"
  NumberPicker  year        [655,1250][823,1723]      numberpicker_input "2026"
```

Rows: `form-date-picker`, `form-date-picker-container`,
`form-date-picker-column`, `form-date-picker-input`.

**NEVER scroll a field-list screen from its centre when it carries a date
question.** Each NumberPicker column is `scrollable=true`, so a
centre-origin swipe — which is exactly what `scrollUntilVisible` issues —
is **consumed by the picker and spins the date**. Measured on-device:

```
portrait   swipe x=540  (centre)   Aug 14 -> Aug 22    page did NOT move
landscape  swipe x=1200 (centre)   Aug 22 -> Aug 25    page did NOT move
landscape  swipe x=300  (edge)     Aug 25 -> Aug 25    no mutation
```

Both halves bite: questions below the picker are unreachable, **and** a
payment-gating field is silently changed by an automation gesture with no
error and nothing able to assert against it. Use `safeScrollOriginX`
(`lib/fieldlist-gestures.ts`) to pick an origin outside the picker's
x-range, and assert the date via `form-date-picker-input` afterwards —
that read-back is the only surface that reports what the picker now holds.

**Driving the picker — one tap per step, live-calibrated (ace#1081).** Each
column renders three children in order:

```
Button    previous value      day column [445,1250][613,1423]   "13"
EditText  numberpicker_input  day column [445,1423][613,1549]   "14"   <- current
Button    next value          day column [445,1549][613,1723]   "15"
```

**Tapping the lower Button increments that column by exactly one** —
measured with read-back: Aug 14 → 15 → 16 on two separate taps. Always read
the result back from `${SELECTOR:form-date-picker-input}`; never assume the
tap landed.

Do **not** swipe inside a column to set a value. A swipe also moves it, but
by an unpredictable number of steps (one centre swipe jumped Aug 14 → 22) —
that is the ace#1300 hazard, not a drive mechanism.

So a strictly-future constraint IS walkable, and usually with a single tap:

```
next_meeting_date   validate: . > today() and . <= date(today() + 30)
```

The widget defaults to today, which fails `. > today()`. **One** tap on the
day column's next-value Button makes it tomorrow, satisfying both clauses.
Only a constraint with a far-future floor needs a longer sequence — and
there, bounds stability across a long burst and month/year rollover are
**not yet calibrated**, so verify on-device before authoring one.

#### Quiz / required-input answer-tap rule — MANDATORY

A `form-advance.yaml` (or any direct `nav_btn_next` tap) on a
required-input question with no answer selected surfaces
`warning_root` ("Sorry, this response is required!" per atlas §7),
stalling the recipe. Every required-input question in a Maestro
recipe **MUST** be preceded by an explicit answer-selection step:

```yaml
# CORRECT — answer is tapped before advancing, and the advance names its frame
- tapOn:
    text: "Public hospital"      # literal option text from Nova get_form
- runFlow:
    file: form-advance.yaml
    env:
      SCREENSHOT_NAME: "journey-learn-m1q2-facility-answered"

# WRONG — no answer tap; nav_btn_next stalls on warning_root
- runFlow:
    file: form-advance.yaml      # required-input question is unanswered
    env:
      SCREENSHOT_NAME: "journey-learn-m1q2-facility-answered"
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
`form-advance.yaml` step for every display/label node — both leading ones
before the first input AND interior ones between inputs — with NO answer tap on
those advances** (a display node has nothing to select; it's the input-node
rule above, inverted). A form `[intro(label), q1(single_select, required)]`
therefore composes as: `form-advance` (past intro) → `tapOn: <q1 option>` →
`form-advance`/`form-submit`.

**This rule is now statically enforced** (dimagi-internal/ace#1045). It was
prose-only from #710 (2026-06) to #1045 (2026-07-31), and it recurred in that
window — a golden `journey-learn.yaml` authored a month after #710 closed did
`learn-tap-module` → `takeScreenshot` → `tapOn: <q1 option>` with no
intervening advance, so the tap landed on the `intro` label screen and killed
the Learn leg (bednet-spot-check/20260729-0002). `recipe-sanity-probe` now
counts the form's LEADING `kind: label` nodes (skipping `hidden`, which render
nothing) and fails `answer-tap-before-leading-label-advance` when the recipe
emits fewer bare advances than that between the menu-walk entry step
(`learn-tap-module` / `deliver-form-walk`) and its first answer tap — naming
expected vs found. Field-gated: it needs Step 2.6's caller to supply
`fields`, exactly like `group-field-list-per-question-walk`. It is the
inverse of the #858 permissive carve-out, which bounds the same advance
count from above; the two cannot conflict.

**The score-gated finalize (#569) is now statically enforced too**
(dimagi-internal/ace#1118): a trailing `relevant`-gated label pair means
`form-submit.yaml` performs the answer→result advance itself, so do NOT
chain an extra `form-advance` between the last required answer and
`form-submit` — the probe fails `score-gated-quiz-over-advance` when one is
present beyond what the form's UNGATED trailing label screens license.
Field-gated like its siblings, and it needs each trailing label's
`relevant` flag in the supplied `fields` (Step 2.6's caller passes it).

For each form-walk segment of a recipe:

1. Call `get_form({app_id, moduleUuid, formUuid})` — uuids off the
   `get_app({app_id})` map per § Use live labels — and inspect each
   field's `kind` + required-ness, **in document order**.
1.5. Walk the fields in order. For every leading or interior **display/label
   node** (`kind: label` / a display-only node with no input widget), emit one
   `runFlow` into `form-advance.yaml` with NO preceding answer tap (but still
   with its own `env: { SCREENSHOT_NAME: ... }` — see § Screenshot names are
   caller-bound) — it advances past the intro/instructions/result screen to the
   next node (jjackson/ace#710). Do this BEFORE the first answer tap when the
   form's first node(s) are display nodes.
2. For every `kind: single_select` field that's required, emit a
   **guarded-scroll option tap** BEFORE the `form-advance.yaml` step. The
   option label comes from the field's `options[].label` in the Nova
   blueprint — verbatim, not paraphrased, not derived from the PDD brief.

   ```yaml
   - runFlow:
       when:
         notVisible:
           text: "<literal option label>.*"
       commands:
         - scrollUntilVisible:
             element:
               text: "<literal option label>.*"
             direction: DOWN
             speed: 30
             timeout: 20000
             visibilityPercentage: 60
             centerElement: true
   - tapOn:
       text: "<literal option label>.*"
   ```

   **Both halves are load-bearing, and they fail in opposite directions
   (dimagi-internal/ace#1070).** A bare `tapOn` with no scroll misses any
   option below the fold — a long option label on a small screen pushes the
   4th option off, and this was measured on trilingual labels (en/nya/tum),
   where a 4-option question routinely rendered ~3 options per screen. This
   case is **back in full force as of 2026-08-17** (PR #1463, superseding ace#968/#1391): ACE
   builds a real per-language layer again, and a translated label is often
   LONGER than its English source, so plan for the same off-screen options
   the trilingual builds hit. (It briefly went rare during the English-only
   window, 2026-08-14..2026-08-17.) Both halves below are unchanged. But an
   *unconditional* `scrollUntilVisible` is equally wrong: on a question
   whose options already fit, there is nothing to scroll, and CommCare's
   form view reads the resulting no-op swipes as **backward form
   navigation**, walking the flow out of the form to an "Exit Form?"
   dialog. The `when: notVisible` guard is what makes one recipe correct
   for both shapes.

   Live repro of each half, same app, same walk
   (spark-facilitator/20260728-1338, 2026-07-30): pre-test q4's correct
   option sat below the fold and a bare tap could not reach it; post-test
   q6's four options all fit, and an unconditional scroll exited the form.

   Do NOT reach for `scroll` or a fixed swipe count instead — those are
   unguarded by construction and reproduce the q6 failure.
3. For `kind: image` required fields, emit the photo-capture sequence
   (`camera-take-photo` → `camera-shutter-button` → `camera-save-photo`)
   before advance.
4. For `kind: text` / `kind: decimal` required fields, emit `inputText`
   with a plausible sample value before advance. **On a field-list
   (`kind: group`) screen a bare `inputText` only lands for the FIRST
   input** — CommCare autofocuses that one and nothing else. Every later
   input needs the calibrated focus sequence of § Step 3 item 3:
   unconditional centring scroll at `speed: 30` on the element
   immediately above the `EditText` (its `hint` when it has one, else the
   question label), then `tapOn: below: <that anchor>`, then `eraseText`,
   then `inputText`, then `hideKeyboard` (ace#1299, ace#1844).
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
   coordinates (**longitude first**; AVD backend only — unsupported on
   the cloud emulator backend); see
   `playbook/integrations/mobile-integration.md`, (b) tap
   `${SELECTOR:geopoint-record-location}` — the widget's button ships
   **TWO labels**, and the mapped selector is the alternation
   `(RECORD|REPLACE) LOCATION` that accepts both. It renders
   **"RECORD LOCATION"** when the field is EMPTY (live-calibrated
   2026-07-13 on hh-poverty-targeting/20260702-1456,
   dimagi-internal/ace#861) and **"REPLACE LOCATION"** when it ALREADY
   HOLDS A VALUE (live-captured 2026-09-01 on
   spark-facilitator/20260828-0703, dimagi-internal/ace#1879). The
   second label is not an edge case: a case-bound geopoint on a followup
   form is implicitly preloaded from the previous visit
   (dimagi-internal/ace#1809), so **every walk after the first against
   the same case meets REPLACE, not RECORD**. Never re-hardcode the
   single-label string — always go through the selector map, or the
   recipe passes on walk 1 and dies on walk 2. (The Button carries no
   resource-id, and the earlier "Capture Location" guess does not exist
   on-device.) (c) The tap **auto-captures** when a
   mock fix is pre-seeded — wait for the Latitude/Longitude/Altitude/
   Accuracy readout to render under the button (no separate capture
   dialog). On the REPLACE branch that readout, and the
   "Location accuracy is good." label, are ALREADY on screen before the
   tap — carried over from the previous visit — so do not treat their
   presence as proof this walk captured a fresh fix. If a FUTURE APK
   version changes the widget, re-calibrate
   against a live dump of that build (per "close the loop to the source
   of truth") — never transcribe from a sibling build (that's exactly how
   the #593/#686 "GPS is a plain text field" misdiagnosis propagated).
4.7. For `kind: date` fields, the CommCare date widget **defaults to
   today**, so a date question whose `validate` accepts today needs NO
   interaction at all — emit the plain `form-advance.yaml` and the
   pre-filled default carries the screen (`. <= today()` and
   `. >= today()` constraints both fall in this class). A
   **strictly-future or strictly-past** constraint (e.g.
   `. > today() and . <= date(today() + 30)`) is different: today
   violates it, and there is currently **NO calibrated date-widget
   selector** in the APK selector map (no picker / spinner / calendar
   row — dimagi-internal/ace#1081), so the recipe **cannot** drive the
   widget to any other date. Do NOT guess a selector (banned by "close
   the loop to the source of truth") and do NOT chain `form-advance`
   into the constraint error. Instead the journey must **flag it**: the
   Step 5 date-default static gate (below) fails loud naming the field;
   route the smoke through a branch that avoids the field when the form
   has one, and otherwise halt with a `[BLOCKER]` referencing ace#1081
   (the selector row needs live-device calibration before such a field
   is walkable). Statically verify with
   `lib/date-default-validate.ts` rather than eyeballing the
   expression.
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
- **Learn-module completeness — `journey-learn.yaml` MUST finalize EVERY learn-module-bearing form (jjackson/ace#897).** Connect gates Deliver on `learn_progress == 100%` — a `CompletedModule` for **every** `connect.learn_module` marker — and a module only registers when the form carrying its block is **finalized/submitted** on-device (`form_receiver/processor.py::process_learn_modules`). So a Learn smoke recipe that walks the assessment + only *some* content forms leaves Learn stuck below 100% and Deliver permanently locked (canonical: hh-poverty-targeting/20260722-1341 — 4/5 modules, 80%, Deliver locked, mis-blamed on the platform). **Assert:** read the Learn app via `get_app`, collect the set of forms carrying a `connect.learn_module` block, and confirm `journey-learn.yaml` finalizes **every one of them** (each is walked to submit — `content-form-finish[-to-suite]` or a quiz answer+`form-submit`, not skipped). The count of module-forms the recipe finalizes MUST equal the number of `connect.learn_module` markers. If any module-bearing form is not finalized by the recipe, the walk cannot reach 100% — fix the recipe before writing `app-test-cases.yaml` (do not ship a Learn smoke that structurally can't complete Learn). Phase 6's runtime Connect-learn-completion gate (`app-screenshot-capture`) is the backstop that catches a partial completion live; this static check prevents authoring one.
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
- **Date-default static gate — every smoke-walked form
  (dimagi-internal/ace#1081).** The date widget defaults to today and no
  calibrated date-widget selector exists, so a required `kind: date`
  field whose `validate` rejects today is un-walkable — and without this
  gate that is discovered on the emulator in Phase 6, not here.

  **"Defaults to today" is TRUE ONLY ON A FIRST VISIT TO A CASE
  (dimagi-internal/ace#1982).** A `kind: date` field that is ALSO a case
  property is preloaded by Nova on a repeat visit, exactly like the
  attendance, participation and geopoint fields the AS-FOUND screenshots
  already capture — so it arrives holding the PREVIOUS visit's date, not
  today's, and a recipe that "just advances past it" files the old date
  as the new meeting's date. **On any journey that returns to an existing
  case, a case-bound date field MUST be explicitly driven or explicitly
  asserted; never advanced past on the default-is-today assumption.**

  Live on `spark-facilitator/20260828-0703`. `journey-deliver-followup-preload`
  carried the comment *"group `Meeting date` — default (today) satisfies
  `. <= today()`. Not driven."* and advanced. Three meetings walked on
  01 Sep each submitted `date_of_meeting = 2026-08-29` — the device clock
  was correct (`timeEnd` = 01 Sep on all three), and `date_of_meeting` is
  a case property carrying `2026-08-29`. `last_meeting_date` is
  `calculate`d from `date_of_meeting`, so the case's "Last meeting"
  column never advanced, and the deep app-UX verdict opened with a
  BLOCKER reading *"the community case's durable state does not advance
  on a real meeting"* — a defect in the harness reported as a defect in
  the product.

  The cost of the wrong attribution is the point: that BLOCKER drove a
  `reject` disposition and two rounds of investigation into a case-write
  path that was working correctly the whole time. For each
  form a smoke recipe walks (`forms_exercised`), feed the form's fields
  (from `get_form`: `id`, `kind`, `required`, `validate`) through the
  pure helper:

  ```ts
  import { checkDateDefaultValidate, formatDateDefaultValidateReport }
    from '../../lib/date-default-validate';
  const report = checkDateDefaultValidate(fields);
  ```

  - A `verdict: 'violated'` row → **`[BLOCKER]` naming the field** (its
    `fieldId` + the `validate` expression, via
    `formatDateDefaultValidateReport`): the recipe cannot advance past
    that screen. Remediation options, in order: rebind the journey to a
    branch that avoids the field (record which branch and why — the
    payable-path coverage loss must be explicit, per ace#1081's
    spark-facilitator repro); otherwise halt — the field needs the
    ace#1081 selector-map calibration (live-device work) before it is
    walkable. Never ship a recipe that `form-advance`s into the
    constraint error.
  - A `verdict: 'unverifiable'` row → `[WARN]` naming the field and the
    reason; confirm by hand that today satisfies the expression before
    shipping the recipe. Never treat unverifiable as a pass.
- **Transition criteria must assert a DELTA, not presence
  (dimagi-internal/ace#1885).** A criterion whose *name* claims a state
  transition — `updated`, `changed`, `advanced`, `incremented`,
  `decremented`, `refreshed`, `moved`, `cleared`, `reset`, `increased`,
  `decreased` — MUST be verified by an assertion that could only hold
  AFTER the transition. An assertion that would pass identically before
  and after it is not a test of the transition: the test cannot fail for
  the reason it exists. Canonical failure: on
  `spark-facilitator/20260828-0703`, `journey-deliver-followup-preload`
  declared `case_state_updated_after_submit` and the generated recipe
  asserted it as `assertVisible: { text: "Chilanga.*", childOf: { id:
  "${SELECTOR:case-list-container}" } }`. That proves the **row exists**.
  Behind it sat a real `blocks-e2e` defect — three submitted-and-synced
  meetings dated 01 Sep did not advance Chilanga's `last_meeting_date`
  (stale at 08:40, 08:49 and 09:00) while the control case Nsanje Central
  updated correctly in the same frame, and Connect reported
  `delivered: 4`. **The harness went green;** only the screenshot judge
  caught it, after the fact.

  Exactly two shapes count as proof, and the check is mechanical:

  1. **A captured-pair comparison.** A capture step (`copyTextFrom`, or
     an `evalScript` that writes `output.*`) BEFORE the transition, and a
     later `assertTrue`/`assertFalse` whose expression reads that
     capture. This is the only shape that observes both sides.
  2. **A declared expected NEW value.** Write the criterion as
     `{ name: <criterion>, expected_value: <the new value> }` in
     `structural_pass_criteria` and assert that literal in the recipe.
     The literal must NOT also be a navigation target earlier in the
     recipe — a string the recipe TAPPED to get here is on screen before
     the transition too, so asserting it proves nothing.

  **Run the gate before writing `app-test-cases.yaml`** (and again in
  `/ace:qa-deep` when a deferred deep recipe is generated), feeding it
  each journey's criteria plus its composed recipe steps in file order:

  ```ts
  import { checkTransitionCriteria, formatTransitionCriteriaReport }
    from '../../lib/transition-criteria';
  const report = checkTransitionCriteria(journeys);
  ```

  Every violation is a `[BLOCKER]` naming the journey, the criterion and
  the assertions the recipe does carry (via
  `formatTransitionCriteriaReport`). Fix the recipe — or, if the delta
  genuinely cannot be observed on-device, RENAME the criterion to what it
  actually checks (`case_row_present_after_submit`) and record the lost
  coverage. Never leave a transition-named criterion standing on a
  presence assertion; that is the ace#1885 silent green.
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
| 2026-09-05 | **A case-bound date field does NOT default to today on a repeat visit (closes dimagi-internal/ace#1982).** The Step 5 date-default gate's premise — "the date widget defaults to today" — holds only on a FIRST visit. Nova preloads a `kind: date` field that is also a case property, so on a follow-up journey it arrives holding the previous visit's date, and a recipe that advances past it files the old date as the new meeting's. Live on `spark-facilitator/20260828-0703`: `journey-deliver-followup-preload` declared the date "Not driven", and three meetings walked on 01 Sep each submitted `date_of_meeting = 2026-08-29` with a correct device clock. Because `last_meeting_date` is calculated from it, the case's Last-meeting column never moved and the deep app-UX verdict opened with a BLOCKER blaming the product's case-write path — which was working correctly throughout. A journey returning to an existing case must now drive or assert a case-bound date field explicitly. | ACE team |
| 2026-09-01 | **A transition criterion must assert a DELTA, not presence (dimagi-internal/ace#1885).** Step 5 gains a static gate: a criterion whose NAME claims a state transition (`updated`, `changed`, `advanced`, `incremented`, `refreshed`, `moved`, `cleared`, …) must be verified either by a captured-pair comparison (`copyTextFrom` / `evalScript` before, `assertTrue` reading it after) or by a declared `expected_value` the recipe asserts and never taps. Earned by `spark-facilitator/20260828-0703`, where `journey-deliver-followup-preload` declared `case_state_updated_after_submit` and asserted it as `assertVisible "Chilanga.*"` — proof the ROW EXISTS, not that the date moved — and went green over a real `blocks-e2e` defect (`last_meeting_date` stale across three synced meetings while a control case updated in the same frame). The test could not fail for the reason it existed. *Enforced:* `lib/transition-criteria.ts` + `test/lib/transition-criteria.test.ts`, whose calibration fixture is that exact criterion and assertion. | ACE team |
| 2026-08-29 | **Every emitted `- inputText` must be immediately preceded by `- eraseText` (closes dimagi-internal/ace#1844).** Maestro's `inputText` appends at the cursor rather than replacing, so any field carrying a Nova casedb preload (ace#1809), an XForm default, or a stray character received the recipe's value concatenated onto the existing one. Live on `spark-facilitator/20260828-0703` Phase 6 (ACE 0.13.1080, APK 2.63.2): the recipe typed `40` into `hh_represented_at_the_meeting`, the field held `140`, the form's cross-field constraint correctly refused to advance, and the leg died two screens later on a Participation scroll — reading as a selector fault it was not. Re-running the identical leg with `eraseText` inserted before each of the 6 `inputText` calls passed end-to-end (`{delivered: 1, approved: 1, rejected: 0}`). The dangerous half is that wherever the concatenation does NOT trip a constraint the corruption is silent and the leg reports `pass` on wrong data. *Enforced:* `recipe-sanity-probe`'s new `input-without-erase` — pure recipe shape, so unlike its field-gated siblings it runs unconditionally, and unlike them it carries no false-positive tax (a redundant erase on an empty field is a runtime no-op). `findInputFocusSteps` now sees through the interposed `eraseText`, so the ace#1554 checks don't go silently dead on recipes authored under the new rule. | ACE team |
| 2026-08-25 | **Learn suite re-entry is selected PER FORM, not per app, and the call is guarded (closes dimagi-internal/ace#1633).** § Suite re-entry between modules picked the finalize/re-entry pair from a single per-APP reading of `post_submit`, but where a `previous` finalize lands is a property of the OWNING MODULE: CommCare auto-skips a module's one-row form list when the module holds exactly one form whose name differs from the module name, so `previous` lands on the suite ROOT there and on the form LIST everywhere else. One app can be both shapes at once — `bednet-check-2-visit/20260825-1310` (module "Baseline check": one form "What you know now"; module "Spot-check training": two forms; all `post_submit: previous`) — and the per-app table then prescribes an unconditional `back` that walks OUT of the suite after module 1, hanging the walk before module 2 (the #1071 signature, #897 consequence). The section now states the per-form rule with both module shapes spelled out, and every composition of `learn-suite-reentry-from-module.yaml` is guarded POSITIVELY on the next module's suite row (the workaround that run shipped), which is correct under either landing. The 2x2 stays as the choice of WHICH recipe; the finalize half is landing-agnostic because `content-form-finish-to-suite.yaml` exits on the `learn-suite-menu` alternation. *Enforced:* `test/skills/learn-suite-reentry-guarded.test.ts`. | ACE team |
| 2026-08-23 | **§ Multi-screen content forms now branches on `post_submit` (closes dimagi-internal/ace#1566 — the finalize half of the #1071 class).** The section prescribed `content-form-finish.yaml` unconditionally for every content form while § Suite re-entry between modules already branched, so a multi-module Learn app whose forms are `post_submit: previous` (Nova's default) got a finalize recipe whose bounded advance loop and terminal assert are both keyed on the home-grid `learn-home-start-tile` — a surface that never renders when the finalize lands on the module's own form list. Live: bednet-check-2-visit/20260820-0832 (2 modules, 5 forms, all `previous`). Finalize + re-entry are now stated as one 2x2 (multi/`module` → `content-form-finish` + `learn-suite-reentry`; multi/`previous` → `content-form-finish-to-suite` + `learn-suite-reentry-from-module`; single-module → `content-form-finish-to-suite`, no re-entry). Enforced by `test/mcp/mobile/static-recipe-invariants.test.ts § home-anchored finalize is post_submit-gated`. | ACE team |
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
| 2026-07-30 | **Add § answer-tap rule step 4.7 (`kind: date`) + the Step 5 date-default static gate (the static half of dimagi-internal/ace#1081).** The date widget defaults to today, so `<= today()` / `>= today()` constraints need no interaction — but a strictly-future/past constraint has NO calibrated selector (the connect-2.63.2 map carries no date-widget row), so today violating the constraint makes the screen un-walkable. New pure helper `lib/date-default-validate.ts` (`checkDateDefaultValidate`) statically evaluates each required date field's `validate` with `.` = today; Step 5 now BLOCKER-gates a violation naming the field (and WARNs on unverifiable expressions) at Phase 3 instead of burning Phase 6 wall-clock (spark-facilitator/20260730-1718 repro: `next_meeting_date` with `. > today() and . <= date(today() + 30)` silently rerouted the Deliver smoke to the non-payable branch). The selector-map date-widget row itself stays open on ace#1081 pending live-device calibration. | ACE team |
| 2026-08-01 | **Close dimagi-internal/ace#1138 Gap 2 — the followup/case-select leg.** New `mcp/mobile/recipes/static/deliver-case-select.yaml` + four live-calibrated case-list rows in `connect-2.63.2.yaml` (`case-list-container`, `case-list-header`, `case-list-row-cell`, `case-list-detail-continue`), captured from a real `EntitySelectActivity` ui-dump on ACE_Pixel_API_34 / CommCare 2.63.2 (spark-facilitator/20260731-0656). `deliver-form-walk.yaml` now composes the case handoff BETWEEN Level 1 and Level 2 — CommCare collects the case BEFORE the form (module -> case list -> detail CONTINUE -> form list -> form), and the detail screen is a real screen the walk must cross. Authors bind `CASE_NAME`; the `[BLOCKER]` halt for followup-only payable forms is retired. Also fixes a latent defect in Gap 1's shipped recipe: the Level-1 positional fallback guarded only on `notVisible: ${MODULE_NAME}`, which flips TRUE once the named branch navigates away, so it fired on the case list and died on `row_txt` not found. Enforced by four new invariant blocks in `test/mcp/mobile/static-recipe-invariants.test.ts` (positive-guard rule, container-scoped case tap, detail-CONTINUE crossing, handoff ordering), each proven non-vacuous. | ACE team |
| 2026-07-31 | **The leading-label rule is now STATICALLY ENFORCED (closes dimagi-internal/ace#1045); nested `runFlow.env` finally feeds the module/form checks (closes #1068).** § Quiz / required-input answer-tap rule → "Leading (and interior) display/label screens" had been prose-only since #710/#684, and recurred in that window (bednet-spot-check/20260729-0002: a golden `journey-learn.yaml` tapped a q1 option with no advance past the `intro` label, killing the Learn leg and locking Deliver). `recipe-sanity-probe` gained `answer-tap-before-leading-label-advance` — counts the walked form's leading `kind: label` nodes (skipping `hidden`) and fails when fewer bare advances sit between the menu-walk entry step and the first answer tap, naming expected vs found. It's the inverse of the #858 permissive carve-out and is field-gated like `group-field-list-per-question-walk`. Same PR taught `extractRecipeParameters` to walk NESTED `runFlow.env` maps (the shape Phase 3 emits), so `expected-module-not-in-app` / `expected-form-not-in-module` can fire at all — they had been silently inert — plus a `module-form-checks-not-run` WARN + `observed.module_form_checks_ran` so an inert check never reads as a clean pass. Still prose-only: the score-gated over-advance class (#569). | ACE team |
| 2026-07-31 | **Menu anchors are display-mode-agnostic; a single-container anchor is now a CI failure (closes dimagi-internal/ace#1127).** #1082/PR #1100 correctly made Phase 3 `app-hq-settings` apply GRID menu display app-wide — and because every Phase 6 menu anchor resolved to the LIST container `screen_suite_menu_list` ALONE, no shipped palette recipe could execute on any ACE opp (bednet-spot-check/20260731-1353: Learn halted at `learn-launch.yaml`, Deliver walled identically, Phase 6 `verdict: blocked`, apps confirmed healthy server-side). CommCare renders the SAME `row_img`/`row_txt` rows in either container; only the container id changes. Fix: `learn-suite-menu` / `deliver-suite-menu` are now regex alternations (`org.commcare.dalvik:id/(screen_suite_menu_list|grid_menu_grid)`) in connect-2.63.0 + 2.63.2, `deliver-form-walk.yaml`'s two RAW container literals now route through the map, and a new `menu-container anchors are display-mode-complete` invariant suite fails on (a) any palette file hardcoding a container id, (b) any selector-map row naming one container but not all, (c) any RESOLVED palette anchor that isn't complete. Adding a future display mode = one id in `KNOWN_MENU_CONTAINERS` + one map edit. | ACE team |
| 2026-06-01 | **Learn content forms are multi-screen + finalize to StandardHomeActivity (closes #646).** Two new static palette pieces: `content-form-finish.yaml` (bounded multi-screen advance loop that taps `nav_btn_next` until a Learn CONTENT form auto-finalizes, exits on the `learn-home-start-tile` home anchor — NOT the suite menu — handles the score-gated two-screen FINISH, and asserts the home grid post-finalize) and `learn-suite-reentry.yaml` (the explicit "tap Start → wait `screen_suite_menu_list`" re-entry that MUST run between every module, because a Learn form finalizes to the home grid not the suite menu). Added §§ "Multi-screen content forms" + "Suite re-entry between modules"; the prior single-screen-only content-form note is subsumed. Closes the malaria-rdt/20260601-0929 Phase 6 Learn-walk blocker (recipe walked each content form as single-screen and called the next `learn-tap-module` directly, stalling on page 2 then hard-failing the suite-menu assert). Validated structurally (`mobile_validate_recipe` + selector-resolution gate against connect-2.63.0); full live re-walk lands on the next fresh-run Phase 6 (this run consumed its one-way Learn state). | ACE team |
| 2026-08-01 | **Migrated Nova reads to uuid addressing (ace#1132).** Nova's 2026-07-31 redeploy moved its whole surface from `moduleIndex`/`formIndex`/`fieldId` to `moduleUuid`/`formUuid`/`fieldUuid`. Two `get_form` reads here named uncallable operations — § Use live labels passed a bare `form_id`, and the per-form-walk field read in § Emitting a form-walk segment passed the index pair — both rejected server-side with `unrecognized_keys`. Both now pass `{app_id, moduleUuid, formUuid}`, resolved ONCE from `get_app({app_id})` (its blueprint prints `[uuid …]` on every module, form, and field), with `search_blueprint({query, app_id})` for a single semantic name. Enforced by `test/skills/nova-uuid-addressing.test.ts`. | ACE team |
| 2026-08-20 | **Sanction the hint-anchored focus tap ace#1299 actually validated (closes ace#1547).** PR #1397 closed ace#1299 COMPLETED but left § Step 3 item 3 declaring both replacement idioms un-emittable until proven on a live device, 14 hours after that issue's own follow-up comment proved the hint-anchored one on-device (isolated probe, `spark-facilitator/20260813-2126`: `cbf_name` and `phone_number` landed in their OWN fields). Read literally, that made any Deliver field-list with more than one text input unauthorable — Step 2.6 halts `[BLOCKER]` and Phase 6 gets zero Deliver screenshots (observed on `hh-poverty-targeting/20260819-1435`). Item 3 now carries the validated rule (**the focus anchor is the element immediately above the `EditText` — the field's `hint` when it has one, the question label when it does not**), the validated idiom, and the guarded-vs-unconditional discriminator: guarded when the anchor IS the tap target (ace#1070 stands for option taps), unconditional when the anchor is a DIFFERENT element from the tap target, because there `when: notVisible: <anchor>` is structurally blind to the real failure ("anchor visible, its EditText still below the fold"). `speed: 30` replaces `speed: 80` in the option snippet — at 80 the centring scroll overshot a ~300px radio band and halted the leg (ace#1299). Index-based anchoring stays uncalibrated. Same reconciliation applied to `docs/mobile-atlas/connect-2.63.2.md` § 1, `mcp/mobile/selectors/connect-2.63.2.yaml` (`form-question-input*` prose), and the `group-field-list-per-question-walk` remediation string in `mcp/mobile/recipe-sanity-probe.ts`, which still taught the inert bare `below:` tap. Pinned by `test/mcp/mobile/static-recipe-invariants.test.ts § app-test-cases field-list input focus contract`. | ACE team |
| 2026-08-23 | **Both halves of the § group-field-list item-3 input rule are now STATICALLY ENFORCED (closes ace#1554).** ace#1299 § 4 specified two checks and called them explicitly unit-testable; neither had landed, because `NovaFieldSlice` carried no `hint` — `grep -n "hint" mcp/mobile/recipe-sanity-probe.ts` returned exactly one hit, prose inside a remediation string. So the probe returned a clean `ok: true` with `field_data_supplied: true` on the very recipe that produced `cbf_name = "Thandiwe Banda0991234567"` with a required `phone_number` empty. `recipe-sanity-probe` gains `input-anchor-skips-hint` (a focus tap anchored on the QUESTION LABEL of a hint-carrying field — the anchor resolves to the hint TextView and the tap moves no focus) and `input-focus-scroll-is-guarded` (a `when: notVisible: <anchor>` wrapper around the centring scroll, structurally blind to "anchor visible, its EditText still below the fold" — ace#1299's "more important half"), plus `hint?: string` on `NovaFieldSlice` and `observed.hint_data_supplied`. Filed un-bundled from ace#1547/PR #1553 precisely because a false positive here halts Phase 3 in an `incomplete` re-author loop, so both checks default to SILENCE under uncertainty: the hint check reads only fields that positively carry a `hint` (missing hints ⇒ no-op, never an assumed "no hint"), an ambiguous anchor attributes to nothing (the ace#1548 rule), a hint-less field anchored on its label is CORRECT and never flagged, and the guard check fires only on the `tapOn: below:` + `inputText` shape, never on an option tap where ace#1070 keeps the guard right. Step 2.6's caller must now pass `hint` alongside `label` (omit the key when there is none). Pinned by 22 cases in `test/mcp/mobile/recipe-sanity-probe.test.ts`, half of them "does NOT flag". | ACE team |
