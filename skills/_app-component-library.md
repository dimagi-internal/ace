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
| [`payability-scoped-key`](#payability-scoped-key) | Deliver | The PDD declares ANY submission to the Deliver form non-payable (did-not-happen branch, screening-only visit, ineligible record, non-paid meeting type) | `pdd-to-deliver-app-eval § Connectify wiring (b2)` |
| [`embedded-bc-script`](#embedded-bc-script) | Deliver | PDD specifies a behavior-change segment delivered verbatim | `pdd-to-deliver-app-eval` |
| [`assessment-gate`](#assessment-gate) | Learn | PDD specifies a readiness / competency gate before delivery | `pdd-to-learn-app-eval § assessment_gating` |
| [`english-only-ui`](#english-only-ui) | Learn + Deliver | PDD names a working language other than English | `pdd-to-{learn,deliver}-app-eval § language_conformance` |
| [`learn-app-naming`](#learn-app-naming) | Learn | Always | `pdd-to-learn-app-eval § naming_convention` (NEW) |
| [`end-of-form-previous`](#end-of-form-previous) | Learn | Always | `pdd-to-learn-app-eval § form_navigation` (NEW) |
| [`assessment-display-lifecycle`](#assessment-display-lifecycle) | Learn | App has BOTH a pre- and a post-assessment form | `pdd-to-learn-app-eval § assessment_gating` (extends) |
| [`grid-menu-display`](#grid-menu-display) | Learn + Deliver | Always | `pdd-to-{learn,deliver}-app-eval § menu_display` (NEW) |
| [`deliver-app-naming`](#deliver-app-naming) | Deliver | Always | `pdd-to-deliver-app-eval § naming_convention` (NEW) |
| [`live-photo-capture`](#live-photo-capture) | Deliver | Any image / photo capture question | `pdd-to-deliver-app-eval § Capture fitness` (extends) |
| [`no-section-module-language`](#no-section-module-language) | Deliver | Always | `pdd-to-deliver-app-eval § terminology` (NEW) |
| [`connect-supported-capabilities-only`](#connect-supported-capabilities-only) | Learn + Deliver | Always | `app-deploy` feature-flag verification (a required flag other than `commcare_connect` is a build defect) |
| [`observable-before-derived`](#observable-before-derived) | Deliver | Always, for any visit/encounter form with an outcome or disposition field | `pdd-to-deliver-app-eval § field_answerability` |
| [`constraint-locality`](#constraint-locality) | Deliver | Always, for any form carrying `constraint` / `validate` expressions | `pdd-to-deliver-app-eval § field_answerability`; `app-release-qa` (mechanical bind check) |
| [`relevance-reachability`](#constraint-locality) | Deliver | Always, for any form carrying `relevant` expressions | `pdd-to-deliver-app-eval § field_answerability`; `app-release-qa` (mechanical bind check) |
| [`screen-grouping`](#screen-grouping) | Deliver (+ Learn) | Always, for any form that puts more than one question in a `group` | `pdd-to-deliver-app-eval § field_answerability`; `pdd-to-deliver-app § Step 4g` (mechanical, `lib/screen-shape.ts`) |
| [`consent-script-floor`](#consent-script-floor) | Deliver | The PDD describes consent being sought from the people whose data/images are captured — **whether or not it declares a consent FIELD** (a read-aloud announcement counts) | `pdd-to-deliver-app-eval § consent_floor` (hard-gate — backstop only; this is a BUILD-TIME component) |
| [`threshold-coherence-flag`](#threshold-coherence-flag) | Deliver | PDD fixes ≥2 numeric thresholds constraining one physical quantity | `pdd-to-deliver-app-eval § threshold_coherence` (hard-gate) |
| [`discriminating-assessment-items`](#discriminating-assessment-items) | Learn | Any scored assessment | `pdd-to-learn-app-eval § assessment_rule_coverage` |
| [`instrument-grounded-examples`](#instrument-grounded-examples) | Learn | Learn app teaches administration of a fixed instrument | `pdd-to-learn-app-eval § assessment_rule_coverage` (examples criterion) |

---

## Mechanisms a PDD must not assert

**Read this before specifying any enforcement or verification mechanism**
(`idea-to-pdd § Step 4a`), and before building one.

Each row is a mechanism ACE has specified, shipped downstream, and only then
found not to work as written. The cost is never just a missing feature: the
PDD's sentence flows verbatim into the **Work Order** and the **training
materials**, so a control that does not fire still reads as real in a
contractual document and in what the LLO is taught (ace#995, ace#1006,
ace#1121).

**Two categories, and the difference is load-bearing.** Table A is closed at
the platform surface — there is no path, and the design must change. Table B
is buildable in principle but not something ACE's toolchain produces today —
the PDD still must not assert it, but the escalation path is a **capability
request**, not a dead end. Collapsing B into A manufactures false platform
constraints, which is worse than having no list: it teaches every future
reader that a solvable problem is unsolvable. (This section shipped with
exactly that error — see the change log for 2026-08-13.)

### Table A — closed at the platform surface

| Mechanism | Why it is closed | Sanctioned alternative | Origin |
|---|---|---|---|
| **Connect-side enforcement of a GPS accuracy / location radius** — Connect refuses or flags a visit on fix quality | Connect's verification-flags form no longer renders `gps` / `gps_radius_meters` (#1013 — posted as unrecognized keys, returns `ok: true`, never persisted on any run). On the **form** side Nova additionally rejects `validate` on `kind: geopoint` (#695/#699); note that an in-form accuracy gate via an adjacent constrained question is **ACE policy-closed, not platform-closed** (#723 FLW UX, PR #988's constraint-locality parser) — do not describe it as impossible | **Observability, stated honestly.** Tolerance in the question hint, `gps_accuracy_m` submitted every visit, a whole-range on-screen advisory, normalized lat/lon, down-weighting in dedup. See [`gps-accuracy-capture`](#gps-accuracy-capture) | ace#1006, ace#1013 |
| **Reading a case property into a followup form's field** — "the visit form opens pre-filled with the household's registered ID", or any control/key that depends on a followup form knowing its own case | Closed on all three surfaces, each proven live on this Nova instance. (1) `case-ref` parts are REJECTED app-wide — a followup form's `case-ref` to its own case type fails Nova's canonical identity round-trip in every expression shape and slot (ace#1180 / `commcare-nova#458`). (2) `caseWrite` is WRITE-ONLY — a hidden field carrying it holds its literal `default_value` and then overwrites the case property with that literal (ace#1224). (3) A **visible** case-bound field does NOT emit a preload either — proven against a compiled CCZ: the bind is present, the value never is (ace#1232). A casedb `setvalue` Nova sometimes emits on its own has been seen working once, but is not requestable and is emission-order fragile, so it is not a mechanism | **Re-ask, or key off the worker.** Ask the identifying value on the followup form itself as a **select** over the same option source the create form used ([`structured-capture`](#structured-capture)); where the FLW maps 1:1 to the entity, key `entity_id` on worker identity + encounter date via a `user-ref` part inside an explicit `concat(...)`. See `pdd-to-deliver-app § entity_id` (case-UPDATE rule). Never let a payment key or an advisory `relevant` depend on a case read | ace#1180, ace#1224, ace#1232 |
| **An elapsed-time floor or cap derived from bare `now()` calculates** — "the form cannot be submitted in under N minutes" | JavaRosa evaluates a calculate at form-init and thereafter **only when a node it references changes**. A bare `now()` references no node, so every bare `now()` in a form resolves to form-init time and any duration between two of them is permanently 0 — the threshold is structurally unable to fire. This is an evaluation-semantics fact, not a tooling gap | **The mechanism IS buildable — this implementation is not.** Chain each timestamp to the previous part's last answer: `<part>_start = if(<last answer of previous part> = '', '', now())`. See [`section-timestamps`](#section-timestamps) | ace#995 |

### Table B — buildable, but not supported by ACE's toolchain today

A PDD must not assert these **as delivered**, because ACE will not build
them this cycle. But they are not platform limits, and saying so in a
document that outlives the constraint is a lie with a long tail.

| Mechanism | Actual status | What ACE does instead | Origin |
|---|---|---|---|
| **A conditional primary-case create** — "if `consent_given = no` the form ends WITHOUT creating a case", or any registration form whose own case is opened only on some answers | **Not expressible on Nova's authoring surface**, established by construction on Nova app `74a097c6` and read back, not inferred. `create_form` / `update_form` carry no create-condition slot. `add_case_operations` DOES accept a `create` action with a `condition` Predicate and the call SUCCEEDS — but a read-back shows the form's own primary-case create still present, so what was accepted is an **ADDITIONAL** case that would double-create on every consenting submission (Nova's own framing agrees: case operations exist for creating *another* case). Relevance is not a workaround — a relevance-hidden case-bound field skips its property write, but the form still opens the case. So `type: registration` implies an **unconditional** primary-case create. CommCare itself supports a conditional open-case action, so this is a **Nova toolchain gap, not a platform closure** | **Screen consent BEFORE the registration form, or mark the case rather than withhold it.** Either put the consent question in a preceding form/menu so a decline never reaches the registering form, or let the case be created and carry `consent_given = no` as a case property that every downstream filter and payment rule excludes on. State the residual honestly: a declined household DOES produce a case record. Where withholding the record genuinely matters, raise it as a **Nova capability request** | ace#1294 |
| **A randomized / per-attempt item draw from an assessment bank** — "12 items served per attempt, drawn from a bank of 30, fresh draw each retake" | **Expressible in XForms.** A seeded random value (`once(random())`) can drive item selection either from a **lookup-table/fixture** nodeset (`randomize()` over the bank, take the first N) or from **hidden questions gated on `relevant`** within a single form. A fresh form instance means a fresh draw, so per-attempt rotation follows. **Connect scores it fine** — a fixed-size draw keeps the denominator constant (12 of 30 served → `passing_score: 10` works normally); only a *variable-size* draw would break commensurability with the single `passing_score`. The real blockers are that **Nova has no authoring primitive for it** and the fixture/relevance machinery is a material complexity and maintenance cost for the value returned | **One fixed bank sized for the gate** (plus a distinct pre-test bank where a baseline is wanted — see [`assessment-gate`](#assessment-gate)). Where retake-resistance genuinely matters, raise it as an **open question** and, if the program needs it, file it as a **Nova capability request** — do not record it as impossible | ace#1121, ace#1213 |
| **A multilingual app UI** — form labels, choices, hints or assessment items rendered in the FLW's working language, or a language selector | **Expressible in CommCare.** XForms has `<itext>` and HQ supports multiple app languages natively — this is NOT a platform limit. It is closed on **ACE's builder**: Nova's MCP exposes no per-language / locale / itext channel on any tool (verified live 2026-08-14, zero hits across all 81 tools). The inline-stacking fallback used 2026-07-30..2026-08-14 is retired — it multiplies label length by N for a low-literacy cohort and is not localization. | Ships an **English-only UI** with short, plain source sentences, and carries the working language on the surfaces that can hold it — training materials, FLW guide, facilitator briefing, and the per-opp OCS chatbot. The PDD names the working language as context, never as a delivered app property. See [`english-only-ui`](#english-only-ui). | ace#1391 (supersedes ace#968) |

**Evidence discipline — the rule this section broke on its first day.** "Not
exposed on Nova's authoring surface" is a statement about **ACE's builder**,
not a proof about what XForms or CommCare can express. Do not launder one
into the other. Before a mechanism goes in **Table A**, name the surface and
how it is closed (a rejected call, a source citation, a field that no longer
renders) and check that the closure is not merely *our* policy or *our*
tooling. When in doubt it goes in **Table B** — under-claiming a constraint
costs a capability request, over-claiming it costs the capability.

**How Phase 1 uses this.** `idea-to-pdd` checks every enforcement or
verification mechanism it is about to specify against **both tables**. A
listed mechanism **must not be asserted as enforced or delivered**. Where
the design intent is still wanted, the PDD states the **buildable
approximation and names the residual** — the shape `gps-accuracy-capture`
already models ("observability, stated honestly — not enforcement") — or
raises an open question. `idea-to-pdd-eval` treats a listed mechanism
asserted as enforced/delivered as a finding. The two tables produce the same
PDD behaviour and different escalation paths.

**How to add a row.** Only when the status is **verified at the surface**,
not inferred from one failed build attempt. A mechanism that merely proved
awkward once does not belong here; put that in the relevant component. Rows
are cheap to read and expensive to get wrong, so an unverified row is worse
than no row — and a row in the wrong table is worse than an unverified one,
because it reads as settled.

**Related but NOT Phase-1 assertable** (build-surface constraints the PDD
never speaks to — listed so this reference is complete, detail in their own
components): any capability requiring a **CommCare HQ feature flag** other
than `commcare_connect` is out of scope, several being `TAG_FROZEN` upstream
([`connect-supported-capabilities-only`](#connect-supported-capabilities-only),
ace#1195). A **multilingual app UI** used to sit here too; as of 2026-08-14 it
is a Table B row below, because the PDD now DOES speak to it — it may name a
working language, and must not assert that the app is delivered in it
([`english-only-ui`](#english-only-ui), ace#968).

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

**Addressing rule for every calculate (both apps):** a reference to
another question is written `#form/<id>`, never a bare `<id>` — Nova
persists a bare id as raw text with no error, so the reference silently
never resolves. Full rule + the two-call read-back check in
[`assessment-gate`](#assessment-gate) (ace#1119).

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

### payability-scoped-key

- **App:** Deliver
- **Trigger:** the PDD declares any submission to the Deliver form
  **non-payable** — a did-not-happen branch, a screening-only visit, an
  ineligible-household record, a meeting type that isn't paid work.
- **Enforced by:** `pdd-to-deliver-app-eval § Connectify wiring (b2)`.
- **Origin:** ace#969. `entity_id` is Connect's dedup grain, and the brief
  derived it from the PDD's `duplicate-detection-key` — the *identity* fields —
  alone. On a form that records both payable and non-payable events, the
  non-payable submission mints the key first and the real payable visit then
  dedups against it. The FLW is structurally blocked from being paid for work
  they actually did, and the form's own closing text typically tells them to
  record both. Sibling of [`section-timestamps`](#section-timestamps)'s BRANCH
  CAUTION — same blind spot (non-payable branches), different mechanism.

**Brief paragraph (verbatim):**

> REQUIRED — Payability-scoped `entity_id`: when a SUBSET of submissions to
> this form is non-payable, the payability discriminator MUST be a component of
> `entity_id`. Derive the key from the PDD's **paid-unit definition**, not only
> its `duplicate-detection-key` identity fields — the key must be unique per
> *payable* event so a non-payable submission occupies a different key space
> and cannot consume the payable one. Put the discriminator INSIDE the
> `concat(...)`, never as a separate `{ kind: "text" }` part between two
> references (a bare separator parses as XPath subtraction). A dedup key of
> (community, date) on a form recording both committee and community meetings
> becomes `concat(/data/community_code, '-', /data/meeting_date, '-', /data/meeting_type)`.
> The discriminator is a key component, so the no-free-text rule applies to it:
> it MUST be a select. If the non-payable set cannot be expressed as a form
> field, do NOT ship the identity-only key silently — record in the build memo
> that non-payable submissions share the payable key space, and name the field
> that would fix it.
> SCOPE: this closes the slot-consumption mode only. A non-payable record still
> mints a CompletedWork on its own key until Layer A verification rejects it —
> the `deliver_unit` marker carries no relevance condition, which is upstream
> of ACE.

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

**MANDATORY — write every cross-field reference as `#form/<id>`, never a
bare `<id>`** (dimagi-internal/ace#1119). `edit_field` with
`calculate: "if(q1 = 'c', 1, 0)"` persists `q1` as a **raw text part**:
Nova does not resolve a bare id into a `field-ref`, and it does not
error. `if(#form/q1 = 'c', 1, 0)` resolves correctly. Because every
`qN_score` is `if(qN = '<key>', 1, 0)` and `user_score` sums those refs,
a single re-authoring pass that drops the `#form/` prefix silently
breaks the whole scoring chain — `get_app` still shows every field, the
build still succeeds, `make_build` still passes, and the FLW's score is
wrong. Same rule applies to a `relevant` / `constraint` referencing
another question.

**EXACTLY ONE form in a Learn app may carry `connect.assessment`
(dimagi-internal/ace#1131).** Connect stores a single `passing_score` per
`CommCareApp` (`opportunity/models.py`, set once via `learn_app_passing_score`),
and `process_assessments` runs for **every** submitted form block carrying
`user_score`, setting `passed = score >= app.passing_score`. Every Connect
surface that asks "has this worker passed?" then uses **any-passed** semantics
— `assessment_exists_subquery(passed=True)` in `opportunity/helpers.py`,
credentialing in `users/user_credentials.py`, the `passed` count in
`opportunity/models.py`. There is no per-form distinction anywhere in the
platform.

So a pre-test carrying `connect.assessment` **is a gating instrument**, whatever
its intro copy says. A worker who has opened no module can submit the baseline
bank, score above the threshold, and be recorded `passed=True` — measured live
at 0.85 against an 80 gate. The pre-test's own "this is not the gate" reassurance
is contradicted by the platform, and the FLW is the one who pays for it.

The pre-test still belongs in the Learn flow: give it `connect.learn_module` so
Connect shows it and counts its completion, and compute `user_score` internally
for its own baseline result labels. Just never hand that score to Connect.
Note that `app_xml.py` does NOT extract assessments from the CCZ (only module /
deliver / task), so this is **submission-time** behaviour — CCZ marker-presence
QA cannot see it, which is why `app-release-qa` checks marker CARDINALITY
instead.

**Read back after any pass that rewrites scoring calculates.** Two tool
calls, and it converts a silent class into a checked one: `get_field` on
one `qN_score` and on `user_score`, then assert each returned
`calculate.parts` contains a **`field-ref`** part (not only text parts).
If it does not, the reference did not resolve — re-issue the `edit_field`
with the `#form/` prefix before moving on. Cheap enough to run every
time; do not skip it because the app "looks right" structurally.

**Brief paragraph (verbatim):**

> REQUIRED: When the PDD specifies a readiness gate before delivery, the
> assessment must be a real competency gate: (a) build a **pre-test AND a
> post-test** with distinct item banks (pre-test surfaces baseline; post-test
> is the gate); (b) include enough scored items to actually test the curriculum
> — roughly **≥1 item per module/major topic**, not 5 items for a 5-module
> course — and **when the PDD names the required topics, the GATING bank must
> cover THOSE topics, at whatever per-topic minimum the PDD states.** Write the
> PDD's topic list down, map every gating item to one of them, and check the
> counts before you ship. A topic taught in the curriculum but tested only in
> the non-gating pre-test is NOT covered by the gate: the worker can certify
> without ever being examined on it. If you deliberately re-allocate the gate
> toward harder-to-guess topics (a legitimate trade — it raises discrimination),
> the topics you moved OUT must be named in the build memo as a reduction in
> what the certificate certifies, never left implicit; (c) compute `user_score`
> as a percentage (per the rule above) and
> wire it to `connect.assessment` at the PDD's threshold (<THRESHOLD>) so
> Connect enforces the Deliver-unlock gate — **on the POST-TEST ONLY. The
> pre-test MUST NOT carry a `connect.assessment` block** (see the
> exactly-one-gating-instrument rule below); give it `connect.learn_module`
> only, and let it compute its own internal `user_score` for its baseline
> result labels; (d) the result screen MUST be
> **conditional on the score** — a pass `label` relevant when
> `#form/user_score >= <THRESHOLD>` AND a separate fail/retry `label` relevant
> when below — NOT an unconditional "Well done!" that fires regardless of the
> score; (e) give a failing FLW retry guidance that **MUST NOT contain the
> correct answer** — not the correct option's label text, not a paraphrase that
> uniquely identifies it. Point the worker back at the MODULE CONTENT instead:
> the point of a fail message is to send them to the teaching, not to
> substitute for it. Without this clause the natural authoring of "retry
> guidance" re-teaches by restating the right answer and then invites another
> attempt — and with no attempt limit, a worker who fails once is shown the
> answer and passes on attempt 2, leaving the `user_score >= <THRESHOLD>`
> wiring intact and completely inert (dimagi-internal/ace#1041; shipped through
> two runs, including one promoted to golden). Do NOT try to enforce the gate
> via in-app case-property sequential unlock — Learn forms carry no case blocks;
> the gate is Connect-side. The in-app job is a genuine pre/post assessment
> plus an honest pass/fail experience.

### english-only-ui

- **App:** Learn **and** Deliver.
- **Trigger:** the PDD names a working language other than English.
- **Parameters:** `<LANGUAGE>` (the PDD's named working language) — used only
  to tell the architect what NOT to do, and what to record in the build memo.
- **Enforced by:** `pdd-to-{learn,deliver}-app-eval § language_conformance`.
- **Standing decision (Jon, 2026-08-14): every ACE app ships an English-only
  UI.** The PDD still records the program's working language — it is real, and
  it drives the training materials, the facilitator briefing, the per-opp OCS
  chatbot and the solicitation's language requirement. It does **not** drive
  the app's strings. A build that ships English-only when the PDD names
  Chichewa is now CORRECT, not a gap.
- **Why the previous mechanism is retired (ace#1391, superseding ace#968).** Nova exposes no
  per-language / locale / itext channel on any tool — re-verified live
  **2026-08-14** against `tools/list`: **zero hits for `itext` / `locale` /
  `i18n` / `translat` across all 81 tools**, `update_app` carries only `name`,
  and the architect's own 70k-character operating prompt (`get_agent_prompt`,
  mode `autonomous_build`) does not mention languages at all. The only
  `language`-shaped parameter on the whole surface is `defaultLanguageCode`
  on `add_automations` / `update_automation`, which sets the language of an
  outbound SMS/email in a messaging rule — not a form-label channel.
  Between 2026-07-30 and 2026-08-14 the sanctioned fallback was to stack every
  language inline in one label. **That is not localization.** It multiplies
  every label's length by N, surrounds the language a reader can read with two
  they cannot, offers no language selector, and lands hardest on exactly the
  low-literacy cohorts these PDDs single out. A convincing-looking fake
  translation layer is worse than an honest monolingual one, because it
  reports the problem as solved. ACE builds English and waits for a real
  per-language channel; see § `Mechanisms a PDD must not assert` **Table B**.
- **Where language support actually lives.** Not nowhere — just not in the
  app's labels. It belongs to the surfaces that can carry it today: the
  training materials and FLW guide (`training-flw-guide`), the facilitator
  briefing, and the per-opp OCS chatbot — an LLM chat surface, so a worker can
  type in their own language. **Unmeasured, and do not upgrade it by repetition:**
  ACE has never tested chatbot answer quality in a non-English working language,
  so the chatbot is where language support BELONGS, not a validated capability
  to promise an LLO. Note the working language in the build memo either way,
  rather than leaving a reader to assume it was forgotten.
- **What this asks of the English.** Since the English IS the interface for a
  worker who may not be a native speaker, keep source sentences SHORT, plain
  and concrete — no idiom, no subordinate clauses stacked three deep. This
  was already the rule when stacking multiplied every string; it matters just
  as much now that the English stands alone.

**Brief paragraph (verbatim) — Deliver:**

> REQUIRED: Build every user-facing string (labels, choices, hints,
> constraint/validation messages) in **ENGLISH ONLY**. The PDD names
> <LANGUAGE> as the program's working language; that is deliberate context for
> training and facilitation, and it is NOT an instruction to translate the app.
> **Do not stack languages inline.** Do not author `English / <LANGUAGE>: …`
> labels, do not put a translation in parentheses after the English, and do not
> add a language-selector question. A stacked-language build fails
> `language_conformance` at the eval gate.
> **Do not go looking for a translations parameter, and do not report its
> absence as a blocker.** Nova exposes no per-language / locale / itext channel
> on any tool (verified live 2026-08-14 across all 81 tools). This is a settled
> decision, not a gap you have discovered.
> Because the English is the whole interface for a worker who may not be a
> native speaker, keep sentences SHORT, plain and concrete. In the build memo,
> record one line: the app ships an English-only UI by standing decision, and
> <LANGUAGE> support lives in the training materials and the OCS chatbot.

**Brief paragraph (verbatim) — Learn:**

> REQUIRED: Build every user-facing string (module names, form names, labels,
> choices, hints, assessment items and their option labels) in **ENGLISH
> ONLY**. The PDD names <LANGUAGE> as the program's working language; that is
> deliberate context for training and facilitation, and it is NOT an
> instruction to translate the app.
> **Do not stack languages inline.** Do not author `English / <LANGUAGE>: …`
> labels, do not put a translation in parentheses after the English, and do not
> add a language-selector question. A stacked-language build fails
> `language_conformance` at the eval gate.
> **Do not go looking for a translations parameter, and do not report its
> absence as a blocker.** Nova exposes no per-language / locale / itext channel
> on any tool (verified live 2026-08-14 across all 81 tools). This is a settled
> decision, not a gap you have discovered.
> Because the English is the whole interface for a worker who may not be a
> native speaker, keep sentences SHORT, plain and concrete — this matters
> doubly for assessment stems and option labels, which are read repeatedly. In
> the build memo, record one line: the app ships an English-only UI by standing
> decision, and <LANGUAGE> support lives in the training materials and the OCS
> chatbot.

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

### connect-supported-capabilities-only

- **App:** Learn **and** Deliver
- **Trigger:** always.
- **Enforced by:** `app-deploy`'s feature-flag verification
  (`get_app_hq_feature_flags`) — a required flag other than `commcare_connect`
  is a BUILD DEFECT to fix in the app, not an operator email to send.
- **Origin:** dimagi-internal/ace#1195. `spark-facilitator/20260810-0737` built
  the first ACE Deliver app to use **case-search inputs** — two per module,
  across all three modules. Nothing in the PDD asked for them; they came out of
  the architect's default module authoring. They pulled in two HQ flags that
  are **`TAG_FROZEN`** in `dimagi/commcare-hq:corehq/toggles/__init__.py`:
  `search_claim` (Simple Case Search) and `case_search_advanced` (Advanced Case
  Search, itself described as *"complex, fragile case search configuration for
  USS projects"*). `TAG_FROZEN` reads: *"This feature flag will be removed with
  an alternative solution in future. **Do not add new projects to this list.**"*
  The deploy step correctly detected the gap but emitted the wrong remedy —
  "email support@dimagi.com" — which asks Dimagi staff to override a stated
  internal policy for a capability the app never needed.

**The distinction that matters: a case LIST is free; a case SEARCH is
flag-gated.** The local case list is served from the device casedb and needs no
flag at all — which is why the Deliver smoke walked fine on a project space
where both search flags were absent. Search inputs are the only thing that
pulls the flags in, and on a 20-community pilot they buy nothing over scrolling
a list.

**Why this is a standing component rather than a one-line ban on case search.**
Nova exposes flag-gated capabilities through the same tool surface as
everything else, with nothing marking them. Banning the one feature that burned
us leaves the next one (related lookups, split-screen case search, USH
case-claim updates) to sail through. The rule is therefore stated as a
capability budget, not a blocklist.

**Brief paragraph (verbatim):**

> REQUIRED — Use only CommCare capabilities that work WITHOUT a feature flag.
> The single exception is **CommCare Connect** (`commcare_connect`), which is
> the flag this whole app exists to use and is already enabled on the ACE
> project space. Any OTHER capability that requires a CommCare HQ feature flag
> is out of scope for this build — do not use it, and do not assume a flag can
> be switched on later. Many HQ flags are frozen or deprecated, meaning HQ's own
> source instructs staff not to enable them for new projects, so a build that
> depends on one is not merely waiting on provisioning; it cannot ship as
> designed. Concretely, and most importantly: **do NOT add case-search inputs to
> any menu.** A case LIST needs no flag and is what the worker actually uses;
> a case SEARCH requires `search_claim`, and any fuzzy or advanced matching
> additionally requires `case_search_advanced` — and BOTH of those are frozen.
> Give each menu a plain case list with useful columns instead. If you believe a
> capability genuinely requires a feature flag and the app cannot meet its
> requirement without it, do NOT quietly use it: name the capability, the flag
> it needs, and the requirement it serves in the build memo, and build the
> closest flag-free alternative.

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

### screen-grouping

- **App:** Deliver (the same reasoning applies to Learn content forms).
- **Trigger:** always, for any form that puts more than one question in a
  `group`.
- **Parameters:** none — the thresholds live in `lib/screen-shape.ts`
  (`SCREEN_INPUT_WARN` = 6, `SCREEN_INPUT_MAX` = 8) so the brief, the build
  check and the eval cannot drift apart.
- **Enforced by:** `pdd-to-deliver-app § Step 4g` (mechanical, level-0, runs
  on the already-fetched blueprint BEFORE deploy) and
  `pdd-to-deliver-app-eval § field_answerability`.
- **Origin:** dimagi-internal/ace — hh-poverty-targeting/20260812-2034.

**This is NOT a one-question-per-screen rule, and must never become one.**
Operator ruling (Jon, 2026-08-13): *"It's actually fine app design practice to
have multiple questions on a screen if that makes sense for the flow, not
strictly requiring one question per screen, so it's fine that it is built that
way and shouldn't be viewed as a problem. It shouldn't be a super long
scroll."* Grouping questions that belong together is GOOD design and the
default; the defect is only a group that has quietly become a wall.

**Why this component exists at all.** A Nova `kind: group` compiles to a
CommCare **field-list** — every child, labels and questions alike, renders on
ONE scrollable screen. Until this component landed, nothing in ACE said so at
build time: `observable-before-derived` governs question ORDER,
`constraint-locality` governs CONSTRAINTS, and no component governed screen
COMPOSITION. `pdd-to-deliver-app`'s Steps 4a–4f checked field counts,
one-form-per-module, case write-back, case-list columns, the deliver marker and
option sources — none checked screen shape. And `pdd-to-deliver-app-eval`'s ten
dimensions included nothing that looks at how many questions share a screen.

The result on hh-poverty-targeting/20260812-2034: the architect grouped by
relevance condition — defensible on its own terms, one authored condition per
block — which put **all ten PPI indicators plus the household roster repeat on
a single screen**. It cleared every Phase 3 gate and `field_answerability`
scored **9.5**. The shape surfaced two steps later while authoring the Phase 6
smoke recipe, by which time the app was already on CommCare HQ, so the fix cost
a re-upload, a fresh HQ app id and an orphan app to soft-delete. Had Phase 4
run first it would have cost a delete-and-recreate of the Connect opportunity,
because `connect_create_opportunity` writes HQ app ids at create time and
Connect's edit form does not expose them.

**The rule is coherence first, count second.** Group questions that share
something the worker can feel: one recall period, one answer source, one
instruction, one physical object. Split when the shared thing changes — and
give a question its own screen precisely when its rule DIFFERS from its
neighbours', because the separation is what makes the difference visible at the
point of use. The canonical example is the Nigeria PPI: the four consumption
items share a 7-day recall and one help text, so they belong together; the
electricity item uses a **30-day** recall, and the Learn curriculum explicitly
teaches workers not to carry the seven days across to it — so it earns its own
screen, and that screen is itself a teaching aid.

**A repeat never belongs inside a field-list.** A repeat nested in a group does
not render as its own repeat flow. Put it at the form root or in a group of its
own.

**A long read-aloud passage belongs with the answer it governs.** A consent
script or verbatim behaviour-change segment sharing a screen with unrelated
earlier questions scrolls out of view before the worker reaches the answer —
which for a consent script means the attestation is recorded against text the
respondent may never have heard read out.

**Brief paragraph (verbatim):**

> REQUIRED — Screen grouping: a `group` renders as a CommCare field-list, so
> every question inside it shares ONE scrollable screen. Multiple questions per
> screen is GOOD design when they belong together — do NOT put one question per
> screen. Group by something the worker can feel: one recall period, one answer
> source, one instruction, one physical object. Split when that shared thing
> changes, and deliberately give a question its own screen when its rule DIFFERS
> from its neighbours' (e.g. an item with a 30-day recall sitting among items
> with a 7-day recall gets its own screen, so the difference is visible where it
> matters). Keep a screen to a set the worker can hold in view: more than 6
> answerable questions on one screen needs a justification, and more than 8 is a
> defect — split it. Never nest a `repeat` inside a group; it will not render as
> its own repeat flow, so put it at the form root or in a group of its own. Put
> a long read-aloud passage (a consent script, a verbatim script segment) on the
> screen that carries the answer it governs, not above unrelated earlier
> questions, or it scrolls out of view before the worker answers.

> Mechanically enforced by `lib/screen-shape.ts` (`checkScreenShape`), which the
> build calls at Step 4g and the eval reuses — see
> `test/lib/screen-shape.test.ts`, whose regression anchor is the exact
> ten-indicators-plus-repeat group that shipped.

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

### branch-scoped-groups

- **App:** Deliver
- **Trigger:** any `group` whose questions are only meaningful on ONE branch of
  a discriminator question (an outcome, a disposition, a yes/no gate).
- **Rule:** that group MUST carry `relevant` on the discriminator. A
  branch-scoped group left ungated displays on every branch, which is how a
  form ends up asking for a value the current branch cannot produce.
- **Why it is a component and not a style note (ace#1015).** On
  `spark-facilitator/20260728-1338` the `savings` group had no `relevant`, so
  it showed on both branches of `meeting_conducted`. On the did-not-happen
  branch the CBF was asked the next-meeting date **twice**, by two required
  questions with different constraints:

  | Field | Constraint |
  |---|---|
  | `meeting_did_not_happen/reschedule_date` | `. >= today()` |
  | `savings/next_meeting_date` | `. > today() and . <= today() + 30` |

  Rescheduling for **today** satisfies the first and hard-blocks the second,
  with no way to reconcile — on exactly the branch the PDD required to be
  "reachable without friction" (a worker honestly reporting that a meeting did
  not happen is doing the right thing). The pair is unsatisfiable only at the
  EDGE, which is why per-field analysis and a happy-path smoke walk both pass.
- **The surgical fix is one line** (`relevant` on the group); this component
  exists so the next form does not need one.
- **Enforced by:** `pdd-to-deliver-app-eval § field_answerability` (e)
  cross-question satisfiability, graded via `checkPairSatisfiable` from
  `lib/constraint-satisfiability.ts`.

### consent-script-floor

- **App:** Deliver
- **This is a BUILD-TIME component, not only an eval criterion.** The floor is
  an authoring requirement on the `/nova:autobuild` brief; the eval gate is the
  BACKSTOP. Discovering the floor at eval time is a bad place to discover it —
  it lands after the app is built, after `app-connect-coverage`, one step before
  deploy, and remediating means re-authoring consent language (often in several
  languages), redeploying and re-releasing.
- **Trigger (deliberately wide — see the miss below):** any of the four clauses
  below, **evaluated INDEPENDENTLY**. The PDD does not have to describe consent,
  declare a consent FIELD, or mention consent at all — **a PDD that is silent
  about consent still fires this component** whenever one of the clauses holds.
  In particular clause 3 is always-on for capture of identifiable people, on the
  same detection as [`live-photo-capture`](#live-photo-capture): a photo question
  that needs `acquire` is categorically also a photo question that needs this
  floor (ace#1223). It fires on ANY of:
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
- **`consent-branch-completeness` — what element (c) implies for REQUIRED
  fields (ace#1326).** When this floor fires AND the PDD states any field
  downstream of the consent gate as unconditionally required, the two
  requirements contradict each other on the withdrawal branch, and **both
  resolutions build fine**:

  - *Keep `required`, no `relevant`.* The worker who has just read aloud "you
    can stop at any time" must then interrogate the household that withdrew,
    or put SOMETHING in the fields to close the form. Those fields cannot be
    legitimately answered, so what lands is **invented data** — in exactly the
    fields the programme's primary metric is computed from.
  - *Add `relevant: <consent> = 'yes'`.* Correct, but it silently changes an
    observable program fact and puts blank-observation records into a
    denominator the PDD defined with no exclusion.

  **The build MUST:** (1) gate those fields on the consent answer — **element
  (c) wins over a literal completeness rule; collecting data after a
  withdrawal is never the right resolution**; (2) record the deviation in the
  build memo naming each gated field; (3) note the denominator consequence for
  any metric computed over them.

  Run `checkConsentBranchCompleteness` from `lib/consent-branch.ts` over the
  blueprint — the same helper `pdd-to-deliver-app-eval § conditional_logic_match`
  grades with, so build-emit and eval-grade cannot drift.

  Live: `bednet-check-2-visit/20260814-0856`, whose primary metric is "share
  of followed-up households with `slept_under_net = yes` AND `net_hanging =
  yes`" over closed `household` cases with **no** exclusion for withdrawn
  consent, on a programme targeting ≥ 90% `consent_confirmed = yes` — so up to
  ~10% of follow-ups can bias the headline net-use rate downward.
- **Enforced by:** `pdd-to-deliver-app-eval § consent_floor` — binary hard-gate,
  surfaces `[BLOCKER]`; and `§ conditional_logic_match` for the branch-
  completeness clause.
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
(see [`english-only-ui`](#english-only-ui) — this English is read aloud by a
worker who may not be a native speaker). Element letters are annotations, not part of the read-aloud text.
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
> — and where any field downstream of the consent gate is stated as
> unconditionally required, gate it on the consent answer (`relevant: <consent>
> = 'yes'`) rather than leaving a withdrawn household unable to close the form:
> a respondent who has just been told they may stop must not then be required
> to answer. Record every field you gate this way in the build memo.
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
- **Enforced by:** `pdd-to-learn-app-eval § assessment_rule_coverage` — a
  structural audit of which taught rules the bank actually keys on. Uncovered
  rules come back as a `repairs[]` work order addressed to THIS skill.
- **What you are optimizing.** Every item should key on a rule the worker can
  only know because a module taught it. **An item nobody can answer without the
  training is perfect even if it looks easy; an item that is hard because it is
  arbitrary is a worse instrument, not a better one.** You are NOT trying to
  make items hard for a clever guesser — see the warning below, which is the
  single most expensive lesson in this file.

**Author each item in this order.**

**Step 1 — pick the RULE before you write a single option.** Write down three
things: (i) the taught rule, in one sentence; (ii) the module that teaches it,
by name; (iii) the operation it protects — the instrument field or step whose
mishandling causes an **unpaid visit**, a **blocked form**, or **corrupted
data**. If you cannot name the module, discard the item.

**Step 2 — prefer COUNTER-INTUITIVE rules.** Among the taught rules, the ones
that carry training signal are those where ordinary common sense gives the
WRONG answer. Four recurring shapes, and they are where your items should
concentrate:

| Shape | Example |
|---|---|
| A convention that reads backwards | leave `amount_saved` BLANK when not saving — never `0`, because `0` means "tried and saved nothing" |
| A deliberate non-payment | a committee meeting is recorded and correctly NOT paid |
| An inclusion/exclusion rule | `members_with_disability` sit INSIDE `total_attendance`, not added to it |
| A named number the worker cannot derive | the appeal window, a minimum subject count in a photo, a recency limit on a date |

A scenario item ("heavy rain stopped the meeting — what do you do?") is answered
by ordinary decency and carries little signal, however carefully its options are
written. It is still worth having a few — they build confidence and confirm the
obvious rule — but a bank made only of them is a comprehension check, not a
readiness gate. **Aim for roughly half the items keyed on counter-intuitive
rules**, and make sure every counter-intuitive rule the curriculum teaches is
covered at least once. That coverage is what the eval scores.

**Step 3 — keep the bank INDEPENDENT.** At most ~1 item per underlying rule. Two
items on one rule are one item's worth of resolution reported as two. If item N's
answer follows from item N−1's, they are the same item.

**Step 4 — option hygiene. Necessary, not sufficient.** Every distractor must be
an action a competent, decent worker might ACTUALLY take: a real misconception, a
defensible-sounding wrong practice, or a near-miss on a real rule (off-by-one
threshold, right action wrong trigger). **No option may be rejectable on sight** —
"fake a photo", "fudge the figures" collapse four options to two before any
reasoning starts, and that is the one option-craft defect the eval still deducts
for. Beyond that, do not spend effort normalizing option length or inverting which
option sounds most virtuous: both were measured and neither moves the outcome
(ace#1014).

**Apply all of this to the PRE-test as well.** Hardening only the post-test makes
the PDD's pre/post learning-gain metric overstate the gain.

**Do NOT pad the bank to hit an item count.** A padded item is usually one that
fails Step 1, and it lowers the effective bar the gate applies.

> **⚠ Do NOT author items to defeat a smart reader — this is the expensive
> lesson.** Between 2026-07-27 and 2026-08-13 this component and its eval were
> built around an LLM "blind reader" probe: items were scored on how well an
> untrained model could guess them, and a bank the model could answer was failed.
> That was retired on 2026-08-13 (ace#1206) for two reasons. **(a)** An LLM told
> to role-play a low-literacy CHW still reads English fluently, does the
> arithmetic, and eliminates options — its floor is its own competence, not the
> persona's, and no ACE bank has ever been put in front of a real CHW to validate
> the inference. **(b)** For a CHW curriculum, where most taught rules amount to
> "record what happened, honestly", a bank an intelligent reader CAN mostly answer
> is the expected and correct result. The only way to drive that number down is to
> write arbitrary trivia — which is harder to learn, less useful in the field, and
> a worse instrument for exactly the cohort the gate protects. Roughly 500K
> subagent tokens went into two authoring cycles chasing that number
> (ace#1014, ace#1187). Author for **taught-rule dependence**, not for difficulty.

**Pre-release self-check (do this during the build, record it in the build
memo).** One table, one row per item: the taught rule · the module that teaches
it · the operation it protects · counter-intuitive yes/no · whether any other
item tests the same rule · whether any option is rejectable on sight. An item
that cannot fill the first three columns gets discarded, not rewritten.

**Consuming a `repairs[]` work order.** When `pdd-to-learn-app-eval` returns
`repairs[]`, each entry names an uncovered rule, the module that teaches it, and
a `suggested_target` item to re-key. Re-key the named item — keep its stem and
its subject where you can, and change what the options *differ on* so the answer
turns on the uncovered rule rather than on judgment. Do not add items to cover a
rule when an existing free item can be re-pointed at it; growing the bank lowers
the effective bar. One repair round, then re-grade.

**Brief paragraph (verbatim):**

> REQUIRED — Every assessment item must key on a rule a module TEACHES, and the
> bank must cover the counter-intuitive ones. For each item, before writing any
> option, name three things: the taught rule in one sentence, the module that
> teaches it, and the operation it protects (the field or step whose mishandling
> causes an unpaid visit, a blocked form, or corrupted data). If you cannot name
> the module, discard the item. Then concentrate the bank on the taught rules
> where ordinary common sense gives the WRONG answer — a convention that reads
> backwards (leave the amount blank, never zero), a deliberate non-payment (a
> committee meeting is recorded and correctly not paid), an inclusion rule (people
> with a disability are already inside total attendance, not added to it), or a
> named number the worker cannot derive (an appeal window, a minimum count, a
> recency limit). Aim for roughly half the items on those, and make sure EVERY
> counter-intuitive rule the curriculum teaches is tested at least once. Scenario
> items answered by ordinary decency are fine in moderation but carry little
> signal. Keep the bank independent — at most about one item per rule; if item N
> follows from item N-1 they are the same item. Every distractor must be something
> a competent, decent worker might actually do: no option may be rejectable on
> sight, because that collapses four options to two before any reasoning starts.
> Do NOT spend effort making items hard for a clever reader — for this curriculum
> most correct answers are sensible, and a bank engineered to defeat a smart
> guesser is a bank of arbitrary trivia, which is worse training for a
> low-literacy cohort, not better. Apply all of this to the pre-test as well as
> the post-test, and do not pad the bank to hit a count. Record a per-item table
> in the build memo: rule, module, operation, counter-intuitive yes/no,
> independence, and whether any option is rejectable on sight.
### instrument-grounded-examples

- **App:** Learn
- **Trigger:** the Learn app teaches administration of a fixed instrument
  (scorecard, questionnaire, protocol) that the Deliver app implements.
- **Enforced by:** `pdd-to-learn-app-eval § assessment_rule_coverage` (examples
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
| 2026-08-14 | **ACE builds English-only app UIs; `localization-layer` retired and `localization_match` INVERTED (ace#1391, superseding ace#968; Jon).** Re-verified Nova's live surface: zero hits for `itext`/`locale`/`i18n`/`translat` across all **81** tools (was 63 on 2026-07-31), `update_app` carries only `name`, and the architect's own 70k-char operating prompt never mentions languages; the surface's only language parameter is `defaultLanguageCode` on messaging automations. Since 2026-07-30 the sanctioned fallback had been stacking every language inline in one label — Jon's call: that is a terrible solution and localization should be solved properly when it can be solved at all, so until Nova ships a real per-language channel ACE ships an honest monolingual UI rather than a convincing fake. Component `localization-layer` → **`english-only-ui`** (same trigger, opposite instruction: build English, do not stack, do not hunt for a translations parameter, record the decision in the build memo). Eval dimension `localization_match` → **`language_conformance`**, same 8% and same null-when-N/A: English-only is now FULL CREDIT, stray stacked strings score 5 + `[WARN]`, systematic inline stacking or an in-app language selector is ≤3 → `fail`. Both calibration anchors amended — the ITN negative control's `localization_match ≤3` clause is REMOVED, not relaxed (the same artifact now scores full credit there; the other three dimensions still force `fail`). Phase 1 still records the working language — it drives training, facilitation, the OCS chatbot and the solicitation — but must not assert a translated app; multilingual UI is now a **Table B** row (buildable in CommCare via itext, closed on ACE's builder — never call it a platform limit). *Enforced:* `test/skills/english-only-ui.test.ts`. | ACE team |
| 2026-08-14 | **New component `branch-scoped-groups` (ace#1015).** A group whose questions only make sense on one branch of a discriminator must be gated on that discriminator. Ungated, the `savings` group on spark-facilitator/20260728-1338 displayed on both branches of `meeting_conducted` and asked the next-meeting date twice with incompatible constraints, so rescheduling for TODAY was a dead end on the branch the PDD required to be frictionless. Paired with `pdd-to-deliver-app-eval § field_answerability` (e). | ACE |
| 2026-08-14 | **`consent-script-floor` gains `consent-branch-completeness` (ace#1326).** Element (c) — "you may stop at any time, including after being asked" — and an unconditionally-required observation field contradict each other on the withdrawal branch, and nothing owned the interaction: both resolutions were silently shippable, and one produces INVENTED data in the fields the primary metric is computed from. Element (c) now explicitly wins; the build gates those fields on the consent answer, records each in the memo, and names the denominator consequence. Graded mechanically by `checkConsentBranchCompleteness` (`lib/consent-branch.ts`), shared with `pdd-to-deliver-app-eval § conditional_logic_match` so build-emit and eval-grade cannot drift — same pairing as `screen-grouping` / `lib/screen-shape.ts`. | ACE |
| 2026-08-14 | **Table B gains "a conditional primary-case create" (ace#1294).** A PDD said a registration form with `consent_given = no` ends "without creating a case". The Nova architect disproved it by construction on app `74a097c6`: no create-condition slot on `create_form`/`update_form`; `add_case_operations` accepts a conditioned `create` and succeeds, but a read-back shows the form's own primary create still present, so the accepted operation is an ADDITIONAL case that would double-create on consent; relevance skips a property write but still opens the case. Filed in **Table B**, not A — CommCare supports a conditional open-case action, so the closure is Nova's authoring surface, and the section's own tiebreak sends a doubtful mechanism to B. Phase 3 was the earliest point this could be falsified, which is exactly the ace#995/#1006/#1121 cost pattern: the sentence had already reached the PDD and would have reached the Work Order and all five Phase-6 training documents. | ACE |
| 2026-08-13 | **Table A gains "reading a case property into a followup form's field" (ace#1180 / ace#1224 / ace#1232), and `consent-script-floor`'s trigger is restated as four INDEPENDENT clauses.** The case-read row records three separately-proven closures — `case-ref` rejected app-wide, `caseWrite` write-only, and a visible case-bound field emitting no preload (proven against a compiled CCZ) — because each one was rediscovered by a different run reaching for the next workaround, and the sanctioned alternative (re-ask as a select, or key on worker identity + encounter date via a `user-ref` part inside an explicit `concat(...)`) is what `pdd-to-deliver-app § entity_id` now mandates. The consent trigger's lead-in used to read "the PDD describes consent being sought…", which primed exactly one misread: a PDD *silent* about consent was treated as not firing it. `spark-facilitator/20260812-1635` shipped 0-of-6 floor elements on an app photographing 8+ identifiable people into an AI verification layer plus a human audit sample (ace#1223) — the second miss on the same opp. Clause 3 is now stated as always-on for capture of identifiable people, on the same detection as `live-photo-capture`. | ACE team |
| 2026-08-13 | **CORRECTION — split the section into Table A / Table B; question-bank randomization was wrongly listed as unbuildable (ace#1213).** Jonathan, same day: *"you can select a random number and then select the questions from a fixture or from the form based on that … it's certainly possible to do in an xform + fixture or just within an xform with hidden questions."* Correct, and **both** of the arguments the row shipped with were wrong. (1) *"No per-attempt item-selection primitive on Nova's surface"* is a fact about ACE's BUILDER; the entry itself said not to launder that into a platform claim, and then the row did exactly that. (2) The supposedly decisive Connect argument — one absolute `passing_score` per `CommCareApp`, so a draw is not commensurable with the gate — **only holds for a VARIABLE-size draw.** The specified mechanism was a FIXED 12-of-30, which keeps the denominator constant at 12, so `passing_score: 10` works normally. The argument never bit. The section is renamed **`Mechanisms a PDD must not assert`** and split: **Table A** = closed at the platform surface (Connect's verification-flags form no longer renders `gps`/`gps_radius_meters`; JavaRosa's calculate-recomputation semantics making a bare-`now()` duration permanently 0), **Table B** = buildable but outside ACE's toolchain today (question-bank randomization). Both tables produce the same PDD behaviour — do not assert it — and different escalation paths: Table A means the design changes, Table B means a **capability request**. Also corrected in Table A: an in-form GPS accuracy gate via an adjacent constrained question is **ACE policy-closed** (#723, PR #988), not platform-closed, and must not be described as impossible. New tiebreak: **when in doubt a mechanism goes in Table B** — under-claiming a constraint costs a capability request, over-claiming it costs the capability, and a false platform limit written into a Work Order outlives the constraint. `idea-to-pdd-eval` gains a **symmetric check**: asserting a Table B mechanism is *impossible* is itself a 1-point deduction + `[INFO]`. *Enforced:* `test/skills/pdd-must-not-assert-mechanisms.test.ts` pins randomization to Table B and fails on either retired claim by name. | ACE team |
| 2026-08-13 | **New reference section: `Known-unbuildable mechanisms` (ace#1213).** Three mechanisms have now been specified by Phase 1, shipped into the PDD, the Work Order AND the Phase-6 training materials, and only then found to be unbuildable — a hard GPS accuracy gate (ace#1006), an elapsed-time floor derived from bare `now()` (ace#995), and a randomized per-attempt assessment item draw (ace#1121). Each was already documented, but as **prose inside whichever component happened to be adjacent**, discoverable only by someone who already knew to look; Phase 1 had nothing enumerable to check a specified mechanism against. The new section is that list: per row, the mechanism, WHY it is closed (naming each enforcement surface and how), the sanctioned alternative, and the origin issue. `idea-to-pdd § Step 4a` now checks every enforcement/verification mechanism against it before specifying one, and `idea-to-pdd-eval § feasibility_headline_metrics` treats a listed mechanism asserted as enforced as a 2-point deduction + `[BLOCKER]`, hard-gating at >=2. Two deliberate design choices: (1) an **evidence-discipline caveat** — 'no per-attempt item draw is exposed on Nova's authoring surface' is a fact about ACE's BUILDER, not a proof about XForms. (2) A **bar for adding rows** — closure must be verified at the surface, not inferred from one failed build attempt, because an unverified row is worse than no row. **RETRACTED SAME DAY — see the correction entry above:** this version listed question-bank randomization as unbuildable on two arguments that were both wrong, and the section has since been split into Table A / Table B. Build-surface constraints Phase 1 never speaks to (itext ace#968, feature flags ace#1195) are cross-referenced rather than duplicated. *Enforced:* `test/skills/known-unbuildable-mechanisms.test.ts`. | ACE team |
| 2026-05-29 | **Created the library.** Extracted the deployability/fitness `REQUIRED:` brief paragraphs that previously lived inline in `pdd-to-deliver-app` and `pdd-to-learn-app` into named, parameterized components: `gps-accuracy-capture`, `init-safe-calculates`, `data-quality-constraints`, `case-write-back`, `structured-capture`, `section-timestamps`, `embedded-bc-script` (Deliver), `assessment-gate` (Learn), `localization-layer` (both — dedups the previously-duplicated localization paragraph). Each component pairs 1:1 with the `pdd-to-*-app-eval` fitness dimension that hard-fails a build omitting it. Closes the "reusable component library" item (PR-8 build track) from `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md` / open decision #2. | ACE team |
| 2026-06-25 | **Added standing app-build instructions** (per-app guidance applied to every Nova build). New components: `learn-app-naming`, `end-of-form-previous`, `assessment-display-lifecycle` (Learn); `grid-menu-display` (Learn + Deliver); `deliver-app-naming`, `live-photo-capture`, `no-section-module-language` (Deliver). Extends the library beyond field/calculate/constraint patterns to app- and form-level build settings (naming, menu display, end-of-form navigation, photo appearance, assessment form Display Conditions, terminology). The "Other → free-text follow-up" requirement was already covered by `structured-capture`, so no separate component was added. Several components are CommCare-HQ settings not surfaced by Nova's documented MCP tools; they are emitted as brief instructions and the first Learn + Deliver test build must confirm (a) Nova applies them and (b) they are readable by the eval. Eval dimensions marked (NEW) are pending addition to the eval skills. | Sarvesh |
| 2026-07-01 | **Enforcement landed for the blueprint-readable components.** After the 2026-06-25 test builds confirmed which instructions Nova actually applies, added binary `[BLOCKER]` hard-gates (NOT weighted dimensions — no rubric-weight rebalancing) to the eval skills: `naming_convention` + `form_navigation` in `pdd-to-learn-app-eval`, `naming_convention` + `terminology` in `pdd-to-deliver-app-eval`. A violation forces suite verdict `fail`. The three HQ-layer components (`grid-menu-display`, `live-photo-capture`, `assessment-display-lifecycle`) remain provisional/unenforced pending the post-build step in `docs/superpowers/specs/2026-06-25-post-build-hq-settings-automation.md`. | Sarvesh |
| 2026-07-15 | **Post-build spike resolved the three HQ-layer components.** (1) `assessment-display-lifecycle` → **WON'T-DO** as a Display Condition (case-less Learn apps have no app-readable state for a `form_filter`); deprecated + removed from the `pdd-to-learn-app` emit-checklist; the behavior is already delivered Connect-side by `assessment-gate`. (2) `live-photo-capture` → verify side is now live on `main` (`app-release-qa` camera-only check, dimagi-internal/ace#867); decided always-on for Deliver (superset of #867's PDD-conditional verify); auto-apply via `commcare_patch_xform` is pending one live probe (no tool fetches the draft XForm yet). (3) `grid-menu-display` → verifiable from `suite.xml`, auto-apply pending a write-mechanism probe (HQ endpoint vs Playwright). Both apply-automations are tracked as `commcare-setup.residuals[]` per #867. | Sarvesh |
| 2026-07-27 | **Walkability components (first external domain-expert iteration).** Sophie Feintuch reviewed `hh-poverty-targeting/20260722-1341` and found 6 defect classes ACE's own evals passed (ace#979–#984). New components: `observable-before-derived`, `constraint-locality`, `consent-script-floor`, `threshold-coherence-flag` (Deliver); `discriminating-assessment-items`, `instrument-grounded-examples` (Learn). Root cause shared across all six: the build was graded against the PDD and a structural bar, never against **the lived sequence of a real visit or the competence of a real worker**. Two enforcement lessons baked in: (1) `constraint-locality` is checked **mechanically** in `app-release-qa` (bind-level, no LLM) because the class is 100% detectable; (2) `assessment_discrimination` is an **executed blind-guess probe**, not a prose criterion — `instructional_depth` already required "anti-guess (plausible distractors)" and still scored the decorative bank 9.4/10, so the fix is forcing the judge to show per-item work. Every finding verified against the deployed CCZ, not the Nova blueprint. | ACE (Sophie Feintuch review) |
| 2026-07-17 | **Built the post-build auto-apply (`app-hq-settings`).** New atoms `commcare_get_form_source` + `commcare_set_menu_display`; new Phase-3 skill `app-hq-settings` (Step 2.65, between `app-deploy` and `app-release`) patches `appearance="acquire"` onto Deliver image uploads and sets `display_style=grid` per module on both apps, then clears the matching `residuals[]`. `live-photo-capture` and `grid-menu-display` flip from provisional to **applied** (verified by `app-release-qa`). Fail-soft on this initial rollout (errors leave the residual open + are caught by `app-release-qa`, never halt Phase 3); end-to-end live validation lands on the first post-install runs. | Sarvesh |
| 2026-07-30 | **`discriminating-assessment-items` gets an authoring PROCEDURE, and `localization-layer` stops instructing an unbuildable mechanism.** (1) **ace#1014** — three measured authoring passes on the same 12-item bank (`spark-facilitator/20260730-1718`) showed the component's adjectives don't bite: 12/12 cold-guessable as built, 10/12 after full typography normalization, 9–10/12 after deliberate virtue-inversion. Typography is not the lever (q5 was exactly uniform at 65/65/65/65 chars and still fell; 7 of 10 misses were general competence alone) and virtue-inversion is not sufficient either (q1/q4 were properly inverted and still fell on structural tells). Rewrote the brief as **two gates** — Gate 1 behavioural plausibility, Gate 2 no structural giveaway (self-justifying key, minimal-claim tell, odd-one-out on a binary, absurdity elimination) — with virtue-inversion demoted to a third, weaker heuristic, plus a **mandatory pre-release self-check** cheap enough to run inside the build brief. Eval side: `assessment_discrimination` gains per-item structural-tell deductions, a **gate-margin hard-gate** (`ratio × 100 >= the PDD's unlock threshold` → fail; a 75% gate has zero margin, `9 * 100 div 12` = exactly 75.0), pre-test coverage, and the blind-probe harness contract — `get_form` returns stems, options AND the `qN_score` calculates atomically, so a self-probe is contaminated by construction and the probe must be run by separate agents on independently permuted neutral labels with picks committed before reveal. (2) **ace#968** — the component said to ship translations "via itext", but Nova exposes **no per-language / locale / itext channel on any tool** (`update_app` carries only `name` and `connect_type`), so it instructed something unbuildable; four architect instances across two opps each independently fell back to inline stacking and reported it as a deviation. Rewrote both brief paragraphs to name **inline multilingual authoring as the sanctioned mechanism**, require COMPLETE COVERAGE (English-only stays a hard fail), permit two degradations (bare proper nouns; compact slash form in short strings), and require short English source sentences plus a build-memo note where the PDD carries a literacy constraint. Eval side: `localization_match` in **both** `pdd-to-{learn,deliver}-app-eval` now grades coverage rather than mechanism — inline coverage takes full credit with an `[INFO]`, incomplete coverage and English-only both hard-fail, and the literacy/reading-load tension surfaces as a `[WARN]` for a human rather than a deduction against the build. | ACE team |
| 2026-07-31 | **`structured-capture` learns where options COME FROM (ace#1136), and `consent-script-floor` becomes a build-time component with a trigger that fires on spoken consent (ace#1137).** Both from `spark-facilitator/20260731-0656`, Deliver app `657a4bb7-fb2f-4a10-af43-8414707b2c43`. (1) **ace#1136** — the PDD spelled four fields `select`/`lookup` (`traditional_authority`, `group_village`, `village` "from registered communities", `community_id`) and the build shipped all four as free `text`; only `district`, whose option set was inline-enumerable from the source `.ccz`, came through as a real `single_select`. Root cause: neither this library nor `pdd-to-deliver-app` said anything about option SOURCES, so an architect with no list in hand degraded silently to `kind: text`. Nova's post-2026-07-31 surface makes a lookup-backed source buildable — `get_lookup_tables({app_id})` lists the app Project's data tables + column ids, `set_field_options_source({app_id, moduleUuid, formUuid, fieldUuid, source})` atomically replaces a select's complete choice source with `{kind:'lookup', tableId, valueColumnId, labelColumnId}` or `{kind:'inline', options}` — and this component is the only place ACE names them. Widened the trigger to include "the PDD spells it select/lookup" and "the field feeds a Connect `entity_id`"; added the no-table-exists ladder (inline-enumerate → partial select + Other + build-memo entry → never a silent `text`); made a silent degradation an explicit defect; and stated that free text must never feed an `entity_id` (it forced a mid-run dedup-key change on this very run, and the replacement key `community_id` was free text too, so only the name-collision mode closed). (2) **ace#1137** — `photo_consent_script`, read aloud verbatim to an assembled village meeting before photographing them and the programme's only consent language, scored 4/6: `confidential` and `where the data goes / who sees it` both missing, on a programme whose photos go to an AI verification layer plus a 10% human audit sample. The PDD declared no consent *field*, so the old trigger ("the PDD requires recorded consent (any form with a consent gate)") read as not firing and the orchestrator emitted `embedded-bc-script` instead. Widened the trigger to any consent sought from the people whose data/images are captured — spoken, read-aloud, announced, Learn-taught, or field-gated; marked the component BUILD-TIME (the eval gate is the backstop, and discovering the floor one step before deploy means re-authoring consent language in N languages); noted the `embedded-bc-script` overlap explicitly (both fire; this one wins); added a worked six-element script; and named (d)/(e)/(f) as the elements builds actually omit. Eval-side wording still says "when the PDD requires recorded consent" / "read the consent field's hint" — flagged in the component for the owner of `pdd-to-deliver-app-eval` rather than edited here. | ACE team |
| 2026-07-28 | **`gps-accuracy-capture` stops requiring an unbuildable gate (ace#1006).** The component demanded "a capture-gate that re-prompts / refuses to accept a fix worse than the minimum." That is not expressible on EITHER enforcement surface: Nova rejects `validate` on `kind: geopoint` (#695/#699), the adjacent-gate workaround is closed by both #723 (FLW UX) and PR #988's constraint-locality parser, and Connect's verification-flags form no longer renders `gps` / `gps_radius_meters` at all (#1013 — posted as unrecognized keys, `ok: true`, never persisted on any run). Rewritten to the honest contract: tolerance in the hint, `gps_accuracy_m` submitted every visit, whole-range advisories, normalized lat/lon — plus a mandatory build-memo line recording that a stated tolerance is ADVISORY. New FORBIDDEN rule: an advisory whose branches cover only a band BELOW the tolerance (the >50 m blind spot that shipped in `hh-poverty-targeting/20260728-0705`) — every advisory must have an above-tolerance branch. Matching edits: `pdd-to-deliver-app-eval § Capture fitness` stops crediting the gate, `idea-to-pdd § Step 4a` stops letting a PDD assert an enforced tolerance. | ACE team |
| 2026-08-02 | **`assessment-gate` gains the bare-id calculate rule + a read-back check (ace#1119, partial).** `edit_field` with `calculate: "if(q1 = 'c', 1, 0)"` persists `q1` as a raw TEXT part — Nova does not resolve a bare id into a `field-ref` and emits no error, so `if(#form/q1 = 'c', 1, 0)` is the only form that resolves. Since every `qN_score` is `if(qN = '<key>', 1, 0)` and `user_score` sums those refs, one re-authoring pass using bare ids silently zeroes the scoring chain while the app still looks structurally correct. The component now mandates `#form/<id>` for every cross-field reference and requires a two-call read-back (`get_field` on one `qN_score` and on `user_score`; assert `calculate.parts` contains a `field-ref`) after any pass that rewrites scoring calculates. Cross-referenced from `init-safe-calculates` so Deliver authors hit it too. Does NOT close #1119 — its main finding (the authoring procedure doesn't produce discriminating items) is untouched. | ACE team |
| 2026-08-12 | **`discriminating-assessment-items` is re-pointed at item TOPIC selection and bank INDEPENDENCE; option-craft demoted to hygiene (ace#1187).** Re-measurement of the same 20-item bank (`spark-facilitator/20260810-0737`, Learn app `34a66bf7-9b48-40ef-aa56-31ac357e8a72`) with three readers — trained field persona **19.0/20**, untrained field persona **8.0/20**, untrained M&E domain expert **11/20** — showed the *reader*, not the options, was carrying the ace#1014 plateau. The expert proxy the eval had been briefing sat 15pp above the population the Deliver gate protects and understated true discrimination by 27% (A−C = 8.0 vs A−B = 11.0), and its edge was stability of exam technique rather than knowledge the training supplies. The component's own **"Ceiling, not field, measurement"** caveat had documented exactly this since 2026-07-30 while the eval hard-gated on the number anyway; that is now resolved rather than merely noted. Build-side rewrite: **Step 1 (the lever)** — before writing any option, name the taught rule, the module that teaches it, and the operation it protects (unpaid visit / blocked form / corrupted data); an item with no module is testing general competence, which an untrained worker already has, so it cannot move the contrast however its options are written. **Step 2** — at most ~1 item per underlying rule; duplicated rules inflate the nominal item count while effective resolution stays flat. **Step 3** — Gates 1 and 2 retained verbatim but explicitly reframed as *necessary, not sufficient*, and unable to rescue a Step-1 failure; the brief no longer implies option-craft can move the number. Padding is now named as what it is — a free mark that lowers the effective bar (5 free items turned a nominal 16/20 = 80% gate into 11/15 = 73%). The pre-release self-check leads with rule/module/operation + independence, and demotes the author's own cold pick to weak evidence (rewrite 2 self-predicted 5–7/12 and measured 9–10/12). Paired 1:1 with the contrast statistic in `pdd-to-learn-app-eval § assessment_discrimination` and the new `assessment_operation_coverage` dimension. | ACE team |
| 2026-08-12 | **New component `connect-supported-capabilities-only` — ACE apps may depend on no HQ feature flag but `commcare_connect` (ace#1195).** `spark-facilitator/20260810-0737` built the first ACE Deliver app to use **case-search inputs** (two per menu, all three menus). Nothing in the PDD asked for them; they came from the architect's default module authoring. They pulled in `search_claim` and `case_search_advanced`, **both `TAG_FROZEN`** in `dimagi/commcare-hq:corehq/toggles/__init__.py` — whose tag description reads *"This feature flag will be removed with an alternative solution in future. Do not add new projects to this list."* — with the advanced one further scoped to USS projects. `app-deploy`'s flag verification correctly detected the gap but emitted the wrong remedy ("email support@dimagi.com"), which asks Dimagi staff to override a stated internal policy for a capability the app never needed. The component states the rule as a **capability budget rather than a blocklist**, because Nova exposes flag-gated capabilities through the same tool surface as everything else with nothing marking them — banning only case search leaves related lookups, split-screen search and USH case-claim updates to sail through. The load-bearing distinction: **a case LIST is free, a case SEARCH is flag-gated**; the local list is served from the device casedb, which is why the Deliver smoke walked fine on a space where both flags were absent. Matching edit to `app-deploy` Step 4.5: it now branches on WHERE the requirement came from — traces to the PDD → operator email as before; does NOT trace to the PDD → `[BLOCKER]` build defect naming the capability to remove. Deliberately scoped: no slug→tag map was vendored (operator decision, 2026-08-12) — the instruction is "nothing but `commcare_connect`", which needs no lookup. | ACE team |
| 2026-08-12 | **`assessment-gate` gets the exactly-one-gating-instrument rule; `app-connect-coverage` stops mandating the defect (closes ace#1131).** The component said to wire `user_score` to `connect.assessment` at the PDD threshold but never said WHICH form, while clause (a) told the architect to build a pre-test AND a post-test — so architects wired both. `app-connect-coverage § Scope` then made it structural: its Learn row read "quiz-only (select inputs + `user_score` hidden) → `assessment`", and a **baseline pre-test has exactly that shape**, so a coverage pass would add the marker back even if a build removed it. Connect has no per-form distinction anywhere: one `passing_score` per `CommCareApp`, `process_assessments` sets `passed = score >= passing_score` for every submitted block carrying `user_score`, and every "has this worker passed?" surface uses any-passed semantics (`assessment_exists_subquery(passed=True)`, credentialing, the `passed` count). So a pre-test carrying the marker IS a gating instrument whatever its intro copy claims — measured live at 0.85 cold against an 80 gate, i.e. a worker who opened no module is recorded `passed=True`. Fixes: (1) the brief now says the marker goes on the **post-test only**, with the pre-test carrying `connect.learn_module` and computing its score internally for its own baseline labels; (2) a new mechanism block states the exactly-one rule with the Connect source citations; (3) `app-connect-coverage` splits its Learn quiz row into gating-post-test vs baseline-pre-test, says to decide **by role, not by shape**, and says a pre-test carrying `assessment` is a defect to REMOVE rather than coverage to preserve; (4) `app-release-qa` gains a **cardinality** halt (`learn-assessment-cardinality`) — exactly one form may declare `connect.assessment`, zero or ≥2 halts the release. The cardinality check has to live in release QA because `app_xml.py` never extracts assessments from the CCZ, so the behaviour is submission-time and marker-PRESENCE QA is structurally blind to it; the blueprint is the only pre-release surface that can see the count. | ACE team |
| 2026-08-12 | **`discriminating-assessment-items` enforcement moves off the author onto a measured build-time probe (closes ace#1119).** The component shipped a mandatory PRE-RELEASE SELF-CHECK graded by the same agent that wrote the bank — while the component's own text records that author self-prediction here is worthless (ace#1014's rewrite 2 self-predicted 5–7/12 and measured 9–10/12). New `pdd-to-learn-app § 4d` replaces the prediction with a measurement at build time, alongside the existing 4a/4b/4c post-build pre-checks: two separate agents, PDD-derived FLW persona, stems and options only, independently permuted neutral labels, picks committed before reveal, scored against the live `qN_score` calculates. Gate is `untrained_max × 100 >= the PDD's unlock threshold` → rewrite the items the probe got right, **bounded at two cycles**, then record a residual and proceed. Deliberately a FLOOR, not the eval's contrast: it catches only 'the protected population passes cold', and the brief says explicitly not to tune against it beyond clearing it — chasing an absolute cold score is what ace#1187 cost two authoring cycles. Calibrated on three real banks with large margins (decorative hh-poverty 20260722 fires at 1.00; spark-facilitator 20260810 clears at 0.55; hh-poverty 20260730 clears at 0.17). Skips below 5 scored items (degenerate, ace#1042). Carries a topology note: the step calls `Agent` so it must run at level 0, which holds because `commcare-setup` is executed inline — if the skill is ever dispatched as a subagent, skip and let the eval carry it rather than restructuring the phase. The self-check paragraph stays as authoring hygiene, now labelled as such. | ACE team |
| 2026-08-13 | **Retired the cold-read probe on BOTH sides; `discriminating-assessment-items` is now enforced by a structural audit (ace#1206).** The 2026-08-12 entries above hardened a persona-based blind-reader measurement in two places — a blocking build-time floor in `pdd-to-learn-app § 4d` and a trained-minus-untrained contrast in `pdd-to-learn-app-eval § assessment_discrimination`. Both are removed. **(1)** The eval's gate was arithmetically the statistic the same revision had just declared too noisy to gate on: `delta <= 1 - untrained_ratio`, tight whenever the trained reader scores 100%. **(2)** More fundamentally, the untrained reader is an LLM told to role-play a low-literacy CHW, and an LLM's floor is its own competence — it still reads English fluently, does the arithmetic, and eliminates options. For a CHW curriculum whose taught rules are largely "record what happened, honestly", the proxy passing cold is the EXPECTED result for a GOOD bank, so it cannot be a failure signal; the only way to drive it down is arbitrary trivia, which is harder to learn and less useful in the field. The metric's gradient pointed away from good material for the cohort it protected. No ACE bank has ever been put in front of a real CHW, so the LLM->CHW inference was never validated while being load-bearing for a gate. Trigger: `spark-facilitator/20260812-1635` — untrained persona 11/12 twice with identical miss sets, trained 12/12, on a build scoring 8.45 with complete trilingual coverage, worked examples from the real instrument and correct conditional gating. **The replacement asks the same question structurally**: enumerate the taught rules where common sense gives the WRONG answer (a convention that reads backwards, a deliberate non-payment, an inclusion rule, a named window or threshold) plus the high-consequence operations, map each scored item to the rule it keys on, and score coverage with counter-intuitive rules weighted double — from the artifact, with no persona, no dispatched agents and no run-to-run noise. An item whose distractors are all rejectable on sight is EXCLUDED from coverage rather than deducted for, so the penalty scales with how hollow the bank is — a capped deduction let nine hollow items cost the same as two and failed the negative control on measurement. Uncovered rules return as `repairs[]`, a work order the orchestrator hands to `pdd-to-learn-app` (never applied by the judge, which would converge on passing itself), capped at one round. Component text went 216 -> ~120 lines; the authoring guidance now leads with TOPIC selection and counter-intuitive coverage, and option craft is explicitly hygiene. Kept from the retired pass: the framing that an item nobody can answer without the training is perfect even if it looks easy. Negative control unchanged — `hh-poverty-targeting/20260722-1341` covers ~0 counter-intuitive rules and takes the absurd-distractor deduction on every item. | ACE team |
| 2026-08-13 | **New `screen-grouping` component — nothing governed screen composition (hh-poverty-targeting/20260812-2034).** A Nova `kind: group` compiles to a CommCare field-list, so every child shares ONE scrollable screen — and no component said so at build time: `observable-before-derived` governs question ORDER, `constraint-locality` governs CONSTRAINTS, and that was the whole surface. `pdd-to-deliver-app`'s Steps 4a-4f checked field counts, one-form-per-module, case write-back, case-list columns, the deliver marker and option sources; `pdd-to-deliver-app-eval` had ten dimensions. None looked at how many questions share a screen. So an architect grouping by relevance-condition (defensible on its own terms) put **all ten PPI indicators plus the household roster repeat on one screen**, cleared every Phase 3 gate, and scored `field_answerability` **9.5**. It surfaced two steps later while authoring the Phase 6 smoke recipe — after upload — costing a re-upload, a fresh HQ app id and an orphan to soft-delete; after Phase 4 it would have cost a delete-and-recreate of the Connect opportunity. **This is explicitly NOT a one-question-per-screen rule** (operator ruling, Jon 2026-08-13: multiple questions per screen is good design when they belong together; it just "shouldn't be a super long scroll") and must never be graded as one. The component states the coherence rule — group by a shared recall period / answer source / instruction, split when that changes, and give a question its own screen precisely when its rule DIFFERS (the 30-day electricity item among 7-day consumption items earns its own screen, and that separation is itself a teaching aid). Thresholds live in `lib/screen-shape.ts` so the brief, the build check and the eval cannot drift. Also extends `assessment-gate` (b): when the PDD names required topics and a per-topic minimum, the GATING bank must cover THOSE topics — a topic tested only in the non-gating pre-test is not covered by the gate, and a deliberate re-allocation must be named in the build memo. *Enforced:* `pdd-to-deliver-app § Step 4g` + `test/lib/screen-shape.test.ts` (regression anchor is the exact shipped group). | ACE team |
