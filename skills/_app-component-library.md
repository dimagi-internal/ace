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
| [`gps-accuracy-capture`](#gps-accuracy-capture) | Deliver | PDD Evidence Model specifies a GPS arrival/location radius or accuracy tolerance (observability only — a hard gate is unbuildable, ace#1006) | `pdd-to-deliver-app-eval § Capture fitness` |
| [`init-safe-calculates`](#init-safe-calculates) | Deliver (cross-cutting) | Any hidden calc parses a capture-later value (`selected-at`/`substr`/`regex`/`number`) | `app-release-qa` (`commcare-cli play`) |
| [`data-quality-constraints`](#data-quality-constraints) | Deliver | Always, for any data-capture instrument | `pdd-to-deliver-app-eval § Data-quality validation` |
| [`case-write-back`](#case-write-back) | Deliver | A case-UPDATE / follow-up form captures new observations | `pdd-to-deliver-app-eval § Capture fitness`; `app-connect-coverage` |
| [`structured-capture`](#structured-capture) | Deliver | An answer has an enumerable option set, OR the PDD spells the field `select` / `lookup` / "choose from", OR the field feeds a Connect `entity_id` | `pdd-to-deliver-app-eval § Capture fitness` |
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
| [`observable-before-derived`](#observable-before-derived) | Deliver | Always, for any visit/encounter form with an outcome or disposition field | `pdd-to-deliver-app-eval § field_answerability` |
| [`constraint-locality`](#constraint-locality) | Deliver | Always, for any form carrying `constraint` / `validate` expressions | `pdd-to-deliver-app-eval § field_answerability`; `app-release-qa` (mechanical bind check) |
| [`relevance-reachability`](#constraint-locality) | Deliver | Always, for any form carrying `relevant` expressions | `pdd-to-deliver-app-eval § field_answerability`; `app-release-qa` (mechanical bind check) |
| [`consent-script-floor`](#consent-script-floor) | Deliver | The PDD describes consent being sought from the people whose data/images are captured — **whether or not it declares a consent FIELD** (a read-aloud announcement counts) | `pdd-to-deliver-app-eval § consent_floor` (hard-gate — backstop only; this is a BUILD-TIME component) |
| [`threshold-coherence-flag`](#threshold-coherence-flag) | Deliver | PDD fixes ≥2 numeric thresholds constraining one physical quantity | `pdd-to-deliver-app-eval § threshold_coherence` (hard-gate) |
| [`discriminating-assessment-items`](#discriminating-assessment-items) | Learn | Any scored assessment | `pdd-to-learn-app-eval § assessment_discrimination` |
| [`instrument-grounded-examples`](#instrument-grounded-examples) | Learn | Learn app teaches administration of a fixed instrument | `pdd-to-learn-app-eval § assessment_discrimination` (examples criterion) |

---

## Components

### gps-accuracy-capture

- **App:** Deliver
- **Trigger:** the PDD's Evidence Model specifies an arrival/location radius
  or an accuracy tolerance (e.g. "GPS at arrival within 100 m", "fix accuracy
  ≤ 50 m").
- **Parameters:** `<PREFERRED_M>` (preferred accuracy, default `15`),
  `<MINIMUM_M>` (stated accuracy tolerance — **advisory**, default `25`),
  `<GEOPOINT_ID>` (the geopoint question id).
- **Enforced by:** `pdd-to-deliver-app-eval § Capture fitness` — a plain
  `geopoint` with only a text hint when the PDD states a tolerance caps the
  dimension at ≤3.
- **Pairs with:** [`init-safe-calculates`](#init-safe-calculates) — always emit
  both; the normalized `lat`/`lon`/accuracy outputs here are exactly the
  capture-later calculates that rule guards.

**A hard accuracy gate is NOT achievable — on either side
(dimagi-internal/ace#1006).** Do not spec one, do not build one, and do not
credit one. Both enforcement surfaces are closed:

- **On-device (Nova).** Nova rejects `validate` on a `geopoint` at input
  validation (`kind "geopoint" carries no validate slot`), so
  `selected-at(., 3) <= <MINIMUM_M>` cannot live on the geopoint. It used to be
  silently dropped (#695/#699); now it fails loudly. The old escape hatch — a
  separate adjacent `gps_accuracy_gate` question — is closed twice over: as bad
  FLW UX (#723), and by the mechanical constraint-locality parser
  (`lib/constraint-locality.ts`, checked in `app-release-qa`), which sanctions
  only a self-reference and a cardinality gate adjacent to its repeat. An
  adjacent GPS gate is neither and now hard-fails QA.
- **Server-side (Connect).** Connect's
  `/opportunity/<id>/verification_flags_config/` form no longer renders `gps`,
  `location`, `gps_radius_meters`, `catchment_areas`, `duplicate`, or
  `check_attachments` — `connect_set_verification_flags` posts them as
  unrecognized keys, Django drops them, and the atom still returns `ok: true`
  (dimagi-internal/ace#1013). No ACE run has ever persisted one. And even when
  `location` existed it was a *radius*, never an *accuracy* bound — so Connect
  was never a complete answer to the accuracy ceiling anyway.

**So the contract is observability, stated honestly — not enforcement.** Emit:

1. The tolerance in the question **hint** (`"Capture GPS. Target accuracy
   ≤ <MINIMUM_M> m — move to open sky and re-capture if the reading is
   worse."`).
2. `gps_accuracy_m` computed and **submitted on every visit**, so the
   verification layer can weight dedup by each fix's own error.
3. A live advisory label reading the captured accuracy back to the FLW, with
   **conditional branches covering the WHOLE range on both sides of the
   tolerance** — see the blind-spot rule below.
4. Normalized `lat` / `lon` outputs.

**FORBIDDEN — the advisory blind spot.** An advisory whose relevance conditions
cover only a band *below* the tolerance (e.g. `20 <= gps_accuracy_m <= 50`)
goes **silent on exactly the readings it exists to catch**: a 90 m fix shows no
warning at all, which reads to the FLW as "fine." This shipped in
`hh-poverty-targeting/20260728-0705` and had to be patched by hand. Every
accuracy advisory MUST have a branch for `gps_accuracy_m > <MINIMUM_M>` — the
loudest one — as well as the marginal band beneath it. Enumerate the branches
and check they partition the range with no gap.

**Build memo requirement (mandatory).** Whenever the PDD, Work Order, or
Evidence Model states a GPS accuracy tolerance, the Phase 3 build memo MUST
carry an explicit line recording that **the stated tolerance is advisory, not
enforced** — naming both closed surfaces above. Shipping a build whose
artifacts assert a control that cannot fire is the ace#995 / ace#981 family
(dead `now()` duration floor; decorative assessment gate) and is what this
requirement exists to stop.

*(A banded gate — have the form emit a `gps_quality` band and add a Connect
`form_json` field-value rule requiring it to equal `good` — is the one path
that could convert this from advisory to enforced, since `form_field_rules` do
still persist. It needs the band thresholds to be a deliberate design decision
per opp, so it is NOT part of this component; noted here so the option isn't
rediscovered from scratch.)*

**Brief paragraph (verbatim):**

> REQUIRED — GPS accuracy capture (observability, NOT a gate): if the PDD's
> Evidence Model specifies an arrival/location radius or accuracy tolerance
> (e.g. "within 100 m", "fix accuracy ≤ 50 m"), a bare `geopoint` with a
> "cross-check manually" hint is NOT sufficient — but a hard capture-gate is
> NOT buildable either (Nova rejects `validate` on `geopoint`; Connect's
> verification flags no longer carry `gps` / `gps_radius_meters`). Emit
> instead: the target accuracy stated in the question HINT (<MINIMUM_M> m); a
> hidden `gps_accuracy_m` calculate SUBMITTED on every visit so the
> verification layer can weight dedup by each fix's own error; normalized `lat`
> / `lon` outputs; and a live accuracy-readout advisory label whose relevance
> branches cover the WHOLE range — a marginal band (<PREFERRED_M>–<MINIMUM_M> m)
> AND, mandatorily, an above-tolerance branch (> <MINIMUM_M> m). An advisory
> that only fires inside a band goes silent on exactly the bad readings it
> exists to catch. Do NOT emit a `constraint` / `validate` accuracy gate on the
> geopoint, and do NOT emit a separate adjacent `gps_accuracy_gate` question —
> the first is rejected by Nova, the second hard-fails `app-release-qa`'s
> constraint-locality check. Record in the build memo that the stated tolerance
> is ADVISORY, not enforced.
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
> The `-1` sentinel is what the advisory branches test against, so an
> un-captured geopoint shows no warning rather than a spurious one. (An
> accuracy `constraint` / `validate` on the geopoint itself is moot — Nova
> rejects it; see the gate section above.)

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
  reliability improves when bucketed, **or** the PDD spells the field as
  `select` / `lookup` / "choose from" / "from the registered <X>", **or** the
  field is a component of a Connect `entity_id`.
- **Enforced by:** `pdd-to-deliver-app-eval § Capture fitness` — ≥2 enumerable
  answers left as free `text` caps the dimension at ≤4.
- **Origin of the option-source rule:** dimagi-internal/ace#1136.
  `spark-facilitator/20260731-0656` (Deliver app
  `657a4bb7-fb2f-4a10-af43-8414707b2c43`) shipped **all four** PDD-declared
  select/lookup fields — `traditional_authority`, `group_village`, `village`
  ("select, from registered communities; required"), `community_id`
  ("select/lookup") — as free `text`. Only `district` survived as a real
  `single_select`, because its option set happened to be inline-enumerable from
  the source `.ccz`. Nothing in this library or in `pdd-to-deliver-app` said
  anything about **where options come from**, so an architect facing "select
  from registered communities" with no list in front of it degraded silently to
  `kind: text` and reported the form complete. `capture_fitness` scored 4.0.

**A PDD-declared select that ships as `text` is a DEFECT, not a degradation.**
The architect has a lookup-backed option source available today; there is no
"couldn't enumerate it" excuse. Two Nova tools do the whole job, and this
library is the only place ACE names them:

- **`get_lookup_tables({app_id})`** — lists the app Project's data tables and
  their columns, with the stable `tableId` / column ids you need. Call it
  **once per build, before authoring any select whose options are not in the
  PDD**, and read the result before deciding a field's kind.
- **`set_field_options_source({app_id, moduleUuid, formUuid, fieldUuid,
  source})`** — atomically replaces a single/multi-select field's COMPLETE
  choice source. `source` is either
  `{kind: 'inline', options: [{value, label: {parts: [{kind: 'text', text}]}}, …]}`
  (≥2 options) or
  `{kind: 'lookup', tableId, valueColumnId, labelColumnId, filter?}`.
  It is a REPLACE, not a patch — there is no retained inactive source, so send
  the complete set. (`edit_field`'s `updates.optionsSource` takes the same
  `LookupOptionsSource` shape if you are already editing the field.)

Nova is **uuid-addressed** — `moduleUuid` / `formUuid` / `fieldUuid`, not
indexes. Resolve them from `get_app` / `get_module` / `get_form`, or in one
call from a semantic id with
`search_blueprint({query: '<field id>', app_id})`.

**When no suitable lookup table exists.** Do NOT fall through to `kind: text` —
that is the exact failure this rule exists to stop. In priority order:

1. **Enumerate inline** if the option set is knowable and bounded from the
   source material (the PDD, the inputs pack, a source `.ccz`), via
   `set_field_options_source` with `kind: 'inline'`. This is how `district`
   came through correctly on the run above.
2. **If the set is real but not in hand** (a roster of registered communities
   that lives with the LLO), still ship a `single_select` over the values you
   DO have plus an explicit "Other" with a relevance-gated `_other` free-text
   follow-up — and name the field in the build memo as an open item with the
   exact table + value column + label column that needs to exist before
   go-live. A partially-enumerated select degrades gracefully; free text does
   not degrade, it just loses the constraint.
3. **Never** ship free `text` for a PDD-declared select without a build-memo
   line saying so. An unrecorded degradation is what made #1136 invisible until
   the eval caught it.

*(ACE's own `commcare_create_lookup_table` / `commcare_lookup_table_append_rows`
atoms create fixtures on a CommCare HQ project space. Whether a table created
that way surfaces in Nova's `get_lookup_tables` for an app that has not yet
been uploaded to HQ is **UNVERIFIED** — do not assume it. If you try it,
confirm with `get_lookup_tables` before binding, and record the result here.)*

**Free text must never feed a Connect `entity_id`.** `entity_id` is Connect's
dedup and payment grain (see `pdd-to-deliver-app § entity_id`), so an editable
free-text component of the key opens two failure modes at once: a typo mints a
SECOND payable delivery for the same real-world event, and two distinct
entities that share a name collapse into one. On the run above the operator had
to repoint the key mid-run from `village + date_of_meeting` to `community_id`
— which closed the name-collision mode only, because `community_id` was free
text too. A lookup-backed select closes both. If a key component cannot be made
a select, say so in the build memo next to the `entity_id` you shipped.

**Brief paragraph (verbatim):**

> REQUIRED — Structured capture over free text: any answer with an enumerable
> option set (who-sleeps-under-net, net condition, risk groups, how-obtained)
> MUST be a single- or multi-select, never free `text`; every "Other" option
> MUST have a conditional `_other` free-text follow-up (relevance-gated on the
> Other selection); prefer bucketed selects over raw integers where field
> reliability matters (net age as `<1 / 1–2 / 3–4 / 5+ / don't know`).
> OPTION SOURCES — read this before you type `kind: text`. When the PDD spells a
> field `select` / `lookup` / "choose from" / "from the registered <X>" and you
> do NOT have the option list in front of you, that is NOT permission to ship
> free text. Call `get_lookup_tables({app_id})` FIRST — it lists this app
> Project's data tables and columns with their stable ids — and if a table
> holds the option set, bind it with
> `set_field_options_source({app_id, moduleUuid, formUuid, fieldUuid, source:
> {kind: 'lookup', tableId, valueColumnId, labelColumnId}})`. That call is an
> atomic REPLACE of the field's complete choice source (there is no retained
> inactive source), and Nova is uuid-addressed — resolve moduleUuid / formUuid /
> fieldUuid from `get_app` / `get_form`, or in one call from a semantic id via
> `search_blueprint({query, app_id})`. If NO table holds the set: enumerate the
> options inline with `set_field_options_source({… source: {kind: 'inline',
> options: [...]}})` when the set is knowable from the PDD or the source
> material; otherwise ship a select over the values you DO have plus an "Other"
> + relevance-gated `_other` follow-up, and record in the build memo the exact
> table + value column + label column that still needs to exist. Degrading a
> PDD-declared select to `kind: text` SILENTLY is a build defect — if you must
> degrade, name the field and the reason in the build memo. And never let free
> text feed a Connect `entity_id`: an editable key component means one typo
> mints a second payable delivery and two same-named entities collapse into one.

### section-timestamps

- **App:** Deliver
- **Trigger:** the PDD's success metrics reference visit-time, a time/cost
  model, or per-section duration.
- **Enforced by:** `pdd-to-deliver-app-eval § Capture fitness`.
- **Origin of the dependency rule:** ace#995. A bare `now()` **references no
  node**, and JavaRosa evaluates a calculate at form-init and thereafter only
  when a node it references changes — so every bare `now()` in a form resolves
  to the same instant. On `hh-poverty-targeting/20260727-1406` that made all
  five timestamps identical, `form_duration_seconds` permanently ~0, and the
  PDD's 6-minute duration floor **structurally unable to fire**. A fraud
  control that reads as configured in the PDD, the Work Order, the training
  deck and the Connect opportunity, and is inert in the built app.

**Brief paragraph (verbatim):**

> REQUIRED — Section timestamps: emit a hidden timestamp at the start of each
> major part of the encounter (and `today()` for visit_date) so the cost/time
> model can reconstruct per-part duration distributions. (Only when the PDD's
> success metrics reference visit-time or a cost model.)
> LOAD-BEARING — a bare `now()` NEVER RECOMPUTES. A calculate is evaluated at
> form-init and thereafter only when a node it references changes; `now()`
> references nothing, so every bare `now()` in the form records form-init time
> and they are all equal. Any duration derived from two of them is always zero,
> which silently disables every control that reads it. So every timestamp after
> the first MUST depend on the last answer of the part before it:
> `<part>_start_time = if(<last answer of previous part> = '', '', now())`.
> Only the very first timestamp (`visit_start_time`) may be a bare `now()` —
> form-init IS its intended meaning. Before emitting a duration-derived
> verification threshold (a duration floor, a per-part cap), trace it back to
> its two timestamps and confirm both can actually vary; if they can't, the
> threshold is decorative and belongs in the build memo as an open item, not
> silently compiled.
> BRANCH CAUTION: an end-of-encounter timestamp anchored to the last question
> of the *payable* path is never reached on non-payable outcomes. If the PDD
> has non-payable branches, either anchor per-branch or state in the build memo
> that duration is measured on completed encounters only — do NOT pick silently.

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
- **Tool-surface reality (ace#968) — there is NO itext channel.** Nova's MCP
  surface exposes **no per-language / locale / translations parameter on any
  tool**; `update_app` offers only `name` and `connect_type`. Four independent
  architect instances across two opps each searched the deferred tool set for one,
  found nothing, and each independently reached the same workaround. The component
  text used to say "via itext", which instructs something **unbuildable** — so
  architects fell back to stacking languages inline and reported it as a
  deviation. Until Nova ships a per-language channel, **inline multilingual
  authoring in a single label is the documented, sanctioned mechanism**, not a
  workaround to apologize for. The requirement is COMPLETE TRANSLATION COVERAGE;
  per-language itext is a capability-gated preference that is currently
  unreachable. **English-only remains a hard fail** — the fallback exists so that
  coverage is achievable, not so that it is optional.
- **Known cost, and why the brief caps string length.** The inline form puts
  N× string length on every label, with languages the reader cannot read stacked
  around the one they can, and no language selector. On
  `spark-facilitator/20260730-1718` the PDD carried an explicit low-literacy
  design constraint (the registration form's education field admits `None`) and
  required three languages, producing a genuine lose-lose: English-only hard-fails
  the eval, stacked-inline triples every label for exactly the cohort the PDD
  singles out. The brief therefore requires SHORT source sentences and permits the
  two degradations below; where the PDD carries a literacy constraint, record the
  tension in the build memo rather than silently picking a side.
- **Two permitted degradations** (both correct, both must NOT be graded as
  incomplete coverage):
  1. **Bare proper nouns.** Option labels that are identical across all named
     languages — district names, facility names, personal names — stay bare. A
     tri-lingual block of the same proper noun repeated N times is pure noise.
  2. **Compact slash form in short strings.** Case-list column headers and other
     strings with no room for N labelled paragraphs use
     `English / <LANGUAGE-2> / <LANGUAGE-3>` instead of the block form.

**Brief paragraph (verbatim) — Deliver:**

> REQUIRED: Every user-facing form string (labels, choices, hints,
> constraint/validation messages) must carry its <LANGUAGE> counterpart —
> complete coverage, no English-only string anywhere. English-only is a hard-fail
> at the eval gate when the PDD names a working language, and localization is NOT
> deferrable "downstream"; it is part of this build.
> **Mechanism — read this before you look for a translations parameter.** Nova
> exposes NO per-language / locale / itext channel on any tool (`update_app`
> carries only `name` and `connect_type`). Do not search for one and do not report
> its absence as a blocker. Author every string INLINE in one label: English
> first, then each named language in turn, each prefixed with its language name
> (e.g. `<English text> / <LANGUAGE>: <translated text>`), using one consistent
> separator across the whole app. Two exceptions, both correct: option labels that
> are identical across languages (district names, facility names, other proper
> nouns) stay BARE, and short strings with no room for stacked paragraphs (case-list
> column headers) use the compact `English / <LANGUAGE>` slash form.
> Because inline stacking multiplies every label's length, keep the ENGLISH source
> sentences short and plain — this matters most where the PDD names a low-literacy
> or low-education cohort. State in the build memo which mechanism you used, which
> strings took a permitted exception, and — if the PDD carries a literacy
> constraint — that inline stacking increases reading load, so a human can decide
> whether to trim scope.

**Brief paragraph (verbatim) — Learn:**

> REQUIRED: Every user-facing module/quiz string (module names, form names,
> labels, choices, hints, assessment items and their option labels) must carry its
> <LANGUAGE> counterpart — complete coverage, no English-only string anywhere.
> English-only is a hard-fail at the eval gate when the PDD names a working
> language, and localization is NOT deferrable "downstream"; it is part of this
> build.
> **Mechanism — read this before you look for a translations parameter.** Nova
> exposes NO per-language / locale / itext channel on any tool (`update_app`
> carries only `name` and `connect_type`). Do not search for one and do not report
> its absence as a blocker. Author every string INLINE in one label: English
> first, then each named language in turn, each prefixed with its language name
> (e.g. `<English text> / <LANGUAGE>: <translated text>`), using one consistent
> separator across the whole app. Two exceptions, both correct: option labels that
> are identical across languages (district names, facility names, other proper
> nouns) stay BARE, and short strings with no room for stacked paragraphs use the
> compact `English / <LANGUAGE>` slash form.
> Because inline stacking multiplies every label's length, keep the ENGLISH source
> sentences short and plain — this matters most where the PDD names a low-literacy
> or low-education cohort, and it matters doubly for assessment stems and option
> labels, where a tripled option set is read four times per item. State in the
> build memo which mechanism you used, which strings took a permitted exception,
> and — if the PDD carries a literacy constraint — that inline stacking increases
> reading load, so a human can decide whether to trim scope.

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
- **Enforced by:** none — see status. The Connect-side gate is enforced by
  [`assessment-gate`](#assessment-gate) (`pdd-to-learn-app-eval § assessment_gating`).
- **Status — WON'T-DO as a Display Condition (decided 2026-07-15).** The
  2026-06-25 Learn build (`dMtqjjKy8mGKTlkZgREH`) plus the 2026-07-15 spike
  confirmed this is not expressible: a CommCare form Display Condition
  (`form_filter`) can only test case/session state, and ACE Learn apps are
  case-less by hard rule (`assessment-gate`; `pdd-to-learn-app` "no `<case>`
  blocks"), so there is no app-readable "completed" signal for the condition to
  read. The intended behavior (shown-once / gated / hidden-after-pass) is already
  delivered **Connect-side** via `assessment-gate` + Connect's native
  module-completion tracking. **This component is deprecated** and has been
  removed from the `pdd-to-learn-app` emit-checklist; it is retained here for
  provenance. See `docs/superpowers/specs/2026-06-25-post-build-hq-settings-automation.md`.
- **Superseded by:** [`assessment-gate`](#assessment-gate) — it builds the real
  pre/post test, scoring, and Connect wiring, and Connect enforces the gate. The
  "shown-once / hidden-after-pass" experience is a Connect module-completion
  behavior, not a CommCare Display Condition.

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
- **Enforced by:** applied post-build by the `app-hq-settings` skill
  (`commcare_set_menu_display` per module + `commcare_set_app_menu_display`
  per app); verified from the raw app doc (`GET /apps/source/<build_id>/`,
  session-cookie auth) by `app-release-qa` — NOT from `suite.xml`, which
  carries no style attribute (ace#1009).
- **HQ surface:** App Settings > Advanced Settings > set "Modules Menu Display"
  AND "Forms Menu Display" to "Grid", then save & publish.
- **Status (completed 2026-07-30, dimagi-internal/ace#1082):** the component is
  THREE fields, all now applied by `app-hq-settings` (Phase 3 Step 2.65):
  app-level `use_grid_menus: true` (the root module menu) + app-level
  `grid_form_menus: 'some'` (without which the suite generator IGNORES
  per-module styles — HQ `suite_xml/sections/menus.py:86-92`) via the
  `commcare_set_app_menu_display` atom (`edit_app_attr/<app_id>/all/` +
  JSON `{"hq": {...}}`), plus per-module `display_style: 'grid'` via
  `commcare_set_menu_display`. History: 2026-07-17 shipped only the
  per-module half; spark-facilitator/20260730-1718 observed
  `use_grid_menus: false` + `grid_form_menus: 'none'` on both live apps —
  confirmed-separate fields, and the shipped per-module grids were inert.
  App-level atom live-validated 2026-07-30 against those apps.
  `app-release-qa` BLOCKER-gates all three fields.

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
- **Enforced by:** applied post-build by `app-hq-settings` (`commcare_get_form_source`
  → inject `acquire` → `commcare_patch_xform`), then verified by the `app-release-qa`
  camera-only check (dimagi-internal/ace#867) — a released Deliver image `<upload>`
  lacking `appearance` containing `acquire` halts with `[BLOCKER]
  camera-only-appearance-missing`.
- **HQ surface:** the image question's Advanced options > Appearance Attribute =
  `acquire`.
- **Decision (2026-07-15):** always-on for Deliver (matches the original "photos
  always taken live" instruction). This is a superset of #867's PDD-conditional
  verify — if `acquire` is always applied, that check always passes — so the two
  do not conflict.
- **Status (built 2026-07-17):** APPLIED post-build by `app-hq-settings` (Phase 3
  Step 2.65) — for each Deliver form with an image `<upload>` it fetches the draft
  XForm (`commcare_get_form_source`), injects `appearance="acquire"` (idempotent),
  and patches it back (`commcare_patch_xform` with sha1) before `app-release`.
  Verified by `app-release-qa`'s #867 check on the released CCZ; clears the
  camera-only residual. Best-effort on this initial rollout (a failure leaves the
  residual open + is caught by `app-release-qa`, never halts Phase 3); end-to-end
  live validation lands on the first post-install runs. Nova still can't set this at
  build time (the image-field blueprint has no appearance key) — hence the post-build
  patch.

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

## Walkability components (added 2026-07-27 — domain-expert review)

The four Deliver components below and the two Learn components after them came
from **Sophie Feintuch's expert review** of `hh-poverty-targeting/20260722-1341`
(dimagi-internal/ace#979–#984) — the first time anyone outside the ACE authoring
chain iterated on an ACE build. They share one root cause: **the build was graded
against the PDD and against a structural bar, but never against the lived
sequence of a real visit or the competence of a real worker.** Every finding was
verified against the *deployed* CCZ, not just the Nova blueprint.

### observable-before-derived

- **App:** Deliver
- **Trigger:** always, for any visit/encounter form that records an outcome,
  disposition, or status that summarizes how the encounter went.
- **Parameters:** `<OUTCOME_ID>` (the outcome field id), the PDD's enumerated
  outcome values.
- **Enforced by:** `pdd-to-deliver-app-eval § field_answerability` — a required
  non-hidden field whose value is determined by fields ordered after it caps the
  dimension at ≤3.
- **Origin:** ace#979. The hh-poverty-targeting Deliver form asked "What was the
  outcome of this visit?" as **question 1**, with 20+ fields relevance-gated on
  the answer — so the FLW had to *declare* the outcome before the app would let
  them collect the evidence for it.

**Brief paragraph (verbatim):**

> REQUIRED — Ask only what the user can observe; COMPUTE what is derived. Never
> ask for a value that is a function of answers not yet given. An outcome /
> disposition / status field (`<OUTCOME_ID>`) is almost always derived: it
> summarizes the encounter, so it cannot be answered before the encounter has
> happened. Order the form as the real-world sequence actually unfolds, asking at
> each step ONLY what the user knows at that step, then compute the outcome as a
> hidden calculate from those observations. For a household/doorstep visit the
> canonical sequence is: (1) is the dwelling occupied? (observation) (2) if
> occupied, is an eligible respondent available? (observation) (3) if yes, read
> the consent script and record consent yes/no (4) if consent yes, the substantive
> instrument (roster, indicators, photo, GPS). Then:
> `<OUTCOME_ID> = if(occupied = 'no', 'vacant', if(eligible_respondent = 'no',
> 'no_eligible_respondent', if(consent = 'no', 'refused', 'completed')))`.
> Relevance-gate downstream questions on the OBSERVATIONS (e.g.
> `consent = 'yes'`), never on the derived outcome. A user-facing outcome question
> placed before its own inputs is a build defect, not a style choice.

### constraint-locality

- **App:** Deliver
- **Trigger:** always, for any form carrying `constraint` / `validate`
  expressions.
- **Enforced by:** `pdd-to-deliver-app-eval § field_answerability`, plus the
  **mechanical bind check** in `app-release-qa` (no LLM — parses each `<bind>` in
  the released CCZ and flags any `constraint` referencing a node outside its own
  nodeset).
- **Origin:** ace#980 — two independent instances in one form. `gps_onsite_confirm`
  carried `constraint="number(selected-at(/data/gps, 3)) <= 50"` with the message
  "recapture the location", on a screen with no location widget; `i1_zone` ("In
  which zone does the household live?") carried
  `constraint="count(/data/roster) >= 1"`, blocking the FLW over a roster several
  screens earlier.

**Brief paragraph (verbatim):**

> REQUIRED — Constraint locality: a `constraint` / `validate` MUST be enforceable
> on the screen where it fires. If satisfying the message requires navigating to a
> DIFFERENT question, the constraint is attached to the wrong question — move it
> to the node it is actually about. Concretely: a GPS-accuracy rule belongs on the
> geopoint question itself (`selected-at(., 3) <= <MINIMUM_M>`), NEVER on a later
> confirmation question; a repeat-cardinality rule ("roster must have ≥1 row")
> belongs on the repeat itself or on a gate **immediately** following it — never
> on an unrelated later question. Every `constraint` expression should reference
> only `.` (the question itself), same-repeat siblings, or the repeat it directly
> guards; a constraint reaching out to a node the user cannot edit from this
> screen is a build defect. Wrapping the foreign reference in a hidden calculate
> does NOT make it local — the check resolves calculates transitively. The
> `validate_msg` must name an action the user can take RIGHT NOW, on THIS screen.
>
> RELEVANCE REACHABILITY (the temporal sibling of the same rule): a `relevant`
> expression MUST be decidable by the time the form walks past the field it
> gates. Never gate a field on an answer the user gives LATER — CommCare only
> advances to the next relevant question after the current index, so the field
> is skipped, and if a later branch ends the form it is never revisited. If a
> note or follow-up must capture something decided on a later screen, place a
> SECOND field after that screen rather than back-referencing forward. Wrapping
> the later answer in a hidden calculate does NOT help — the calculate inherits
> the position of the latest question it depends on.

### consent-script-floor

- **App:** Deliver
- **This is a BUILD-TIME component, not only an eval criterion.** The floor is
  an authoring requirement on the `/nova:autobuild` brief; the eval gate is the
  BACKSTOP. Discovering the floor at eval time is a bad place to discover it —
  it lands after the app is built, after `app-connect-coverage`, one step before
  deploy, and remediating means re-authoring consent language (often in several
  languages), redeploying and re-releasing.
- **Trigger (deliberately wide — see the miss below):** the PDD describes
  consent being sought from the people whose data, photographs, or recordings
  are captured — **whether or not the PDD declares a consent FIELD.** It fires
  on ANY of:
  - a consent gate / consent field in the Deliver App Specification;
  - a **read-aloud, verbatim, spoken, or announced** consent of any kind, even
    when the only place it lives is a `label` or a Learn-app lesson;
  - a photograph, audio, or video capture of identifiable people;
  - a survey that feeds an eligibility, targeting, or enrolment decision.

  When the trigger fires but the PDD declares no consent field, the build MUST
  still (a) put the full-floor script in the form as a read-aloud `label` at the
  point the worker speaks it, and (b) record the attestation in a field — an
  unrecorded consent is unauditable, and the payment record is the only place it
  can be evidenced.
- **Enforced by:** `pdd-to-deliver-app-eval § consent_floor` — binary hard-gate,
  surfaces `[BLOCKER]`.
- **Overlaps with [`embedded-bc-script`](#embedded-bc-script) — both fire; this
  one wins.** A verbatim read-aloud passage that seeks consent is a consent
  script first and a read-aloud script second. Emitting only `embedded-bc-script`
  for it satisfies "the exact text goes in the form" while saying nothing about
  what the text must CONTAIN, which is precisely how the miss below happened.
- **Origin:** ace#983. The built consent script covered purpose / voluntary /
  may-stop / confidential, and omitted **where the data goes** and **that
  participation does not guarantee selection** — on a survey whose entire purpose
  is deciding who gets into a benefit program.
- **The trigger miss (dimagi-internal/ace#1137).**
  `spark-facilitator/20260731-0656` (Deliver app
  `657a4bb7-fb2f-4a10-af43-8414707b2c43`, field `photo_consent_script`) shipped
  a read-aloud-verbatim script the CBF speaks to an assembled village meeting
  before photographing them — the only consent language in the programme — and
  it scored **4/6**: `confidential` and `where the data goes / who sees it` both
  absent, on a programme where the photo goes to an **AI verification layer plus
  a 10% human audit sample**. That is exactly the fact a consenting participant
  would want. The PDD declared no consent-gate *field* (consent was a verbal
  announcement taught in the Learn app), so the orchestrator composing the brief
  read the old trigger — *"the PDD requires recorded consent (any form with a
  consent gate)"* — as not firing, and emitted `embedded-bc-script` instead.
  Hence the widened trigger above: **spoken consent with no consent field is
  still consent.**
- **Elements (d), (e) and (f) are the ones builds omit** — (e)/(f) in ace#983,
  (d)/(e) in ace#1137. Check those three explicitly and by name; do not assume a
  fluent-sounding paragraph covers them.
- **Eval-side note (routed to the owner of `pdd-to-deliver-app-eval`).** That
  skill's `§ 5b consent_floor` still says *"when the PDD requires recorded
  consent"* and *"read the consent field's hint"* — narrower than this
  component's trigger on both counts, so a spoken-consent build with the script
  in a `label` and no consent field can pass the gate by not being checked.
  Build-emit and eval-grade are deliberately symmetric in this library; the eval
  wording needs the same widening (any read-aloud consent text, wherever it
  lives).

**Worked example — a script that satisfies all six.** Substitute every
angle-bracket parameter with the PDD's real value and keep the sentences short
(see [`localization-layer`](#localization-layer) — this text gets stacked per
language). Element letters are annotations, not part of the read-aloud text.
**No angle bracket may survive into the shipped label** — a literal `<`/`>` in
label text is invalid XML at `make_build` (see `pdd-to-deliver-app § REQUIRED —
Forbid angle-bracket placeholder notation`).

> Before we begin, I want to explain what I am doing and ask your permission.
> **(a)** I am recording that this meeting took place, for
> `<PROGRAM_NAME>`'s report on `<WHAT_THE_PROGRAM_DOES>`. I will take one photo
> of the group.
> **(e)** The photo and my notes go to `<IMPLEMENTING_ORG>`. They are checked
> automatically by a computer system, and a small number are reviewed by a
> person at `<ORG_OR_FUNDER>` to confirm the meeting happened.
> **(d)** Your name is not attached to the photo, and it is not shared publicly
> or with anyone outside that work.
> **(b)** Taking part is your choice.
> **(c)** If you do not want to be in the photo, move and sit to one side, and
> you can tell me at any time — before or after — and I will not include you.
> **(f)** Being in the photo does not give you any payment and does not place
> you in `<PROGRAM_NAME>`. Staying out of it takes nothing away from you — you
> are still counted as attending this meeting, and as taking part if you spoke.
> Does anyone want to sit out of the photo?

**Brief paragraph (verbatim):**

> REQUIRED — Consent-script floor (BUILD-TIME): any consent language the worker
> obtains from the people whose data, photographs, or recordings are captured
> MUST contain ALL of these elements, in plain read-aloud language: (a) the
> purpose of the survey / recording; (b) that participation is voluntary; (c)
> that the respondent may stop or opt out at any time — including AFTER the
> moment they are asked; (d) that responses are kept confidential — say what is
> and is not attached to their name; (e) **where the data goes / who will see
> it** — name that it leaves the worker and reaches the implementing
> organization and any downstream program owner who will act on it, INCLUDING
> any automated / AI verification layer and any human audit sample; (f)
> **whether participation guarantees any benefit** — when the activity feeds an
> eligibility, targeting, or enrolment decision made elsewhere, the script MUST
> state explicitly that taking part does NOT guarantee selection, payment, or
> assistance, and that opting out costs them nothing they would otherwise get.
> THIS APPLIES WHETHER OR NOT THE PDD DECLARES A CONSENT FIELD. A read-aloud
> announcement to an assembled group, a verbal consent taught in the Learn app,
> or a photo-consent line inside a behavior-change script are all consent
> scripts and all carry the full floor. Where the PDD names spoken consent with
> no consent field, put the full-floor script in the form as a read-aloud
> `label` at the point the worker speaks it AND record the attestation in a
> field — an unrecorded consent cannot be evidenced against a payment. Elements
> (d), (e) and (f) are the ones builds actually omit; check those three by name
> before you ship. They matter most on exactly the programs where a participant
> has the strongest incentive to misreport: a script that says "to help target
> support to families who need it most" while hiding that most respondents will
> not be enrolled both misleads the respondent and manufactures the misreporting
> the verification rules exist to catch.

### threshold-coherence-flag

- **App:** Deliver (with `connect-opp-setup` for the Connect-side half).
- **Trigger:** the PDD fixes ≥2 numeric thresholds that constrain the same
  physical quantity.
- **Enforced by:** `pdd-to-deliver-app-eval § threshold_coherence` — binary
  hard-gate: an incoherent pair that was compiled *without* a build-memo entry
  surfaces `[BLOCKER]`.
- **Origin:** ace#984. The PDD dedups households at `< 15m` while the built form
  accepts GPS readings with accuracy up to `50m` — so the discriminator carries no
  signal (honest neighbours flag as duplicates; real duplicates read far apart).
  ACE compiled both numbers without ever comparing them.

**Brief paragraph (verbatim):**

> REQUIRED — Threshold coherence: when two configured numbers constrain the same
> physical quantity, CHECK them against each other and surface any conflict in the
> build memo rather than silently compiling both. Pairs to check on every build:
> GPS de-duplication radius vs accepted GPS accuracy tolerance (a dedup radius at
> or below the worst accepted accuracy is meaningless); form duration floor vs a
> realistic completion time for the actual item count; max payable visits/day vs
> a realistic per-visit duration; any score threshold vs the instrument's
> attainable score range (compute the true min/max from the point values — a
> lookup table covering 0–100 for an instrument that can score 102 is a defect).
> Picking the value may be a PM decision and not ACE's; NOTICING the incoherence
> is always ACE's job. Record each checked pair and its verdict in the build memo.

### discriminating-assessment-items

- **App:** Learn
- **Trigger:** any scored assessment (pre-test, post-test, knowledge check).
- **Enforced by:** `pdd-to-learn-app-eval § assessment_discrimination` — a
  dimension with a **mandatory blind-guess probe** (the judge must attempt each
  item cold and report a per-item guessable/not-guessable table).
- **Origin:** ace#981. All 10 post-assessment items in hh-poverty-targeting were
  one virtuous answer + three absurd distractors ("Keep asking until they agree",
  "Fill in the answers yourself", "You got tired and left"), so a worker who read
  nothing scores 100% and the 80% Deliver-unlock gate is decorative.
  **`pdd-to-learn-app-eval` scored that app 9.4/10** — and its `instructional_depth`
  criterion already said items must be "anti-guess (plausible distractors)". The
  prose criterion existed and did not bite, which is why the eval side of this
  component is an executed probe rather than another adjective.
- **Measured trajectory (ace#1014, `spark-facilitator/20260730-1718`, Learn app
  `38836b2d-0405-4e99-879a-53cd2344eff9`).** Three authoring passes on the same
  12-item bank, each re-probed blind:

  | Pass | Cold-guessable |
  |---|---|
  | As built | 12/12 (1.00) |
  | Rewrite 1 — typography normalization (matched length, voice, sentence count) | 10/12 (0.833) |
  | Rewrite 2 — deliberate virtue-inversion | 9/12 and 10/12, two independent blind runs |

  **Two negative results drive the procedure below.** (1) *Typography is not the
  lever* — q5's four options were exactly uniform at 65/65/65/65 characters and
  was still guessed cold; of the 10 misses only 2 traced to structural tells and
  1 to a stem leak, while **7 fell to general professional competence alone**.
  (2) *Virtue-inversion alone is not the lever either* — q1 and q4 were properly
  inverted and still fell 2/2, because the option SET gave them away
  structurally before virtue was ever consulted. Author self-prediction on this
  dimension is worthless: rewrite 2's author self-predicted 5–7/12 and measured
  9–10/12, because the author knows which option they intended to be hard, which
  is exactly the knowledge a cold reader lacks.
- **Zero margin at the failure point.** `9 * 100 div 12` is **exactly 75.0** and
  a `result_pass` firing at `>= 75` therefore admits a 9/12 cold guesser on the
  boundary. The gate only fails a guesser at ≤8/12, so the bank must defeat a
  careful reader on **five** items to hold — it currently defeats them on one to
  three. There is no slack to trade away.
- **Ceiling, not field, measurement.** The blind guessers are LLMs, not field
  workers: they read dense English fast and are unusually good at eliminating
  internally-inconsistent options — exactly the skill the structural tells
  reward. Read 9–10/12 as "trivially defeatable by a careful reader", not as a
  field prediction.

**Brief paragraph (verbatim):**

> REQUIRED — Assessment items MUST discriminate. An item earns its place only if a
> worker who has NOT studied the modules would get it wrong. Matching option
> LENGTH, voice and sentence count does NOT achieve this — a bank normalized to
> exactly uniform option lengths still measured 10/12 cold-guessable (ace#1014).
> Author every item through TWO GATES, in order, and reject the item if either
> fails:
>
> **Gate 1 — behavioural plausibility.** Every distractor must be an action a
> competent, decent worker might ACTUALLY take: a real misconception, a
> defensible-sounding wrong practice, or a near-miss on a real rule (off-by-one
> threshold, right action wrong trigger, correct-for-a-different-case). Nothing
> may be rejectable on sight. Any option a sensible person dismisses without
> reasoning (fake a photo, withhold your next report, fudge the figures to
> reconcile) collapses 4 options to 2 BEFORE any reasoning starts and turns the
> item into a coinflip. Plausible-to-you-the-author is not plausible-to-a-stranger:
> the test is whether a stranger would have to think about it.
>
> **Gate 2 — no structural giveaway.** Independent of what each option SAYS, the
> option SET must not point at the key. Four tells, each individually sufficient
> to lose an item, all observed live in ace#1014:
> (i) **self-justifying key** — the keyed option carries its own rationale
> ("…because payment follows a check that has not happened") while the distractors
> merely assert; readers pick the reasoned option. Either give every option its own
> rationale clause or give none of them one.
> (ii) **minimal-claim tell** — three options each posit some extra system
> behavior and the key claims the least ("…and nothing more"); under uncertainty a
> guesser takes the minimal claim, reliably. Options must match in CLAIM-STRENGTH,
> not just in length.
> (iii) **odd-one-out on a binary** — the set splits 2-accept / 2-refuse and
> exactly one side carries a clean, stateable rule; that side wins by construction.
> (iv) **absurdity elimination** — see Gate 1; it is restated here because it is
> a property of the SET, and it survives "all distractors plausible" being
> nominally satisfied.
>
> **Third, weaker heuristic — virtue-inversion.** Prefer items where the keyed
> answer is NOT the most responsible-sounding option, so the standard
> pick-the-decent-instinct meta-heuristic misfires. This helps and is NOT
> sufficient on its own: items that were properly inverted still fell to Gate 2
> tells. Never treat it as a substitute for the two gates.
>
> **Working template.** The one item that defeated two independent blind runs had
> exactly three properties, and it is the shape to copy: the key requires a
> program-specific taxonomy taught in a module and nothing else; the STRONGEST
> distractor is the maximally-virtuous option (a committee meeting, well run,
> carefully written, sent same-day); and all four options are actions a competent,
> decent worker might actually take, so nothing is eliminable on sight.
>
> Also: (a) each item must be answerable ONLY from program-specific content
> actually taught in a module — cite the module it tests; (b) prefer items keyed to
> concrete program specifics (the actual threshold, the actual required evidence,
> the actual instrument wording) over generic professional-ethics sentiment;
> (c) items must be INDEPENDENT — if item N's answer can be derived from item
> N-1's, the bank's effective item count is lower than its nominal one; (d) apply
> all of this to the PRE-test bank as well as the post-test — hardening only the
> post-test makes the PDD's pre/post learning-gain metric OVERSTATE the gain.
> Do NOT pad the bank to hit an item count with items that fail these gates — a
> shorter discriminating bank beats a longer decorative one.
>
> **PRE-RELEASE SELF-CHECK (run this during the build, before you ship the
> bank).** For each item, in writing, in the build memo:
> 1. Cover the answer key. Read only the stem and the options.
> 2. Ask: *"could someone who read none of the modules pick this by
>    elimination?"* Name the option that persona would pick and WHY in ≤10 words.
> 3. Ask the four Gate-2 questions explicitly: is the key self-justifying? does
>    the key claim the least? is the key the odd one out on a binary split? is any
>    option rejectable on sight?
> 4. Only then uncover the key. If your cold pick was the key, or any Gate-2
>    answer was yes, REWRITE the item — do not argue that it is fine.
>
> Record the per-item result and the resulting count as a line in the build memo.
> Do not self-assess this as "the options are already good" — that assessment has
> been made and measured wrong three times on the same bank. Your own prediction
> is not evidence; the cold pick you wrote down before uncovering the key is.

### instrument-grounded-examples

- **App:** Learn
- **Trigger:** the Learn app teaches administration of a fixed instrument
  (scorecard, questionnaire, protocol) that the Deliver app implements.
- **Enforced by:** `pdd-to-learn-app-eval § assessment_discrimination` (examples
  criterion) — a teaching example referencing a question absent from the
  instrument is a deduction.
- **Origin:** ace#982. Module 1 taught neutral-vs-leading administration using
  *roof material* and *number of rooms* — neither is in the Nigeria PPI. The one
  place training addressed the highest-risk FLW behavior did it on questions the
  FLW will never ask.

**Brief paragraph (verbatim):**

> REQUIRED — Teaching examples MUST come from the real instrument. Every worked
> example, good/bad pair, and practice item in the Learn app MUST be built from a
> question that actually appears in the instrument the Deliver app implements —
> never invented survey content. The Learn app is authored from the same PDD that
> fixes the instrument, so there is no excuse for teaching against questions the
> worker will never ask. Where a teaching point needs a good/bad pair, draw it
> from the real item and prefer the items with the HIGHEST coaching risk:
> self-reported consumption and recall questions (did your household eat X this
> week) are far easier to lead than observable assets, so they are where a
> leading-questions lesson earns its keep. Example of the right shape, for a
> consumption indicator: bad/leading — "You haven't had eggs this week, have you?"
> said with a tone that signals which answer helps the household qualify; good —
> read the item verbatim, then wait quietly.

---

## Change log

| Date | Change | By |
|---|---|---|
| 2026-05-29 | **Created the library.** Extracted the deployability/fitness `REQUIRED:` brief paragraphs that previously lived inline in `pdd-to-deliver-app` and `pdd-to-learn-app` into named, parameterized components: `gps-accuracy-capture`, `init-safe-calculates`, `data-quality-constraints`, `case-write-back`, `structured-capture`, `section-timestamps`, `embedded-bc-script` (Deliver), `assessment-gate` (Learn), `localization-layer` (both — dedups the previously-duplicated localization paragraph). Each component pairs 1:1 with the `pdd-to-*-app-eval` fitness dimension that hard-fails a build omitting it. Closes the "reusable component library" item (PR-8 build track) from `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md` / open decision #2. | ACE team |
| 2026-06-25 | **Added standing app-build instructions** (per-app guidance applied to every Nova build). New components: `learn-app-naming`, `end-of-form-previous`, `assessment-display-lifecycle` (Learn); `grid-menu-display` (Learn + Deliver); `deliver-app-naming`, `live-photo-capture`, `no-section-module-language` (Deliver). Extends the library beyond field/calculate/constraint patterns to app- and form-level build settings (naming, menu display, end-of-form navigation, photo appearance, assessment form Display Conditions, terminology). The "Other → free-text follow-up" requirement was already covered by `structured-capture`, so no separate component was added. Several components are CommCare-HQ settings not surfaced by Nova's documented MCP tools; they are emitted as brief instructions and the first Learn + Deliver test build must confirm (a) Nova applies them and (b) they are readable by the eval. Eval dimensions marked (NEW) are pending addition to the eval skills. | Sarvesh |
| 2026-07-01 | **Enforcement landed for the blueprint-readable components.** After the 2026-06-25 test builds confirmed which instructions Nova actually applies, added binary `[BLOCKER]` hard-gates (NOT weighted dimensions — no rubric-weight rebalancing) to the eval skills: `naming_convention` + `form_navigation` in `pdd-to-learn-app-eval`, `naming_convention` + `terminology` in `pdd-to-deliver-app-eval`. A violation forces suite verdict `fail`. The three HQ-layer components (`grid-menu-display`, `live-photo-capture`, `assessment-display-lifecycle`) remain provisional/unenforced pending the post-build step in `docs/superpowers/specs/2026-06-25-post-build-hq-settings-automation.md`. | Sarvesh |
| 2026-07-15 | **Post-build spike resolved the three HQ-layer components.** (1) `assessment-display-lifecycle` → **WON'T-DO** as a Display Condition (case-less Learn apps have no app-readable state for a `form_filter`); deprecated + removed from the `pdd-to-learn-app` emit-checklist; the behavior is already delivered Connect-side by `assessment-gate`. (2) `live-photo-capture` → verify side is now live on `main` (`app-release-qa` camera-only check, dimagi-internal/ace#867); decided always-on for Deliver (superset of #867's PDD-conditional verify); auto-apply via `commcare_patch_xform` is pending one live probe (no tool fetches the draft XForm yet). (3) `grid-menu-display` → verifiable from `suite.xml`, auto-apply pending a write-mechanism probe (HQ endpoint vs Playwright). Both apply-automations are tracked as `commcare-setup.residuals[]` per #867. | Sarvesh |
| 2026-07-27 | **Walkability components (first external domain-expert iteration).** Sophie Feintuch reviewed `hh-poverty-targeting/20260722-1341` and found 6 defect classes ACE's own evals passed (ace#979–#984). New components: `observable-before-derived`, `constraint-locality`, `consent-script-floor`, `threshold-coherence-flag` (Deliver); `discriminating-assessment-items`, `instrument-grounded-examples` (Learn). Root cause shared across all six: the build was graded against the PDD and a structural bar, never against **the lived sequence of a real visit or the competence of a real worker**. Two enforcement lessons baked in: (1) `constraint-locality` is checked **mechanically** in `app-release-qa` (bind-level, no LLM) because the class is 100% detectable; (2) `assessment_discrimination` is an **executed blind-guess probe**, not a prose criterion — `instructional_depth` already required "anti-guess (plausible distractors)" and still scored the decorative bank 9.4/10, so the fix is forcing the judge to show per-item work. Every finding verified against the deployed CCZ, not the Nova blueprint. | ACE (Sophie Feintuch review) |
| 2026-07-17 | **Built the post-build auto-apply (`app-hq-settings`).** New atoms `commcare_get_form_source` + `commcare_set_menu_display`; new Phase-3 skill `app-hq-settings` (Step 2.65, between `app-deploy` and `app-release`) patches `appearance="acquire"` onto Deliver image uploads and sets `display_style=grid` per module on both apps, then clears the matching `residuals[]`. `live-photo-capture` and `grid-menu-display` flip from provisional to **applied** (verified by `app-release-qa`). Fail-soft on this initial rollout (errors leave the residual open + are caught by `app-release-qa`, never halt Phase 3); end-to-end live validation lands on the first post-install runs. | Sarvesh |
| 2026-07-30 | **`discriminating-assessment-items` gets an authoring PROCEDURE, and `localization-layer` stops instructing an unbuildable mechanism.** (1) **ace#1014** — three measured authoring passes on the same 12-item bank (`spark-facilitator/20260730-1718`) showed the component's adjectives don't bite: 12/12 cold-guessable as built, 10/12 after full typography normalization, 9–10/12 after deliberate virtue-inversion. Typography is not the lever (q5 was exactly uniform at 65/65/65/65 chars and still fell; 7 of 10 misses were general competence alone) and virtue-inversion is not sufficient either (q1/q4 were properly inverted and still fell on structural tells). Rewrote the brief as **two gates** — Gate 1 behavioural plausibility, Gate 2 no structural giveaway (self-justifying key, minimal-claim tell, odd-one-out on a binary, absurdity elimination) — with virtue-inversion demoted to a third, weaker heuristic, plus a **mandatory pre-release self-check** cheap enough to run inside the build brief. Eval side: `assessment_discrimination` gains per-item structural-tell deductions, a **gate-margin hard-gate** (`ratio × 100 >= the PDD's unlock threshold` → fail; a 75% gate has zero margin, `9 * 100 div 12` = exactly 75.0), pre-test coverage, and the blind-probe harness contract — `get_form` returns stems, options AND the `qN_score` calculates atomically, so a self-probe is contaminated by construction and the probe must be run by separate agents on independently permuted neutral labels with picks committed before reveal. (2) **ace#968** — the component said to ship translations "via itext", but Nova exposes **no per-language / locale / itext channel on any tool** (`update_app` carries only `name` and `connect_type`), so it instructed something unbuildable; four architect instances across two opps each independently fell back to inline stacking and reported it as a deviation. Rewrote both brief paragraphs to name **inline multilingual authoring as the sanctioned mechanism**, require COMPLETE COVERAGE (English-only stays a hard fail), permit two degradations (bare proper nouns; compact slash form in short strings), and require short English source sentences plus a build-memo note where the PDD carries a literacy constraint. Eval side: `localization_match` in **both** `pdd-to-{learn,deliver}-app-eval` now grades coverage rather than mechanism — inline coverage takes full credit with an `[INFO]`, incomplete coverage and English-only both hard-fail, and the literacy/reading-load tension surfaces as a `[WARN]` for a human rather than a deduction against the build. | ACE team |
| 2026-07-31 | **`structured-capture` learns where options COME FROM (ace#1136), and `consent-script-floor` becomes a build-time component with a trigger that fires on spoken consent (ace#1137).** Both from `spark-facilitator/20260731-0656`, Deliver app `657a4bb7-fb2f-4a10-af43-8414707b2c43`. (1) **ace#1136** — the PDD spelled four fields `select`/`lookup` (`traditional_authority`, `group_village`, `village` "from registered communities", `community_id`) and the build shipped all four as free `text`; only `district`, whose option set was inline-enumerable from the source `.ccz`, came through as a real `single_select`. Root cause: neither this library nor `pdd-to-deliver-app` said anything about option SOURCES, so an architect with no list in hand degraded silently to `kind: text`. Nova's post-2026-07-31 surface makes a lookup-backed source buildable — `get_lookup_tables({app_id})` lists the app Project's data tables + column ids, `set_field_options_source({app_id, moduleUuid, formUuid, fieldUuid, source})` atomically replaces a select's complete choice source with `{kind:'lookup', tableId, valueColumnId, labelColumnId}` or `{kind:'inline', options}` — and this component is the only place ACE names them. Widened the trigger to include "the PDD spells it select/lookup" and "the field feeds a Connect `entity_id`"; added the no-table-exists ladder (inline-enumerate → partial select + Other + build-memo entry → never a silent `text`); made a silent degradation an explicit defect; and stated that free text must never feed an `entity_id` (it forced a mid-run dedup-key change on this very run, and the replacement key `community_id` was free text too, so only the name-collision mode closed). (2) **ace#1137** — `photo_consent_script`, read aloud verbatim to an assembled village meeting before photographing them and the programme's only consent language, scored 4/6: `confidential` and `where the data goes / who sees it` both missing, on a programme whose photos go to an AI verification layer plus a 10% human audit sample. The PDD declared no consent *field*, so the old trigger ("the PDD requires recorded consent (any form with a consent gate)") read as not firing and the orchestrator emitted `embedded-bc-script` instead. Widened the trigger to any consent sought from the people whose data/images are captured — spoken, read-aloud, announced, Learn-taught, or field-gated; marked the component BUILD-TIME (the eval gate is the backstop, and discovering the floor one step before deploy means re-authoring consent language in N languages); noted the `embedded-bc-script` overlap explicitly (both fire; this one wins); added a worked six-element script; and named (d)/(e)/(f) as the elements builds actually omit. Eval-side wording still says "when the PDD requires recorded consent" / "read the consent field's hint" — flagged in the component for the owner of `pdd-to-deliver-app-eval` rather than edited here. | ACE team |
| 2026-07-28 | **`gps-accuracy-capture` stops requiring an unbuildable gate (ace#1006).** The component demanded "a capture-gate that re-prompts / refuses to accept a fix worse than the minimum." That is not expressible on EITHER enforcement surface: Nova rejects `validate` on `kind: geopoint` (#695/#699), the adjacent-gate workaround is closed by both #723 (FLW UX) and PR #988's constraint-locality parser, and Connect's verification-flags form no longer renders `gps` / `gps_radius_meters` at all (#1013 — posted as unrecognized keys, `ok: true`, never persisted on any run). Rewritten to the honest contract: tolerance in the hint, `gps_accuracy_m` submitted every visit, whole-range advisories, normalized lat/lon — plus a mandatory build-memo line recording that a stated tolerance is ADVISORY. New FORBIDDEN rule: an advisory whose branches cover only a band BELOW the tolerance (the >50 m blind spot that shipped in `hh-poverty-targeting/20260728-0705`) — every advisory must have an above-tolerance branch. Matching edits: `pdd-to-deliver-app-eval § Capture fitness` stops crediting the gate, `idea-to-pdd § Step 4a` stops letting a PDD assert an enforced tolerance. | ACE team |
