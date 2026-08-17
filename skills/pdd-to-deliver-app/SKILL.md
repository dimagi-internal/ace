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
   - **State the marker MECHANISM: a Deliver app must carry an APP-LEVEL
     Connect mode of `deliver` — set via
     `configure_connect({app_id, mode: "deliver", participants})` — AND
     every paid form must carry a `connect.deliver_unit` block.** The
     app-level mode is what makes Nova's compiler emit the
     `<learn:deliver>` marker into the released CCZ. **Leaving the app
     with no Connect mode ships a marker-less CCZ even when each form
     already has a `connect.deliver_unit` block** — Connect surfaces zero
     deliver units → Phase 4 cannot create a payment unit. Per form, set
     `connect.deliver_unit: {name, id, entity_id, entity_name}` — via the
     `participants[]` entry on `configure_connect`, or via
     `update_form({moduleUuid, formUuid, connect})` after build; the form
     stays `type: registration` — there is no special deliver form type.
     This mirrors the Learn app, which compiles its `learn_module` /
     `assessment` markers because its app-level mode is `learn`. Name
     `mode: "deliver"` explicitly in the brief so the architect sets it as
     part of the build, not as an afterthought.
     - **Do NOT** tell the architect the marker is "module-level" via
       `module_type` / `add_module`, and do NOT let the app land with no
       Connect mode. Live Nova `update_module` accepts only `name` (no
       `module_type`); there is no `add_module` tool (it is
       `create_module`, which has no Connect parameter). A brief that
       frames the marker as module-level leads the architect to leave the
       app-level mode unset and ship a marker-less CCZ — the root cause of
       the `malaria-rdt/20260603-1600` Phase 3 halt.
     - **`update_app` no longer carries `connect_type`** — it was removed
       in Nova's 2026-07-31 redeploy (dimagi-internal/ace#1133) and
       `update_app({name, app_id})` now sets the display name only.
       `configure_connect` is the ONLY path to the app-level mode, and it
       is **REPLACE-ALL**: every form omitted from `participants[]` has
       its Connect block CLEARED. See Step 4e.
     - **The `get_app` / `get_form` `[Connect enabled]` flag is a FALSE
       POSITIVE for compile** — it shows whenever a form carries a
       `connect.deliver_unit` block, even when `connect_type: ""` means the
       marker will NOT compile. Never treat `[Connect enabled]` as evidence
       the marker shipped; verify against the compiled CCZ
       (`connect_markers.deliver ≥ 1`, see Step 4e + `app-release-qa`).
     > For the mechanism rationale + the controlled malaria-rdt disproof,
     > see reference.md § Marker mechanism.
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

     A single `/data/...` field path as `entity_id` is install-safe
     (form fields resolve at `xforms-ready`) and `validate_app`-clean
     (it's a real form reference).

     **No component of `entity_id` may be free `text` where the option set is
     enumerable.** The business key is only as good as the fields it
     concatenates: an editable free-text component means one typo mints a
     SECOND payable delivery for the same real-world event, and two distinct
     entities that share a name collapse into one. Every key component that
     names a place, facility, community, or roster member MUST be a
     lookup- or inline-backed select — see
     `_app-component-library.md § structured-capture` § option sources for the
     `get_lookup_tables` + `set_field_options_source` recipe. If a key
     component genuinely cannot be made a select this run, say so in the build
     memo next to the `entity_id` you shipped; do not ship it silently.
     (Reproducer: `spark-facilitator/20260731-0656` — free-text `village`
     forced a mid-run repoint of the key from `village + date_of_meeting` to
     `community_id`, which was ALSO free text, so only the name-collision mode
     closed. ace#1136.)

     > For the 6-app deployed-practice audit that grounds this rule, see reference.md § entity_id business key.

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
     > `entity_id` to reference that field and `entity_name` to the
     > human-readable label field. Both are structured expressions, NOT
     > XPath strings — each takes `{ parts: [...] }`, where a part is
     > `{ kind: "field-ref", uuid: <field uuid> }`,
     > `{ kind: "user-ref", property: "username" }`, or
     > `{ kind: "text", text }`. (`{ kind: "case-ref", caseType,
     > property }` is in the schema but is REJECTED app-wide on this Nova
     > instance — never author one; see the case-UPDATE rule below.) So
     > `entity_id: { parts: [{ kind: "field-ref", uuid: <entity_key uuid> }] }`
     > and
     > `entity_name: { parts: [{ kind: "field-ref", uuid: <beneficiary_name uuid> }] }`.
     >
     > **`parts` is XPath SOURCE, not a template — it does NOT concatenate
     > for you.** Every part is interpolated RAW into the compiled
     > `calculate`, and nothing quotes a `text` part. A bare
     > `{ kind: "text", text: " - " }` sitting between two references
     > therefore compiles to the XPath **minus operator**, and the key
     > evaluates to `NaN` — the same constant for every worker, so Connect
     > collapses the whole programme into ONE payable entity and everyone
     > after the first goes unpaid. `configure_connect` accepts that
     > payload with no error and the app builds clean; the only symptom is
     > unpaid work (ace#1232, proven against a compiled CCZ). **Any
     > literal separator MUST be quoted inside a `concat(...)` you write
     > yourself, in the parts list:**
     >
     > ```
     > parts: [ { kind: "text",     text: "concat(" },
     >          { kind: "user-ref", property: "username" },
     >          { kind: "text",     text: ", ' - ', " },
     >          { kind: "field-ref", uuid: <date field uuid> },
     >          { kind: "text",     text: ")" } ]
     > ```
     >
     > That verbosity is the only correct form, not defensive style —
     > "simplifying" it back to a bare `" - "` separator silently breaks
     > the payment key. The hidden-`entity_key`-field shape below sidesteps
     > the trap entirely: build the `concat(...)` in the field's own
     > `calculate`, then point `entity_id` at ONE `field-ref` part.
     >
     > Example for a malaria RDT outlet visit whose dedup key is
     > (outlet, brand, batch): `entity_key` =
     > `concat(/data/outlet_name, ' - ', /data/rdt_brand,
     > ' - ', /data/batch_number)`. **Build the composite inside
     > `concat(...)`, as shown — do NOT express it as alternating
     > reference and `{ kind: "text", text: " - " }` parts.** An earlier
     > version of this section offered that shape as an equivalent, on a
     > since-disproven claim that `parts` joins its members for you; it
     > does not. (The two statements contradicted each other between
     > ace#1230 and ace#969; the live-derived rule above wins.) The
     > hidden `entity_key` calculate
     > field is preferred for a second reason too — persisting the key
     > as form data is what lets case-UPDATE forms read the same grain
     > back (see below). Do NOT use `/data/case/@case_id`
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
     > every form MUST emit the IDENTICAL `entity_id` grain — and on the
     > followup forms that grain **MUST NOT depend on reading the case
     > back into a form node.** There is no mechanism on this Nova
     > instance that a brief can reliably ask for to get a case property
     > into a followup form's field. All three surfaces are closed, each
     > proven live:
     >
     > - **`case-ref` parts are rejected app-wide.** A followup form's
     >   `case-ref` to its OWN case type fails with "This expression does
     >   not survive Nova's canonical identity parse and print round
     >   trip" across every expression shape and slot, so a brief
     >   mandating one is **unbuildable** (ace#1180 /
     >   `commcare-nova#458`).
     > - **`caseWrite` is write-only — it does not preload.** A hidden
     >   field carrying `caseWrite` plus a literal `default_value` looks
     >   like a preload and is not one: it holds the literal and then
     >   writes that literal back, wiping the case property (ace#1224).
     >   Step 4h below halts on this shape.
     > - **A visible case-bound field does NOT emit a preload either.**
     >   Proven against a compiled CCZ: the bind is there, the value
     >   never is (ace#1232).
     >
     > (One shape HAS been observed working — a hidden field populated by
     > a casedb `<setvalue event="xforms-ready">` that Nova emitted on its
     > own, `bednet-check-2-visit/20260813-2333`. Do not build on it: it
     > is not requestable from the authoring surface, and it is correct
     > there only because that `setvalue` happened to be emitted AFTER the
     > empty-string initializer for the same node. One emission-order
     > change and every worker silently goes unpaid, with no build,
     > validate, or `play` error. It is not a sanctioned mechanism.)
     >
     > **Sanctioned alternative — key on worker identity + the encounter
     > date.** In the common ACE shape the FLW maps 1:1 to the entity
     > (one facilitator per CBF, one worker per assigned household), so
     > the worker IS the entity referent and no case read is needed:
     >
     > ```
     > entity_id.parts = [ { kind: "text",      text: "concat(" },
     >                     { kind: "user-ref",  property: "username" },
     >                     { kind: "text",      text: ", ' - ', " },
     >                     { kind: "field-ref", uuid: <encounter date uuid> },
     >                     { kind: "text",      text: ")" } ]
     > ```
     >
     > Note the quoted separator inside an explicit `concat(...)` — a
     > bare `{ text: " - " }` part is XPath subtraction and yields `NaN`
     > (see the parts-is-XPath-source rule above). Add the payability
     > discriminator, and any finer per-encounter component, INSIDE the
     > same `concat(...)`. `entity_name` follows the same construction
     > over the human-readable fields.
     >
     > **When the FLW does NOT map 1:1 to the entity** (one worker serves
     > many households/outlets), worker identity alone collapses them.
     > Then re-ASK the identifying key component on the followup form as
     > a **select** over the same option source the create form used
     > (`_app-component-library.md § structured-capture`) and reference it
     > with an ordinary `field-ref` — an answered field, not a case read.
     > If neither shape fits, say so in the build memo next to the
     > `entity_id` you shipped; do not ship a key that silently depends on
     > a case read.
     >
     > Still NOT the case id, in either form: `/data/case/@case_id` is
     > rejected by `validate_app` (the case block is not a blueprint
     > field) and `#case/case_id` compiles to a casedb lookup that breaks
     > create-form install and is the wrong dedup grain anyway (a
     > per-registration UUID gives no cross-registration / cross-FLW
     > dedup).
     >
     > Caveat that still applies: a per-form suffix must go **inside**
     > `concat(...)`, never as a bare
     > `{ kind: "text", text: " - <form_name>" }` part between two
     > references.
     >
     > Re-open the case-read path only once `commcare-nova#458` (#1180)
     > is fixed AND a preload is re-verified against a live compiled CCZ —
     > not against the blueprint, which shows the bind either way.

     **Payability-scoped keys** (any form where SOME submissions are not
     paid work):

     > REQUIRED: When the PDD marks a SUBSET of submissions to this form
     > **non-payable** — a did-not-happen branch, a screening-only
     > visit, an ineligible-household record, a committee meeting on a
     > form that also records community meetings — the **payability
     > discriminator MUST be a component of `entity_id`.**
     >
     > Derive the key from the PDD's **paid-unit definition**, not only
     > from its `duplicate-detection-key` identity fields. The key must
     > be unique per *payable* event, so that a non-payable submission
     > occupies a DIFFERENT key space and cannot consume the payable
     > one. An identity-only key on such a form means the FLW's
     > non-payable submission mints the key first, the real payable
     > visit dedups against it, and the worker is structurally blocked
     > from being paid for work they actually did — while the form's own
     > closing text often tells them to record both.
     >
     > Put the discriminator **inside** the `concat(...)`, never as an
     > extra `parts[]` entry (caveat (ii) above). A dedup key of
     > (community, date) on a form that records both committee and
     > community meetings becomes
     > `concat(/data/community_code, '-', /data/meeting_date, '-', /data/meeting_type)`.
     >
     > The discriminator is now a key component, so the "no free `text`
     > where the option set is enumerable" rule above applies to it: it
     > MUST be a select. On the CASE-UPDATE path the discriminator must
     > be answered on THIS form — an ordinary `field-ref` to the form's
     > own select. Do NOT reach for the entity's stored copy: a followup
     > form cannot read its own case (see the case-UPDATE rule above), so
     > a discriminator that "comes off the case" ships as a constant.
     >
     > If the PDD's non-payable set cannot be expressed as a form field
     > at all, do NOT ship the identity-only key silently — record in
     > the build memo that non-payable submissions share the payable key
     > space, and name the field that would fix it.
     >
     > Scope note: this closes the *slot-consumption* mode. A non-payable
     > record still mints a CompletedWork on its own key until Layer A
     > verification rejects it — the `deliver_unit` marker itself carries
     > no relevance condition, which is upstream of ACE. (ace#969.)

     > For the upstream-validator note + the history of why the case id was abandoned, see reference.md § entity_id business key.

   - **REQUIRED — Architect must verify-then-retry every `add_fields`
     call.** Nova's `add_fields` has a partial-persistence quirk: a
     single call with N items often persists only the first few; a
     skipped verification ships forms that look complete in the build
     summary but render with missing questions in the actual app.
     Insert this paragraph **verbatim** into the brief, in its
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

     > For the full failure analysis, see reference.md § add_fields partial persistence.

     Also insert this paragraph verbatim into the brief
     (dimagi-internal/ace#1181):

     > REQUIRED: Nova tool payloads are truncated in transport before
     > the tool sees them, surfacing as `InputValidationError: could
     > not be parsed as JSON` — the JSON is well-formed, it was cut
     > mid-string, and the threshold is NOT a clean size check (first
     > seen near 5 KB, then reproduced at 1.9 KB), so no field count is
     > derivable from bytes. Batch `add_fields` at **~5 fields per
     > call** from the start (commcare-nova#459) — a conservative floor
     > proven safe, not a computed limit. Do NOT debug the payload's
     > quoting when you see that error — shrink the batch. The
     > verify-then-retry rule above still applies to every batch.

   - **REQUIRED — Deployability (fitness) components.** A faithful
     transcription of the PDD's field list is NOT a deployable
     instrument. `pdd-to-deliver-app-eval`'s fitness axis (55% weight)
     **hard-fails** the build on each gap below; the build must emit the
     applicable components so the instrument is field-reliable, not just
     structurally complete.

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
     - `structured-capture` — any answer with an enumerable option set, **any
       field the PDD spells `select` / `lookup` / "choose from" / "from the
       registered X", and any field that feeds a Connect `entity_id`.** A
       PDD-declared select that ships as free `text` is a DEFECT, not a
       degradation: the architect must call `get_lookup_tables` and bind the
       option set with `set_field_options_source` (lookup- or inline-backed)
       rather than falling through to `kind: text`, and any degradation that
       does happen must be named in the build memo. Verified at level 0 by
       Step 4f (ace#1136).
     - `section-timestamps` — PDD success metrics reference visit-time / a
       cost model.
     - `embedded-bc-script` — PDD specifies a verbatim behavior-change
       segment.
     - `app-language-layer` — PDD names a working language other than
       English (Deliver variant). Build the ENTIRE app in English first —
       English is the source language and stays the runtime default —
       then, as the **LAST** build step, add the working language
       (`add_language(copyFrom: 'en')`) and author real translations via
       `update_translations`, echoing each unit's `sourceFingerprint`.
       Translating before the English is final is the failure mode: any
       later edit silently reverts that string to English
       (`out-of-date`). Confirm `out-of-date` is 0 via `get_languages`
       before hand-off. Never stack languages inline. (Standing decision
       2026-08-17, PR #1463, superseding ace#968/#1391 — Nova shipped the channel; see
       `_app-component-library.md § app-language-layer` for the proven
       contract.) Graded by `language_conformance`.
     - `deliver-app-naming` — always. App name must contain "Deliver app".
     - `live-photo-capture` — any image/photo capture question. Appearance
       Attribute set to `acquire` (live camera, never gallery-browse).
     - `no-section-module-language` — always. No user-facing "section" or
       "module" wording anywhere.
     - `connect-supported-capabilities-only` — always. Use only capabilities
       that work WITHOUT an HQ feature flag; `commcare_connect` is the sole
       exception. **Most concretely: do NOT add case-search inputs** — a case
       LIST needs no flag, while a case SEARCH requires `search_claim` and
       fuzzy/advanced matching additionally requires `case_search_advanced`,
       and BOTH are `TAG_FROZEN` in HQ ("do not add new projects to this
       list"), so the build cannot ship as designed rather than merely waiting
       on provisioning (ace#1195).
     - `grid-menu-display` — always (Learn + Deliver). Modules and Forms
       Menu Display set to "Grid".
     - `observable-before-derived` — any visit/encounter form with an
       outcome / disposition / status field. Ask observations in
       real-world order; COMPUTE the outcome. A user-facing outcome
       question placed before its own inputs is a defect (ace#979).
     - `constraint-locality` — always, for any form with constraints. A
       constraint must be fixable on the screen where it fires; it may
       reference only `.` or same-repeat siblings (ace#980).
     - `screen-grouping` — always, for any form that puts more than one
       question in a `group`. A group is a CommCare field-list, so its children
       share ONE scrollable screen. Multiple questions per screen is GOOD
       design — this is **not** a one-question-per-screen rule — but group by a
       shared rule (one recall period, one answer source), split when that rule
       changes, never nest a `repeat` inside a group, and keep a long read-aloud
       passage on the screen carrying the answer it governs. Verified at level 0
       by Step 4g.
     - `consent-script-floor` — **always-on for capture of identifiable
       people, on exactly the same condition as `live-photo-capture`: any
       image / photo / audio / video capture question of people fires this
       component ON ITS OWN.** No consent field, no read-aloud passage, and
       no mention of consent anywhere in the PDD is required — a PDD that is
       *silent* about consent fires it just as hard as one that describes
       consent being sought. A photo question that needs `acquire` is
       categorically also a photo question that needs the floor; evaluate the
       two off the same detection and emit both. (It also fires on the other
       clauses in the component: a read-aloud announcement to an assembled
       group, a verbal consent taught in the Learn app, or a photo-consent
       line inside a behavior-change script.) **Do not reason "the PDD
       doesn't mention consent, so the trigger doesn't fire"** — that is
       exactly the miss that shipped 0-of-6 elements on an app photographing
       8+ identifiable people into an AI verification layer plus a human
       audit sample (`spark-facilitator/20260812-1635`, ace#1223; the prior
       run of the same opp shipped 4/6, so this has now missed twice).
       All six floor elements — and check `confidential`, where the
       data goes (name any AI verification layer and human audit sample), and
       that participation does not guarantee selection **by name**, because
       those three are the ones builds actually omit (ace#983, ace#1137).
       This is a build-time authoring rule; `pdd-to-deliver-app-eval §
       consent_floor` is the backstop, not the place to discover it. When this
       fires alongside `embedded-bc-script` on the same read-aloud passage,
       BOTH are emitted and this one governs the content.
     - `threshold-coherence-flag` — PDD fixes ≥2 numbers constraining one
       physical quantity. Check the pairs, surface conflicts in the build
       memo (ace#984).

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
    most likely.)

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
       - Module "CBF Registration" [uuid b60055c1-…] (case_type: cbf)
         - Form "CBF Registration" [uuid c3deb000-…] (registration, 12 fields)
           - community_id [uuid c3df54f7-…] (text)
       ```

       Build `uuids[module][form] -> {moduleUuid, formUuid}` (and the
       per-field uuids) from this ONE response and carry it through the
       rest of the recipe — Steps 4b–4h all address off this map. One
       lookup beats N. If you only hold a semantic name later,
       `search_blueprint({query, app_id})` resolves it — but prefer the
       map you already have.

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

    > For why this runs even though `validate_app` catches some shortfalls downstream, see reference.md § Step 4a safety net.

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
    upstream Nova bug that necessitates this.

4c. **Case write-back verification (follow-up forms must persist
    observations).** The structural preventer for case-update forms that
    capture observations but write zero case properties (losing what they
    observed). `pdd-to-deliver-app-eval § case_persistence` hard-gates
    this at ≤2; this step catches it at build time. Cheap; runs on the
    already-fetched blueprint. Same bounded-loop shape as 4a/4b.

    1. From `get_app({app_id})`, identify each **case-UPDATE** form (a
       form Nova tagged as updating an existing case type rather than
       creating one — it carries `case_property_on` writes against a case
       type some other form creates).
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
    (`add_case_list_columns`, `set_case_list_filter`,
    `update_case_list_column`, `remove_case_list_column`,
    `reorder_case_list_columns`, `set_case_search_display`,
    `set_case_search_advanced`, `add_search_inputs`, …) is **not present
    in the autonomous architect's tool allowlist**. It will try
    `generate_schema`, a fresh `create_module`, and promoting
    `case_name` to a visible field — none of which auto-seeds the
    default column — and report it cannot reach validate-clean.

    These case-list-config atoms ARE available to the level-0 Claude
    Code session that executes this skill, so the heal is a
    deterministic L0 operation: run it here, after the autonomous build
    returns, rather than asking the architect to do something its tools
    can't.
    > For why this step lives at level 0 (not the architect brief) + the upstream allowlist gap (jjackson/ace#632), see reference.md § Step 4d level-0 heal.

    Cheap; runs on the already-fetched blueprint. Same bounded-loop
    shape as 4a/4b/4c.

    Note: Nova's `validate_app` is architect-side only — it is NOT
    exposed at the L0/user tool surface (nova@nova-marketplace 1.1.0;
    jjackson/ace#821), so this recipe inspects the blueprint directly
    instead of asking the validator.

    1. From the already-fetched `get_app({app_id})` blueprint, identify
       every **case-CREATE** module, and for each one call
       `get_module({app_id, moduleUuid})` — the `moduleUuid` comes from
       the Step 4a step-2 addressing map — to confirm its case type and
       whether its case list is empty (`case_list_config: null` /
       missing `caseListConfig.columns`). If every case-create module
       already carries a non-empty case list — or the app has no
       case-create modules — skip the rest of this step; there is
       nothing to heal.
    2. For each offending module, call
       `add_case_list_columns({app_id, moduleUuid, ...})` to add ONE
       plain column over the case name field (the module's `case_name` /
       case-name field). A single default column is sufficient to clear
       the architect-side validate error; this is the same one-column
       heal an operator applies by hand.
    3. Re-fetch via `get_module({app_id, moduleUuid})` and re-assert
       the case list is now non-empty. **Bounded loop, max 3
       iterations** over steps 1–3. If any case-create module still has
       an empty `caseListConfig.columns` after the third iteration,
       surface a clear failure naming each module still missing its
       case-list column, and do NOT write the success summary.

    (Apps with no case-CREATE module, or whose case-create modules
    already carry a non-empty case list, skip cleanly at step 1.)

    **CAUTION — this heal can author a case list nobody can reach
    (dimagi-internal/ace#977).** On a REGISTRATION-ONLY module the entry's
    only session datum is `function="uuid()"`, so no entity-selection screen
    is ever pushed and the column set added here is dead configuration —
    satisfying `validate_app` while producing a list no worker can ever see.
    `app-release-qa` Step 4 blocks that shape (`case-list-unreachable`) —
    but only when the case type is unreachable **app-wide** (ace#1281). If a
    sibling module opens the same case type behind a real entity datum, the
    inert detail on the registration module is `[INFO]`, not a blocker, because
    Nova **refuses** to remove the last visible Results column from a module
    that declares a case type ("Every case list needs at least one visible
    Results field… Nothing was changed") — the shape is unavoidable and must
    not be healed here.

    So when a case-CREATE module has no case list, ask FIRST whether the
    module is genuinely registration-only **and whether any other module opens
    that case type**. If nothing does, the right resolution is to add the
    followup form the PDD implies — **not** to add a column to clear the
    validator. This is Jon's blueprint invariant from 2026-07-28: a module that
    declares a case type + case list should have some form that actually opens
    a case.

4e. **Deliver-marker compile pre-check (catch a missing app-level Connect
    type before deploy) — runs at LEVEL 0.** Mirror of
    `pdd-to-learn-app` § 4b. The autonomous architect
    (`Agent(nova:nova-architect-autonomous)`) can land a Deliver app with
    **no app-level Connect mode** even though every form already carries
    its `connect.deliver_unit` block. The per-form `[Connect enabled]`
    flag is a **FALSE POSITIVE for compile**: with no app-level mode the
    released CCZ ships with ZERO `<learn:deliver>` markers, Connect
    surfaces zero deliver units, and Phase 4 fails at payment-unit
    creation. `app-release-qa` (Phase 3 Step 2.8) catches it
    post-release, but that is a full deploy→build→release cycle too late
    — assert it here, cheaply, on the already-built app.

    1. Call `get_app({app_id})`. Its summary header prints the app's
       Connect type (e.g. `Connect type: deliver` / `Connect type:
       learn`); a standard app prints none. **Keep this response** — you
       need its complete form list and `[uuid …]` markers for step 3.
    2. **Assert the header reads `Connect type: deliver`.** Do NOT rely
       on the per-form `[Connect enabled]` flag — it is a false positive
       for compile (see above, and Step 3's marker-mechanism bullet).
    3. On a miss, heal at LEVEL 0 with **`configure_connect`**, which is
       available to the level-0 session that executes this skill.
       `update_app` no longer carries `connect_type` — it was removed in
       Nova's 2026-07-31 redeploy (dimagi-internal/ace#1133);
       `configure_connect` replaced it and sets the app-level mode AND
       every form's Connect block in one atomic call.

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
         mode: "deliver",
         participants: [
           // EVERY paid form in the app, addressed by formUuid.
           { formUuid: "<paid form uuid>",
             connect: { deliver_unit: { name, entity_id, entity_name } } },
           …
         ]
       })
       ```

       Note the **structured expression shape** — `entity_id` /
       `entity_name` (like `label`, `relevant`, `calculate`,
       `default_value`) take `{parts: [...]}`, not a plain XPath string;
       a bare string is rejected. Omit each block's `id` and let Nova
       derive it.

       Then re-run `get_app` and re-assert BOTH the header and that every
       form that carried a Connect block before still carries one.
       **Bounded loop, max 3 iterations.** The per-form
       `connect.deliver_unit` blocks the architect already built stay
       intact, so the marker compiles on the next deploy with **no
       rebuild and no fresh app id**. If the header still does not read
       `Connect type: deliver` after the third attempt (or
       `configure_connect` is itself unavailable), halt with a clear
       `deliver-marker-wont-compile` failure and do NOT write the success
       summary.

    Use `update_form({moduleUuid, formUuid, connect})` **only** to refine
    one sub-config on a form that ALREADY participates — it cannot enable
    Connect, switch mode, or add a participant, and it refuses a
    whole-slot null. Full division of labour:
    `playbook/integrations/nova-integration.md § configure_connect
    replaced update_app({connect_type})`.

    Reproducer: `malaria-rdt/20260603-1600` — the Deliver app landed with
    no app-level Connect mode; both the original and a fresh
    re-upload+re-release produced `connect_markers.deliver = 0` (that
    session predated the L0 heal and fell back to a rebuild, blocked by a
    concurrent Nova `create_app` outage). See jjackson/ace#694. The L0
    heal in step 3 above was confirmed live on
    `bednet-spot-check/20260616-0618` — one call flipped the header from
    absent to `Connect type: deliver` with the per-form blocks intact, no
    rebuild. See jjackson/ace#792. (That heal was
    `update_app({connect_type: "deliver"})` at the time; the parameter was
    removed 2026-07-31 and `configure_connect` is now the only path —
    dimagi-internal/ace#1133.)

4f. **Option-source pre-check (PDD-declared selects must not ship as free
    text).** The structural preventer for ace#1136. `structured-capture` puts
    the rule in the architect brief; this step is the level-0 safety net for
    when the architect had no option list in front of it and fell through to
    `kind: text` anyway — the exact failure mode of
    `spark-facilitator/20260731-0656`, where four of five PDD-declared
    select/lookup fields shipped as free text and only the one with an
    inline-enumerable option set survived. Cheap; runs on the already-fetched
    blueprint. Same bounded-loop shape as 4a–4e.

    1. **Build the declared-select list from the PDD** (not from the brief and
       not from the architect's return string). Every field in the Deliver App
       Specification whose spec text contains `select`, `lookup`,
       `choose from`, `pick from`, or `from the registered …` goes on the list,
       plus every field named as a component of a `connect.deliver_unit`
       `entity_id`.
    2. **Resolve each one in the built app.** Nova is uuid-addressed — one
       `search_blueprint({query: '<field id>', app_id})` per field returns
       `{moduleUuid, formUuid, fieldUuid}` and the field's context; or read
       them off the `get_form` responses already fetched in Step 4a.
    3. **Assert** each declared-select field's `kind` is `single_select` or
       `multi_select`. Collect the offenders as
       `degraded[] = {field_id, declared_as, shipped_kind, feeds_entity_id}`.
    4. **If `degraded` is empty, proceed to Step 5.** Nothing to do.
    5. **For each offender, try to bind a real option source before accepting
       the degradation.** Call `get_lookup_tables({app_id})` ONCE — it lists
       this app Project's data tables and their columns with the stable ids
       `set_field_options_source` needs — then, per offender:
       - **A table holds the option set** → convert the field and bind it:
         `set_field_options_source({app_id, moduleUuid, formUuid, fieldUuid,
         source: {kind: 'lookup', tableId, valueColumnId, labelColumnId}})`.
         The call is an atomic REPLACE of the field's complete choice source
         (there is no retained inactive source), so send the whole thing.
         Convert a `text` field to a select first via
         `edit_field({app_id, moduleUuid, formUuid, fieldUuid, updates:
         {kind: 'single_select', optionsSource: {...}}})` — a kind conversion
         that would set saved case values aside returns `needsConfirmation`;
         on a fresh build there is nothing to set aside, so re-call with
         `confirmConversion: true`.
       - **No table, but the set is knowable** from the PDD / inputs / a source
         `.ccz` → bind it inline:
         `source: {kind: 'inline', options: [{value, label: {parts: [{kind:
         'text', text}]}}, …]}` (≥2 options).
       - **Neither** → ship a select over the values you DO have plus an
         explicit "Other" with a relevance-gated `_other` free-text follow-up.
    6. **Re-run steps 2–3. Bounded loop, max 3 iterations.**
    7. **Whatever survives is a NAMED gap, never a silent one.** Any field
       still on `degraded` after the third iteration MUST appear in the build
       memo and in the Step 7 summary's `option_source_gaps` list, with the
       field id, what the PDD declared, what shipped, and the exact table +
       value column + label column that needs to exist before go-live.
       **Halt** — do not write the success summary — if any still-degraded
       field `feeds_entity_id` **on a PAYABLE deliver unit**: a free-text
       component of Connect's dedup / payment grain is a payment-correctness
       defect, not a data-quality one (one typo mints a second payable
       delivery; two same-named entities collapse into one). Everything else
       records and proceeds.

       **Two exemptions, both from the halt's own rationale (ace#1295).**
       The rationale is payment correctness, so it does not reach a case where
       payment cannot be affected, and the escape ladder in step 5 has no rung
       that fits a field which is not enumerable in principle:

       - **The deliver unit is UNPAID.** A form the PDD declares not payable
         carries no payment unit (`app-connect-coverage § Step 2` decides
         payability by role — ace#1327), so neither failure mode exists.
         Record the gap in `option_source_gaps` and proceed.
       - **The component is non-enumerable BY NATURE** — a personal name, a
         free-text identifier, anything captured at the moment the entity
         first enters the system. On a registration form there is no roster to
         select from: no lookup table can exist, inline enumeration is
         impossible for an open-ended name, and "the values you DO have plus
         Other" is nonsense for a name field. `concat(username,
         hh_head_name, visit_date)` is the STANDARD registration-key shape,
         not a degradation.

       Both exemptions must be **stated in the build memo with the reason**,
       never taken silently — and when the unit is payable, a non-enumerable
       component still halts. Live false-halt:
       `bednet-check-2-visit/20260813-2313`, Deliver app `74a097c6`, where
       both exemptions applied at once.

    (Apps whose PDD declares no select/lookup fields skip cleanly at step 1.)

4g. **Screen-shape check (a group is a field-list — catch the wall BEFORE
    deploy).** The structural preventer for the `screen-grouping` component.
    A Nova `kind: group` compiles to a CommCare **field-list**, so every child
    renders on ONE scrollable screen. Grouping questions that belong together
    is correct and expected; the defect is a group that has become a wall, and
    until this step existed nothing in Phase 3 looked at screen composition at
    all. Cheap; runs on the already-fetched blueprint. Same bounded-loop shape
    as 4a–4f.

    **Position rationale — this MUST run before `app-deploy`.** On
    hh-poverty-targeting/20260812-2034 the shape (all ten PPI indicators plus
    the roster repeat on one screen) was not noticed until `app-test-cases`
    tried to author the smoke recipe against it — two steps later, with the app
    already uploaded. Fixing it there cost a re-upload, a fresh HQ app id and an
    orphan app to soft-delete. Had Phase 4 already run it would have cost a
    delete-and-recreate of the Connect opportunity
    (`connect_create_opportunity` writes HQ app ids at create time and
    Connect's edit form does not expose them). Here the same fix is free.

    1. From the `get_app` / `get_form` responses already fetched in Step 4a,
       build the form's field tree with each field's `id`, `kind`, flattened
       `label` text, and `children` for groups/repeats.
    2. Feed it to the pure helper — do NOT eyeball the counts:

       ```ts
       import { checkScreenShape, formatScreenShapeReport }
         from '../../lib/screen-shape';
       const report = checkScreenShape(fields);
       ```

    3. Branch on the findings:
       - `severity: 'violation'` on `oversized-screen` → **split that group**
         into sets that share a rule, via `add_fields` (new group containers)
         + `move_field`. **Create each new container carrying the SAME
         `relevant` the original group had, BEFORE moving any field into it** —
         a field moved out of a gated group to an ungated one silently loses
         its gating, which is a correctness defect far worse than the scroll
         length you came to fix.
       - `severity: 'violation'` on `repeat-in-field-list` → `move_field` the
         repeat to the form root, or into a group of its own.
       - `severity: 'warn'` → keep the grouping only if the questions are one
         coherent set, and say so in the build memo; otherwise split.
    4. Re-fetch and re-run. **Bounded loop, max 3 iterations.** If a violation
       remains after the third, surface a clear failure naming each offending
       group and do NOT write the success summary.
    5. Record the final `formatScreenShapeReport(...)` line in the build memo,
       plus one sentence per surviving `warn` justifying the grouping.

    (Forms with no multi-question group skip cleanly — `screensChecked: 0`.)

4h. **Taught-vs-collectable cross-check (dimagi-internal/ace#1259).** Runs
    ONLY when the Learn app for this run already exists (it is built first in
    Phase 3; if you are building Deliver standalone, skip and say so).

    Nothing in ACE cross-reads the two blueprints: `pdd-to-learn-app` and this
    skill each build from the PDD independently, and each `-eval` grades its
    own app against the PDD in isolation. So a curriculum can instruct a worker
    to perform a step this form cannot record, and every Phase 3 gate passes.
    Live on hh-poverty-targeting/20260813-1612: Learn M8's padlocked-dwelling
    worked example says "you still do all of this… take one photograph… record
    the outcome as vacant", while the only `dwelling_photo` sits in a group
    gated `relevant: consent = 'yes'` — never reached on a vacant visit. At
    their first padlocked dwelling the worker follows the training, takes the
    photo, and finds no screen to attach it to. A human found it by reading the
    two blueprints side by side.

    ```ts
    import { checkTaughtStepsCollectable, formatTaughtVsCollectableReport }
      from '../../lib/taught-vs-collectable';
    const report = checkTaughtStepsCollectable(learnBlueprint, deliverBlueprint);
    ```

    **Do NOT auto-fix.** Which artifact is wrong is a judgement — the Learn app
    may over-teach or this form may under-collect, and BOTH can be
    PDD-conformant at once (they were on that run: §5.1 listed the live
    photograph under "a payable visit requires all of", §5.2 gated the photo
    screen on Consent = yes). Surface each finding in the build memo with both
    sides quoted, and raise it at the Phase 3 pause so a human decides which
    side moves. `report.checked === false` means the curriculum states no
    unconditional evidence step — "not applicable", not "clean".

4h. **Fake-preload check (a hidden `caseWrite` field can never hold the case
    value) — runs at LEVEL 0.** The structural preventer for ace#1224. Because
    a followup form cannot read its own case on this Nova instance (§ `entity_id`
    case-UPDATE rule), architects reach for a shape that *looks* like a preload
    and is not: a hidden field with `caseWrite` set whose value comes from a
    literal `default_value`. It holds the literal forever, and then writes that
    literal **to the case** — so it simultaneously collapses whatever it feeds
    and wipes the case property it names. Nothing fails at build, validate, or
    submit time; every symptom is post-hoc and silent. Cheap; runs on the
    already-fetched blueprint. Same bounded-loop shape as 4a–4g.

    1. From the `get_app` / `get_form` responses already fetched in Step 4a,
       enumerate every field where **all three** hold:
       - `kind == "hidden"`, AND
       - `caseWrite` is set (any case type / property), AND
       - its value comes from a literal `default_value` — i.e. there is no
         `calculate` referencing a real answered field on this form. A
         `default_value` of `''` (or any constant) with no such `calculate`
         is the defect shape.

       Collect them as
       `fake_preloads[] = {field_id, case_type, property, feeds_entity_id,
       guards_relevant[]}`.

    2. **HALT if any of them feeds a `connect.deliver_unit` `entity_id` or
       `entity_name`** — directly as a part, or transitively via a field
       whose `calculate` references it. That is a **payment-correctness**
       defect, not a data-quality one: the key evaluates to the same constant
       for every entity, Connect dedups every delivery into ONE payable
       entity, and every worker after the first goes unpaid while every
       submission succeeds. Do not write the success summary; surface the
       field, the marker it feeds, and the case property it would wipe.

    3. **Also inspect every hidden field referenced by a `relevant`
       expression**, whether or not it feeds a marker. This is how the
       dead-advisory mode surfaces and it is invisible to an entity_id-only
       scan: an advisory gated on `x != ''` where `x` is always `''` can never
       fire, so the guardrail the PDD promised is inert while reading as
       present in the blueprint, the Work Order and the training materials.
       Treat a `relevant` guarding on a fake preload as a violation and fix it
       in the same pass.

    4. **Repair — add a new visible field, never convert in place.** `hidden`
       is a **TERMINAL kind in Nova**: `edit_field` categorically refuses
       hidden→visible, and `confirmConversion: true` does NOT unlock it (that
       flag only covers kind conversions that set saved case values aside).
       So the repair is: add a NEW visible field that captures the value the
       form actually needs (a select over the same option source the create
       form used, per Step 4f), repoint the `entity_id` / `entity_name` parts
       and any `relevant` at the new field, and **neutralise** the old one —
       drop its `caseWrite` so it stops overwriting the case property, or
       `remove_field` it outright if nothing else references it.

       ```
       /nova:edit <app_id> "Field <id> in <module>/<form> is hidden with a
       caseWrite to <case_type>/<property> and a literal default_value, so it
       can never hold the case value and overwrites that property with the
       literal. Add a new VISIBLE field capturing <value> (select over
       <option source>), repoint <entity_id|entity_name|relevant> at it, and
       remove the caseWrite from <id>. Do not attempt to convert <id> to
       visible — hidden is terminal. After the edit, get_form and verify."
       ```

    5. Re-fetch and re-assert. **Bounded loop, max 3 iterations.** Anything
       still on `fake_preloads` after the third iteration goes in the build
       memo and the Step 7 summary by field id, case property, and what it
       feeds — and if it feeds a marker, the step halts per step 2 rather
       than recording.

    (Apps with no hidden `caseWrite` fields skip cleanly at step 1.)

5. **(Optional) Inspect the built app** via `/nova:show <app_id>` to
   cross-check structure against the PDD before writing the summary.

6. **Self-evaluate (LLM-as-Judge):**
   - Does the app structure match the PDD Deliver spec?
   - Is the delivery unit framed correctly for the archetype?
   - Are all Connectify fields configured (Deliver Unit, Entity ID)?
   - Are verification criteria encoded in form questions?
   - Did every field the PDD spelled `select` / `lookup` ship as a select
     with a real option source, and is every remaining gap named (Step 4f)?
   - Does every screen hold a set the worker can hold in view, with no group
     over the ceiling and no `repeat` nested in a field-list (Step 4g), and is
     each surviving `warn` justified in the build memo?
   - Does every node feeding `entity_id` / `entity_name` actually vary per
     worker and per entity — no hidden `caseWrite` fake preload (Step 4h), no
     bare `text` separator between two parts (which compiles to subtraction),
     and no dependency on a followup form reading its own case?
   - If any consent is sought from the people whose data or images are
     captured — spoken or field-gated — does that script carry all six
     `consent-script-floor` elements, `confidential` and where-the-data-goes
     included?

7. **Write the summary** to
   `ACE/<opp-name>/runs/<run-id>/3-commcare/pdd-to-deliver-app_summary.md` with required
   frontmatter:

   ```yaml
   ---
   nova_app_id: <id-returned-by-autobuild>
   # `/build/`, NOT the legacy `/apps/` route, which 404s (ace#1431).
   # Built by `novaAppUrl()` in `lib/nova-url.ts` — the single source.
   nova_app_url: https://commcare.app/build/<id-returned-by-autobuild>
   archetype: <atomic-visit | focus-group | multi-stage>
   delivery_unit: <one-line description matching the PDD>
   option_source_gaps: []   # Step 4f — one entry per PDD-declared select
                            # that still shipped as free text, with the
                            # table + value column + label column it needs.
                            # Empty list is the expected value.
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

### `longitudinal-visits`

Delivery unit = **one FLW visit to one followed entity**, and the entity
is a real case with a life longer than the visit. Structurally this is
CommCare case management as normal — case type, registration form,
follow-up form(s) against a case list — with three requirements the
`atomic-visit` branch does not carry:

1. **The case list must show which visit is due.** Put the entity's
   phase / last-activity / next-due state in the case-list columns (and
   in search inputs where the caseload is large). An FLW who has to open
   a case to discover the next activity will guess instead.
2. **Follow-up forms preload the case state the predicate reads.** Any
   longitudinal fact Layer A depends on must be *on the submitted form*
   to be enforceable downstream — Connect's form-field rules see the
   form, not the case. Preloading is what makes the longitudinal
   predicate expressible at all.
3. **`entity_id` carries entity + sequence position**, per the PDD's
   `payment-unit-entity-id` decision — typically
   `concat(<case_id>, '-', <activity_code>)`. As elsewhere, `entity_id`
   is a **business key, not the case id**: the case id alone pays each
   entity exactly once, ever.

The failure mode to design against is a Deliver app that is
case-managed and a payment predicate that is not — the app tracks the
entity beautifully while Connect pays for any visit at all
(`spark-facilitator/20260813-2126`, ace#1462).

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
- **Nova MCP tools called directly at level 0** (Steps 4a–4h): `get_app`,
  `get_module`, `get_form`, `search_blueprint` (semantic id → uuids in one
  call), `add_case_list_columns`, `edit_field`, `configure_connect`,
  `update_form`, `get_lookup_tables`, `set_field_options_source`. Nova is
  **uuid-addressed** since 2026-07-31 (dimagi-internal/ace#1132) —
  `moduleUuid` / `formUuid` / `fieldUuid`, never indexes; resolve the whole
  map with ONE `get_app({app_id})` at Step 4a and reuse it. The app-level
  Connect mode is set by `configure_connect({app_id, mode, participants})`,
  which is **REPLACE-ALL** (ace#1133) — `update_app` no longer carries
  `connect_type`. Enforced by `test/skills/nova-uuid-addressing.test.ts`.

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
| `option-source-binding` | For each PDD-declared select/lookup field, where did its options come from — a Project data table, an inline enumeration, or a named gap? | Step 4f `option_source_gaps`; `pdd-to-deliver-app-eval § Capture fitness` |

The orchestrator's Phase Write-Back Verifier (`agents/ace-orchestrator.md`
§ Phase Write-Back Contract § Decisions log clause) enforces the
contract; the renderer (`skills/decisions-render`) regenerates the gdoc
at end of every phase.

Each row this skill writes uses `phase: 3-commcare` and
`skill: pdd-to-deliver-app`.
