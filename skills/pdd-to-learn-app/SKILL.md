---
name: pdd-to-learn-app
description: >
  Build the CommCare Learn (training) app from the PDD via Nova's
  /nova:autobuild. Captures nova_app_id and writes a structure summary.
disable-model-invocation: false
---

# PDD to Learn App

Generate the Learn (training) app from the PDD using the Nova plugin
(`voidcraft-labs/nova-marketplace`, slash command `/nova:autobuild`).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `1-design/idea-to-pdd.md` | source PDD; archetype + Learn App Specification drive the Nova brief |
| Phase 1 (componentized only) | `run_state.…idea-to-design.products.components[]` + `.program_level[]` | the component set and the program-level Learn PDD — see Step 0 |

## Products

- `3-commcare/pdd-to-learn-app_summary.md` — Learn-app structure summary (modules, forms, fields, `nova_app_id`)
- `3-commcare/pdd-to-learn-app_build-memo.md` (componentized only) — the gap list Learn PDD §6(5) requires

## Process

0. **Componentized programme? Plan the modules before briefing Nova.**

   If `products.mode` is `componentized` (set by Phase 1's Step 0 — see
   `skills/idea-to-pdd`), the Learn app is **not** built from one PDD. It is
   foundations plus one module per component, and the two sets below are NOT
   the same set:

   ```
   planLearnModules({ components, activeComponentIds, frameworkComponentIds, referencedAbsentIds })
   // lib/learn-module-plan.ts
   ```

   **Where each argument comes from — all four are read, none is composed:**

   | Argument | Source |
   |---|---|
   | `components` | `products.components[]` |
   | `activeComponentIds` | the model's selection; omit for the first-programme default |
   | `frameworkComponentIds` | `products.framework_component_ids` — **and nothing else** |
   | `referencedAbsentIds` | `products.unresolved_references[].to` |

   `framework_component_ids` is absent when no document in the input set
   declared the framework's inventory. That is a legitimate state: pass
   `undefined` and let the plan emit its `inventory-unavailable` gap. **Do not
   substitute anything for it** — not the framework document's prose component
   table, not a `absent_components` list read out of `component-set.yaml`, not
   a list you assemble from the components you can see. Phase 1 owns that value
   (`skills/idea-to-pdd` § Step 0a.6); a value invented here is the parsed guess
   the plan exists to refuse, and it reports as fact (ace#2056).

   - **BUILT** — a module for every component that HAS a PDD, all present in
     the one app.
   - **SHOWN** — foundations plus only the modules for this model's active
     components; the rest are built and gated off.

   `built ⊇ shown`. For a first programme they are equal, which is exactly why
   collapsing them is tempting — and how a later programme silently loses the
   gating and ships every module to every worker. Brief Nova from `modules[]`,
   and carry `shown` into the gating; scope both assessments to
   `questionBankScope`, never to the built set. *An FLW is tested on what they
   will actually deliver, not on hidden modules* (Learn PDD §4).

   Read each module's content requirements from that component's OWN PDD
   (`modules[].pdd_file_id`), not from the programme overview — the overview
   composes, it does not restate.

   **Write `buildMemoNotes` into the build memo, including the gaps.** Learn
   PDD §6(5) requires naming every framework component skipped for having no
   PDD. When the framework's inventory is unavailable the plan says so
   explicitly rather than reporting none — do not quietly drop that line, and
   do not substitute a parsed guess at the component list.

   If `products.mode` is `synthesized` or absent, ignore this step entirely and
   continue at Step 1. That is every opp before `poverty-graduation`.

1. **Read the PDD** from `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md` via Google Drive MCP.

1a. **Archetype check — focus-group uses the sentinel pattern.** If the
    PDD's `Archetype:` is `focus-group`, this skill still produces a
    Learn app, but a **minimal sentinel** — a single 1-form readiness
    check, not a full training curriculum. It satisfies the
    `connect_create_opportunity` non-null `learn_app` requirement AND
    gates whether the facilitator has completed the out-of-band training.
    Proceed to step 2 with the focus-group sentinel brief described in
    `## Archetypes § focus-group` below. For the sentinel rationale + the
    out-of-band training model, see reference.md § focus-group sentinel
    rationale.

    For `multi-stage` PDDs, follow the multi-stage branch below — each
    stage's Learn app shape depends on the stage's declared archetype.

2. **Extract the Learn app spec** from the PDD. The spec drives the Nova
   brief; what to extract depends on `archetype:` (see `## Archetypes` below).

3. **Compose a Nova brief** — a single natural-language description that
   `/nova:autobuild` consumes as its sole argument. Nova does not accept
   file paths or markdown attachments; whatever Nova needs to build the
   right app must be inline in the description string. The brief should:
   - Open with the app's purpose and target FLW persona (1–2 sentences)
   - State the archetype framing explicitly (e.g. "this is a facilitation
     training app, not a form-walkthrough app")
   - **Explicitly state this is a CommCare Connect Learn app and that
     every content form needs `connect.learn_module`, and the GATING
     quiz form needs `connect.assessment`, per CommCare Connect's rules.**
     Load-bearing language — without it, autobuild often skips the
     per-form Connect blocks. For why, see reference.md § Connect-marker
     language is load-bearing.
   - **REQUIRED — exactly ONE form carries `connect.assessment` when the
     PDD declares one gate. A diagnostic pre-test must NOT carry it**
     (ace#1205). Connect stores a single `passing_score` per learn app and
     every "has this worker passed?" surface uses **any-passed** semantics
     (ace#1131), so a second scored form does not become a second gate —
     it becomes an ALTERNATIVE gate, and since a pre-test is by
     construction the easiest instrument in the app, it becomes the one
     that unlocks Deliver. Insert this paragraph **verbatim** into the
     brief, in its own paragraph, prefixed `REQUIRED:`:

     > REQUIRED: Only the FINAL gating assessment may carry a
     > `connect.assessment` block. If you build a diagnostic pre-test, it
     > MUST NOT carry `connect.assessment` — score it with an ordinary
     > hidden `user_score` field and conditional result labels, but leave
     > the Connect marker off. Connect stores one passing score per learn
     > app and treats a pass on ANY marked form as satisfying the gate, so
     > a marked pre-test silently becomes the easiest path to unlocking
     > Deliver, whatever the pre-test's own on-screen text says about not
     > counting.

     `pdd-to-learn-app-eval § 5b single_gating_assessment` is the
     structural backstop; it reads the blueprint and `[BLOCKER]`s a second
     marked form. Healable at L0 with one `configure_connect` call —
     **REPLACE-ALL, so resend the complete participant set**.
   - Describe each module / form, in order
   - List the required Connectify fields (Learn Module, Assessment Score)
   - Reference the relevant PDD section when it shapes Nova's choices
   - **REQUIRED — Forbid angle-bracket placeholder notation in
     label/option/hint text.** Insert this paragraph **verbatim** into
     the brief, in its own paragraph, prefixed `REQUIRED:`:

     > REQUIRED: Do NOT use literal `<` or `>` characters in any form
     > label, option label, hint text, constraint message, or itext
     > value. Nova's XForm emitter does not entity-encode `<`/`>` in
     > label text, so a literal "<3 letters>" or "<number>" placeholder
     > becomes invalid XML when CCHQ parses the form during
     > `make_build` (CCHQ rejects with "Error parsing XML: StartTag:
     > invalid element name"). Use words ("three letters", "a number")
     > or backticks (`three letters`) for placeholder syntax. Same rule
     > for `&` and `"` in label text — write them out as words instead
     > of relying on entity encoding to land. This applies especially
     > to pattern-recognition / regex-style quiz options where it's
     > tempting to write `<country><number>.<number>` literally.

     For the upstream filing + the `app-release` Step 2.7 backstop, see
     reference.md § Angle-bracket placeholder ban.
   - **REQUIRED — Set `connect.learn_module.id` AND `connect.assessment.id`
     explicitly to short stable identifiers, separately from the human-
     readable `name`.** This is the load-bearing constraint; the ≤40-char
     name fallback below is just a safety net. Insert this paragraph
     **verbatim** into the brief, in its own paragraph, prefixed `REQUIRED:`:

     > REQUIRED: Every `connect.learn_module` and `connect.assessment`
     > block MUST include an explicit `id` field. The id is the Connect
     > slug — it MUST be short (8-20 chars), lowercase, snake_case, code-
     > like, and stable across renames of the human-readable name. Examples:
     > `m1_background`, `m6_sample_prep`, `m1_quiz`. Do NOT rely on Nova's
     > default derivation (`module_<index>_<slugify(name)>`) — that
     > conflates the Connect slug with the display name and trips Connect's
     > 50-char `LearnModule.slug` column on any name that slugifies past
     > ~40 chars. The `name` field is a separate, human-readable string
     > that can be any length and any character set — that's where the
     > descriptive title belongs. Vellum-authored apps (the human-driven
     > authoring path in HQ's form designer) separate these into two UI
     > fields ("Module ID" and "Name") and humans naturally pick short
     > identifiers; Nova's API exposes the same two fields but the
     > architect has to set both explicitly because there's no UI to
     > nudge the separation. See `docs/learnings/2026-05-17-connect-slug-length-50-char-trap.md`
     > § Generalization (Vellum-as-source-of-truth) for the full mechanism
     > + source citations.

   - **REQUIRED — `connect.learn_module.time_estimate` is in HOURS, not
     minutes.** Insert this paragraph **verbatim** into the brief, in its
     own paragraph, prefixed `REQUIRED:`:

     > REQUIRED: The `connect.learn_module.time_estimate` field is the
     > estimated time to complete the module in **HOURS**, not minutes.
     > Nova's tool-schema description for this field says "Estimated
     > minutes" — that description is WRONG (stale; filed upstream as
     > voidcraft-labs/nova-plugin#36). Do not follow it and do not flag
     > the conflict — this instruction is the resolved answer, confirmed
     > against Connect's rendering source end-to-end (2026-07-30,
     > dimagi-internal/ace#1077): Connect's model help_text says
     > "Estimated hours to complete the module"
     > (`commcare_connect/opportunity/models.py:297`); the PM dashboard
     > renders the raw value as `f"{value}hr"`
     > (`commcare_connect/opportunity/tables.py:1677-1678`); ingest is a
     > straight `int()` passthrough from the CCZ's `<time_estimate>`
     > element with no unit conversion
     > (`commcare_connect/opportunity/app_xml.py:107-108`, `tasks.py:95`);
     > and the FLW-facing Connect mobile app sums the raw values and
     > renders "Estimated time: %d hours" (commcare-android
     > `ConnectJobIntroFragment.kt:64-77`, plural resource
     > `connect_opportunity_estimated_hours`). Vellum's plugin help text
     > agrees ("Estimated time to complete the module in hours",
     > `src/commcareConnect.js:158`). For typical Learn modules this is
     > 1 (one hour) or 2; never a two-digit minute count. If a module
     > genuinely takes less than an hour, round up to 1. `app-release-qa`
     > structurally asserts every released value is plausible as hours
     > against the PDD's stated module durations
     > (`lib/time-estimate-check.ts`), so a raw minute count halts the
     > release.

   - **REQUIRED — Keep module/assessment names short enough that the
     derived slug fits Connect's 50-char column (FALLBACK).** This is the
     defense-in-depth fallback for cases where the explicit-id rule above
     is missed. Insert this paragraph **verbatim** into the brief, in its
     own paragraph, prefixed `REQUIRED:`:

     > REQUIRED: If you have not set `connect.learn_module.id` /
     > `connect.assessment.id` explicitly per the rule above, the `name`
     > field MUST be ≤ 40 characters as a fallback — Nova's default slug
     > derivation `module_<index>_<slugify(name)>` overflows Connect's
     > 50-char `LearnModule.slug` column on longer names and triggers an
     > opaque HTTP 500 from `connect_create_opportunity`. Prefer the
     > explicit-id rule above (cleaner; lets `name` be any length); this
     > clause exists only because architects sometimes skip the id field.

     For the reproducer, the `app-release` Step 6 backstop, and removal
     criteria, see reference.md § ≤40-char name fallback.
   - **REQUIRED — Architect must verify-then-retry every `add_fields`
     call.** Nova's `add_fields` has a partial-persistence quirk: a
     single call with N items often persists only the first few.
     Mid-build sessions where the architect skipped verification have
     shipped forms that look complete in the build summary but render
     with missing questions. Insert this paragraph **verbatim** into
     the brief, in its own paragraph, prefixed `REQUIRED:`:

     > REQUIRED: Nova's `add_fields` has a partial-persistence quirk.
     > After EVERY `add_fields` call, immediately call `get_form` and
     > count the persisted fields. If the count is less than what you
     > requested, re-issue `add_fields` for the missing fields and
     > re-verify. Repeat until counts match. Do not move on to the
     > next form before counts match — silent partial persistence on
     > form N becomes invisible once you start working on form N+1.

     For the full failure analysis, see reference.md § add_fields
     verify-then-retry.

     Also insert this paragraph verbatim into the brief
     (dimagi-internal/ace#1181):

     > REQUIRED: a large `add_fields` call can fail with
     > `InputValidationError: could not be parsed as JSON`. This is a
     > HARNESS-side failure, not a Nova one, and not a size limit —
     > `commcare-nova#459` was closed NOT_PLANNED on 2026-08-16 after
     > Nova's request logs showed zero malformed bodies and payloads up
     > to 23.4 KB returning 200. The error is Claude Code's own
     > client-side error, raised when the model's streamed tool-call
     > arguments fail `JSON.parse` locally, before any request is made;
     > the two known causes are a generation cut mid-call and a deferred
     > tool's schema dropping out of context after compaction. The
     > "cut mid-string" appearance is an artifact of the harness echoing
     > only the first ~200 chars.
     > So: do NOT pre-batch defensively, and do NOT debug the payload's
     > quoting. Send the natural batch. IF you see that error, shrink the
     > batch and retry — as RECOVERY, not as a planned cadence. Nova
     > commits each batch atomically (all-or-nothing), so a retry after
     > this error cannot double-write. The verify-then-retry rule above
     > still applies to every batch.
   - **REQUIRED — `user_score` MUST be a PERCENTAGE (0-100), not a raw
     point sum.** Connect's `passing_score` field on each assessment is
     on a 0-100 scale — `passing_score: 80` means "pass at 80%."

     **First resolve `<THRESHOLD>` — it is NOT a constant.** Read
     `run_state.yaml.phases.idea-to-design.products.pdd.program_parameters.learn_passing_score`;
     fall back to the PDD's § Program Parameters table; use **80 only
     when the PDD decides nothing.** That is the same resolution order
     `connect-opp-setup` uses to set the LIVE gate, and it is the skill
     that owns the value — so following it here is what keeps the two
     numbers equal.

     **Why this matters more than it looks (ace#1333).** This skill
     authors the app's ON-SCREEN result experience; `connect-opp-setup`
     independently sets Connect's live gate. If a PDD pins a different
     score and the brief hardcodes 80, the two diverge with **no error
     anywhere** — no build failure, no `validate_app` complaint, no eval
     finding, no read-back mismatch, because each system is internally
     consistent with its own number. The app tells the worker
     **"Passed"** and Connect keeps Deliver **locked**. Live instance:
     `bednet-check-2-visit/20260814-0856`, whose PDD pins
     `learn_passing_score: 100` and argues it (six items scored as a
     percentage, so the reachable scores are 0/17/33/50/67/83/100).

     Insert this paragraph **verbatim** into the brief, in its own
     paragraph, prefixed `REQUIRED:`, substituting the resolved
     `<THRESHOLD>` everywhere it appears:

     > REQUIRED: The `user_score` hidden field on every quiz form MUST
     > compute a PERCENTAGE on the 0-100 scale, NOT a raw point sum.
     > Formula: `(q1_score + q2_score + ... + qN_score) * 100 div N`
     > where N is the total number of scored questions in that quiz.
     > For a 5-question quiz where each `qK_score` is `if(correct, 1, 0)`,
     > the calculate expression is:
     > `(#form/q1_score + #form/q2_score + #form/q3_score + #form/q4_score + #form/q5_score) * 100 div 5`
     > This produces 0 (0%), 20, 40, 60, 80, or 100 (100%).
     > Connect's `passing_score` for this opportunity is
     > `<THRESHOLD>` (= <THRESHOLD>%). With percentage scoring at a
     > threshold of 80, that means "at least 4 of 5 correct" on a 5-Q
     > quiz, "at least 4 of 4" on a 4-Q quiz (rounds to 100, so
     > 3/4 = 75 < 80 = fail, 4/4 = 100 >= 80 = pass), and "at least 7 of
     > 8" on an 8-Q quiz (7/8 = 87.5 >= 80 = pass); at a threshold of
     > 100 every scored item must be correct. Do NOT emit `user_score`
     > as a raw sum (e.g. 4 out of 5) — Connect compares the raw number
     > against `<THRESHOLD>` and the FLW always fails.

     For the reproducer, see reference.md § user_score percentage scoring.
   - **REQUIRED — Learn forms must NOT carry `<case>` blocks.** Connect's
     Learn-app contract is form-only; case state is the Deliver app's
     domain. Insert this paragraph **verbatim** into the brief, in its
     own paragraph, prefixed `REQUIRED:`:

     > REQUIRED: Learn forms must NOT create or update CommCare cases.
     > Do not declare a `case_type` on Learn modules, do not configure
     > registration forms to create cases, and do not bind any field to a
     > case property via `case_property_on`. Calibration scores, pass
     > flags, and assessment `user_score` MUST live as form-level hidden
     > fields only — Connect reads them via each form's `connect.assessment`
     > block, which is the right channel for cross-form Learn signal. If
     > a downstream Deliver-app query needs the FLW's calibration status
     > (e.g. "did this FLW pass the standardization gate?"), the answer
     > comes from Connect's per-FLW assessment-completion API, NOT from
     > a CommCare case property written by the Learn app.

   - **FIRST — check the PDD's assessment spec against the
     known-unbuildable list, and NAME any substitution you make.**
     `idea-to-pdd § Step 4a` gates Phase 1 against
     `_app-component-library.md § Known-unbuildable mechanisms`, so a PDD
     authored on a current plugin should never reach you specifying one. That
     gate landed on **2026-08-13 (0.13.766, ace#1213)** — every PDD authored
     before it, and every PDD carried forward from an older run, predates it.
     This step is the belt-and-braces for exactly those.

     Read the PDD's assessment blueprint against the list before composing the
     brief. The one that actually recurs: **a randomized / per-attempt item
     draw** ("a bank of 24, 12 served per attempt, retakes drawn from unseen
     items"). It is closed twice over — Nova exposes no per-attempt
     item-selection primitive, and decisively, Connect scores against a single
     absolute `passing_score` per app, so a variable-membership draw makes
     `user_score` incommensurable with the gate. Build the sanctioned
     alternative — **one fixed bank sized for the gate**, plus a distinct
     pre-test bank where a baseline is wanted — exactly as you would anyway.

     **The build is not the defect; the silence is.** On
     hh-poverty-targeting/20260812-2034 the PDD specified the 24-item draw, the
     build correctly shipped one fixed 12-item bank, and **nothing recorded
     that a substitution had happened** — so the PDD, and anything generated
     from it, still told a reader that retakes were draw-resistant. Whenever
     you substitute, write it into the build memo and the summary as a named
     deviation: what the PDD asked for, what you built, why the ask is closed,
     and the residual the operator now owns (for the fixed-bank case: unlimited
     re-attempts against a fixed bank let a worker pass by memorising the
     answers, which is a real retake-resistance loss the PDD assumed away).
     Never resolve it silently, and never build the unbuildable thing to be
     faithful to the PDD.

   - **REQUIRED — Deployability (fitness) components.** A label-only
     curriculum + one trivial quiz is NOT a deployable training
     instrument; `pdd-to-learn-app-eval` **hard-fails** it. The canonical,
     parameterized text for each component lives in
     **[`skills/_app-component-library.md`](../_app-component-library.md)** —
     the single source of truth, paired 1:1 with the eval dimension that
     hard-fails a build omitting it. For each Learn component whose
     **Trigger** fires, open the library and insert that component's
     **Brief paragraph** into the brief **verbatim**, in its own
     paragraph, prefixed `REQUIRED:`, substituting any `<PARAM>`
     placeholders from the PDD. Emit-checklist (see the library for full
     text + triggers):

     - `assessment-gate` — trigger: PDD specifies a readiness /
       competency gate before delivery. (Gate stays Connect-side — Learn
       forms carry no case blocks per the rule above.)
     - `app-language-layer` (Learn variant) — trigger: PDD names a
       working language other than English. The brief tells the
       architect to build the app in **English ONLY** and to call no
       language atom. **ACE owns the language layer**, ACE-direct, in
       Step 4e below — after every English-editing step has finished.
       That split is the fix for ace#1556: the architect's operating
       prompt forbids it saving self-generated target text, so a brief
       that asked it to author translations produced a silent no-op
       (207 units copied, 0 translated, both targets, on
       `spark-facilitator/20260820-0817`). It also makes translate-LAST
       structural — the architect's turn is over before the language
       exists. Never stack languages inline. (Standing decision
       2026-08-17, PR #1463, superseding ace#968/#1391; ownership split
       2026-08-23, ace#1556 — see
       `_app-component-library.md § app-language-layer` for the proven
       contract and the ACE-direct recipe.) Graded by
       `language_conformance`.
     - `learn-app-naming` — always. App name must contain "Learn app".
     - `no-starter-module` — always (Learn + Deliver). Nova's `create_app`
       seeds a placeholder module (top-level menu "Survey" → form "Survey" →
       one text field `question_1` labelled "Question 1"). Emit the component
       so the brief tells the architect to DELETE it, and to report whether it
       was present. Removal is currently architect discretion, and discretion
       is what varies run to run: on `bednet-check-2-visit/20260828-0629` the
       Deliver app shipped with the seed while the Learn app, briefed from the
       same template in the same phase, removed it unprompted. Enforced at
       release by `app-release-qa § Step 4` (ace#1787).
     - `end-of-form-previous` — always, every form. End of Form Navigation
       must be "Previous Screen".
     - `grid-menu-display` — always (Learn + Deliver), but **do NOT put it
       in the Nova brief**. Nova's authoring surface exposes no
       menu-display-format control at all: `update_app` sets only the display
       name, `create_module` / `update_module` carry no display-format field,
       `set_menu_media` sets icons and audio labels (Menu ICONS are a different thing and ACE does apply them — `app-media-coverage` at Phase 3 Step 1.7, via this same `set_menu_media`, using Nova's built-in topic/action icon slugs.), and `set_case_list_tile`
       lays out a case LIST — unrelated, and inapplicable to case-less Learn
       modules. The component is real and enforced, just not here: it is
       applied POST-BUILD by `app-hq-settings` (Phase 3 Step 2.65) via
       `commcare_set_menu_display` + `commcare_set_app_menu_display`, and
       BLOCKER-gated by `app-release-qa` off the released app's raw doc.
       Briefing it made every architect build report a spurious "unmet
       requirement" in the build memo — the one artifact meant to carry REAL
       deviations — and invited the architect to reach for an unrelated atom
       to satisfy the paragraph (dimagi-internal/ace#1632; live on
       bednet-check-2-visit/20260825-1310, where Step 2.65 then applied all
       three fields HQ-side on the first attempt).
     - `connect-supported-capabilities-only` — always (Learn + Deliver). Use
       only capabilities that work WITHOUT an HQ feature flag; `commcare_connect`
       is the sole exception. Learn apps are case-less so the case-search trap
       is a Deliver concern, but the budget applies to every build (ace#1195).
     - **PDD worked examples are ILLUSTRATIVE — never bank content**
       (dimagi-internal/ace#1120). When the PDD supplies worked
       assessment items, they model the *required shape*; they are not a
       bank to ship as-is, and the brief MUST NOT tell the architect to
       "ship these verbatim". Author the bank to the
       `discriminating-assessment-items` standard below and treat every
       PDD example as a candidate that must clear the same two gates —
       **hardening or discarding a PDD example is PDD-COMPLIANT, not a
       deviation**, and does not belong in the build memo's deviations
       list. Say so explicitly in the brief when the PDD carries worked
       examples. Live case: `hh-poverty-targeting/20260730-2210` promoted
       the PDD's three worked items into the brief as verbatim
       post-assessment items; all three were then guessed cold by both
       independent blind probes, and the builder had no discretion to
       fix them. If a PDD example survives the gates, keeping it is fine
       — the point is that the decision is the builder's.
     - `discriminating-assessment-items` — any scored assessment.
       **Step 1 is the lever** — before writing any option, name the
       taught RULE the item tests, the MODULE that teaches it, and the
       OPERATION it protects (unpaid visit / blocked form / corrupted
       data); no module named → discard the item. **Step 2 — concentrate
       the bank on COUNTER-INTUITIVE rules**, the taught rules where
       ordinary common sense gives the WRONG answer (a convention that
       reads backwards, a deliberate non-payment, an inclusion rule, a
       named window or threshold). Aim for roughly half the items on
       those and cover every counter-intuitive rule the curriculum
       teaches at least once — that coverage is exactly what
       `pdd-to-learn-app-eval § assessment_rule_coverage` scores.
       **Step 3** — bank independence, ~1 item per rule. **Step 4** —
       option hygiene: no option rejectable on sight. **Do NOT author
       items to be hard for a clever reader** — the eval no longer
       measures that, and for a CHW curriculum most correct answers are
       sensible, so chasing difficulty produces arbitrary trivia that is
       worse training for the cohort (ace#1206; ~500K tokens were spent
       learning this across ace#1014 / ace#1187). The component's
       **pre-release self-check** is mandatory and its per-item table
       (rule, module, operation, counter-intuitive?, independence,
       any-option-rejectable-on-sight) belongs in the build memo.
     - **Randomise the correct-option POSITION independently per item, and
       never rotate through the letters (ace#2061).** Tell the architect this
       explicitly in the brief. "Spread across a/b/c/d" is not enough and is
       what produced the defect: a balanced-but-CYCLIC key (`a,d,c,b`
       repeating) is more predictable than randomness, not less, and clears an
       80% gate at 90% for anyone who notices. *Enforced:*
       `pdd-to-learn-app § 4c step 3b` + `lib/answer-key-pattern.ts`.
     - `instrument-grounded-examples` — the Learn app teaches
       administration of a fixed instrument. Every worked example and
       good/bad pair built from a REAL instrument item, preferring the
       highest coaching-risk items (self-reported consumption over
       observable assets) (ace#982).
     - `entity-state-taxonomy` — the followed entity carries states the
       curriculum names (always for `archetype: longitudinal-visits`).
       **Teach the PDD's declared `program_parameters.entity_state_taxonomy`
       verbatim** — the same values, labels and step ranges the Deliver app
       ships, parsed with `parseStateTaxonomy` from
       `lib/entity-state-taxonomy.ts` before the brief is composed. Where
       that row names a source document, brief from THAT file out of the
       run's frozen `inputs/`. `declared: false` or non-empty `problems` is
       a **HALT** with a Phase-1 finding, never a licence to invent phase
       names. Both apps deriving from the one declaration is what makes
       Learn and Deliver agree; a Learn app taught on an invented mapping
       sends a trained worker to a phase where the step they were taught
       does not exist (ace#1564).

     Do NOT inline-paraphrase these — reference the library so the build
     and `pdd-to-learn-app-eval` stay symmetric. Skip a component whose
     trigger doesn't fire.

4. **Invoke `/nova:autobuild "<brief>"`.** This is a one-shot autonomous
   build — Nova will not ask clarifying questions. Capture from the
   response:
   - `app_id` — durable Nova handle, written to the summary as `nova_app_id`
   - Build summary
   - Any warnings Nova emits

4a. **Post-build field-count verification — runnable recipe (skill-side safety net).**

    The architect-brief language above puts retry-then-verify discipline
    on the architect agent. This step is the skill-side safety net for
    cases where the architect finished short. For the failure history
    behind this step, see reference.md § Step 4a safety net.

    **Always run this recipe before writing the success summary.** Not
    a prose contract — a numbered tool-call sequence the L0 LLM
    executes verbatim:

    1. **Build the expected field-count table** from the brief that was
       sent to `/nova:autobuild`. For each `(module, form)` pair the
       brief named, extract the field list. Persist as an in-memory
       map `expected[module][form] -> [field_id, ...]`. The brief is
       the source of truth — not the PDD prose, not the architect's
       return string.

    2. **Read the built app** via one `get_app({app_id})` call. Compare
       module + form names against the expected map. **Halt** if any
       expected `(module, form)` is missing — that's a structural gap
       the field-count recipe can't fix.

       **This same call is the addressing map.** Nova is uuid-addressed
       (2026-07-31 migration — see
       `playbook/integrations/nova-integration.md § The 2026-07-31
       uuid-addressing migration`); there are no `moduleIndex` /
       `formIndex` parameters on any tool. `get_app`'s blueprint prints
       `[uuid <rfc-uuid>]` on every module, form, and field:

       ```
       - Module "Bednet Basics" [uuid b60055c1-…] (case_type: cbf)
         - Form "Lesson 1" [uuid c3deb000-…] (survey, 9 fields)
           - user_score [uuid c3df54f7-…] (hidden)
       ```

       Build `uuids[module][form] -> {moduleUuid, formUuid}` (and the
       per-field uuids) from this ONE response and carry it through the
       rest of the recipe. One lookup beats N. If you only hold a
       semantic name later, `search_blueprint({query, app_id})` resolves
       it — but prefer the map you already have.

    3. **For every form in the expected map**, call
       `get_form({app_id, moduleUuid, formUuid})` using the uuids from
       step 2 (one call per form, batchable in parallel across forms).
       Collect:
       - `persisted_ids`: the set of `field.id` values present in the
         response. Hidden / label / group / repeat fields all count.
       - `persisted_count`: `len(persisted_ids)`.

    4. **Compute the diff per form.** `missing = expected[m][f] -
       persisted_ids`. **Also** compute `referenced_missing`: any field
       referenced in another field's `calculate` / `relevant` /
       Connect-marker `user_score` (the sum the Connect `assessment`
       block reads) that isn't in `persisted_ids`.
       (`validate_app` flags this class as "X references Y which
       doesn't exist in this form" — same shortfall, different
       detection path. Catching it here means we don't ship to
       `validate_app` with a known gap.)

    5. **If `missing ∪ referenced_missing` is empty across every form,
       proceed to step 5 (`/nova:show`).** No edit needed.

    6. **If non-empty for any form**, dispatch ONE `/nova:edit` call
       per affected form. Prompt template:

       ```
       /nova:edit <app_id> "Add the following missing fields to form
       <module-name> / <form-name>: <comma-separated field ids and
       their kind/calculate spec from the brief>. After each add_fields
       call, get_form and verify persistence. Do not return until every
       requested field is present."
       ```

       Re-run step 3 + step 4 after the edit returns.

    7. **Bounded loop, max 3 iterations.** If any form is still short
       after the third iteration, halt with a structured failure
       listing `<form-name>: <missing ids>` per offender, and do NOT
       write the success summary. The operator decides whether to
       /nova:edit manually, re-dispatch autobuild, or escalate.

    Why we run this even though `validate_app` will catch some shortfalls
    downstream: see reference.md § Step 4a safety net.

    Same shape as `app-connect-coverage` — verify+fix in a bounded
    loop, post-Nova.

4b. **Learn-marker compile pre-check (catch a missing app-level Connect
    type before deploy) — runs ACE-DIRECT.** Mirror of
    `pdd-to-deliver-app` § 4e. The autonomous architect
    (`Agent(nova:nova-architect-autonomous)`) can land a Learn app with
    **no app-level Connect mode** even though every form already carries
    its `connect.learn_module` / `connect.assessment` block. The per-form
    `[Connect enabled]` flag is a **FALSE POSITIVE for compile**: with no
    app-level mode the released CCZ ships with ZERO `<learn:module>` /
    `<learn:assessment>` markers, and Connect's HQ→Connect sync cannot
    register the learn module or the assessment gate. `app-release-qa`
    (Phase 3 Step 2.8) catches it post-release, but that is a full
    deploy→build→release cycle too late — assert it here, cheaply, on the
    already-built app.

    1. Call `get_app({app_id})`. Its summary header prints the app's
       Connect type (e.g. `Connect type: learn`); a standard app prints
       none. **Keep this response** — you need its complete form list and
       `[uuid …]` markers for step 3.
    2. **Assert the header reads `Connect type: learn`.** Do NOT rely on
       the per-form `[Connect enabled]` flag — it is a false positive for
       compile (see above).
    3. On a miss, heal ACE-direct with **`configure_connect`**, which is
       available to the ACE session that executes this skill.
       `update_app` no longer carries `connect_type` — it was removed in
       Nova's 2026-07-31 redeploy (jjackson/ace#1133); `configure_connect`
       replaced it and sets the app-level mode AND every form's Connect
       block in one atomic call.

       > **⚠ `configure_connect` is REPLACE-ALL, not a patch.** Upstream:
       > *"learn/deliver requires the complete nonempty UUID-addressed
       > participant set, and every unlisted form becomes auxiliary."*
       > **Every form you omit from `participants[]` has its existing
       > Connect block CLEARED.** A partial participant list turns this
       > marker-repair into a marker-deletion — strictly worse than the
       > problem you came to fix. This is the OPPOSITE of
       > `update_form({connect})`, which is per-form and additive.

       So: **enumerate the COMPLETE participating set from the step-1
       `get_app` response first**, then call once:

       ```
       configure_connect({
         app_id,
         mode: "learn",
         participants: [
           // EVERY content/quiz form in the app, addressed by formUuid.
           { formUuid: "<content form uuid>",
             connect: { learn_module: { name, description, time_estimate } } },
           { formUuid: "<quiz form uuid>",
             connect: { assessment: { user_score: { parts: [
               { kind: "field-ref", uuid: "<user_score field uuid>" } ] } } } },
           …
         ]
       })
       ```

       Note the **structured expression shape** — `user_score` (like
       `label`, `relevant`, `calculate`, `default_value`) takes
       `{parts: [...]}`, not a plain XPath string; a bare string is
       rejected. Omit each block's `id` and let Nova derive it.
       `time_estimate` is in **hours** despite upstream's schema
       description saying minutes (nova-plugin#36).

       Then re-run `get_app` and re-assert BOTH the header and that every
       form that carried a Connect block before still carries one.
       **Bounded loop, max 3 iterations.** If the header still does not
       read `Connect type: learn` after the third attempt (or
       `configure_connect` is itself unavailable), halt with a clear
       `learn-marker-wont-compile` failure and do NOT write the success
       summary.

    Use `update_form({moduleUuid, formUuid, connect})` **only** to refine
    one sub-config on a form that ALREADY participates — it cannot enable
    Connect, switch mode, or add a participant, and it refuses a
    whole-slot null. Full division of labour:
    `playbook/integrations/nova-integration.md § configure_connect
    replaced update_app({connect_type})`.

    Reproducer: bednet-spot-check/20260615-0702 — the Learn app scaffolded
    with no app-level Connect type; the first released CCZ had `module=0`/
    `assessment=0`; an L0 heal + re-deploy + re-release fixed it to
    `module=1`/`assessment=1`. The fix is this pre-check, NOT a
    `mcp/connect/backends/commcare.ts` change — the compile is correct
    given a correct app-level mode. See jjackson/ace#783. (That heal was
    `update_app({connect_type: "learn"})` at the time; the parameter was
    removed 2026-07-31 and `configure_connect` is now the only path —
    jjackson/ace#1133.)

4c. **Conditional-result-label pre-check (catch the unconditional pass
    message before deploy) — runs ACE-DIRECT.** This is the structural
    preventer for the exact gap `pdd-to-learn-app-eval § assessment_gating`
    hard-fails on: a quiz with an **unconditional** "Well done!" result
    label that fires regardless of score. The brief above (the
    `assessment-gate` component, § Step 3) REQUIRES conditional pass +
    fail/retry labels — but when the brief is hand-composed (e.g. the
    orchestrator executing this skill inline at L0) and the
    `assessment-gate` component paragraph is skipped, the architect emits
    one always-on congratulatory label. The eval catches it, but only
    **after** a full deploy→build→release cycle. Assert it here, cheaply,
    on the already-built blueprint.

    **Trigger:** the PDD specifies a readiness / competency gate before
    delivery (the same trigger that put the `assessment-gate` component in
    scope in § Step 3). If the PDD specifies no gate, skip this step.

    1. For each form carrying a `connect.assessment` block, call
       `get_form({app_id, moduleUuid, formUuid})` (uuids from the § 4a
       step-2 map, or `search_blueprint({query, app_id})` if you don't
       have them).
    2. **Assert the form has a genuine pass/fail result EXPERIENCE:** at
       least one `label` field whose `relevant` references
       `user_score >= <threshold>` (the PASS message) AND a separate
       `label` field whose `relevant` references `user_score < <threshold>`
       (the FAIL/retry message). A single result `label` with NO
       `relevant` condition (fires unconditionally) FAILS this assertion —
       that is the `assessment_gating` hard-gate trigger.
    2b. **Assert the fail/retry label does NOT contain the correct answer**
       (dimagi-internal/ace#1041). `get_form` returns both the option labels
       and the fail label, so this is a deterministic string check on data
       already in hand — not another adjective. The correct answer is
       whatever literal the scoring `calculate` compares the question
       against (CommCare has no correct-option primitive, so that literal
       IS the answer key). Compare case-insensitively with whitespace
       collapsed; a reworded restatement leaks just as much as a verbatim
       one. On a hit, heal at L0 via `edit_field` to replace the retry text
       with a pointer to the module content, then re-assert.

       A leak makes the gate DECORATIVE while every structural check still
       passes: with no attempt limit, a worker who fails once is shown the
       answer and passes on attempt 2. Live case
       (bednet-spot-check/20260729-0002): `fail_msg` restated the correct
       option verbatim and told the worker to answer again — and the golden
       run it forked from carries the identical leak.

       The released-CCZ backstop is `lib/assessment-retry-leak.ts`
       (`checkAssessmentRetryLeak`), run by `app-release-qa`, which catches
       the class even when this step is skipped — which is exactly what
       happened live, because the brief was hand-composed at L0 and the
       `assessment-gate` component paragraph was never inserted.

    3. On a miss, heal ACE-direct (`edit_field` / `add_fields` are
       available to the ACE session that executes this skill):
       `edit_field({app_id, moduleUuid, formUuid, fieldUuid, updates})`
       to add a pass condition to the existing pass label, and
       `add_fields({app_id, moduleUuid, formUuid, fields})` to append a
       `result_fail` label carrying retry guidance (review the content,
       answer again). Use `<threshold>` = the SAME resolved value the
       brief used (`learn_passing_score` → PDD § Program Parameters →
       80), never a hardcoded 80 — an on-screen pass label that
       disagrees with Connect's live gate tells a worker they passed
       while Deliver stays locked (ace#1333). Then re-fetch via
       `get_form({app_id, moduleUuid, formUuid})` and re-assert.
       **Bounded loop, max 3 iterations.** If the form still lacks a
       conditional pass+fail pair after the third attempt, halt with a
       clear `assessment-result-unconditional` failure and do NOT write
       the success summary.

    3b. **Check the ANSWER KEY is not periodic (ace#2061).** Extract each
       `qN_score`'s calculate literal — the value the score compares against IS
       the answer key, since CommCare has no correct-option primitive — and run:

       ```ts
       checkAnswerKeyPattern({ key, passMark });   // lib/answer-key-pattern.ts
       ```

       It fails when ANY fixed periodic guess (period 1-6, every phase
       alignment) reaches the pass mark. On a hit, re-key the offending items:
       move the correct option's TEXT to a different position and update that
       item's calculate to match. **Do NOT simply point the calculate at a
       different letter** — that makes a wrong answer correct.

       Measured on `poverty-graduation/20260905-1345`: a 32-item gate whose key
       ran `c a d b` then `(a d c b)` seven times without deviation. Answering
       that cycle cold scores **29/32 = 90%** against an 80% gate, so the Learn
       gate certified a worker who had read nothing. **The letter distribution
       was perfect — 8 each of a/b/c/d** — which is exactly why no frequency
       check saw it and why this one reads the sequence instead. It is also a
       different mechanism from ace#981 / ace#1014 / ace#1187, which are about
       whether an item is guessable from its WORDING: every item on that build
       had plausible distractors and tested a real taught rule.

    4. **Check what the pass label CLAIMS against what the bank tests
       (ace#1368).** Run `checkPassLabelScope` from
       `lib/pass-label-scope.ts` over the built `result_pass` text, with
       the rules the bank actually keys on and whether the PDD declared
       the gate is not a competence certification:

       ```ts
       checkPassLabelScope(resultPassText, {
         certifiedRules,                 // the rules the bank tests
         declaredNotCompetence,          // from the PDD's residual/deviation
         untestedPaymentPredicate,       // e.g. 'consent_confirmed on the follow-up form'
       });
       ```

       On a finding, rewrite the label to claim only what was examined —
       do NOT regenerate the PDD, and do not widen the bank to justify
       the sentence.

       Live: `bednet-check-2-visit/20260813-2333` built
       **"You can now begin delivery work"** after examining TWO
       payment-model facts, directly contradicting the PDD's own D-1
       residual (*"not a competence certification and must not be
       described as one"*). The PDD wrote the residual honestly; the
       builder wrote a label that violates it, and nothing compared the
       two. **The pass label is what the WORKER reads.**

       That gate also never tests the follow-up **consent
       re-affirmation** — the sole server-side payment predicate
       (`form_field_rules` keys on `consent_confirmed`) — so a worker can
       clear it and still fail the only check that decides whether they
       get paid. Pass that predicate as
       `untestedPaymentPredicate` so the finding names it.

       **`relevant` is a STRUCTURED expression, not a string** (Nova's
       2026-07-31 redeploy — a bare string is rejected). Reference the
       score field by uuid rather than by `#form/` path:

       ```
       relevant: { parts: [
         { kind: "field-ref", uuid: "<user_score field uuid>" },
         { kind: "text", text: " >= <threshold>" }
       ] }
       ```

       The same `{parts: [...]}` shape applies to `label`, `hint`,
       `required`, `validate`, `calculate`, and `default_value`. Part
       kinds: `text` · `field-ref` · `path-ref` · `case-ref` ·
       `user-ref` · `user-property-ref`. Two rules that bite here:
       a **`hidden` field is rejected unless it has `calculate` or
       `default_value`**, and Nova **applies nothing on rejection**
       ("Nothing was changed") while naming the exact problem — so read
       the error and re-call rather than assuming a partial apply.

    Note: the `relevant` expression legitimately contains `<` / `>=`;
    that is an attribute expression Nova entity-encodes at compile, NOT
    label text — the angle-bracket ban (§ Step 3) applies only to
    label/option/hint TEXT, so a `user_score < 80` relevance is fine.

    Reproducer: bednet-spot-check/20260615-1309 — the inline Phase-3 Learn
    brief omitted the `assessment-gate` component paragraph; the architect
    built one unconditional result label; `pdd-to-learn-app-eval` hard-gated
    it (`assessment_gating` 2.0 → overall 6.58 → fail). An L0
    `edit_field`(relevant) + `add_fields`(result_fail) heal + re-deploy +
    re-release + re-eval lifted it to `assessment_gating` 5.0 → 7.29 / warn.
    Sibling run 20260615-0702 (conditional labels present) scored 7.10 / warn
    — the single dimension is the whole swing on this minimal opp. See
    jjackson/ace#787.

4d. **(Retired 2026-08-13 — no build-time cold-read probe.)** A measured
    cold-read probe briefly lived here: two dispatched agents on a PDD-derived
    FLW persona, stems and options only, blocking the build when the untrained
    reader cleared the PDD's unlock threshold. It was removed the day after it
    landed, together with the eval-side contrast it fed
    (`pdd-to-learn-app-eval § assessment_discrimination` → now
    `§ assessment_rule_coverage`).

    **Why:** the probe's untrained reader is an LLM told to role-play a
    low-literacy CHW, and an LLM's floor is its own competence, not the
    persona's — it still reads English fluently, does the arithmetic, and
    eliminates options. For a CHW curriculum, whose taught rules are largely
    "record what happened, honestly", the protected population's proxy passing
    cold is the EXPECTED result for a well-built bank, not a catastrophe. The
    filter fired on `spark-facilitator/20260812-1635` — a build with complete
    trilingual coverage, worked examples from the real instrument and correct
    conditional gating — and the only way to clear it would have been to
    author arbitrary trivia, which is harder to learn and less useful in the
    field. No ACE bank has ever been put in front of a real CHW, so the
    LLM→CHW inference was never validated. See ace#1206.

    **What replaced it:** the same question, asked structurally. Rather than
    simulating a reader, `pdd-to-learn-app-eval § assessment_rule_coverage`
    audits which taught rules the bank keys on and whether the
    **counter-intuitive** ones — where common sense gives the WRONG answer —
    are covered. That answers "is this bank mostly common sense?" from the
    artifact, with no persona, no dispatched agents and no run-to-run noise,
    and it returns `repairs[]` naming the specific items to re-key (see
    § Repair mode below). Do not reinstate a persona probe here without
    reading ace#1206 first.
4e. **Language layer — runs ACE-DIRECT, LAST of the 4x steps (ace#1556).**
    Applies only when the PDD names a working language other than English;
    otherwise skip and say so in the summary.

    **Why ACE-direct and not the architect.** The architect's operating prompt
    (nova plugin `1.26.0`/`1.27.0`, `skills/autobuild/SKILL.md`) says *"Never
    treat your own language fluency as a substitute or bulk-translate
    self-generated text through `update_translations`. Only save target text
    supplied by the user."* An `/ace:run` supplies no human target strings, so
    the architect declines and the layer silently never lands — 207 units
    copied, 0 translated, in both targets on `spark-facilitator/20260820-0817`
    (ace#1556). ACE is the caller — the "user" in that sentence — so ACE
    supplies the target text through the same six atoms on its own Nova MCP
    surface. Running here also makes translate-LAST **structural**: every
    English-editing step (4a–4d, and any `repairs[]` pass) is already done, so
    nothing can demote a translation to `out-of-date` behind you.

    Execute `_app-component-library.md § app-language-layer` **ACE's ACE-direct
    recipe** verbatim — `get_languages` → `add_language(copyFrom: 'en')` →
    page `get_translatable_content` and author real values via
    `update_translations` (≤50 units/call, echoing each just-read
    `sourceFingerprint`) → `get_languages` again. Read the atoms' live schemas
    from Nova's `tools/list`; do not paraphrase them here.

    **Gate:** `out-of-date` and `missing` must both be 0 at hand-off. Record
    the final per-language coverage counts in the build memo, plus one line
    stating the translations are ACE-authored (`origin: ai`) and carry
    `needs-review` until a speaker of the language reviews them. If the layer
    cannot be completed, halt loud with the counts — do NOT write a summary
    claiming a language layer the app does not carry. Partial coverage is the
    false affordance the issue was filed about: units left `origin: copied`
    are English strings wearing the language's name, and a worker cannot tell
    them apart from real translations.

5. **(Optional) Inspect the built app** via `/nova:show <app_id>` to
   cross-check the structure against the PDD before writing the summary.

6. **Self-evaluate (LLM-as-Judge):**
   - Does the app structure match the PDD Learn spec?
   - Are all required Connectify fields configured (Learn Module,
     Assessment Score, passing score)?
   - For `focus-group`: does the app actually teach facilitation craft
     rather than form completion?

7. **Write the summary** to
   `ACE/<opp-name>/runs/<run-id>/3-commcare/pdd-to-learn-app_summary.md`. Required
   frontmatter:

   ```yaml
   ---
   nova_app_id: <id-returned-by-autobuild>
   # `/build/`, NOT the legacy `/apps/` route, which 404s (ace#1431).
   # Built by `novaAppUrl()` in `lib/nova-url.ts` — the single source.
   nova_app_url: https://commcare.app/build/<id-returned-by-autobuild>
   archetype: <atomic-visit | focus-group | multi-stage>
   # Addressing map — Nova is uuid-addressed (2026-07-31, ace#1132).
   # Persist what § 4a step 2 already read so downstream steps and the
   # -eval rubrics address by uuid without re-resolving. One lookup at
   # build time beats N lookups later.
   nova_uuids:
     modules:
       - name: <module name>
         uuid: <moduleUuid>
         forms:
           - name: <form name>
             uuid: <formUuid>
             # Only the fields later steps address directly (the
             # assessment score field, result labels). Not every field.
             fields:
               user_score: <fieldUuid>
   ---
   ```

   Body content stays the same as before: module list, Connect
   configuration, decisions made, Nova warnings.

   Anything downstream that lost this map can re-derive it with one
   `get_app({app_id})` (whole-app) or `search_blueprint({query, app_id})`
   (one semantic name) — but persist it here so they don't have to.

8. **Notify admin group** that Learn app generation is complete, with the
   Nova app URL and a link to the summary in GDrive.

## Repair mode — consuming a `repairs[]` work order

`pdd-to-learn-app-eval § assessment_rule_coverage` does not just score the
assessment; when the bank leaves a taught rule untested it returns a typed
`repairs[]` list naming the uncovered rule, the module that teaches it, and a
`suggested_target` item to re-key. The orchestrator dispatches THIS skill to
apply them — the judge never repairs the bank it grades, because a grader that
authors its own fix and re-scores it converges on passing itself.

When invoked with a `repairs[]` list:

1. **Re-key, don't grow.** For each entry, edit the `suggested_target` item in
   place via `edit_field` (and `set_field_options_source` when the options
   change). Keep the stem's subject where you can; change what the options
   *differ on*, so the answer turns on the uncovered rule rather than on general
   judgment. Adding items instead of re-keying inflates the bank and lowers the
   effective bar the gate applies.
2. **Preserve the invariants.** Every edited item keeps: an English source
   stem AND options (`app-language-layer` — repairs edit the English, which is
   the source language), no option rejectable on sight, no literal `<` / `>` in
   label text, and a `qN_score` whose calculate references the question as
   `#form/<id>` — a bare id persists as raw text with no error and silently
   breaks the scoring chain (ace#1119). **If the app carries a working
   language, every repaired string's translation is now `out-of-date` and
   falls back to English** — re-run § Step 4e (the ACE-direct language layer;
   never the architect, ace#1556) for the repaired units and re-confirm
   `out-of-date` is 0 before hand-off.
3. **Read back the scoring chain.** After any pass that rewrites options or
   keys, `get_field` on the edited `qN_score` and on `user_score` and assert
   each `calculate.parts` still contains a `field-ref` part, not only text.
4. **Update the build memo's per-item table** for every item you touched, and
   record which `repairs[]` entries you applied.
5. **One round.** Return after applying the list; the orchestrator re-runs the
   eval once. Do not iterate against the score — roughly 500K subagent tokens
   were spent across two prior authoring cycles looping against a number that
   could not move (ace#1014, ace#1206).

If a `repairs[]` entry cannot be satisfied — the rule genuinely has no
non-guessable formulation, or re-keying would break a load-bearing teaching
example — say so explicitly in the build memo with the reason, and leave the
item alone. An unfixable entry is a finding for a human, not a licence to
fabricate an arbitrary item.

## Archetypes

The Learn app's job depends on the PDD's `archetype:` field. Read it
before composing the brief.

### `atomic-visit`
Learn app teaches FLWs to **collect data** at individual visits. Standard
form-walkthrough Learn app: how to open a case, complete each form field,
what good vs. bad inputs look like (e.g., the photo standardization
protocol from the Evidence Model — Layer A), how to handle edge cases (no
stock, hostile vendor, duplicate), submission and case closure.

### `longitudinal-visits`
Everything in `atomic-visit`, plus the three things an FLW working a case
list has to be taught and a fresh-sample FLW does not:

- **Working the case list** — finding an entity, reading its tile to see
  which visit is due, and what to do when the entity is missing.
- **The sequence** — which visits exist, in what order, at what cadence,
  and how to tell whether a case is on track or behind.
- **What gets paid, given history** — teach the
  `payability-against-history` decision plainly: whether repeating an
  activity on the same entity pays, and what happens if it does not.
  This is the single most expensive thing for an FLW to learn by
  discovering it in a payment statement.

Skip the parts of the `atomic-visit` walkthrough that assume a fresh
subject each time (duplicate-vendor handling, per-day caps) unless the
PDD actually declares them.

### `focus-group`

**Produce a minimal sentinel Learn app** — one module, one form, ~7
fields, both Connect markers (`connect.learn_module` +
`connect.assessment` with passing_score 1). It satisfies the
`connect_create_opportunity` non-null `learn_app` requirement AND is a
coordinator-confirmed in-app readiness gate. For the rationale, see
reference.md § focus-group sentinel rationale.

**Sentinel app spec (the Nova brief):**

- **App name:** `"<Opp display name> — Facilitator Readiness Check"`
  (e.g., "Malaria ITN FGD — Facilitator Readiness Check").
- **One module:** "Readiness Check" (case_type: `facilitator`).
- **One form:** "Briefing Acknowledgement" (case-create form,
  `connect.learn_module` set AND `connect.assessment` with
  `passing_score=1` and `user_score: #form/user_score`).

Fields (the complete sentinel form):

1. `intro` (label) — out-of-band training overview pointing the
   facilitator at the per-opp OCS chatbot + the LLO's handbook gdoc +
   the practice-session audio review the coordinator grades.
2. `case_name` (hidden, calculate `concat(#user/username, ' - readiness')`).
3. `acknowledge_readiness` (single_select yes/no, required, constraint
   `. = 'yes'` — the facilitator must answer `yes`, i.e. coordinator-
   confirmed practice-session-pass). Saves to case property
   `readiness_acknowledged`.
4. `acknowledgement_date` (date, required, default `today()`). Saves
   to `readiness_date`.
5. `q1_score` (hidden, `calculate: if(#form/acknowledge_readiness = 'yes', 1, 0)`).
6. `user_score` (hidden, `calculate: #form/q1_score`). Referenced by
   the `connect.assessment` block.
7. `result_label` (label) — readiness-acknowledged closing message.

The sentinel **does not duplicate or replace** the out-of-band training.
It's a thin in-app artifact whose only operational job is to gate
attestation submissions on coordinator-confirmed practice-session-pass.
The real facilitator training (OCS chatbot + handbook gdoc + coordinator-
graded practice-session audio review) lives out-of-band. For where that
training lives, the "why sentinel and not real training" rationale, and
the full archetype redefinition spec, see reference.md § focus-group
sentinel rationale.

### `multi-stage`
Generate one Learn app per stage that has its own delivery work,
branching on each stage's archetype. If only Stage 2 involves FLW
delivery, only that stage gets a Learn app. The Stage Gate from the PDD
determines whether Stage 2 training launches before or after Stage 1
results.

## MCP Tools Used

- **Google Drive MCP:** `drive_read_file`, `drive_create_file`
- **Nova plugin slash commands:** `/nova:autobuild`, `/nova:show`,
  `/nova:list`, `/nova:edit` (for follow-up tweaks)

The Nova plugin is installed separately
(`/plugin install nova@nova-marketplace`) and signs in via OAuth on first
use. ACE does not call Nova MCP tools by name; it invokes the user-facing
slash commands listed above. See
`playbook/integrations/nova-integration.md` for current status.

## Mode Behavior
- **Auto:** Build via `/nova:autobuild`, write summary, notify admin,
  proceed.
- **Review:** Build, write summary, present summary for review before
  proceeding.

## Dry-Run Behavior
When `--dry-run` is active:
- Do NOT call `/nova:autobuild` (Nova builds are durable side effects;
  a dry run that creates a real app would clutter Nova's app list).
- Write the composed brief and the intended Nova invocation to
  `comms-log/dry-run-pdd-to-learn-app.md` (recipients: nova / brief /
  expected Connectify fields).
- Do not write `app-summaries/learn-app-summary.md` (no `nova_app_id`
  to record).
- State tracks as `dry-run-success`.
