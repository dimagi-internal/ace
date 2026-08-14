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

## Products

- `3-commcare/pdd-to-learn-app_summary.md` — Learn-app structure summary (modules, forms, fields, `nova_app_id`)

## Process

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

     **When the PDD names a working language other than English**, also
     insert this paragraph verbatim into the brief (dimagi-internal/ace#1181):

     > REQUIRED for multilingual builds: Nova tool payloads over ~5 KB
     > are truncated in transport before the tool sees them, surfacing
     > as `InputValidationError: could not be parsed as JSON` — the
     > JSON is well-formed, it was cut mid-string, and the threshold is
     > not a clean size check (a 1.9 KB retry has reproduced it). Your
     > labels stack every language inline, roughly tripling each
     > field's bytes, so batch `add_fields` at **~5 fields per call**
     > from the start (commcare-nova#459). Do NOT debug the payload's
     > quoting when you see that error — shrink the batch. The
     > verify-then-retry rule above still applies to every batch.
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
     - `localization-layer` (Learn variant) — trigger: PDD names a
       working language other than English. **Hard-fail** dimension:
       English-only when the PDD names a working language fails the gate.
       Nova exposes **no per-language / itext channel** — the sanctioned
       mechanism is complete coverage authored INLINE in one label; do
       not search for a translations parameter or report its absence as
       a blocker (ace#968).
     - `learn-app-naming` — always. App name must contain "Learn app".
     - `end-of-form-previous` — always, every form. End of Form Navigation
       must be "Previous Screen".
     - `grid-menu-display` — always (Learn + Deliver). Modules and Forms
       Menu Display set to "Grid".
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
     - `instrument-grounded-examples` — the Learn app teaches
       administration of a fixed instrument. Every worked example and
       good/bad pair built from a REAL instrument item, preferring the
       highest coaching-risk items (self-reported consumption over
       observable assets) (ace#982).

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
    type before deploy) — runs at LEVEL 0.** Mirror of
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
    3. On a miss, heal at LEVEL 0 with **`configure_connect`**, which is
       available to the level-0 session that executes this skill.
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
    message before deploy) — runs at LEVEL 0.** This is the structural
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

    3. On a miss, heal at LEVEL 0 (`edit_field` / `add_fields` are
       available to the level-0 session that executes this skill):
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
   nova_app_url: https://commcare.app/apps/<id-returned-by-autobuild>
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
2. **Preserve the invariants.** Every edited item keeps: complete
   language coverage on stem AND options (`localization-layer`), no option
   rejectable on sight, no literal `<` / `>` in label text, and a `qN_score`
   whose calculate references the question as `#form/<id>` — a bare id persists
   as raw text with no error and silently breaks the scoring chain (ace#1119).
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
