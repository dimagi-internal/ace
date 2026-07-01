# App component library (`_app-component-library.md`)

Reference document, **not a skill** — the leading `_` excludes it from the
skill catalog (same convention as `_eval-template.md`, `_qa-template.md`).
It is never invoked; the build skills read it and assemble their
`/nova:autobuild` brief from it.

This is the **single source of truth** for the *deployable-by-default* field /
calculate / constraint patterns the CommCare build skills emit. Each component
is a named, parameterized building block with a **verbatim brief paragraph**
the build skill drops into the autobuild brief. The library exists so depth is
the **default** — not bespoke hand-craft re-derived per opportunity — and so a
new build skill or archetype can emit a component by name instead of
reinventing it.

**Provenance.** The component set was distilled 2026-05-29 from the field-level
comparison of ACE's ITN build (`malaria-itn-app/20260528-1607`) against
Sarvesh's hand-finished `[Final]` ITN builds — where ACE scored 9.6 on a
hollow build that a domain expert would not deploy. See
`docs/superpowers/specs/2026-05-29-eval-fitness-gap.md` and the comparison doc
`1Ch8Hb9byn3mIz1p0oi7qqB_KS2CHPIlrgrgWmEJsSDA`.

## How the build skills use this file

In Step 3 (brief assembly), the build skill:

1. Determines which components are **triggered** for this app, from the PDD and
   the archetype (see each component's **Trigger**).
2. For every triggered component, inserts its **Brief paragraph** into the
   `/nova:autobuild` brief **verbatim**, in its own paragraph, prefixed
   `REQUIRED:`, substituting any `<PARAM>` placeholders from the PDD.
3. Skips components whose trigger doesn't fire (e.g. no GPS radius in the
   Evidence Model → no `gps-accuracy-capture`).

**The symmetry that makes this safe.** Every component pairs 1:1 with the eval
dimension that **hard-fails** a build which omits it (the **Enforced by**
field). If the brief assembly drops a triggered component, the matching
`pdd-to-*-app-eval` fitness dimension catches it as a build failure — not a
silent quality gap. Build-emit and eval-grade are deliberately symmetric: this
library and the eval rubrics are two views of the same contract.

## Generic vs opportunity-specific (open decision #2, resolved 2026-05-29)

These components are **generic** — they apply to any data-capture or training
app of the relevant archetype, so they live here and are emitted by name.

What is **NOT** a library component (stays opportunity-specific hand-craft,
authored from the PDD per run):

- **Deliver form architecture** — single comprehensive visit form vs. two
  linked visit forms. This is a per-intervention design decision (and a
  Phase-1 `evidence_basis` call — see `idea-to-pdd`), not a reusable component.
- **Domain content** — the actual KAP item list, module curriculum text,
  choice enumerations, BC script wording. The *patterns* for capturing them
  (structured-capture, embedded-bc-script) are components; the *content* is not.

## Component index

