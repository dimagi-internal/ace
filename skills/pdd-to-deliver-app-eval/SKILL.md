---
name: pdd-to-deliver-app-eval
description: >
  Grade a Nova-built Deliver app against the PDD that specified it —
  field count, ordering, conditional logic, Connectify wiring.
disable-model-invocation: false
---

# PDD-to-Deliver-App Eval

The Deliver app is the most testable artifact ACE produces. This skill
grades it on **two axes**: (1) does the build match the PDD's stated
structure (count, order, conditional logic, gate, Connectify wiring) —
*conformance*; and (2) **is the build a deployable data-capture
instrument** — *fitness* — graded against an expert "would a CommCare
specialist ship this?" bar that is **decoupled from the PDD**.

The second axis is load-bearing and dominates the weight (55%). It
exists because conformance alone is the ITN failure mode: a faithful
build of a thin PDD (no input validation, plain geopoint instead of
accuracy-gated GPS, a follow-up form that writes nothing back to the
case, English-only when the PDD named French) matched its skeleton and
scored 9.6 — while being materially undeployable next to a human
expert's hand-finished build. See `skills/_eval-template.md § The
out-of-chain fitness requirement` and
`docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`.

Sibling rubric to `pdd-to-learn-app-eval`. See `skills/_eval-template.md`
for shared contracts (verdict shape, severity rules, stock blocks)
and `skills/eval-calibration/SKILL.md` for calibration methodology.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `1-design/idea-to-pdd.md` | source PDD; archetype + Deliver App Specification + delivery unit drive expectation |
| Phase 3 | `3-commcare/pdd-to-deliver-app_summary.md` | Deliver-app structure summary (`nova_app_id`, forms, fields) |
| Nova MCP (optional) | `get_app({app_id: <nova_app_id>})` | authoritative field-by-field blueprint (recommended) |

## Products

- `3-commcare/pdd-to-deliver-app-eval_verdict.yaml` — verdict YAML per `_eval-template.md § Verdict YAML contract`

## Process

1. **Read inputs from GDrive** (paths in `## Inputs` above).

