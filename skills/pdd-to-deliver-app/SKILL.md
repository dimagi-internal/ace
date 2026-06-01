---
name: pdd-to-deliver-app
description: >
  Build the CommCare Deliver (service-delivery) app from the PDD via
  Nova's /nova:autobuild. Captures nova_app_id and writes a structure summary.
disable-model-invocation: false
---

# PDD to Deliver App

Generate the Deliver (service delivery) app from the PDD using the Nova
plugin (`voidcraft-labs/nova-marketplace`, slash command
`/nova:autobuild`).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `1-design/idea-to-pdd.md` | source PDD; archetype + Deliver App Specification + delivery unit drive the Nova brief |

## Products

- `3-commcare/pdd-to-deliver-app_summary.md` — Deliver-app structure summary (forms, fields, `nova_app_id`)

## Process

1. **Read the PDD** from `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md` via Google Drive MCP.

2. **Extract the Deliver app spec** from the PDD. Pay special attention
   to the **delivery unit** — this is the most archetype-sensitive part
   of the spec and determines the form structure (see `## Archetypes`
   below).

3. **Compose a Nova brief** — a single natural-language description that
   `/nova:autobuild` consumes as its sole argument. Nova does not accept
   file paths or markdown attachments. The brief should:
   - Open with the delivery purpose and the verification artifact
     (1–2 sentences)
   - State the archetype framing explicitly (atomic-visit vs.
     focus-group session vs. multi-stage)
   - **Explicitly state this is a CommCare Connect Deliver app and
     that every form needs the appropriate `connect.deliver_unit`
     (or `task`) block per CommCare Connect's rules.** This is
     load-bearing language — without it, autobuild often skips the
     per-form Connect blocks even though its system prompt knows
     about them. The `app-connect-coverage` skill in Phase 3 Step 1.5
     is the safety net for cases where the brief was vague, but the
     more robust path is for this brief to be unambiguous up front.
     See `docs/learnings/2026-04-29-nova-connect-marker-bugs.md`
     § Bug 1 for the prompt-quality dependency.
   - **State the marker MECHANISM, not just the requirement: the
     `connect.deliver_unit` marker is set at the MODULE level via
     `module_type` — NOT a nested `connect:{}` object and NOT a form
     field.** Name this in the brief so the architect calls the right
     tool: `add_module`/`update_module(module_type:
     "connect.deliver_unit", id: "<slug>", entity_id: "/data/<key>",
     entity_name: "/data/<label>")` (the module's `deliver_unit_slug`
     auto-derives from its id). The form itself stays
     `form_type: "basic"` — there is NO deliver `form_type`. Live Nova
     enums: `module_type` ∈ {`basic`, `connect.learn_module`,
     `connect.deliver_unit`}; `form_type` ∈ {`basic`,
     `connect.assessment`}. Do NOT instruct the architect to pass a
     `connect: {deliver_unit: {...}}` object — `add_module` throws an
     opaque `"Unknown error"` and `update_form` type-rejects it, and an
     architect that takes that path ships a marker-less Deliver app
     (Connect surfaces no deliver unit → Phase 4 cannot create a payment
     unit). This mirrors the Learn marker mechanism
     (`module_type: "connect.learn_module"` +
     `form_type: "connect.assessment"`): an architect that gets Learn
     right first-try gets Deliver right too once the brief names the
     mechanism. Verified live on bednet-spot-check 20260601-1252; see
     jjackson/ace#660.
   - **REQUIRED — every form that needs its own paid deliver_unit
     MUST live in its own module.** Nova's `compile_app` emits the
     module slug as the `<learn:deliver id="...">` attribute for
     every form in the module, and Connect's HQ→Connect sync dedups
     deliver_units by `(app, slug)`. Two forms in one module produce
     ONE deliver_unit (named after the first form, second form
     silently unpaid in production). Architect each module with
     exactly one paid form. Insert this paragraph **verbatim** into
     the brief, in its own paragraph, prefixed `REQUIRED:`:

     > REQUIRED: Every form that needs its own paid deliver_unit
     > MUST live in its own module. Connect's HQ→Connect sync
     > dedups DeliverUnit records by `(app, slug)` and Nova's
     > `compile_app` reuses the module slug as the
     > `<learn:deliver id>` for every form in that module. The
     > result: two forms in one module collapse into ONE
     > deliver_unit with the first form's name, leaving the second
     > form's submissions silently unpaid because no payment_unit
     > can be wired to a non-existent deliver_unit. The default
     > Nova choice — group related forms into one module — does
     > not transfer to Deliver apps. Use exactly one paid form per
     > module.

     See `feedback_connect_deliver_unit_per_module` memory for the
     full mechanism + reproduction history.
   - Describe the delivery form's structure section by section
   - List the required Connectify fields (Deliver Unit, Entity ID)
   - Reference the relevant PDD section (Evidence Model, Output
     Specification, etc.)
   - **REQUIRED — Forbid angle-bracket placeholder notation in
     label/option/hint text.** Insert this paragraph **verbatim** into
     the brief, in its own paragraph, prefixed `REQUIRED:`:

     > REQUIRED: Do NOT use literal `<` or `>` characters in any form
     > label, option label, hint text, constraint message, or itext
     > value. Nova's XForm emitter does not entity-encode `<`/`>` in
     > label text, so a literal "<placeholder>" or "<expected format>"
     > becomes invalid XML when CCHQ parses the form during
     > `make_build` (CCHQ rejects with "Error parsing XML: StartTag:
     > invalid element name"). Use words ("placeholder text", "the
     > expected format") or backticks (`expected format`) for
     > placeholder syntax. Same rule for `&` and `"` in label text —
     > write them out as words instead of relying on entity encoding
     > to land. This applies to hint text and constraint messages too,
     > anywhere literal `<`/`>` would be tempting (e.g. format hints,
     > validator-message templates).

     Filed upstream as voidcraft-labs/nova-plugin issue #15
     ("XForm emitter does not entity-encode `<`/`>` in label text");
     this skill-side constraint is the workaround. Phase 3's
     `app-release` Step 4a surfaces a typed `BuildRejectedError` (with
     form name + line/col) and dispatches a Nova architect repair
     loop if the architect violates this constraint anyway, so the
     operator gets clean diagnostic + auto-recovery instead of "Cannot
     make new version" + a CCHQ UI peek. See
     `docs/learnings/2026-04-29-nova-connect-marker-bugs.md` § Bug 4.
   - **REQUIRED — Set `connect.deliver_unit.id` AND `connect.task.id`
     explicitly to short stable identifiers, separately from the human-
     readable `name`.** This is the load-bearing constraint; the ≤40-char
     name fallback below is just a safety net. Insert this paragraph
     **verbatim** into the brief, in its own paragraph, prefixed `REQUIRED:`:

     > REQUIRED: Every `connect.deliver_unit` and `connect.task` block
     > MUST include an explicit `id` field. The id is the Connect slug —
     > it MUST be short (8-20 chars), lowercase, snake_case, code-like,
     > and stable across renames of the human-readable name. Examples:
     > `shop_registration`, `sample_prep_initial`, `wohl_shipment`. Do
     > NOT rely on Nova's default derivation (which slugifies the module
     > name) — that conflates the Connect slug with the display name and
     > trips Connect's 50-char `DeliverUnit.slug` column on any name that
     > slugifies past ~40 chars. The `name` field is a separate, human-
     > readable string that can be any length and is what shows up in
     > the deliver-unit picker on Connect — terseness is preferred for
     > picker readability but not required for correctness once the id
     > is set explicitly. Vellum-authored apps (the human-driven
     > authoring path in HQ's form designer) separate these into two UI
     > fields ("Delivery Unit ID" / "Task ID" and "Name") and humans
     > naturally pick short identifiers; Nova's API exposes the same two
     > fields but the architect has to set both explicitly because there's
     > no UI to nudge the separation. See
     > `docs/learnings/2026-05-17-connect-slug-length-50-char-trap.md`
     > § Generalization (Vellum-as-source-of-truth) for the full mechanism
     > + source citations.

   - **REQUIRED — Keep deliver_unit/task names short enough that the
     derived slug fits Connect's 50-char column (FALLBACK).** This is
     the defense-in-depth fallback for cases where the explicit-id rule
     above is missed. Insert this paragraph **verbatim** into the brief,
     in its own paragraph, prefixed `REQUIRED:`:

     > REQUIRED: If you have not set `connect.deliver_unit.id` /
     > `connect.task.id` explicitly per the rule above, the `name` field
     > MUST be ≤ 40 characters as a fallback — Nova's default slug
     > derivation overflows Connect's 50-char `DeliverUnit.slug` /
     > `TaskType.slug` column on longer names and triggers an opaque
     > HTTP 500 from `connect_create_opportunity`. Prefer the explicit-id
     > rule above (cleaner; lets `name` be any length); this clause
     > exists only because architects sometimes skip the id field.

     Reproducer + class-level preventer: see
     `pdd-to-learn-app/SKILL.md` § REQUIRED — Set id explicitly. The
     structural backstop is `app-release` Step 6's
     `projected_connect_state.oversized_slugs.deliver_units` /
     `oversized_slugs.task_units` gate. Removal criteria: (a) drop the
     ≤40-char fallback when the upstream commcare-connect PR widens
     `DeliverUnit.slug` to `max_length=255` (already `=100` since a prior
     fix) AND `TaskType.slug` to `max_length=255` (dimagi/commcare-connect#1195)
     and `SLUG_LENGTH_LIMIT` in `mcp/connect/backends/commcare.ts` is
     bumped in lock-step. (b) KEEP the explicit-id rule even after the
     column widens — it's a cleanliness invariant matching Vellum's
     slug-vs-name separation, not just a workaround for the column width.
   - **REQUIRED — `entity_id` is Connect's dedup / payment grain; make
     it a BUSINESS KEY built from form fields, NOT the system case id.**
     `entity_id` is the value Connect uses to collapse duplicate
     deliveries and aggregate visits to the same real-world entity. It
     must therefore be a human-meaningful key derived from the PDD's
     `duplicate-detection-key` (Evidence Model Layer A) — the natural
     identifiers that define one unique entity (e.g. beneficiary name +
     phone; outlet + brand + batch) — built from the form's own fields.

     **Do NOT use the raw case id.** Both forms of it are wrong:
       1. `/data/case/@case_id` is hard-rejected by Nova `validate_app`
          ("references `/data/case` which doesn't exist in this form") —
          the case block is a build-time-emitted XForm node, not a
          blueprint field the validator's reference oracle can resolve.
       2. `#case/case_id` compiles to a casedb-lookup XPath that breaks
          install on a CASE-CREATE form (`XPathTypeMismatchException`
          from `FormDef.initAllTriggerables`; "A part of your
          application is invalid" on device) — Connect populates
          `case_id_new_<type>_<n>` not `case_id`, and the case isn't in
          `casedb` yet.
       3. Even if the validator accepted it, a per-registration case
          UUID gives **zero cross-registration / cross-FLW dedup** — two
          FLWs registering the same entity get two case_ids → two paid
          entities → the PDD's duplicate-detection is defeated. The case
          id is the wrong *grain*, independent of the validator quirk.

     Grounded in deployed practice: across 6 real human-built Connect
     Deliver apps (KMC, MBW; both atomic-create-payment and multi-visit),
     **0/6 use the case id for `entity_id`** — all build a `concat(...)`
     business key from form fields and persist it to a case property for
     downstream forms to reuse. A single `/data/...` field path as
     `entity_id` is install-safe (form fields resolve at `xforms-ready`)
     and `validate_app`-clean (it's a real form reference) — the same
     shape the malaria-rdt run verified end-to-end through
     `validate_app` + `make_build` + release + `commcare-cli play`.

     Insert the matching paragraph(s) **verbatim** into the brief, in
     their own paragraph, prefixed `REQUIRED:`.

     **Case-CREATE deliver_units** (registration forms — the typical
     atomic-visit Deliver app):

     > REQUIRED: For any `connect.deliver_unit` block on a CASE-CREATE
     > form, set `entity_id` to a BUSINESS KEY built from the form's own
     > fields — NOT the case id. Create a hidden calculate field (e.g.
     > `entity_key`) whose `calculate` is a `concat(...)` of the
     > natural-identifier fields that define a unique entity per the
     > PDD's duplicate-detection key, then set
     > `entity_id: '/data/<group>/entity_key'` and `entity_name` to the
     > human-readable label field (e.g. `entity_id: '/data/entity_key'`,
     > `entity_name: '/data/beneficiary_name'`). Example for a malaria
     > RDT outlet visit whose dedup key is (outlet, brand, batch):
     > `entity_key` = `concat(/data/outlet_name, ' - ', /data/rdt_brand,
     > ' - ', /data/batch_number)`. Do NOT use `/data/case/@case_id`
     > (rejected by `validate_app` — the case block is not a blueprint
     > field) or `#case/case_id` (compiles to a casedb lookup that breaks
     > create-form install, and is the wrong dedup grain anyway: a
     > per-registration UUID gives no cross-registration/cross-FLW
     > dedup). Form fields resolve at `xforms-ready`, so a `concat(...)`
     > of them is install-time resolvable and validator-clean.

     **Case-UPDATE / multi-form deliver_units** (visit-series and
     multi-stage apps where the SAME entity is referenced across forms):

     > REQUIRED: When a `connect.deliver_unit` spans multiple forms (a
     > registration form plus later visit forms for the same entity),
     > every form MUST emit the IDENTICAL `entity_id` grain. (a) On the
     > CASE-CREATE form, in addition to setting `entity_id` to the
     > business key, persist that key to a case property
     > (`case_property_on` the relevant case type, e.g. write
     > `/data/entity_key` to a case property `entity_key`). (b) On each
     > CASE-UPDATE form, set `entity_id` to read that stored property
     > back off the case (`#case/entity_key`, or a casedb lookup of the
     > parent's stored key for child-case forms) — NOT `#case/case_id`.
     > Optionally suffix ` - <form_name>` (a per-form constant) so each
     > visit type is a distinct deliver entity while repeat submissions
     > of the same type for the same entity dedup. This is the pattern
     > all 6 deployed apps use.

     Upstream (secondary): Nova's `validate_app` reference oracle could
     be taught to recognize `/data/case/@case_id` as a runtime-valid path
     (tracked at
     [voidcraft-labs/nova-plugin#20](https://github.com/voidcraft-labs/nova-plugin/issues/20)),
     but that's no longer load-bearing for ACE — `entity_id` should be a
     business key regardless of whether the validator accepts the case id.

     History (why the case id was abandoned): the prior rule prescribed
     `/data/case/@case_id` (case-create) / `#case/case_id` (case-update)
     as a workaround for the Nova compiler shape — see the reproducers
     `bednet-spot-check/20260525-1405` (`#case/case_name`, failed
     on-device install) and `20260525-2022` (`#case/case_id`, failed
     `commcare-cli.jar play`), and `docs/learnings/2026-05-25-entity-id-misdiagnosis.md`.
     The 6-app audit (jjackson/ace#586) showed the case id was the wrong
     target all along; the fix is a business key, not a different
     case-id XPath.

   - **REQUIRED — Architect must verify-then-retry every `add_fields`
     call.** Nova's `add_fields` has a partial-persistence quirk: a
     single call with N items often persists only the first few. The
     19-field turmeric Deliver form needed 5 `add_fields` calls to
     land all questions; mid-build sessions where the architect
     skipped verification have shipped forms that look complete in the
     build summary but render with missing questions in the actual
     app. Insert this paragraph **verbatim** into the brief, in its
     own paragraph, prefixed `REQUIRED:`:

     > REQUIRED: Nova's `add_fields` has a partial-persistence quirk.
     > After EVERY `add_fields` call, immediately call `get_form` and
     > count the persisted fields. If the count is less than what you
     > requested, re-issue `add_fields` for the missing fields and
     > re-verify. Repeat until counts match. For forms with >10
     > fields plan on 2–5 `add_fields` invocations. Do not move on to
     > the next form before counts match — silent partial persistence
     > on form N becomes invisible once you start working on form
     > N+1.

     See `docs/learnings/2026-04-29-nova-connect-marker-bugs.md`
     § Bug 3 for the full failure analysis.

   - **REQUIRED — Deployability (fitness) components.** A faithful
     transcription of the PDD's field list is NOT a deployable
     instrument. `pdd-to-deliver-app-eval`'s fitness axis (55% weight)
     **hard-fails** the build on each gap below; the build must emit the
     applicable components so the instrument is field-reliable, not just
     structurally complete. (Root cause of the ITN 9.6-on-a-hollow-build:
     the brief never demanded them. See
     `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`.)

     The canonical, parameterized text for each component lives in
     **[`skills/_app-component-library.md`](../_app-component-library.md)** —
     the single source of truth, paired 1:1 with the eval dimension that
     hard-fails a build omitting it. For each Deliver component whose
     **Trigger** fires for this app, open the library and insert that
     component's **Brief paragraph** into the brief **verbatim**, in its
     own paragraph, prefixed `REQUIRED:`, substituting any `<PARAM>`
     placeholders from the PDD. Emit-checklist (see the library for full
     text + triggers):

     - `gps-accuracy-capture` — PDD Evidence Model states a GPS radius.
     - `init-safe-calculates` — always emit alongside any capture-later
       calculate (always pairs with `gps-accuracy-capture`).
     - `data-quality-constraints` — always, for any data-capture form.
     - `case-write-back` — any case-UPDATE / follow-up form that captures
       new observations.
     - `structured-capture` — any answer with an enumerable option set.
     - `section-timestamps` — PDD success metrics reference visit-time / a
       cost model.
     - `embedded-bc-script` — PDD specifies a verbatim behavior-change
       segment.
     - `localization-layer` — PDD names a working language other than
       English (Deliver variant). **Hard-fail** dimension: English-only
       when the PDD names a working language fails the gate.

     Do NOT inline-paraphrase these — reference the library so the build
     and `pdd-to-deliver-app-eval` stay symmetric. Skip a component whose
     trigger doesn't fire.

4. **Invoke `/nova:autobuild "<brief>"`.** Capture from the response:
   - `app_id` — durable Nova handle, written to the summary as
     `nova_app_id`
   - Build summary
   - Any warnings

4a. **Post-build field-count verification — runnable recipe (skill-side safety net).**

    The architect-brief language above puts retry-then-verify
    discipline on the architect agent. This step is the skill-side
    safety net for cases where the architect finished short — including
    the case where the architect ran out of budget mid-form and
    silently persisted N-of-M expected fields with no error. (FGD
    Deliver apps are the highest-risk surface: the per-section summary
    form for focus-group archetypes is ~45-70 fields with 7 section
    groups — exactly the kind of long form where partial persistence is
    most likely. Seen on a sibling Learn-app build; see jjackson/ace#303.)

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

    3. **For every form in the expected map**, call
       `get_form({app_id, moduleIndex, formIndex})` (one call per form,
       batchable in parallel across forms). Collect:
       - `persisted_ids`: the set of `field.id` values present in the
         response. Hidden / label / group / repeat fields all count.
       - `persisted_count`: `len(persisted_ids)`.

    4. **Compute the diff per form.** `missing = expected[m][f] -
       persisted_ids`. **Also** compute `referenced_missing`: any field
       referenced in another field's `calculate` / `relevant` /
       Connect-marker `user_score` / `entity_id` that isn't in
       `persisted_ids`. (`validate_app` flags this class as
       "X references Y which doesn't exist in this form" — same
       shortfall, different detection path. Catching it here means we
       don't ship to `validate_app` with a known gap.)

    5. **If `missing ∪ referenced_missing` is empty across every form,
       proceed to step 4b (one-form-per-module check).** No edit needed.

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

    Why we run this even though `validate_app` will catch some
    shortfalls downstream: `validate_app`'s reference-integrity check
    only catches missing fields that ARE referenced elsewhere. A
    `Post-Session Summary` form that's missing 1 of 7 section groups
    with no cross-reference between groups passes `validate_app`
    cleanly and ships to the FLW silently incomplete. Step 4a is the
    coverage-on-the-brief safety net `validate_app` is structurally
    unable to provide.

    Same shape as `app-connect-coverage` — verify+fix in a bounded
    loop, post-Nova.

4b. **Structural pre-flight: one form per module (deliver_unit slug
    uniqueness).** After field counts match, verify the module/form
    layout is what Connect's sync will consume cleanly. Cheap check;
    fires before any HQ upload.

    1. Call `get_app({app_id})` and enumerate
       modules + forms.
    2. Count forms tagged with `connect.deliver_unit` (or `connect.task`)
       across the app. Call this `intended_paid_form_count`.
    3. Count modules whose form set contains ≥ 1 paid form. Call this
       `paid_module_count`.
    4. **Assert** `paid_module_count === intended_paid_form_count`.
       If not, every multi-paid-form module will collapse to one
       deliver_unit at Connect's sync (Nova reuses the module slug as
       `<learn:deliver id>` per form; Connect dedups by slug). The
       collapsed-but-non-first forms reach production silently unpaid.

    On mismatch, dispatch:

    ```
    /nova:edit <app_id> "Split module <X> so that each of its paid
    forms (<form-Y>, <form-Z>) lives in its own module. Connect dedups
    deliver_units by slug and Nova currently emits the module slug as
    the <learn:deliver id> for every form in that module, so multi-form
    modules collapse to one deliver_unit at sync. After the edit, every
    form with connect.deliver_unit set must be the only form in its
    module."
    ```

    Re-fetch and re-assert. **Bounded loop, max 3 iterations.** If
    still mismatched after 3, surface a clear failure listing each
    offending module + the forms that need separating, and do not
    write the success summary.

    See `feedback_connect_deliver_unit_per_module` memory for the
    upstream Nova bug that necessitates this — when Nova's
    `compile_app` learns to slug `<learn:deliver id>` per-form, this
    check becomes a one-form-per-module preference rather than a
    correctness requirement and the brief language above can soften.

4c. **Case write-back verification (follow-up forms must persist
    observations).** The structural preventer for the ITN Visit-2 defect
    — a case-update form that captured retention/change observations but
    wrote zero case properties, so the change it observed was lost.
    `pdd-to-deliver-app-eval § case_persistence` hard-gates this at ≤2;
    this step catches it at build time. Cheap; runs on the already-
    fetched blueprint. Same bounded-loop shape as 4a/4b.

    1. From `get_app({app_id})`, identify each **case-UPDATE** form (a
       form that updates an existing case rather than creating one —
       `entity_id: '#case/case_id'` per the case-action rule above, or a
       form Nova tagged as updating the case type).
    2. For each case-update form, list its **user-facing observation
       fields** (non-hidden, non-label questions the FLW answers).
    3. **Assert** that the form binds **≥1** of those observation fields
       to a case property via `case_property_on`. A case-update form
       that captures new observations and writes zero case properties
       fails this assertion.
    4. On failure, dispatch:

       ```
       /nova:edit <app_id> "Form <module>/<form> is a case-update form
       that captures observations (<list>) but writes no case
       properties. Bind the observation fields that represent durable
       state (<list>) to case properties on case type <type> via
       case_property_on, so the follow-up visit persists what it
       observed. After the edit, get_form and verify each binding."
       ```

       Re-fetch and re-assert. **Bounded loop, max 3 iterations.** If
       still failing after 3, surface a clear failure naming the form +
       its unpersisted observations, and do not write the success
       summary. (Single-form atomic-visit apps with no case-update form
       have nothing to check — skip cleanly.)

4d. **Case-list column heal — runs at LEVEL 0 (deterministic preventer
    for the autonomous-architect allowlist gap).** A case-CREATE module
    whose `caseListConfig.columns` is empty (`case_list_config: null`)
    fails Nova's `validate_app` with a single error against that module.
    The autonomous architect dispatched in Step 4 (`/nova:autobuild` →
    `Agent(nova:nova-architect-autonomous)`) **cannot clear this error
    on its own**: the case-list-config tool family
    (`add_case_list_column`, `set_case_list_filter`,
    `update_case_list_column`, `remove_case_list_column`,
    `reorder_case_list_columns`, `set_case_search_display`,
    `set_case_search_advanced`, `add_search_input`, …) is **not present
    in the autonomous architect's tool allowlist**. It will try
    `generate_scaffold`, a fresh `create_module`, and promoting
    `case_name` to a visible field — none of which auto-seeds the
    default column — and report it cannot reach validate-clean.

    **Why this step lives in the skill (at level 0) and not in the
    architect brief:** these case-list-config atoms (`add_case_list_column`
    et al.) ARE available to the level-0 Claude Code session that
    executes this skill, even though they are absent from the autonomous
    architect's allowlist. So the heal is a deterministic L0 operation:
    run it here, after the autonomous build returns, rather than asking
    the architect to do something its tools can't. (The upstream half —
    adding the case-list-config family to the
    `nova:nova-architect-autonomous` allowlist — is tracked separately
    and lives in the **external nova plugin**, which is not editable from
    this repo. jjackson/ace#632.)

    Cheap; runs on the already-fetched blueprint. Same bounded-loop
    shape as 4a/4b/4c.

    1. Call `validate_app({app_id})`. If it returns clean, skip the rest
       of this step — there is nothing to heal.
    2. If it reports an empty / missing `caseListConfig.columns` (or
       `case_list_config: null`) on one or more modules, identify each
       offending **case-CREATE** module from `get_app({app_id})` (use
       `get_module({app_id, moduleIndex})` to confirm the module's case
       type + that its case list is empty).
    3. For each offending module, call
       `add_case_list_column({app_id, moduleIndex, ...})` to add ONE
       plain column over the case name field (the module's `case_name` /
       case-name field). A single default column is sufficient to clear
       the validate error; this is the same one-column heal an operator
       applies by hand.
    4. Re-run `validate_app({app_id})`. **Bounded loop, max 3
       iterations** over steps 2–4. If `validate_app` still reports an
       empty `caseListConfig.columns` after the third iteration, surface
       a clear failure naming each module still missing its case-list
       column, and do NOT write the success summary.

    (Apps with no case-CREATE module, or whose case-create modules
    already carry a non-empty case list, validate clean at step 1 and
    skip cleanly.)

5. **(Optional) Inspect the built app** via `/nova:show <app_id>` to
   cross-check structure against the PDD before writing the summary.

6. **Self-evaluate (LLM-as-Judge):**
   - Does the app structure match the PDD Deliver spec?
   - Is the delivery unit framed correctly for the archetype?
   - Are all Connectify fields configured (Deliver Unit, Entity ID)?
   - Are verification criteria encoded in form questions?

7. **Write the summary** to
   `ACE/<opp-name>/runs/<run-id>/3-commcare/pdd-to-deliver-app_summary.md` with required
   frontmatter:

   ```yaml
   ---
   nova_app_id: <id-returned-by-autobuild>
   nova_app_url: https://commcare.app/apps/<id-returned-by-autobuild>
   archetype: <atomic-visit | focus-group | multi-stage>
   delivery_unit: <one-line description matching the PDD>
   ---
   ```

8. **Notify admin group** that Deliver app generation is complete.

## Archetypes

The Deliver app's structure depends on the PDD's `archetype:` field. The
"delivery unit" concept is the most archetype-sensitive part of ACE — get
this wrong and `connect-opp-setup` will configure the wrong verification
rules.

### `atomic-visit`
Delivery unit = **one FLW visit to one beneficiary**. The form is the
verification artifact: every required field, photo, GPS coordinate. Case
management follows the standard create → update → close pattern. The
form's fields map 1:1 to Layer A and Layer B of the PDD's Evidence Model.

### `focus-group`

Delivery unit = **one completed FGD session, attested by a 5-field
CommCare form** submitted at session end. The Deliver app for
focus-group is intentionally minimal — it is the **payment trigger
only**, not the content-capture surface and not the artifact-upload
surface.

**FGD content lives in a Google Doc**, not in this app. **The gdoc is
written after the session ends — typically hours or days later — and
cannot be linked from the attestation form at submission time.** All
qualitative content (per-section themes, verbatim quotes, consensus
grading, post-FGD report, facilitator reflection) lives in the gdoc.
Audio recording (if captured) is out-of-band entirely — it does not
go through CommCare; the facilitator attaches audio to the gdoc as a
Drive attachment or shares it through a separate Drive folder. The
attestation form captures only session-happened evidence + consent
confirmation, and each submission is one payment unit. See
`docs/superpowers/specs/2026-05-15-focus-group-archetype-redefinition.md`.

**App shape (one module, one form):**

- **Module 1: Session Attestation** (case type: `fgd_session`).
- **Form: "Session Attestation"** (case-create, `connect.deliver_unit`
  set). One submission = one completed session = one payment trigger.

**Required fields on the attestation form (5 fields):**

| Field | Kind | Notes |
|---|---|---|
| `consent_all_participants` | single_select | Required attestation: did every participant consent to participate? Options: `yes` (consent obtained from all participants) / `no` (one or more declined / not obtained). Constraint: `. = 'yes'` — form cannot be submitted without affirmative consent, because there is no payment for an FGD held without consent. |
| `session_date` | date | When the session was held. Facilitator picks; usually today (submitted at session end) but can be one or two days back if writing it up later. |
| `venue` | text | Free-text venue description. Hint: include the village/community name + the specific space (e.g. "Kibera, community hall behind the primary school"). |
| `gps` | geopoint | Captured at the venue. Anchors location verification (Layer A). Captured at form-fill time on the FLW's device — implicitly proves the FLW was AT the venue when they attested. |
| `photo` | image | A single evidence photo. Hint: an attendance sheet (first names + role + consent marks, NO faces) or a venue photo. Faces only if every participant has actively consented to a face photo. |

That is the complete form. No audio, no participant count, no per-section
fields, no gdoc link, no reflection, no facilitator-name field
(captured implicitly via Connect's FLW identity). Auto-generated
`case_name` from `concat(#user/username, '-', #form/session_date)` keeps
the case list legible.

**Connect markers:**

- `connect.deliver_unit` set on the form.
- `connect.entity_id` defaults to `concat(#user/username, '-', today())` —
  one paid delivery per facilitator per day, the realistic case for
  60-90 min sessions + travel. This is already a business key (good — see
  the §`entity_id` REQUIRED rule). If any LLO schedules ≥2 sessions/day
  per facilitator, override to a finer-grained business key, e.g.
  `concat(#user/username, '-', /data/session_date, '-', /data/venue)` —
  NOT `#case/case_id` (`payment-unit-entity-id` Decisions Log row).

**Coordinator review flow (out-of-band):**

Layer A verification happens automatically against form contents
(GPS within an expected radius of the planned venue, photo attached,
consent attested, session_date within an expected fielding window).
Layer B verification is the coordinator reviewing the **facilitator's
gdoc**, matched to the attestation submission by `(FLW identity,
session_date, venue)` — there is no `gdoc_link` field, so matching is
operator-driven (coordinator sees the attestation in the FormRepeater
feed, expects a gdoc from that facilitator about that session,
follows up if it doesn't arrive within the gdoc submission window).

**Specifically not included:**

- **No audio upload through CommCare.** Audio recording (if captured)
  is out-of-band entirely. CommCare doesn't carry large audio files
  for FGDs — they live in Drive or wherever the LLO keeps audio.
- **No `gdoc_link` field.** The gdoc doesn't exist when the
  attestation is submitted. Linkage between attestation and gdoc is
  coordinator-driven, by `(FLW, session_date, venue)` match.
- **No per-section structured summary fields.** Qualitative content
  lives in the gdoc.
- **No participant-count / segment / start-end-time fields.** These
  go in the gdoc.
- **No facilitator-reflection field.** Goes in the gdoc.
- **No pre-checklist field.** The pre-session preparation is the LLO's
  responsibility; the consent attestation is the only check that needs
  to gate payment.
- **No pre-session + post-session + reviewer-verification form split.**
  One form, submitted at session end.
- **No case management beyond per-session.** No case lifecycle, no
  per-beneficiary cases, no per-participant follow-up.
- **No Learn-app-equivalent training surface.** `pdd-to-learn-app` is a
  no-op for focus-group archetype.

**Brief language for `/nova:autobuild`:** open with "this is a 5-field
session attestation form for an FGD opportunity. The mobile form
captures only proof-of-session-happened (consent, date, venue, GPS,
photo); it is NOT a content-capture form and NOT an artifact-upload
form. Qualitative content lives in a Google Doc written after the
session, out-of-band; audio (if captured) lives in Drive separately.
One submission = one completed session = one Connect deliver_unit
submission = one payment trigger."

### `multi-stage`
Generate one Deliver app per stage that has its own delivery work,
branching on each stage's archetype. The two Deliver apps may have
completely different structures (e.g., Stage 1 = focus-group session
form, Stage 2 = atomic household-visit form).

## MCP Tools Used

- **Google Drive MCP:** `drive_read_file`, `drive_create_file`
- **Nova plugin slash commands:** `/nova:autobuild`, `/nova:show`,
  `/nova:list`, `/nova:edit`

See `playbook/integrations/nova-integration.md` for plugin status.

## Mode Behavior
- **Auto:** Build via `/nova:autobuild`, write summary, notify admin,
  proceed.
- **Review:** Build, write summary, present summary for review before
  proceeding.

## Dry-Run Behavior
When `--dry-run` is active:
- Do NOT call `/nova:autobuild` (Nova builds are durable side effects).
- Write the composed brief and the intended Nova invocation to
  `comms-log/dry-run-pdd-to-deliver-app.md`.
- Do not write `app-summaries/deliver-app-summary.md` (no `nova_app_id`
  yet).
- State tracks as `dry-run-success`.

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
| `deliver-unit-count` | How many distinct deliver units (modules × forms) does the Deliver app expose? | PDD `Deliver App Specification` numeric |
| `one-form-per-module-workaround` | Are we one-form-per-module to dodge Nova's CCZ marker bug? | `pdd-to-deliver-app-eval` connect-marker-coverage dimension; CLAUDE.md gotcha |
| `multimedia-coverage-strategy` | What multimedia (text vs voice prompts vs both) does the Deliver app surface? | `app-multimedia-coverage` skill output; PDD multimedia note |

The orchestrator's Phase Write-Back Verifier (`agents/ace-orchestrator.md`
§ Phase Write-Back Contract § Decisions log clause) enforces the
contract; the renderer (`skills/decisions-render`) regenerates the gdoc
at end of every phase.

Each row this skill writes uses `phase: 3-commcare` and
`skill: pdd-to-deliver-app`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-06-01 | **Added Step 4d — L0 case-list column heal for case-CREATE Deliver builds (closes jjackson/ace#632).** A case-CREATE module with an empty `caseListConfig.columns` (`case_list_config: null`) fails `validate_app`, and the autonomous architect dispatched by Step 4 (`/nova:autobuild` → `Agent(nova:nova-architect-autonomous)`) **cannot clear it** — the case-list-config tool family (`add_case_list_column` / `set_case_list_filter` / `update_case_list_column` / `reorder_case_list_columns` / `set_case_search_*` / `add_search_input` / …) is absent from the autonomous architect's tool allowlist. New Step 4d runs the deterministic heal at LEVEL 0 (where those atoms ARE available): `validate_app` → for each offending case-create module `add_case_list_column` (one plain column over the case name) → re-`validate_app`, bounded max 3 iterations, halt-loud on residual. Mirrors the L0 heal that unblocked malaria-rdt/20260601-0929 Phase 3. The upstream half (adding the case-list-config family to the `nova:nova-architect-autonomous` allowlist) is tracked separately and lives in the external nova plugin, not editable from this repo. | ACE team |
| 2026-06-01 | **`entity_id` rule reframed: prescribe a BUSINESS KEY from form fields, NOT the case id (supersedes the 2026-05-26 `/data/case/@case_id` rule).** Audited 6 real human-built Connect Deliver CCZs (3 KMC, 3 MBW; atomic-create-payment and multi-visit): **0/6 use the case id for `entity_id`** — all build a `concat(...)` business key from form fields (name+phone, outlet+brand+batch) and persist it to a case property so downstream visit forms reproduce the same grain via casedb. Reframes jjackson/ace#586: `/data/case/@case_id` isn't just `validate_app`-rejected (case block is build-time-emitted, not a blueprint field) — a per-registration case UUID is the wrong *dedup grain* (no cross-registration/cross-FLW dedup), so the case id is wrong independent of the validator quirk. The malaria-rdt heal to `/data/case_name` (=`concat(outlet,brand,batch)`) was correct-by-design, not luck. New REQUIRED rule: case-CREATE → hidden `concat(...)` field of the PDD `duplicate-detection-key` natural identifiers, `entity_id: '/data/…/entity_key'`; multi-form → persist the key to a case property + read it back on case-UPDATE forms (`#case/<key>`), never `#case/case_id`. Upstream voidcraft-labs/nova-plugin#20 demoted to secondary (not load-bearing — `entity_id` should be a business key regardless). Prior reproducers + 2026-05-25 misdiagnosis postmortem retained as history. Companion: `idea-to-pdd` `payment-unit-entity-id` row + focus-group override note aligned. Evidence: 6 CCZs read 2026-06-01. | ACE team |
| 2026-05-29 | **Extracted the deployability/fitness `REQUIRED:` paragraphs into the shared [`_app-component-library.md`](../_app-component-library.md).** The Step-3 "Deployability (fitness) requirements" block (GPS accuracy-gating, init-safe calculates, data-quality constraints, case-write-back, structured-capture, section-timestamps, embedded-BC-script, localization) is no longer inlined — it's now an emit-checklist of **named components** the build inserts verbatim from the library by trigger. Single source of truth for the paragraph text (dedups localization, previously duplicated with `pdd-to-learn-app`); the library pairs each component 1:1 with the `pdd-to-deliver-app-eval` fitness dimension that hard-fails a build omitting it, so the eval is the backstop for the indirection. Closes the reusable-component-library item (PR-8 build track) in `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md` / open decision #2. | ACE team |
| 2026-05-15 | Tighten Step 4a (post-build field-count verification) from "the in-context LLM must..." prose into a numbered tool-call recipe. Mirrors the same change in `pdd-to-learn-app/SKILL.md`. Prompted by `malaria-itn-fgd/20260514-2007` Learn-app cert-assessment partial-persistence (FGD Deliver apps with the ~45-70-field per-section summary form are the highest-risk surface for the same class). See jjackson/ace#303. | ACE team |
| 2026-05-15 | **focus-group archetype rewritten to attestation-form-only.** Previously: 3-module / 69-field per-section-summary Deliver app capturing all qualitative content in CommCare. New: one module, one ~14-field attestation form (date / venue / participants / audio / photo / gdoc link / consent / reflection). Content lives in a Google Doc out-of-band; the gdoc_link field is the bridge. One submission = one payment trigger. Prompted by post-run reframe from operator: "all the content collection... will happen manually and they will send us a gdoc". See `docs/superpowers/specs/2026-05-15-focus-group-archetype-redefinition.md`. | ACE team |
| 2026-05-15 | **Pare focus-group attestation form to 5 fields:** `consent_all_participants` (single_select yes/no, validate=yes), `session_date`, `venue` (text), `gps` (geopoint), `photo` (image). Drop `audio_file` / `backup_audio_file` (audio capture is out-of-band; not in CommCare), `gdoc_link` (gdoc is written AFTER session end, no linkable URL exists at submission time), and the metadata fields (`llo_name`, `site_*`, `venue_type`, `planned_segment`, `actual_participant_count`, `start_time`, `end_time`, `audio_duration_minutes`, `facilitator_reflection`, `pre_checklist_complete`) — these go in the gdoc. Matching attestation → gdoc is coordinator-driven by `(FLW, session_date, venue)` tuple. Prompted by operator: "For the fields just have consent (this should confirm you have consent from all participants), date, venue, gps, photo. everything else is either wrong or goes into the gdoc. the gdoc will be created after the fact so no ability to enter it into commcare". | ACE team |
| 2026-05-25 | **Revert PR #445; restore `#case/case_id` as the canonical create-form `entity_id`; add explicit REQUIRED rule against `#case/case_name` substitution.** PR #445 (commit `749888e`, 2026-05-24) had flipped the recommended override from `#case/case_id` to `#case/case_name` based on a `/canopy:select-session` rescan citing a Nova validator rejection in the `e2e-malaria-rdt` 2026-05-24 run — but no artifact was preserved and the change contradicted a verified learning from one day earlier (`docs/learnings/2026-04-29-nova-connect-marker-bugs.md:92-95`: 2026-05-23 round-trip verification that `#case/case_id` persists exactly as passed). The substitution passed every Phase 3 static gate (`validate_app`, `make_build`, release, `app-release-smoke` projection) then failed on-device install on `bednet-spot-check/20260525-1405` Phase 6 with "A part of your application is invalid" — CommCare's install-time resource graph reads `entity_id`'s XPath BEFORE the hidden `case_name` field's `calculate` fires, gets null, and rejects the CCZ. `#case/case_id` does NOT have this problem because JavaRosa allocates the case UUID synchronously at form-processing start. Per Vellum's source-of-truth help text (`src/commcareConnect.js:243`), `case_id` IS the canonical pattern. New REQUIRED rule inserted in Step 3 ("`entity_id` on a create-form MUST resolve at install/parse time"). Full postmortem: `docs/learnings/2026-05-25-entity-id-misdiagnosis.md`. Structural preventer (commcare-cli.jar install simulation) tracked at `docs/learnings/2026-05-25-bednet-smoke-phase6-install-rejection.md § Preventer 2`. | ACE team |
| 2026-05-26 | **Both prior `entity_id` rules were operator-side workarounds for an unrecognized upstream Nova compiler bug — branch the REQUIRED rule on case action.** The `commcare-cli.jar play` install-time gate (shipped same day in PR #510's Java-resolver fix) caught `bednet-spot-check/20260525-2022`'s Deliver CCZ failing `FormDef.initAllTriggerables` with `XPathTypeMismatchException` on `/data/bednet_visit/deliver/entity_id`. The bind Nova emitted for the directive `entity_id: '#case/case_id'` was the **case-UPDATE** shape: `instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/case_id`. On a case-CREATE form that XPath is broken on two grounds — Connect populates `case_id_new_visit_<n>` (not `case_id`) in session data, and the case isn't in `casedb` yet. The same exception class is what CommCare's mobile runtime surfaces as "A part of your application is invalid" on device — explaining why BOTH bednet runs (1405 with `case_name`, 2022 with `case_id`) hit install rejection for what looked like different reasons; same Nova compiler bug, two different operator workaround attempts. Tracked upstream as voidcraft-labs/nova-plugin#20. Skill rule split: case-create deliver_units now emit `entity_id: '/data/case/@case_id'` + `entity_name: '/data/case_name'` (literal XPaths against the form's own case block, which the form's `<setvalue>` chain populates at xforms-ready); case-update deliver_units keep `#case/case_id` + `#case/case_name` (where Nova's casedb-lookup compilation IS correct). The change-log entry above (2026-05-25) is preserved verbatim for the audit trail; its conclusion was empirically wrong but the postmortem on PR #445 stands. | ACE team |
| 2026-05-29 | **Deployability brief requirements + case-write-back verification (ITN post-mortem).** Added a `REQUIRED — Deployability (fitness) requirements` block to Step 3 (GPS accuracy-gating when a radius is specified; default data-quality constraints — bounds, cross-field, phone regex, char limits; structured selects + other→specify over free text; section timestamps; verbatim in-form BC script) and a `REQUIRED — Localization` paragraph (English core + named-language translation set; English-only hard-fails). Added Step 4c (case write-back verification): case-update forms that capture observations must bind ≥1 `case_property_on`, with a bounded `/nova:edit` repair loop — the structural preventer for the ITN Visit-2 write-nothing defect. These mirror the new `pdd-to-deliver-app-eval` fitness hard-gates 1:1 so build and eval are symmetric. See `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`. | ACE team |
| 2026-05-29 | **Init-safety on GPS lat/lon/accuracy calculates (and a general init-safe-calculate rule).** The GPS accuracy-gating REQUIRED paragraph added 2026-05-29 told the architect to emit normalized `lat`/`lon` outputs but didn't say to guard the `selected-at(<geopoint>, N)` extraction calculates against an empty geopoint — and CommCare evaluates ALL calculates eagerly at `FormDef.initAllTriggerables`, BEFORE any GPS is captured, so `selected-at()` on the empty geopoint threw a fatal `XPathException` and the whole form failed to install ("A part of your application is invalid"). It passed `validate_app` AND `make_build`; only `app-release-qa`'s `commcare-cli play` gate caught it. Folded the `if(<geopoint> = '', '', selected-at(...))` guard into the GPS paragraph and added a standalone `REQUIRED — Init-safe calculates (general rule)` covering any `selected-at`/`substr`/`regex`/`number` extraction over a capture-later source. Reproducer: malaria-itn-app/20260529-1124 Phase 3 (fixed in-phase via one `/nova:edit`). | ACE team |