| Component | App | Trigger | Enforced by (eval dimension) |
|---|---|---|---|
| [`gps-accuracy-capture`](#gps-accuracy-capture) | Deliver | PDD Evidence Model specifies a GPS arrival/location radius | `pdd-to-deliver-app-eval § Capture fitness` |
| [`init-safe-calculates`](#init-safe-calculates) | Deliver (cross-cutting) | Any hidden calc parses a capture-later value (`selected-at`/`substr`/`regex`/`number`) | `app-release-qa` (`commcare-cli play`) |
| [`data-quality-constraints`](#data-quality-constraints) | Deliver | Always, for any data-capture instrument | `pdd-to-deliver-app-eval § Data-quality validation` |
| [`case-write-back`](#case-write-back) | Deliver | A case-UPDATE / follow-up form captures new observations | `pdd-to-deliver-app-eval § Capture fitness`; `app-connect-coverage` |
| [`structured-capture`](#structured-capture) | Deliver | An answer has an enumerable option set | `pdd-to-deliver-app-eval § Capture fitness` |
| [`section-timestamps`](#section-timestamps) | Deliver | PDD success metrics reference visit-time / a cost model | `pdd-to-deliver-app-eval § Capture fitness` |
| [`embedded-bc-script`](#embedded-bc-script) | Deliver | PDD specifies a behavior-change segment delivered verbatim | `pdd-to-deliver-app-eval` |
| [`assessment-gate`](#assessment-gate) | Learn | PDD specifies a readiness / competency gate before delivery | `pdd-to-learn-app-eval § assessment_gating` |
| [`localization-layer`](#localization-layer) | Learn + Deliver | PDD names a working language other than English | `pdd-to-{learn,deliver}-app-eval § localization_match` (hard-fail) |
| [`learn-app-naming`](#learn-app-naming) | Learn | Always | `pdd-to-learn-app-eval § naming_convention` (NEW) |
| [`end-of-form-previous`](#end-of-form-previous) | Learn | Always | `pdd-to-learn-app-eval § form_navigation` (NEW) |
| [`assessment-display-lifecycle`](#assessment-display-lifecycle) | Learn | App has BOTH a pre- and a post-assessment form | `pdd-to-learn-app-eval § assessment_gating` (extends) |
| [`grid-menu-display`](#grid-menu-display) | Learn + Deliver | Always | `pdd-to-{learn,deliver}-app-eval § menu_display` (NEW) |
| [`deliver-app-naming`](#deliver-app-naming) | Deliver | Always | `pdd-to-deliver-app-eval § naming_convention` (NEW) |
| [`live-photo-capture`](#live-photo-capture) | Deliver | Any image / photo capture question | `pdd-to-deliver-app-eval § Capture fitness` (extends) |
| [`no-section-module-language`](#no-section-module-language) | Deliver | Always | `pdd-to-deliver-app-eval § terminology` (NEW) |

---

## Components

### gps-accuracy-capture

- **App:** Deliver
- **Trigger:** the PDD's Evidence Model specifies an arrival/location radius
  (e.g. "GPS at arrival within 100 m").
- **Parameters:** `<PREFERRED_M>` (preferred accuracy, default `15`),
  `<MINIMUM_M>` (minimum acceptable accuracy, default `25`), `<GEOPOINT_ID>`
  (the geopoint question id).
- **Enforced by:** `pdd-to-deliver-app-eval § Capture fitness` — a plain
  `geopoint` with only a text hint when the PDD states a radius caps the
  dimension at ≤3.
- **Pairs with:** [`init-safe-calculates`](#init-safe-calculates) — always emit
  both; the normalized `lat`/`lon`/accuracy outputs here are exactly the
  capture-later calculates that rule guards.

**Brief paragraph (verbatim):**

> REQUIRED — GPS accuracy gating: if the PDD's Evidence Model specifies an
> arrival/location radius (e.g. "within 100 m"), a plain `geopoint` question is
> NOT sufficient. Emit an accuracy-gated capture block: a preferred-accuracy
> threshold (<PREFERRED_M> m) and a minimum-accuracy threshold (<MINIMUM_M> m),
> a capture-gate that re-prompts / refuses to accept a fix worse than the
> minimum, a live accuracy-readout label guiding the FLW, and normalized `lat`
> / `lon` outputs the verification layer can read. A plain geopoint with only a
> text hint ("cross-check manually") does not let Connect enforce the stated
> radius.
> INIT-SAFETY (load-bearing — do NOT skip): the hidden `lat` / `lon` /
> accuracy calculates that split the geopoint via
> `selected-at(<GEOPOINT_ID>, N)` MUST be guarded against an empty geopoint.
> CommCare evaluates ALL calculates eagerly at form-init
> (`FormDef.initAllTriggerables`) BEFORE any GPS is captured, so
> `selected-at()` on an empty (zero-length) geopoint throws a fatal
> `XPathException` and the whole form fails to initialize ("A part of your
> application is invalid" on device; caught by `app-release-qa`'s
> `commcare-cli play` gate, NOT by `validate_app` or `make_build`). Wrap every
> such calculate so it returns empty (or a sentinel) until the geopoint is set:
> `lat  = if(<GEOPOINT_ID> = '', '', selected-at(<GEOPOINT_ID>, 0))`,
> `lon  = if(<GEOPOINT_ID> = '', '', selected-at(<GEOPOINT_ID>, 1))`,
> `accuracy = if(<GEOPOINT_ID> = '', -1, number(selected-at(<GEOPOINT_ID>, 3)))`.
> The geopoint's OWN accuracy-gate `constraint` / `validate`
> (e.g. `selected-at(., 3) <= <MINIMUM_M>`) is fine as-is — constraints only
> evaluate on answer, not at init; ONLY the eager hidden calculates need
> guarding.

> Reproducer: malaria-itn-app/20260529-1124 Phase 3 — the baseline form's
> unguarded `selected-at(gps_raw, 0)` on `lat` threw at init and blocked the
> entire app from installing.

### init-safe-calculates

- **App:** Deliver (cross-cutting — applies to any form with capture-later
  calculates, not just GPS).
- **Trigger:** ANY hidden `calculate` that calls `selected-at()`, `substr()`,
  `regex()`, `number()`, or otherwise indexes/parses a value the FLW supplies
  later (a geopoint, a not-yet-answered question, a repeat-group reference).
- **Enforced by:** `app-release-qa` (`commcare-cli play` install-time gate) —
  an unguarded extraction is a fatal install-time error, invisible to
  `validate_app` and `make_build`.

**Brief paragraph (verbatim):**

> REQUIRED — Init-safe calculates (general rule): ANY hidden `calculate` that
> calls `selected-at()`, `substr()`, `regex()`, `number()`, or otherwise
> indexes/parses a value the FLW supplies LATER (a geopoint, a not-yet-answered
> question, a repeat-group reference) MUST guard against that source being
> empty at form-init, by wrapping it `if(<source> = '', <empty-or-sentinel>,
> <expr>)`. Every calculate runs at `initAllTriggerables` before any answer
> exists; an unguarded extraction over an empty source is a FATAL install-time
> error (the form never initializes), not a recoverable runtime one. This
> generalizes the GPS lat/lon case to every capture-later extraction.

### data-quality-constraints

- **App:** Deliver
- **Trigger:** always — every data-capture instrument.
- **Parameters:** field-specific bounds drawn from the PDD's roster / counts
  (e.g. `<HH_MAX>` for household size). Cross-field relationships from the PDD's
  data model.
- **Enforced by:** `pdd-to-deliver-app-eval § Data-quality validation` — a
  capture instrument whose only constraints are a consent gate + one range caps
  the dimension at ≤3, with a 1.5-point deduction per whole missing constraint
  class (unbounded counts / unformatted phone / uncapped free text).

**Brief paragraph (verbatim):**

> REQUIRED — Data-quality validation by default: every numeric count field MUST
> carry a sensible bound `constraint` (e.g. household_size 1–<HH_MAX>);
> cross-field counts MUST be constrained against their parent (e.g.
> `under_5 <= household_size`); any phone field MUST carry a format regex (e.g.
> `regex(., '^[0-9]{10,13}$')`); every free-text field MUST carry a character
> limit; every credit-bearing field (photo, GPS, consent) MUST be `required`
> with a `validate`. Do NOT ship a data-capture instrument whose only
> constraints are the consent gate and one range — unbounded counts and
> unformatted phones produce unusable field data.

### case-write-back

- **App:** Deliver
- **Trigger:** a case-UPDATE / follow-up form (Visit 2+, retention, monitoring)
  captures new observations.
- **Enforced by:** `pdd-to-deliver-app-eval § Capture fitness` (a write-nothing
  follow-up form is an explicit hard-gate) and the `app-connect-coverage`
  structural check.
- **Note:** this is the **opposite** of the Learn-app rule — Learn forms carry
  NO case blocks; Deliver follow-up forms MUST write back.

**Brief paragraph (verbatim):**

> REQUIRED — Follow-up / case-update forms MUST persist their observations to
> the case: every user-facing observation field on a case-UPDATE form
> (retention, change-since-last-visit, V2 readings) MUST be bound with
> `case_property_on` to the relevant case type. A case-update form that
> captures new observations but writes zero case properties is pointless — the
> change it observed is lost.

### structured-capture

- **App:** Deliver
- **Trigger:** an answer has an enumerable option set, or a numeric whose field
  reliability improves when bucketed.
- **Enforced by:** `pdd-to-deliver-app-eval § Capture fitness` — ≥2 enumerable
  answers left as free `text` caps the dimension at ≤4.

**Brief paragraph (verbatim):**

> REQUIRED — Structured capture over free text: any answer with an enumerable
> option set (who-sleeps-under-net, net condition, risk groups, how-obtained)
> MUST be a single- or multi-select, never free `text`; every "Other" option
> MUST have a conditional `_other` free-text follow-up (relevance-gated on the
> Other selection); prefer bucketed selects over raw integers where field
> reliability matters (net age as `<1 / 1–2 / 3–4 / 5+ / don't know`).

### section-timestamps

- **App:** Deliver
- **Trigger:** the PDD's success metrics reference visit-time, a time/cost
  model, or per-section duration.
- **Enforced by:** `pdd-to-deliver-app-eval § Capture fitness`.

**Brief paragraph (verbatim):**

> REQUIRED — Section timestamps: emit a hidden `now()` timestamp at the start
> of each major section (and `today()` for visit_date) so the cost/time model
> can reconstruct per-section visit-time distributions. (Only when the PDD's
> success metrics reference visit-time or a cost model.)

### embedded-bc-script

- **App:** Deliver
- **Trigger:** the PDD specifies a behavior-change / read-aloud segment to be
  delivered verbatim.
- **Enforced by:** `pdd-to-deliver-app-eval`.

**Brief paragraph (verbatim):**

> REQUIRED — Embed any verbatim read-aloud / behavior-change script in-form as
> a `label`, not as something the FLW must recall from the Learn app. If the
> PDD specifies a BC segment to be delivered verbatim, the exact script text
> goes in the Deliver form.

### assessment-gate

- **App:** Learn
- **Trigger:** the PDD specifies a readiness / competency gate before delivery.
- **Parameters:** `<THRESHOLD>` (passing percentage, e.g. `80`).
- **Enforced by:** `pdd-to-learn-app-eval § assessment_gating` — a label-only
  curriculum + one trivial quiz with an unconditional pass message is a
  hard-fail.
- **Architecture note:** the Deliver-unlock gate is enforced **Connect-side**
  (Connect reads the assessment completion). Do NOT enforce it via in-app
  case-property sequential unlock — Learn forms carry no case blocks. The
  in-app job is a genuine pre/post assessment plus an honest pass/fail
  experience. (`user_score` is a percentage 0–100; see
  `pdd-to-learn-app § user_score MUST be a PERCENTAGE`.)

**Brief paragraph (verbatim):**

> REQUIRED: When the PDD specifies a readiness gate before delivery, the
> assessment must be a real competency gate: (a) build a **pre-test AND a
> post-test** with distinct item banks (pre-test surfaces baseline; post-test
> is the gate); (b) include enough scored items to actually test the curriculum
> — roughly **≥1 item per module/major topic**, not 5 items for a 5-module
> course; (c) compute `user_score` as a percentage (per the rule above) and
> wire it to `connect.assessment` at the PDD's threshold (<THRESHOLD>) so
> Connect enforces the Deliver-unlock gate; (d) the result screen MUST be
> **conditional on the score** — a pass `label` relevant when
> `#form/user_score >= <THRESHOLD>` AND a separate fail/retry `label` relevant
> when below — NOT an unconditional "Well done!" that fires regardless of the
> score; (e) give a failing FLW retry guidance. Do NOT try to enforce the gate
> via in-app case-property sequential unlock — Learn forms carry no case blocks;
> the gate is Connect-side. The in-app job is a genuine pre/post assessment
> plus an honest pass/fail experience.

### localization-layer

- **App:** Learn **and** Deliver.
- **Trigger:** the PDD names a working language other than English.
- **Parameters:** `<LANGUAGE>` (the PDD's named working language).
- **Enforced by:** `pdd-to-{learn,deliver}-app-eval § localization_match` —
  a **hard-fail** dimension: English-only when the PDD names a working language
  fails the gate.
- **Decision:** resolves the 2026-05-29 localization decision — author the core
  in English, ship the named-language translation set; do **not** defer
  localization "downstream."

**Brief paragraph (verbatim) — Deliver:**

> REQUIRED: Author all form strings (labels, choices, hints,
> constraint/validation messages) in English as the primary language, AND ship
> a complete translation set in the PDD's named working language (here:
> <LANGUAGE>) via the form's itext — every English string must have its
> <LANGUAGE> counterpart. English-only is a hard-fail at the eval gate when the
> PDD names a working language. Do NOT defer localization "downstream"; the
> translation set is part of this build.

**Brief paragraph (verbatim) — Learn:**

> REQUIRED: Author all module/quiz strings (labels, choices, hints, assessment
> items) in English as the primary language, AND ship a complete translation
> set in the PDD's named working language (here: <LANGUAGE>) via itext — every
> English string must have its <LANGUAGE> counterpart. English-only is a
> hard-fail at the eval gate when the PDD names a working language; do NOT defer
> localization "downstream."

---

## Standing build-settings components (added 2026-06-25)

> **Scope note.** The components below differ in kind from those above: they are
> app- and form-level **build settings** (naming, menu display, end-of-form
> navigation, photo appearance, assessment form Display Conditions, terminology),
> not field/calculate/constraint patterns. Several are CommCare-HQ settings that
> Nova's documented MCP tools (`update_app` / `update_form` / `edit_field`) do
> not surface — they are emitted as brief instructions on the understanding that
> Nova's autonomous architect can apply them. The first Learn + Deliver test
> build is the gate that confirms (a) Nova actually applies each setting and
> (b) the result is readable so the matching eval dimension can enforce it.
> Eval dimensions marked **(NEW)** are pending addition to the eval skills.

### learn-app-naming

- **App:** Learn
- **Trigger:** always.
- **Enforced by:** `pdd-to-learn-app-eval § naming_convention` (NEW) — a Learn
  app whose name omits "Learn app" is a hard-fail.

**Brief paragraph (verbatim):**

> REQUIRED — App naming: the app's display name MUST contain the words
> "Learn app" (e.g. "<PROGRAM> Learn app"). Do not ship a Learn app whose name
> omits "Learn app".

### end-of-form-previous

- **App:** Learn
- **Trigger:** always — every form.
- **Enforced by:** `pdd-to-learn-app-eval § form_navigation` (NEW) — any form
  whose end-of-form navigation is not "Previous Screen" is a hard-fail.
- **HQ surface:** Form Settings > End of Form Navigation = "Previous Screen"
  (Nova post-submit target `previous`).

**Brief paragraph (verbatim):**

> REQUIRED — End of Form Navigation: EVERY form's "End of Form Navigation"
> setting MUST be "Previous Screen" (CommCare HQ: Form Settings > End of Form
> Navigation > "Previous Screen"; equivalently, post-submit returns to the
> previous screen). Do not leave any form on the default app-home / module
> navigation.

### assessment-display-lifecycle

- **App:** Learn
- **Trigger:** the app has BOTH a pre-assessment and a post-assessment form.
- **Parameters:** `<THRESHOLD>` (passing percentage, e.g. `80` — the same value
  wired in [`assessment-gate`](#assessment-gate)).
- **Enforced by:** `pdd-to-learn-app-eval § assessment_gating` (extends the
  existing dimension) — *provisional for the Display Conditions; not yet
  enforceable.*
- **Status (2026-06-25 Learn build `dMtqjjKy8mGKTlkZgREH`):** trigger fired (the
  app has both a pre- and a post-assessment) but the form object carries no
  display-condition key — NOT applied, NOT representable in the Nova blueprint.
  Deferred to the post-build HQ step in
  `docs/superpowers/specs/2026-06-25-post-build-hq-settings-automation.md`.
  **Caveat:** Learn apps are case-less, so a form Display Condition may have no
  in-app state to evaluate — this may not be realizable as a Display Condition
  at all; Connect-side module-completion (per `assessment-gate`) is the likely
  real mechanism. Owner decision pending — see the spec.
- **Pairs with:** [`assessment-gate`](#assessment-gate) — `assessment-gate`
  builds the real pre/post test, scoring, and Connect wiring; THIS component
  governs the **form Display Conditions** that decide *when each assessment form
  is shown*. Always emit both for a gated Learn app.
- **Note:** realizing "shown only once" and "hidden after pass" as a Display
  Condition requires a completion/score signal the form can read. Whether Nova
  wires this is exactly what the first test build validates (see change log).

**Brief paragraph (verbatim):**

> REQUIRED — Assessment form display lifecycle, enforced via CommCare form
> Display Conditions (set on each assessment form's settings):
> (a) the Pre-assessment form's Display Condition MUST make it appear only until
> it has been completed once — after the FLW submits it, it is hidden and does
> not show again;
> (b) the Post-assessment form's Display Condition MUST evaluate true ONLY after
> the Pre-assessment has been completed (it stays hidden until then);
> (c) once the Post-assessment has been completed AND the FLW has met the
> passing score (<THRESHOLD>), the Post-assessment's Display Condition MUST
> evaluate false so it never shows again.
> Implement all three as explicit form Display Conditions — do not rely on menu
> ordering or a manual step.

### grid-menu-display

- **App:** Learn + Deliver
- **Trigger:** always (every app).
- **Enforced by:** `pdd-to-{learn,deliver}-app-eval § menu_display` (NEW) —
  *provisional, not yet enforceable.*
- **HQ surface:** App Settings > Advanced Settings > set "Modules Menu Display"
  AND "Forms Menu Display" to "Grid", then save & publish.
- **Status (2026-06-25 test):** NOT applied by Nova — `get_app`/`get_module`
  have no menu-display field; not representable in the Nova blueprint. The brief
  instruction is best-effort only. Application + enforcement are deferred to the
  post-build HQ step in
  `docs/superpowers/specs/2026-06-25-post-build-hq-settings-automation.md`.

**Brief paragraph (verbatim):**

> REQUIRED — Grid menu display: the app MUST present BOTH its module/menu list
> and its form list as a GRID, not a list. In CommCare HQ: App Settings >
> Advanced Settings > set "Modules Menu Display" and "Forms Menu Display" both
> to "Grid". Applies to every app (Learn and Deliver).

### deliver-app-naming

- **App:** Deliver
- **Trigger:** always.
- **Enforced by:** `pdd-to-deliver-app-eval § naming_convention` (NEW) — a
  Deliver app whose name omits "Deliver app" is a hard-fail.

**Brief paragraph (verbatim):**

> REQUIRED — App naming: the app's display name MUST contain the words
> "Deliver app" (e.g. "<PROGRAM> Deliver app"). Do not ship a Deliver app whose
> name omits "Deliver app".

### live-photo-capture

- **App:** Deliver
- **Trigger:** any image / photo capture question.
- **Enforced by:** `pdd-to-deliver-app-eval § Capture fitness` (extends) —
  *provisional for the appearance attribute; not yet enforceable.*
- **HQ surface:** the image question's Advanced options > Appearance Attribute =
  `acquire`.
- **Status (2026-06-25 test):** NOT applied by Nova — the image-field schema has
  no appearance key (`get_field` exposes none); Nova emitted only an advisory
  `hint`, which does not stop the gallery-browse picker. Application + enforcement
  are deferred to the post-build HQ step in
  `docs/superpowers/specs/2026-06-25-post-build-hq-settings-automation.md`.

**Brief paragraph (verbatim):**

> REQUIRED — Live photo capture only: EVERY photo/image capture question MUST be
> taken live with the camera, never browsed from the device gallery. Set the
> question's Appearance Attribute to "acquire" (Advanced options > Appearance
> Attribute = acquire). Do not leave any image question on the default appearance
> (which lets the user choose an existing image from the library).

### no-section-module-language

- **App:** Deliver
- **Trigger:** always.
- **Enforced by:** `pdd-to-deliver-app-eval § terminology` (NEW) — any
  user-facing "section" / "module" string is a hard-fail.

**Brief paragraph (verbatim):**

> REQUIRED — Terminology: the words "section" and "module" MUST NOT appear
> anywhere user-facing in a Deliver app — not in form names, not in menu names,
> not in question labels, hints, help text, or choice labels. Use plain
> task-oriented names instead.

---

## Change log

| Date | Change | By |
|---|---|---|
| 2026-05-29 | **Created the library.** Extracted the deployability/fitness `REQUIRED:` brief paragraphs that previously lived inline in `pdd-to-deliver-app` and `pdd-to-learn-app` into named, parameterized components: `gps-accuracy-capture`, `init-safe-calculates`, `data-quality-constraints`, `case-write-back`, `structured-capture`, `section-timestamps`, `embedded-bc-script` (Deliver), `assessment-gate` (Learn), `localization-layer` (both — dedups the previously-duplicated localization paragraph). Each component pairs 1:1 with the `pdd-to-*-app-eval` fitness dimension that hard-fails a build omitting it. Closes the "reusable component library" item (PR-8 build track) from `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md` / open decision #2. | ACE team |
| 2026-06-25 | **Added standing app-build instructions** (per-app guidance applied to every Nova build). New components: `learn-app-naming`, `end-of-form-previous`, `assessment-display-lifecycle` (Learn); `grid-menu-display` (Learn + Deliver); `deliver-app-naming`, `live-photo-capture`, `no-section-module-language` (Deliver). Extends the library beyond field/calculate/constraint patterns to app- and form-level build settings (naming, menu display, end-of-form navigation, photo appearance, assessment form Display Conditions, terminology). The "Other → free-text follow-up" requirement was already covered by `structured-capture`, so no separate component was added. Several components are CommCare-HQ settings not surfaced by Nova's documented MCP tools; they are emitted as brief instructions and the first Learn + Deliver test build must confirm (a) Nova applies them and (b) they are readable by the eval. Eval dimensions marked (NEW) are pending addition to the eval skills. | Sarvesh |
| 2026-07-01 | **Enforcement landed for the blueprint-readable components.** After the 2026-06-25 test builds confirmed which instructions Nova actually applies, added binary `[BLOCKER]` hard-gates (NOT weighted dimensions — no rubric-weight rebalancing) to the eval skills: `naming_convention` + `form_navigation` in `pdd-to-learn-app-eval`, `naming_convention` + `terminology` in `pdd-to-deliver-app-eval`. A violation forces suite verdict `fail`. The three HQ-layer components (`grid-menu-display`, `live-photo-capture`, `assessment-display-lifecycle`) remain provisional/unenforced pending the post-build step in `docs/superpowers/specs/2026-06-25-post-build-hq-settings-automation.md`. | Sarvesh |