2. **Detect HITL-pending stub.** If the deliver app summary contains
   any of:
   - `nova_app_id: null`, `nova_app_id: TBD`, or no `nova_app_id` at all
   - explicit status text marking the build as HITL-pending
     (e.g. "actual app JSON/CCZ not yet produced", "awaiting human
     completion", "HITL-pending", "stub-only")
   - the summary lists *only* placeholders/section names with no
     field-level structure (the "skeleton" shape Phase 3 emits before
     Nova finishes a build)

   then emit `verdict: incomplete` immediately with `[INFO] HITL-stub
   summary; no built app to grade against PDD spec`. Do NOT score zero
   or warn — like degraded mode in `connect-program-setup-eval`, this
   is a structural gap in the upstream environment, not a quality
   defect. Once Nova produces a real `nova_app_id` and field-level
   structure, the rubric becomes gradable. Surfaced 0.9.11 cross-opp
   validation: trying to grade a HITL-pending summary makes 2 of 5
   dimensions ungradable (field-order, conditional-logic) and inflates
   the others toward "looks fine" because there's nothing concrete to
   discriminate against.

3. **Extract the PDD's Deliver spec.** Parse the `## Deliver App
   Specification` section (or equivalent for `multi-stage`). Build a
   structured expectation:
   - Total field count (sum across all sections).
   - Section list with question count per section.
   - Question order (the LLO-spec'd numbering).
   - Required-yes consent gate location (which question, what semantics).
   - Conditional-display rules (e.g. "only shown if Q11 = yes").
   - Connectify Deliver Unit name and Entity ID composite formula.
   - Operational caps that should appear in form intro copy.

4. **Extract the built app's actual structure** from the Nova
   blueprint (or app summary). Build the matching structured snapshot.

5. **Grade across 9 dimensions** — 5 conformance (45%) + 4 fitness
   (55%). Each dimension is 0–10. Overall score is the weighted mean.

   **The fitness dimensions are graded against an external expert
   "would a CommCare data-capture specialist ship this instrument?"
   bar — NOT against the PDD.** If the PDD was silent on something a
   deployable instrument needs, that silence is a *finding against the
   build*, never an exemption (per `_eval-template.md` contract rule 3).
   Read the live Nova blueprint (`get_app`) for these — `validate`/
   `constraint` expressions, capture type (bare geopoint vs the
   `gps-accuracy-capture` observability contract),
   choice-list vs free-text, `case_property` writes on update forms, and
   itext/translation entries are all visible there.

   *Conformance axis (45% — does it match the PDD skeleton):*

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Field-count match** | 7% | Total field count matches the PDD's spec. **Split rule (0.9.1):** one PDD field implemented as parent + relevance-conditional child = one half-deviation (-0.5). **Sub-question rule:** a separate `_other` field for spec'd "free-text other" = zero deviation. ±1 net = 0.5 off; ±2+ = 2 off. |
   | **Question-order match** | 6% | Per-section order matches LLO numbering. 1-point deduction per out-of-order question, dimension floor 5.0. |
   | **Gate semantics match** | 14% | Required-yes consent gate present, in correct form-flow position, with correct branch behavior ("if no → refusal-reason + submit"). Missing gate ≤3. Wrong branch ≤4. |
   | **Conditional logic match** | 8% | Relevance/display-conditional fields ONLY (e.g. "Q12 shown iff Q11=yes"). Missing relevance condition = 2-point deduction; inverted = ≤3. **ADDED relevance on a stated requirement (ace#1326).** A field that is `required` in the build AND `required` in the PDD, but carries a `relevant` the PDD did not specify, is either the correct consent resolution or an undisclosed narrowing of a stated requirement — and until this row existed it was neither scored nor surfaced. **Do not eyeball it — run `checkConsentBranchCompleteness` from `lib/consent-branch.ts`** over the blueprint plus the PDD field specs plus the build memo's disclosed list (the same helper the build calls per `_app-component-library.md § consent-script-floor`, so build-emit and eval-grade cannot drift). Grade its findings: `disclosed-consent-gate` → no deduction, surface a `[WARN]` naming the metric-denominator consequence; `undisclosed-consent-gate` → 1-point deduction (the build is right, the record is wrong); `undisclosed-narrowing` → 2-point deduction; `ungated-required-after-consent` → **hard-gate ≤3** — a household that withdraws cannot close the form without an answer it has no way to give, so what lands is invented data in the fields the primary metric is computed from. (Capture-quality validation expressions are graded under `data_quality_validation`, not here.) |
   | **Connectify wiring** | 10% | (a) Deliver Unit name exact match; (b) Entity ID composite matches PDD formula (or sensible — market_name + GPS hash for atomic-visit). **(b) YIELDS TO (b2) — ace#1434.** When the PDD pins an identity-only grain AND a non-payable branch exists, the two are in direct conflict: (b2) mandates a third key component and (b) mandates exactly two. The **discriminator wins**, so a build shipping the payability-scoped key and disclosing it as a named deviation takes **NO deduction under (b)** — it is doing what (b2) requires. Deduct under (b) only when the build deviates from the pinned grain for some OTHER reason, or deviates without disclosing. Do not grade this by judgement: `resolveEntityIdGrain()` in `lib/entity-id-precedence.ts` returns the one required shape, and the same opportunity resolved this two different ways on two consecutive runs before it existed; **(b2) PAYABILITY (ace#969): when the PDD marks a subset of submissions to this form non-payable (a did-not-happen branch, a screening-only visit, a committee-vs-community meeting type), the `entity_id` calculate MUST reference the payability discriminator. An identity-only key on such a form lets a non-payable submission mint the key first, so the real payable visit dedups against it and the worker cannot be paid for work they did. Hard-gate the dimension ≤3 if the non-payable branch exists and is neither keyed nor recorded in the build memo. **The key's benefit is CONTINGENT (ace#1434):** it stops a non-payable submission consuming the payable slot, but it also mints `<identity> - no` as its own countable entity, so the worker is paid correctly only if Phase 4 applies a verification rule rejecting that predicate. If the build ships a payability-scoped key, the residual list MUST name the required Phase-4 predicate; a PDD naming a predicate no Phase 4 step applies is a 1-point deduction and an `[INFO]`, because without it the daily cap decides and a worker whose first follow-up was a refusal can still be blocked — the #969 failure one layer down.** (c) required-for-credit fields (photo + GPS + consent) wired with relevant `validate` rules. |

   *Fitness axis (55% — is it a deployable instrument, graded vs expert bar):*

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Capture fitness** | 14% | Does the instrument capture *reliable, structured* data? Check, independent of the PDD: (a) **GPS** — where the PDD's evidence model specifies an arrival/location radius or accuracy tolerance, the build must ship the `gps-accuracy-capture` **observability** contract: the tolerance stated in the question hint, a `gps_accuracy_m` calculate SUBMITTED on every visit, normalized lat/lon outputs, and a live accuracy advisory whose relevance branches cover the whole range INCLUDING an above-tolerance branch. A plain `geopoint` with only a text hint does **not** satisfy a stated tolerance. **Do NOT credit — and do NOT deduct for the absence of — a hard capture-gate that rejects low-accuracy fixes: it is unbuildable on both surfaces** (Nova rejects `validate` on `kind: geopoint`; Connect's verification-flags form no longer carries `gps` / `gps_radius_meters` — dimagi-internal/ace#1006, ace#1013). Grading a build down for lacking it, or up for claiming it, is rubric noise. An accuracy advisory that fires only inside a band BELOW the tolerance (silent on the worst readings — the ace#1006 blind spot) is a 2-point deduction; (b) **structured choices** — answers with an enumerable option set (who-sleeps-under-net, net-condition, risk groups) use single/multi-select, not free `text`; (c) **`other → specify`** — every "Other" option has a conditional free-text follow-up; (d) **bucketed numerics** where field-reliable (net age as `<1 / 1–2 / 3–4 / 5+ / don't know` rather than a raw int). **Hard-gate:** PDD specifies a GPS radius/tolerance AND the build ships a plain geopoint with no submitted `gps_accuracy_m` and no accuracy advisory → dimension **≤3**. (The gate is on the *observability* contract, not on enforcement — see (a).) ≥2 enumerable answers left as free-text → ≤4. |
   | **Data-quality validation** | 13% | Does the instrument *enforce* data quality? Graded vs what a deployable form should constrain, NOT vs the PDD: numeric bounds on counts (`household_size 1–30`), cross-field checks (`under_5 ≤ household_size`), phone-format regex where a phone field exists, char limits on free text, required `validate` on every credit-bearing field. **Hard-gate:** a data-capture instrument with near-zero validation (only a consent check + one range) → dimension **≤3**. Each whole class of missing constraint that a deployable build needs (counts unbounded, phone unformatted, free-text uncapped) = 1.5-point deduction. |
   | **Case persistence** | 12% | Do follow-up / case-update forms **write back the observations they capture**? A case-update form that captures new observations (retention, change, V2 readings) but writes **zero** case properties defeats its own purpose. **Hard-gate:** a case-update form that captures new user-facing observations and writes 0 case properties → dimension **≤2** (this is the exact ITN Visit-2 defect). **N/A rule:** single-form atomic-visit with no follow-up form has nothing to persist — score this dimension `null` and redistribute its weight proportionally across the other fitness dims (do NOT score it 10 — absence of the form isn't a win). |
   | **Field answerability (walkability)** | 8% | **Can a real user walk this form front-to-back in the real-world sequence, answering each question at the moment it is asked and fixing every error where it appears?** Graded by mentally walking the form in order as the FLW lives it — NOT by checking it against the PDD (the PDD usually leaves flow to ACE, which is why this is a fitness dimension). Two independent checks, each with its own hard-gate: **(a) Observable-before-derived** — no required, user-facing question may ask for a value that is a function of answers ordered AFTER it. The tell is an outcome / disposition / status field near the top of the form with downstream questions relevance-gated on it. **Hard-gate:** a user-facing outcome question precedes its own inputs → dimension **≤3** (ace#979: `visit_outcome` was question 1, with 20+ fields gated on it). **(b) Constraint locality** — every `constraint` / `validate` must be satisfiable on the screen where it fires, referencing only `.` or same-repeat siblings, with a `validate_msg` naming an action available on THAT screen. **Hard-gate:** any constraint references a node the user cannot edit from that screen → dimension **≤3** (ace#980: a 50m GPS-accuracy rule whose message said "recapture the location" sat on a later yes/no confirmation; a roster-minimum rule sat on an unrelated zone question). **(c) Relevance reachability** — a `relevant` clause must be decidable by the time the form walks past the field it gates. A relevance referencing a field answered LATER means the field is skipped and, if a later branch ends the form, never revisited. **Hard-gate:** a field whose relevance references ONLY later answers can never display → dimension **≤3** (ace#996: `outcome_note` submitted empty on exactly the two outcomes it existed to capture). A partially-decidable relevance is a 1-point deduction. **(d) Screen composition** — a `group` is a CommCare field-list, so every question inside it shares ONE scrollable screen. **This is NOT a one-question-per-screen criterion and must never be graded as one** (operator ruling, 2026-08-13: multiple questions per screen is good design when they belong together). Grade the two things that are actually defects: a screen carrying more answerable questions than a worker can hold in view, and a `repeat` nested inside a group (which does not render as its own repeat flow). **Do not eyeball the counts — run `checkScreenShape` from `lib/screen-shape.ts` over the blueprint** (same helper the build calls at `pdd-to-deliver-app § Step 4g`, so build-emit and eval-grade cannot drift). **Hard-gate:** any `severity: 'violation'` finding → dimension **≤3**. Each `severity: 'warn'` that the build memo does NOT justify is a 1-point deduction; a warn the memo justifies as one coherent set is no deduction. Cross-check against `app-release-qa`'s mechanical bind report when a released CCZ exists — that check is authoritative for (b) and (c); disagreeing with it means re-reading, not overriding. **(e) Cross-question satisfiability** — two REQUIRED questions on the same walk path that capture the same real-world value must not carry constraints a worker cannot satisfy together. Identifying the pair is your call (it is semantic); what the pair IMPLIES is arithmetic — **run `checkPairSatisfiable` from `lib/constraint-satisfiability.ts`**, do not eyeball the intervals. `satisfiable: false` (empty intersection) → **hard-gate ≤3**. `narrowed: true` with a non-empty intersection → **1-point deduction**: the worker can answer the first question with a date the form ACCEPTED and then be blocked on the second. `'unknown'` (a constraint the parser could not read) is judged by hand and must not be recorded as a pass. Live: spark-facilitator/20260728-1338 asked the next-meeting date twice — `. >= today()` then `. > today() and . <= today() + 30` — so rescheduling for TODAY was a dead end, on exactly the branch the PDD required to be reachable without friction. All of (a)/(b)/(c) passed on that form (ace#1015). |
   | **Language conformance** | 8% | **HARD-FAIL dimension — RE-INVERTED 2026-08-17 (ace#1391 forward). Read the criteria, not your memory: this dimension has flipped TWICE in four days.** Until 2026-08-14 complete inline coverage was full credit; from 2026-08-14 English-only was full credit; from **2026-08-17** Nova ships a real per-language channel and ACE builds it, so a *real translation layer* is full credit and English-only is a miss. Applies only when the PDD names a working language other than English; otherwise `null` + redistribute. **English is always the source language and the review surface** (standing decision, Jon, 2026-08-17 — see `_app-component-library.md § app-language-layer`). Grade against `get_languages` + `get_translatable_content` on the built app, plus the build memo: (a) **English source complete AND the working language present as a real target with authored translations, `out-of-date` = 0**, English still `sourceLanguage` → full credit, with an `[INFO]` recording the coverage counts; (b) **language added but thinly authored** — a substantial share of units still `origin: copied` (an English copy wearing the language's name) → **5** + `[WARN]` naming the roles left untranslated; (c) **no language layer at all** when the PDD names a working language → **≤3 → suite `fail`**; (d) **`out-of-date` > 0 at hand-off** → **≤3 → suite `fail`** — the English moved after translation and those strings silently fell back to English, which is the exact failure the translate-LAST rule exists to prevent; (e) **English is no longer the source language, or was removed/relabelled away** → **≤3 → suite `fail`**; (f) **systematic inline stacking** (labels carrying `English / <LANGUAGE>: …`, the pre-2026-08-14 pattern) or a **language-selector question** → **≤3 → suite `fail`** — a real channel exists now, so faking one is strictly worse than it was. **Review state is NOT a deduction.** ACE-authored translations are `origin: ai` / `review: needs-review` by construction and Nova serves them live; `needs-review` is an audit trail, not a defect, and it is cleared by the same human review the English copy gets — do not treat it as a special gate. **Quality note, not a deduction:** since the English is both the translation source and the fallback for every stale unit, surface a `[WARN]` where stems or labels are long, idiomatic or clause-heavy. |

   **Deduction rules:**
   - Any single dimension ≤3 → suite verdict `fail`, regardless of
     overall mean. (This now bites the fitness hard-gates: a build that
     conforms perfectly but has a plain-geopoint GPS against a stated
     radius, near-zero validation, a write-nothing V2, or missing
     required translations **fails** — it can no longer launder to 9.6.)
   - **`null` dimensions** (case_persistence / language_conformance when
     N/A) are excluded from the weighted mean and their weight is
     redistributed proportionally across the scored dimensions.
   - **Inflation guard (0.9.1, mirrors `ocs-chatbot-eval`):** if the
     rubric surfaces ≥2 `[WARN]`-tier `auto_surfaced` entries, overall
     is capped at **8.5**.
   - 2+ dimensions in 4–6 range → suite verdict `warn`.
   - All scored dimensions ≥ 7 AND overall ≥ 7.5 → suite verdict `pass`.

5b. **Standing-instruction hard-gates (binary, non-weighted).** Pass/fail
   conformance checks on the standing app-build instructions (see
   `skills/_app-component-library.md`). NOT weighted dimensions — they never
   enter the weighted mean — but a violation surfaces `[BLOCKER]` and forces
   suite verdict `fail`, exactly like a dimension ≤3. Both are readable
   straight from the Nova blueprint (confirmed applied by the 2026-06-25 build).

   - **`naming_convention`** — the app's display name MUST contain the words
     "Deliver app". Read the name via `get_app`. Absent → `[BLOCKER]` → `fail`.
   - **`terminology`** — the words "section" and "module" MUST NOT appear in
     any USER-FACING string (form names, module/menu names, question labels,
     hints, choice labels). Scan names + labels via
     `get_form({app_id, moduleUuid, formUuid})`. API structural keys — uuids,
     `moduleUuid`/`formUuid`, "Module 0" — are metadata, never rendered;
     ignore those. Any user-facing occurrence → `[BLOCKER]` → `fail`.

   **Addressing note (ace#1132).** Nova is uuid-addressed since 2026-07-31 —
   no tool accepts `moduleIndex` / `formIndex` / `fieldId`. Get the uuids
   from the summary's `nova_uuids:` frontmatter block if the build wrote one,
   otherwise from ONE `get_app({app_id})` (its blueprint prints `[uuid …]` on
   every module, form, and field); `search_blueprint({query, app_id})`
   resolves a single semantic name. Resolve once at the top of the run and
   reuse the map for every `get_form` read below.
   - **`consent_floor`** (added 2026-07-27, ace#983; trigger + search widened
     2026-07-31, ace#1137) — **grade this whenever the PDD describes consent
     being sought from the people whose data, photographs, or recordings are
     captured — WHETHER OR NOT the PDD declares a consent FIELD.** The trigger
     is the build-side one in `_app-component-library.md §
     consent-script-floor`, verbatim, and it fires on ANY of: a consent gate /
     consent field in the Deliver App Specification; a **read-aloud, verbatim,
     spoken, or announced** consent of any kind, even when the only place it
     lives is a `label` or a Learn-app lesson; a photograph, audio, or video
     capture of identifiable people; a survey that feeds an eligibility,
     targeting, or enrolment decision. Build-emit and eval-grade are
     deliberately symmetric in that library — if the component fires on the
     build side, this dimension MUST fire here.

     **Find the script wherever it lives — do not look only at a consent
     field's hint.** Scan every form's fields via `get_form` and take the
     consent script to be whichever of these carries the consent language:
     a consent field's `hint`, a consent field's `label`, a read-aloud
     `label` node (the `photo_consent_script` shape), an
     `embedded-bc-script` passage that contains a consent ask, or a
     consent passage in the Learn app. A verbatim read-aloud passage that
     seeks consent is a consent script first and a read-aloud script
     second — grade it here even when the build emitted it as
     `embedded-bc-script`.

     The script MUST contain all six floor elements per
     `_app-component-library.md § consent-script-floor`: (a) purpose ·
     (b) voluntary · (c) may stop · (d) **confidential** ·
     (e) **where the data goes / who sees it** · (f) **whether
     participation guarantees a benefit**. Check each element by name. Any
     missing element → `[BLOCKER]` → `fail`.

     **Elements (d), (e) and (f) are the ones builds actually omit** —
     (e)/(f) in ace#983, (d)/(e) in ace#1137. Do not assume a
     fluent-sounding paragraph covers them. Element (e) must name any
     automated / AI verification layer and any human audit sample, not just
     the implementing organization; element (f) is mandatory whenever the
     PDD says eligibility, targeting, or enrolment is determined
     downstream.

     **When the trigger fires but the PDD declares no consent field,
     ALSO assert the attestation is recorded in a field** — an unrecorded
     consent is unauditable, and the payment record is the only place it
     can be evidenced. Script present at full floor but no attestation
     field → `[BLOCKER]` → `fail`.

     Reproducer for the narrow-trigger miss this widening closes:
     `spark-facilitator/20260731-0656` (Deliver app
     `657a4bb7-fb2f-4a10-af43-8414707b2c43`, field `photo_consent_script`)
     shipped the programme's only consent language as a read-aloud script
     scoring **4/6** — `confidential` and `where the data goes / who sees
     it` both absent, on a programme whose photos go to an AI verification
     layer plus a 10% human audit sample. The PDD declared no consent-gate
     *field*, so the old wording (*"when the PDD requires recorded
     consent"* / *"read the consent field's hint"*) did not fire and the
     build passed the gate **by not being checked**.
   - **`threshold_coherence`** (added 2026-07-27, ace#984) — when the PDD fixes
     ≥2 numbers constraining the same physical quantity, the pair MUST be
     coherent OR the conflict MUST be surfaced in the build memo. Check at
     minimum: dedup radius vs accepted GPS accuracy tolerance (read the
     tolerance from the geopoint's hint + the `gps_accuracy_m` advisory
     branches — NOT from a `constraint`, which Nova cannot emit on a geopoint,
     ace#1006); duration floor vs realistic completion
     time for the actual item count; any score threshold / lookup range vs the
     instrument's attainable min–max computed from the point values. An
     incoherent pair with NO build-memo entry → `[BLOCKER]` → `fail`. An
     incoherent pair that IS surfaced → `[WARN]` (the value is a PM decision;
     noticing it is ACE's job).

   *Not enforced here (deferred to the post-build HQ step per
   `docs/superpowers/specs/2026-06-25-post-build-hq-settings-automation.md`):*
   `live-photo-capture` (`acquire` appearance) and `grid-menu-display` are not
   representable in the Nova blueprint, so this rubric cannot read them yet.

6. **Write the verdict YAML** to
   `3-commcare/pdd-to-deliver-app-eval_verdict.yaml` using the shape
   from `skills/_eval-template.md § Verdict YAML contract`. Dimensions:

   ```yaml
   dimensions:
     # Conformance axis (45%) — matches the PDD skeleton
     field_count_match:        { weight: 0.07 }
     question_order_match:     { weight: 0.06 }
     gate_semantics_match:     { weight: 0.14 }
     conditional_logic_match:  { weight: 0.08 }
     connectify_wiring:        { weight: 0.10 }
     # Fitness axis (55%) — deployable instrument, graded vs expert bar
     capture_fitness:          { weight: 0.14 }
     data_quality_validation:  { weight: 0.13 }
     case_persistence:         { weight: 0.12 }   # null + redistribute when no follow-up form
     field_answerability:      { weight: 0.08 }   # walkability: observable-before-derived + constraint locality
     language_conformance:      { weight: 0.08 }   # null + redistribute when PDD names no working language; a REAL translation layer (English source complete + working language authored + out-of-date 0) is full credit; HARD-FAIL on no layer at all, out-of-date > 0, English no longer source, inline stacking, or a language-selector question (ace#1391, re-inverted 2026-08-17)
   ```

7. **Write the human-readable report** to
   `3-commcare/pdd-to-deliver-app-eval_report.md` summarizing each
   dimension's score, surfaced discrepancies (WARN/INFO table), and
   suggested Nova edits to bring the build into spec.

8. **Auto-surfaced concerns** (per `_eval-template.md § Auto-surfaced
   severity rules`, plus skill-specific surfaces):
   - `[WARN]` for each user-facing field present in the build but not
     in the PDD spec.
   - `[INFO]` for the EXISTENCE of hidden/computed fields added beyond
     spec (case_name, entity_id, etc.) — those are typical Nova
     decisions, not bugs. **This carve-out is about existence only. It
     does NOT license the CONTENT of an `entity_id` calculate, which is
     graded by `connectify_wiring` (b)/(b2) and can absolutely be a bug
     — an identity-only key on a form with a non-payable branch costs a
     frontline worker their pay. As originally worded this line read as
     "entity_id is not a bug surface", which is how ace#969 came to be
     surfaced only as a free-form observation AGAINST this rule.**
   - `[BLOCKER]` for each fitness hard-gate that fired (plain geopoint
     vs stated radius; near-zero validation; write-nothing case-update
     form; missing or materially-incomplete required-language coverage;
     a `checkScreenShape` violation — an oversized field-list screen or a
     `repeat` nested in a group).
   - `[WARN]` for each `checkScreenShape` warn the build memo does not
     justify, naming the group and its question count. A grouping the memo
     defends as one coherent set (one recall period, one answer source) is
     NOT a finding — say so explicitly rather than leaving it unmentioned.
   - `[INFO]` when the PDD names a working language other than English,
     recording the final `get_languages` coverage counts for that language
     (`ready` / `needs-review` / `out-of-date` / `missing`) and that the
     translations are ACE-authored (`origin: ai`) and awaiting the same
     review the English copy gets — so a reader can see the review state
     without reading it as a defect (ace#1391 forward).
   - `[WARN]` for each user-facing string still carrying a stacked or
     parenthetical translation — the retired pre-2026-08-14 mechanism
     leaking into a build.
   - `[BLOCKER]` for each standing-instruction hard-gate that fired
     (`naming_convention`: display name lacks "Deliver app"; `terminology`:
     "section"/"module" in a user-facing string).
   - `[WARN]` for each enumerable answer left as free-text, each whole
     class of missing data-quality constraint, and each "Other" option
     with no specify follow-up.

## LLM-as-Judge Rubric

This rubric is **structural-first, semantic-second**. Most
discrepancies between PDD and built app are mechanical: count, order,
condition, name. The judge prompt should compute these
deterministically from the two snapshots before spending tokens on
"is this Connectify wiring sensible?" semantic judgments.

When invoking the LLM judge, seed the prompt with both snapshots in
structured form (parsed JSON or YAML), not the raw artifact text.
That way the judge spends its tokens on the comparison, not on
parsing the markdown.

**Calibration:** the rubric is calibrated against the
`eval-calibration` ground-truth catalogue. For
`smoke-20260428-1242`, known discrepancies the rubric MUST detect
are listed in
`ACE/smoke-20260428-1242/eval-calibration/known-issues.md` (the
Q8/Q8b split, the Q21b sub-question, the operational-caps
server-side note). Detection rate must be ≥ 80% on a calibration
run.

**Fitness-axis ground truth (added 2026-05-29):**
`measured_on: 2026-05-29`. Both cited builds are **live and mutable**
CommCare/Nova apps — re-measure before using either as a regression gate
rather than assuming these verdicts still reproduce (`eval-calibration
§ Step 3c`). The durable half of this anchor is the **verdict list**
below, not any ratio: verdicts survive re-enumeration, scores don't.

The fitness
dimensions are calibrated against the malaria-itn-app pair —
the human expert's `[Final]` builds as the *deployable* bar and the
ACE run `20260528-1607` thin build as the *negative control*. The
negative control MUST score: `capture_fitness ≤3` (plain geopoint vs
a stated 100m radius), `data_quality_validation ≤3` (only a consent
check + confidence 1–5), `case_persistence ≤2` (Visit 2 writes no
case properties). If the rubric scores the thin ITN build above `warn` on
any of these, the rubric is not yet calibrated. **Anchor amended
2026-08-14 (ace#968), then RE-amended 2026-08-17 (ace#1391 forward):**
this anchor originally required `localization_match ≤3 → fail`
(English-only against a French PDD). The 2026-08-14 amendment removed that
clause because English-only had become the correct build. Nova shipped a
real per-language channel on 2026-08-17, so the clause is **RESTORED** —
as `language_conformance ≤3 → fail`, case (c), no language layer when the
PDD names a working language. The anchor's original 2026-05-29 verdict was
right all along; only the mechanism changed. The three dimensions above
still force `fail` on their own, so the negative control holds either way.
See `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`.

## Archetypes

| Archetype | What this skill does |
|---|---|
| `atomic-visit` | Default. Grades the single-form Deliver app against the PDD's Deliver Specification. |
| `focus-group` | Grades the FGD facilitation form (typically multi-section, attendance + per-domain summaries) against the PDD's session-form spec. The "consent gate" criterion shifts to the participant-consent script's location and semantics. |
| `multi-stage` | Run once per stage that has its own delivery work, branching on each stage's archetype. The stage-gate field is graded under `gate_semantics_match`. |

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)` for the Drive
block. Plus:
- Nova MCP: `get_app` (authoritative blueprint, recommended over the
  human summary alone)

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior (stock)`.

## Taught-vs-collectable (shared with the sibling eval, ace#1259)

Read the Step 4h `taught-vs-collectable` report from the Phase 3 build memo (or
re-run `checkTaughtStepsCollectable` from `lib/taught-vs-collectable.ts` over
the two blueprints). Every evidence step the instrument states as unconditional must be
recordable on EVERY branch a worker can be on.

A finding is an `[INFO]` on this eval, not a deduction, **unless** this artifact
is the one that should change — because both apps can be PDD-conformant while
disagreeing with each other, which is exactly what happened on
hh-poverty-targeting/20260813-1612 (Learn M8 taught an unconditional
photograph; the Deliver photo field was gated on consent and unreachable on a
vacant visit). Say which side you think should move and why; do not silently
absorb the disagreement into a score.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-08-17 | **Nova shipped a real per-language channel; `language_conformance` RE-INVERTED (ace#1391 forward; Jon).** Verified live against `tools/list`: **95 tools, up from 81 on 2026-08-14**, carrying six itext-shaped language atoms. The 2026-08-14 English-only decision rested on that channel not existing; it now does. Jon's call: fully implement, but **English is always the source language and the review surface**, and translations are reviewed like any other artifact — English included — with no bespoke native-speaker gate. Same 8%, same null-when-N/A, so no reweighting and every other anchor holds. Full credit now needs a REAL layer (English source complete + working language authored + `out-of-date` 0 + English still `sourceLanguage`); `fail` on no layer, `out-of-date` > 0, English displaced as source, inline stacking, or a language-selector question. **`needs-review` is explicitly NOT a deduction** — ACE's writes are `origin: ai` by construction and Nova serves them live, so it is an audit trail, not a defect. Component `english-only-ui` → **`app-language-layer`**, carrying the translate-LAST ordering rule (editing English demotes a translation to `out-of-date`, whose `effective` falls back to English — proven live on scratch app `b4e2c8fd`). The ITN negative control's clause is **RESTORED** as `language_conformance ≤3 → fail`: its original 2026-05-29 verdict was right, only the mechanism changed. **This dimension has now flipped twice in four days — the criteria say so out loud, because a judge's priors are the failure mode here.** *Enforced:* `test/skills/app-language-layer.test.ts`. | ACE team |
| 2026-08-14 | **ACE builds English-only app UIs; `localization-layer` retired and `localization_match` INVERTED (ace#1391, superseding ace#968; Jon).** Re-verified Nova's live surface: zero hits for `itext`/`locale`/`i18n`/`translat` across all **81** tools (was 63 on 2026-07-31), `update_app` carries only `name`, and the architect's own 70k-char operating prompt never mentions languages; the surface's only language parameter is `defaultLanguageCode` on messaging automations. Since 2026-07-30 the sanctioned fallback had been stacking every language inline in one label — Jon's call: that is a terrible solution and localization should be solved properly when it can be solved at all, so until Nova ships a real per-language channel ACE ships an honest monolingual UI rather than a convincing fake. Component `localization-layer` → **`english-only-ui`** (same trigger, opposite instruction: build English, do not stack, do not hunt for a translations parameter, record the decision in the build memo). Eval dimension `localization_match` → **`language_conformance`**, same 8% and same null-when-N/A: English-only is now FULL CREDIT, stray stacked strings score 5 + `[WARN]`, systematic inline stacking or an in-app language selector is ≤3 → `fail`. Both calibration anchors amended — the ITN negative control's `localization_match ≤3` clause is REMOVED, not relaxed (the same artifact now scores full credit there; the other three dimensions still force `fail`). Phase 1 still records the working language — it drives training, facilitation, the OCS chatbot and the solicitation — but must not assert a translated app; multilingual UI is now a **Table B** row (buildable in CommCare via itext, closed on ACE's builder — never call it a platform limit). *Enforced:* `test/skills/english-only-ui.test.ts`. | ACE team |
| 2026-08-14 | **`field_answerability` gains (e) cross-question satisfiability (ace#1015).** Two REQUIRED questions capturing the same real-world value, on one walk path, with incompatible constraints — a class none of (a)/(b)/(c) names, and all three correctly PASSED the form that carried it. Only unsatisfiable at the EDGE (`= today()`), so per-field analysis and a happy-path smoke walk both miss it. Graded via `checkPairSatisfiable` (`lib/constraint-satisfiability.ts`): empty intersection hard-gates ≤3, a NARROWED range is a 1-point deduction, and an unparsed constraint is `'unknown'` rather than a pass. Paired with the new `branch-scoped-groups` component, which addresses the proximate cause (an ungated branch-scoped group). | ACE team |
| 2026-08-14 | **`conditional_logic_match` gains the ADDED-relevance class (ace#1326).** The dimension deducted for a MISSING or INVERTED relevance; an *added* one that neuters a stated requirement was not a class it scored, and `field_answerability`'s reachability check passes both shapes because the consent gate is answered in an earlier group either way. So the consent-withdrawal collision — element (c) vs an unconditionally-required observation field — shipped silently in both directions, one of which puts INVENTED data in the fields the programme's primary metric is computed from. Graded mechanically via `checkConsentBranchCompleteness` (`lib/consent-branch.ts`), shared with the build side. `ungated-required-after-consent` hard-gates ≤3; an undisclosed consent gate is a 1-point deduction (the build is right, the record is wrong); a disclosed one is a WARN naming the denominator consequence. | ACE team |
| 2026-08-13 | **Dated the fitness-axis calibration anchor (ace#1212).** The malaria-itn-app pair (`[Final]` deployable bar + ACE run `20260528-1607` negative control) was recorded as a bare pointer at two live, mutable CommCare/Nova apps, with no measurement date — so a drifted anchor could not be told apart from a valid one, and a rubric revision checking itself against it would silently measure something else. Added `measured_on: 2026-05-29` plus a mutability notice, and stated explicitly that the durable half of this anchor is the **verdict list** (`capture_fitness ≤3`, `data_quality_validation ≤3`, `case_persistence ≤2`, `localization_match ≤3 → fail`) rather than any ratio — verdicts survive re-enumeration, scores don't. Per `eval-calibration § Step 3c`. *Enforced:* `test/skills/eval-calibration-anchors.test.ts`. | ACE team |
| 2026-04-28 | Initial version. Cross-artifact rubric: 5 dimensions (field_count_match, question_order_match, gate_semantics_match, conditional_logic_match, connectify_wiring). Calibrated against `eval-calibration/known-issues.md`. Template for future cross-artifact evals. | ACE team (eval system buildout) |
| 2026-04-29 | Added step-2 HITL-pending stub detection. If the deliver app summary has no `nova_app_id`, has `TBD`/`null`, is explicitly marked HITL-pending, or carries only skeleton structure, emit `verdict: incomplete` immediately. Surfaced 0.9.11 cross-opp validation against `turmeric-dogfood-20260427`: trying to grade a HITL-pending summary made 2 of 5 dimensions ungradable (field-order, conditional-logic) and inflated the others. The early-return pattern mirrors `connect-program-setup-eval`'s degraded-mode detection — both treat upstream environmental gaps as `incomplete`, not as quality defects. | ACE team (0.10.8) |
| 2026-05-05 | Step 7 report path migrated to `runs/<run-id>/3-commcare/pdd-to-deliver-app-eval_report.md` (was opp-level `eval-reports/YYYY-MM-DD-pdd-to-deliver-eval.md`). No methodology change. | ACE team |
| 2026-05-29 | **Fitness axis added (ITN post-mortem).** Reweighted the 5 conformance dims 100%→45% and added 4 out-of-chain fitness dims (55%): `capture_fitness` (0.18), `data_quality_validation` (0.15), `case_persistence` (0.14), `localization_match` (0.08, hard-fail). All four graded against an expert deployability bar decoupled from the PDD, with hard-gates that drop a faithful-but-undeployable build below `pass`. Was: a thin build that matched a thin PDD scored 9.6 (ITN run `20260528-1607`). Calibrated against the malaria-itn-app `[Final]` (deployable bar) + thin ACE build (negative control). Per `_eval-template.md § out-of-chain fitness requirement` + `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`. | ACE team |
| 2026-07-28 | **`capture_fitness` stops crediting a GPS capture-gate that cannot exist (ace#1006).** Criterion (a) required "a capture-gate that rejects low-accuracy fixes." That is unbuildable on both surfaces (Nova rejects `validate` on `kind: geopoint`; Connect's verification-flags form no longer carries `gps` / `gps_radius_meters` — ace#1013), so the judge was rewarding a claim and penalising its honest absence. Re-pointed at the `gps-accuracy-capture` observability contract (tolerance in hint + `gps_accuracy_m` submitted every visit + normalized lat/lon + whole-range advisory), with an explicit do-not-credit/do-not-deduct instruction on enforcement and a new 2-point deduction for a band-only advisory that goes silent above the tolerance. `threshold_coherence` now reads the tolerance from the hint + advisory branches rather than from a geopoint `constraint`. | ACE team |
| 2026-07-30 | **`localization_match` grades coverage, not mechanism (ace#968).** The dimension required a translation set "via itext", but Nova exposes **no per-language / locale / itext channel on any tool** (`update_app` carries only `name` and `connect_type`), so it graded against an unreachable mechanism and architects who took the only available path (inline multilingual labels) reported it as a deviation. Now: complete coverage authored INLINE is the **sanctioned fallback** and takes full credit with an `[INFO]` recording the mechanism; materially-incomplete coverage and English-only both still hard-fail ≤3; the two permitted degradations (option labels identical across languages stay bare; short strings such as case-list headers use the compact slash form) must not false-fail; and where the PDD carries a low-literacy design constraint, the multiplied reading load surfaces as a `[WARN]` for a human decision rather than a deduction against the build. Paired 1:1 with `_app-component-library.md § localization-layer`. | ACE team |
| 2026-07-31 | **Migrated every `get_form` read to uuid addressing (ace#1132).** Nova's 2026-07-31 redeploy moved its whole surface from `moduleIndex`/`formIndex`/`fieldId` to `moduleUuid`/`formUuid`/`fieldUuid`, so the `terminology` and `consent_floor` scans named uncallable operations. Added an addressing note at § 5b: resolve uuids ONCE per run — from the build summary's `nova_uuids:` frontmatter if present, else one `get_app({app_id})` (its blueprint prints `[uuid …]` on every module/form/field), with `search_blueprint({query, app_id})` for a single semantic name — and reuse the map for every `get_form` read. `terminology`'s "ignore API index keys" carve-out now names uuids as the structural metadata to ignore. Also corrected `localization_match`'s parenthetical (`update_app` now carries only `name`); the no-itext-channel claim itself was re-verified across all 63 live tools. | ACE team |
| 2026-08-01 | **Widened `consent_floor`'s trigger and its search surface to match the build side (ace#1137).** The dimension gated on *"when the PDD requires recorded consent"* and read *"the consent field's hint"* — narrower on BOTH counts than `_app-component-library.md § consent-script-floor`, whose trigger fires on read-aloud/spoken/announced consent **even with no consent FIELD declared**, and on photo/audio/video capture of identifiable people. Build-emit and eval-grade are deliberately symmetric in that library; they had drifted apart, so a spoken-consent build whose script lives in a `label` passed the gate **by not being checked** — exactly what shipped on `spark-facilitator/20260731-0656` (`photo_consent_script`, 4 of 6 elements, missing `confidential` and `where the data goes / who sees it`, on a programme whose photos reach an AI verification layer plus a 10% human audit sample). § 5b now carries the component's trigger verbatim, tells the grader to find the script wherever it lives (consent-field `hint` OR `label`, a read-aloud `label` node, an `embedded-bc-script` passage containing a consent ask, or a Learn-app consent passage), names (d)/(e)/(f) as the elements builds actually omit, and adds the missing-attestation-field blocker for the no-consent-field case. | ACE team |
| 2026-08-13 | **`field_answerability` gains (d) screen composition — the dimension was blind to the wall it exists to catch.** It graded observable-before-derived, constraint locality and relevance reachability, all of which the hh-poverty-targeting/20260812-2034 Deliver build satisfied, so it scored **9.5** on a form whose instrument group rendered ten answerable questions plus a nested roster repeat on a single field-list screen. Build-emit and eval-grade are deliberately symmetric in `_app-component-library.md`; the new `screen-grouping` component had no grader, so this closes the pair. Graded mechanically via `checkScreenShape` from `lib/screen-shape.ts` — the same helper the build runs at `pdd-to-deliver-app § Step 4g`, so the two cannot drift and the judge is not eyeballing counts. Any `violation` (oversized field-list screen, or a `repeat` nested in a group) hard-gates the dimension **≤3**; an unjustified `warn` is a 1-point deduction, and a `warn` the build memo defends as one coherent set is explicitly NOT a finding. **This must never be graded as a one-question-per-screen rule** — multiple questions per screen is good design when they belong together (operator ruling, 2026-08-13). | ACE team |
