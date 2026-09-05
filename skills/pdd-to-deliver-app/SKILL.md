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
| Run root | `runs/<run-id>/inputs-manifest.yaml` | the resolver from a PDD-named `[FIXED]` source instrument to the `file_id` of its published file in `inputs/`. Step 4k reads that file — the workbook/PDF itself, never the brief — to check every scoring constant against the source (ace#1527). `inputs[]` lists direct child FILES only, so when the published bundle is a SUBFOLDER of `inputs/` 4k walks the manifest's own recorded `subfolders_not_listed[].folder_id` one level to find it (ace#1648). No `[FIXED]` instrument → 4k skips and says so; a `[FIXED]` instrument whose source cannot be resolved → 4k **HALTS**, never skips. |

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
     > - **~~A visible case-bound field does NOT emit a preload
     >   either.~~ FALSE AS OF 2026-08-29 — Nova emits one for
     >   essentially every field (ace#2006).** ace#1232 proved the
     >   negative against a CCZ compiled at the time; the released
     >   Deliver CCZ of `spark-facilitator/20260828-0703` contains
     >   `<setvalue … value="instance('casedb')/…" event="xforms-ready"/>`
     >   for **35 of its 36 answerable questions** — every one except the
     >   photo upload. Do not rely on this bullet's original claim in
     >   either direction: **assume a visible case-bound field DOES
     >   preload, and check the compiled CCZ.**
     >   *Enforced:* `lib/casedb-preload-audit.ts`, run by
     >   `app-release-qa` § Step 2.9, fails the build on any visible
     >   question answered from the case.
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
       does happen must be named in the build memo. Verified ACE-direct by
       Step 4f (ace#1136).
     - `section-timestamps` — PDD success metrics reference visit-time / a
       cost model.
     - `embedded-bc-script` — PDD specifies a verbatim behavior-change
       segment.
     - `app-language-layer` — PDD names a working language other than
       English (Deliver variant). The brief tells the architect to build
       the app in **English ONLY** and to call no language atom. **ACE
       owns the language layer**, ACE-direct, in Step 4l below — after
       every English-editing step has finished. That split is the fix
       for ace#1556: the architect's operating prompt forbids it saving
       self-generated target text, so a brief that asked it to author
       translations produced a silent no-op (207 units copied, 0
       translated, both targets, on `spark-facilitator/20260820-0817`).
       It also makes translate-LAST structural — the architect's turn is
       over before the language exists. Never stack languages inline.
       (Standing decision 2026-08-17, PR #1463, superseding
       ace#968/#1391; ownership split 2026-08-23, ace#1556 — see
       `_app-component-library.md § app-language-layer` for the proven
       contract and the ACE-direct recipe.) Graded by
       `language_conformance`.
     - `deliver-app-naming` — always. App name must contain "Deliver app".
     - `no-starter-module` — always (Learn + Deliver). Nova's `create_app`
       seeds a placeholder module (top-level menu "Survey" → form "Survey" →
       one text field `question_1` labelled "Question 1"). Emit the component
       so the brief tells the architect to DELETE it, and to report whether it
       was present. Removal is currently architect discretion, and discretion
       is what varies run to run: on `bednet-check-2-visit/20260828-0629` the
       Deliver app shipped with the seed while the Learn app, briefed from the
       same template in the same phase, removed it unprompted. Enforced at
       release by `app-release-qa § Step 4` (ace#1787).
     - `live-photo-capture` — any image/photo capture question, but **do NOT
       put it in the Nova brief**. Nova's authoring surface has no appearance
       control: an `image` field's slots are `id` / `kind` / `label` / `hint` /
       `help` / `required` / `relevant` / `validate` / `calculate` /
       `default_value` / `caseWrite` / `optionsSource`, and none of them is
       `appearance` (`caseWrite.mode` saves a link to the attachment — a
       different thing). The component is real and enforced, just not here: it
       is applied POST-BUILD by `app-hq-settings` § Step 3, which fetches each
       Deliver form's draft XForm (`commcare_get_form_source`), injects
       `appearance="acquire"` onto every image `<upload>`, and patches it back
       (`commcare_patch_xform`) before `app-release`; `app-release-qa` then
       BLOCKER-gates it off the released CCZ form XML as
       `camera-only-appearance-missing`. Briefing it only makes the architect
       search for an atom that does not exist and report a spurious "unmet
       requirement" in the build memo — the one artifact meant to carry REAL
       deviations (dimagi-internal/ace#1640; same defect as ace#1632, which
       hit `grid-menu-display` on bednet-check-2-visit/20260825-1310).
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
     - `grid-menu-display` — always (Learn + Deliver), but **do NOT put it
       in the Nova brief**. Nova's authoring surface exposes no
       menu-display-format control at all: `update_app` sets only the display
       name, `create_module` / `update_module` carry no display-format field,
       `set_menu_media` sets icons and audio labels (Menu ICONS are a different thing and ACE does apply them — `app-media-coverage` at Phase 3 Step 1.7, via this same `set_menu_media`, using Nova's built-in topic/action icon slugs.), and `set_case_list_tile`
       lays out a case LIST, which is a different thing entirely. The
       component is real and enforced, just not here: it is applied
       POST-BUILD by `app-hq-settings` (Phase 3 Step 2.65) via
       `commcare_set_menu_display` + `commcare_set_app_menu_display`, and
       BLOCKER-gated by `app-release-qa` off the released app's raw doc.
       Briefing it made every architect build report a spurious "unmet
       requirement" in the build memo — the one artifact meant to carry REAL
       deviations — and invited the architect to reach for an unrelated atom
       to satisfy the paragraph (dimagi-internal/ace#1632; live on
       bednet-check-2-visit/20260825-1310, where Step 2.65 then applied all
       three fields HQ-side on the first attempt).
     - `observable-before-derived` — any visit/encounter form with an
       outcome / disposition / status field. Ask observations in
       real-world order; COMPUTE the outcome. A user-facing outcome
       question placed before its own inputs is a defect (ace#979).
     - `constraint-locality` — always, for any form with constraints. A
       constraint must be fixable on the screen where it fires; it may
       reference only `.` or same-repeat siblings (ace#980). **Carve-out
       (ace#1560): a MINIMUM-rows gate must be bound OUTSIDE the repeat it
       counts.** A constraint on a node inside a repeat is evaluated per
       repeat INSTANCE, so at zero repetitions it never evaluates — the one
       case the gate exists to catch. `count(/data/roster[…]) >= 1` bound on
       a question INSIDE `/data/roster` is a same-repeat sibling reference,
       satisfies the sentence above exactly, and is dead. Put the minimum on
       a gate question immediately AFTER the repeat. A cap (`count(…) <= 10`)
       is the opposite case and correctly stays inside. Verified at Step 2.8
       by `app-release-qa` over the released binds.
     - `screen-grouping` — always, for any form that puts more than one
       question in a `group`. A group is a CommCare field-list, so its children
       share ONE scrollable screen. Multiple questions per screen is GOOD
       design — this is **not** a one-question-per-screen rule — but group by a
       shared rule (one recall period, one answer source), split when that rule
       changes, never nest a `repeat` inside a group, and keep a long read-aloud
       passage on the screen carrying the answer it governs. Verified ACE-direct
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
     - `fixed-instrument-transcription` — the app digitises a `[FIXED]`
       published instrument whose source file the run's
       `inputs-manifest.yaml` names. Transcribe every constant exactly;
       verified ACE-direct by Step 4k (ace#1527).
     - `entity-state-taxonomy` — **always for `archetype:
       longitudinal-visits`**, and for any archetype whose PDD declares a
       phase / stage / status vocabulary the worker sees. Carry the PDD's
       `program_parameters.entity_state_taxonomy` into the brief
       **verbatim** — every state value with its label and its member
       activity/step range — and where that row names a source document,
       read THAT document out of the run's frozen `inputs/` (resolved via
       `inputs-manifest.yaml`) rather than enumerating from the PDD's
       summary table. Parse the row with `parseStateTaxonomy` from
       `lib/entity-state-taxonomy.ts` BEFORE composing the brief:
       `declared: false`, or a non-empty `problems`, is a **HALT** with a
       Phase-1 finding, never a licence to invent a vocabulary. Verified
       ACE-direct by Step 4l (ace#1564).

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

4d. **Case-list column heal — runs ACE-DIRECT (deterministic preventer
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

    These case-list-config atoms ARE available to the ACE session
    Code session that executes this skill, so the heal is a
    deterministic L0 operation: run it here, after the autonomous build
    returns, rather than asking the architect to do something its tools
    can't.
    > For why this step lives ACE-direct (not the architect brief) + the upstream allowlist gap (jjackson/ace#632), see reference.md § Step 4d ACE-direct heal.

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
    type before deploy) — runs ACE-DIRECT.** Mirror of
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
    3. On a miss, heal ACE-direct with **`configure_connect`**, which is
       available to the ACE session that executes this skill.
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
    the rule in the architect brief; this step is the ACE-direct safety net for
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

         **Neither rung is available when the PDD names a partner register for
         this field (ace#1621).** Both invent vocabulary — the inline rung by
         enumerating a set the architect composed, the Other rung by shipping a
         partial set as if it were the register — and "knowable from the PDD /
         inputs / a source `.ccz`" is precisely the case where the real values
         exist and must be read rather than composed. Go to the register halt
         in step 7.
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

       **A SECOND halt class: a PDD-named partner register (ace#1621).**
       The halt above is scoped to payment correctness, so it is silent on the
       other way a degraded select does damage — shipping ACE's invented words
       as the PARTNER's taxonomy. When the PDD sources a field's options from a
       named register (`<field> from <tag> [source: …] [filtered by …]` in
       § Program Parameters), **an inline invented option list is a HALT**,
       whatever the field's `feeds_entity_id` / payability status, and it is
       never dischargeable as a named gap.

       Do not eyeball it and do not re-derive it — run
       `lib/option-register.ts`: `parseRegisterDeclaration` over the PDD row,
       then `diffOptionRegister({declaration, built, registerRows})` over the
       option source read back from the blueprint. Any finding halts; the
       `unbound-register` code is the one that fires here. `declared: false`
       while the field exists is a **Phase-1 gap** (the PDD owes the register),
       reported against Phase 1, not as an architect defect — the build was
       supposed to HALT rather than fill it.

       Source the rows from the partner's own `.ccz` fixture XML via
       `parseFixtureRegister` in preference to a prose structure document: a
       production CCZ carries the register's REAL value codes, which are what
       the app stores and what the partner's M&E joins on, whereas a
       human-readable guide usually carries only labels and forces the build to
       mint an identifier scheme the partner has never seen (the #1527
       "trust extraction first" rule, one layer over).

       **Where ACE cannot finish the job, HALT with the handoff — never
       placeholders.** ACE now builds the table itself: `create_lookup_table`
       takes the columns AND the rows in one atomic write, so the register
       lands in Nova with the partner's real value codes. What is still not
       autonomous is **BINDING** the select to it — `set_field_options_source`
       and `add_fields optionsSource` both refuse a `kind: 'lookup'` source
       ("its Project lookup definitions are unavailable"), every time, on a
       fresh app and a fresh table (`voidcraft-labs/commcare-nova#545`; the
       "retry" wording in that message is wrong — do not loop on it).

       So the terminal behaviour is: extract the register, **create and
       populate the table via `create_lookup_table`**, write the table id +
       column ids and `renderRegisterCsv` output into the run folder as the
       record, and halt naming the ONE remaining operator step — bind the field
       to that table. Before assuming the bind is still blocked, run
       `scripts/probe-nova-fixtures.ts` (via `$ACE_ROOT`): exit 2 is the state above,
       exit 0 means the bind landed and this halt should be retired (contract +
       tripwire table in `playbook/integrations/nova-integration.md § The
       fixtures (Project data table) channel`). A select carrying invented values is strictly
       worse than a halt, because it has no downstream symptom — the app is
       complete and internally consistent with its own invention, and every
       structural gate passes it (ace#1564's rationale, same class).

       Why this is not covered by the payment halt: on
       `spark-facilitator/20260820-0817` the meeting-activity repeat shipped 11
       ACE-authored placeholders (`attendance_register`,
       `facilitated_discussion`, `savings_collection`, …) identical on all 24
       FCAP steps, while Spark's own 78-activity register sat in the run's
       frozen `inputs/`. The field does not feed `entity_id`, so 4f recorded a
       gap and proceeded exactly as written — and it took an operator reading
       the residual, days later, to stop the release.

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
    side moves. `report.status === 'unable'` means the check **did not run** —
    the curriculum states no unconditional evidence step, so there was nothing
    to cross-check. That is NOT "the two apps agree": record it in the build
    memo with its `reason` (`formatTaughtVsCollectableReport` renders it), and
    if the curriculum visibly DOES teach one, the phrase matchers are the bug.

4i. **Fake-preload check (a hidden `caseWrite` field can never hold the case
    value) — runs ACE-DIRECT.** The structural preventer for ace#1224. Because
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

4j. **Payability-discriminator backstop (ace#1489) — runs ACE-DIRECT.** The
    `entity_id` payability rule lives in Step 3's Nova brief, which is
    *architect prose*: nothing downstream of the build re-checks that the key
    the architect actually shipped honours it. So an identity-only key on a
    form with a non-payable branch escapes Phase 3 silently and is caught a
    whole Nova build later by `app-release-qa` Step 2.8, which raises
    `no-entity-component` as a `[BLOCKER]` and hard-halts the phase. The
    resolution helper already exists and the EVAL side already runs it
    (`pdd-to-deliver-app-eval § Connectify wiring (b2)`); this step closes the
    build/eval asymmetry, exactly as 4g pairs with the eval's `checkScreenShape`.

    1. Read the PDD's Program Parameters `entity_id_grain` and whether the PDD
       marks any subset of submissions to this form non-payable (a did-not-happen
       branch, a screening-only visit, a committee-vs-community meeting type).

    2. Feed it to the pure helper — do NOT adjudicate this by reading the key:

       ```ts
       import { resolveEntityIdGrain } from '../../lib/entity-id-precedence';
       const grain = resolveEntityIdGrain({
         pinnedComponents,          // from the PDD's entity_id_grain
         payabilityDiscriminator,   // the built form field expressing payability, if any
         hasNonPayableBranch,
         sourcePinned,
       });
       ```

    3. Branch on the resolution:
       - `deviates: true` → the built key MUST ship `grain.components` in order,
         and the build memo MUST disclose it using `grain.discloseAs`. Edit the
         `entity_id` calculate via Nova if it does not match, then re-fetch.
       - `unresolvable: true` → a non-payable branch exists but **no field
         expresses payability**. Do NOT ship silently: record `grain.reason` in
         the build memo verbatim and name the field that would fix it. This is
         the case the helper exists to stop from passing quietly.
       - otherwise → the PDD-pinned grain stands; record the one-line reason.

    4. **Whenever the shipped key is payability-scoped, the residual list MUST
       name the Phase-4 verification predicate that rejects the non-payable
       value** (ace#1434). The scoped key stops a non-payable submission
       consuming the payable slot, but it also mints `<identity> - no` as its
       own countable entity — so without that predicate the daily cap decides,
       and a worker whose first follow-up was a refusal can still be blocked.
       A key shipped without the residual is the ace#969 failure one layer down.

    5. Re-fetch and re-assert. **Bounded loop, max 3 iterations.** If the key
       still disagrees with `grain.components` after the third, surface a clear
       failure naming the built key and the required one, and do NOT write the
       success summary — halting here costs one loop; letting it through costs
       a Nova build plus a Phase-3 halt.

    (Forms with no non-payable branch skip cleanly — `deviates:false`, and the
    pinned grain stands.)

4k. **Fixed-instrument constant fidelity (ace#1527) — runs ACE-DIRECT.** When
    the PDD marks an instrument `[FIXED]`, its questions AND its arithmetic are
    fixed by a published document that ACE only *digitises*. Every other gate on
    this path is structurally blind to a constant's VALUE: `validate_app`
    checks expression structure and references, `pdd-to-deliver-app-eval` grades
    the build against the PDD — which describes the instrument narratively, so a
    wrong constant is PDD-conformant prose — and `app-release-qa` checks form
    counts, Connect markers and install-time behaviour. Step 3 hands the
    architect the point values as PROSE, so the architect transcribes from a
    model-authored brief, and **the brief is the thing under test**. On
    `hh-poverty-targeting/20260819-1435` that shipped 9 of 17 point values wrong
    and all 101 poverty-likelihood values invented. A wrong scorecard produces a
    complete, plausible, fully-verified dataset that ranks the wrong households,
    and no downstream check has a symptom to catch. (The PPI licence permits
    digitising a scorecard and its lookup tables only UNMODIFIED, so this is a
    compliance question as well as a quality one.)

    1. **Trigger — two conditions, two DIFFERENT outcomes (ace#1648).** The
       trigger used to AND "the PDD marks an instrument `[FIXED]`" with "the
       manifest carries a source file for it" into ONE silent skip, so
       *nothing to check* and *the thing I must check is unreachable* were
       indistinguishable and both reported green. **A skip that disables a
       correctness check is worse than one that degrades an output, because
       the run still says green.** Split them:

       - **No instrument is `[FIXED]`** → **skip cleanly** and say so in the
         memo (`instrument_constants: skipped — <reason>`). Legitimate.
       - **A `[FIXED]` instrument whose source resolves** (step 2) → run the
         check.
       - **A `[FIXED]` instrument whose source does NOT resolve** → **HALT.**
         Never a skip. Print the resolution detail, record a `[BLOCKER]`-grade
         residual naming the file that would close it (a Phase-1 gap), and do
         NOT write the success summary. Shipping a digitised scorecard that
         nothing ever compared against its published source — while reporting
         a clean phase — is exactly the ace#1527 failure this step exists to
         prevent.

       In every branch: do not substitute the PDD's prose restatement of the
       table or the Nova brief for the file, and **do not compose a path by
       name**.

    2. **Resolve from the MANIFEST — `inputs[]` first, then the folder ids the
       manifest itself records, ONE LEVEL (ace#1648) — then fetch the bytes.**
       Read `inputs-manifest.yaml` and match the entry for the instrument the
       PDD names. If no `inputs[]` entry matches, walk the manifest's own
       recorded folder ids — each `subfolders_not_listed[].folder_id`, plus
       `source_folder_id` when present — with
       `drive_list_folder({folderId})`, **one level deep, never recursively**,
       and match there. The manifest's `inputs[]` is direct child FILES only
       (orchestrator Step 5c) — that is deliberate, since `inputs[]` is the
       frozen evidence set Phase 1 synthesizes from — so a vendor bundle
       published as a SUBFOLDER of `inputs/`, the natural shape for a vendor
       download, is never in `inputs[]`, and 4k took the skip branch every
       time it was.
       Walking an id the manifest ITSELF recorded is not guessing; composing a
       path from a name still is, and is still forbidden. Exactly one match →
       proceed; more than one → HALT rather than pick; zero → HALT per step 1.

       Classify the outcome with the helper rather than by eye — it owns the
       skip-vs-halt split, so the branch cannot silently revert:

       ```ts
       import { resolveInstrumentSource } from '../../lib/instrument-constants';
       const resolution = resolveInstrumentSource({
         fixedInstrument,              // does the PDD mark an instrument [FIXED]?
         manifestEntry,                // matching inputs[] entry, or null
         subfolderCandidates,          // matches from the one-level walk
         manifestRecordsSubfolders,    // did the manifest record any folder ids?
         instrumentName,
       });
       // 'skipped' -> write resolution.memo and move on
       // 'halt'    -> print resolution.detail and STOP (no success summary)
       // 'proceed' -> resolution.source.file_id is the source
       ```

       Then fetch by `file_id`:

       ```ts
       drive_download_binary({ fileId, writeToPath: '<scratch>/<name>.xlsx' })
       ```

       `drive_read_file` returns a typed `unsupported_binary_mimetype` error for
       `.xlsx` / `.pdf` / `.docx` and points at `drive_download_binary` (see
       `docs/atom-schemas.md § drive_read_file`) — reach for the binary atom
       first rather than rediscovering that (ace#1527). **Read the SOURCE, never
       the Nova brief and never the PDD's restatement**: both are model-authored,
       and one of them is the artifact this step exists to test.

    3. **Trust the extraction BEFORE using it as an oracle — run this FIRST.**

       ```ts
       import {
         readXlsxColumn,
         assertExtractionTrusted,
       } from '../../lib/instrument-constants';
       const extracted = readXlsxColumn(bytes, {
         sheet, column, firstRow, lastRow,      // all declared by the SOURCE
       });
       const trust = assertExtractionTrusted(extracted.values, {
         expectedFirst, expectedLast, expectedRowCount,
       });
       ```

       `trusted: false` → **HALT.** Print every `trust.failures` entry and every
       `extracted.problems` entry, then stop: do NOT diff, do NOT edit the app,
       and do NOT write the success summary. An unchecked extraction is a second
       way to ship a wrong instrument while reporting success — the first repair
       round's extraction produced `score 4 -> 79.0`, because an `.xlsx` cell
       carrying `t="s"` holds an INDEX into `xl/sharedStrings.xml` and an
       undecoded index is a perfectly plausible number. `readXlsxColumn` decodes
       through the shared-string table and returns an unresolved index as a
       STRING for exactly that reason, so a `non-numeric` failure is the
       header-leak signature, not a parser quirk. The three assertions
       (endpoints, strict monotonicity, row count) are independent and all run,
       so the printed list is every way the extraction is wrong, not the first.

    4. **Read the BUILT literals from Nova, then diff.** `get_field` over each
       scoring `calculate` and each lookup branch, addressed off the Step-4a
       `get_app` blueprint map — reuse it, do not re-fetch the app. Build a flat
       `key -> points` table plus an `indicator -> {option -> points}` table for
       each side, then:

       ```ts
       import {
         diffScoringConstants,
         compareMaxScore,
       } from '../../lib/instrument-constants';
       const diff = diffScoringConstants({ source: sourceConstants, built: builtConstants });
       const max  = compareMaxScore({ sourcePoints, builtPoints, clampAt });
       ```

       `clampAt` is the ceiling of the PDD's `min(<score>, N)` clamp. Judge
       nothing by eye: `diff.mismatches`, `diff.missingInBuild` and
       `diff.extraInBuild` are the finding set, and `max.clampDead` is the
       second-order one.

    5. **Any mismatch, or `clampDead: true`, is a HALT — this is not a warn.**
       Repair in a **bounded loop, max 3 iterations**: `edit_field` the offending
       literal → re-fetch → re-diff. If anything still disagrees after the third,
       surface a structured failure naming every `{key, source, built}` plus
       `sourceMax` vs `builtMax`, and do NOT write the success summary.
       `clampDead: true` alongside `clampReachableInSource: true` means the built
       instrument cannot reach the ceiling its own clamp exists to enforce — the
       clamp is dead code and the overshoot the PDD wants observable can never
       fire, which is precisely how a wrong instrument stays internally
       consistent with its own wrong numbers. Fix the constants; never delete
       the clamp to make the check pass.

    6. **The memo records the CHECK, not just its verdict.** Write the source
       `file_id` and file name, the sheet / column / row range read, the number
       of rows checked, both endpoint values as extracted, `sourceMax` vs
       `builtMax` and whether the clamp is live, and the mismatch count (`0` on
       success). Add the licence note: the published instrument is reproduced
       UNMODIFIED — verbatim transcription of the scorecard and its lookup table
       is what the licence permits, and any "improvement", including a tidier
       rounding, is out of scope for this build.

    (No `[FIXED]` instrument → skip cleanly; the memo says so. A `[FIXED]`
    instrument whose source cannot be resolved — not in `inputs[]`, and not
    found by the one-level walk of the manifest's recorded folder ids — is a
    **HALT**, never a skip (ace#1648). A skip is a legitimate outcome only in
    the first case; a SILENT skip is never one.)

4l. **Entity state-taxonomy fidelity (ace#1564) — runs ACE-DIRECT.** When the
    followed entity carries states the app must NAME, those names are the
    partner's own process vocabulary and ACE only transcribes them. Step 3
    hands the architect the taxonomy as PROSE, and the architect needs the
    option set to build the phase-filtered step picker `longitudinal-visits`
    requires — so a thin or missing declaration is filled in with something
    plausible. On `spark-facilitator/20260820-0817` that shipped four invented
    phase labels and a different four-way partition of the 24 steps than
    Spark's own published guide (which sat in the run's `inputs/`). Every gate
    passed it: `validate_app` checks structure, the eval grades against a PDD
    that describes the lifecycle narratively, and `app-release-qa` checks counts
    and install-time behaviour — an app is internally consistent with its own
    invented vocabulary. The Learn app then teaches one mapping while Deliver
    offers another, and the invented labels reach real workers and, via the
    training deck, the partner.

    1. **Trigger.** Fires iff the app ships any state option set the worker
       sees — a phase / stage / status / round picker, case-list column, or
       filter. **Always fires for `archetype: longitudinal-visits`**, whose
       case-list requirement makes such a state mandatory. No such state
       anywhere → skip cleanly and say so in the memo
       (`entity_state_taxonomy: skipped — <reason>`).

    2. **Parse the DECLARED taxonomy — this is the only authority.**

       ```ts
       import { parseStateTaxonomy } from '../../lib/entity-state-taxonomy';
       const declared = parseStateTaxonomy(programParameters.entity_state_taxonomy);
       ```

       `declared: false` → **HALT.** The PDD declares no state vocabulary while
       the trigger fires: record a Phase-1 finding naming
       `program_parameters.entity_state_taxonomy` (and the § Entity Lifecycle
       prose it should be derived from), and do not build the picker.
       **Do not substitute a generic lifecycle vocabulary to keep the build
       moving** — an invented phase name is worse than a gap, because a gap is
       visible and a plausible wrong vocabulary is not. `problems` non-empty
       (overlapping step ranges, duplicate values, duplicate labels) → HALT the
       same way: the ambiguity is the PDD's to resolve, not this step's.

       When `declared.source` names a document, the brief must have been
       composed from THAT file out of the run's frozen `inputs/` (resolved via
       `inputs-manifest.yaml`), not from the PDD's summary table. If it was
       not, re-compose before diffing — the summary table is the artifact under
       test.

    3. **Read the BUILT option set from Nova, then diff.** `get_field` over each
       state-bearing select, addressed off the Step-4a `get_app` blueprint map
       (reuse it, do not re-fetch), plus the member activity/step list each
       state exposes. Then:

       ```ts
       import { diffStateTaxonomy, describeTaxonomyDiff } from '../../lib/entity-state-taxonomy';
       const diff = diffStateTaxonomy({ declared: declared.states, built });
       ```

       Judge nothing by eye: `diff.extraInBuild` (an invented state),
       `diff.missingInBuild`, `diff.relabelled` (the partner's words rewritten)
       and `diff.repartitioned` (the step partition moved) are the finding set,
       and `describeTaxonomyDiff` renders them.

    4. **Any finding is a HALT — this is not a warn.** Repair in a **bounded
       loop, max 3 iterations**: `edit_field` the offending option value / label
       / member list → re-fetch → re-diff. If anything still disagrees after the
       third, surface a structured failure listing every finding line and do NOT
       write the success summary. Never "fix" the diff by editing the PDD's
       declared taxonomy to match what was built.

    5. **The Learn app is briefed from the SAME declared taxonomy**, so
       Learn/Deliver agreement is transitive — two builds that each match the
       PDD cannot contradict each other. If the Learn app was briefed from
       anything else, that is the same defect one app over: record it as a
       residual against `pdd-to-learn-app` rather than reconciling Deliver to
       Learn.

    6. **The memo records the CHECK, not just its verdict.** Write the declared
       state values with their labels and step ranges, the source document (or
       `none — declared inline in the PDD`), the number of states and steps
       compared, and the finding count (`0` on success).

    7. **Propagate the corrected taxonomy to the CASE-LIST ENUMS
       (dimagi-internal/ace#1688).** Steps 3–4 repair the FORM's option labels
       via `edit_field`. They do not touch the case-list columns — and this
       step's own trigger (step 1) names a *case-list column* as a surface the
       taxonomy reaches. That gap is the whole of ace#1688: on
       `spark-facilitator/20260820-0817` the Phase-3 correction landed on the
       form itemsets and never on the enums, so the `fcap_community` tile kept
       rendering the earlier INVENTED taxonomy while the form offered Spark's
       real one. Stored `1` read as `1. Introduction` before the visit and
       `1. Planning` during it.

       **ACE does not author these enums — the architect does.** The case-list
       tool family (`add_case_list_columns`, `update_case_list_column`,
       `configure_case_list`) carries a `kind: 'id-mapping'` column whose
       `mapping: [{value, label}]` is supplied by whoever calls it, and the
       autonomous architect calls it while building the picker. So the enum is
       composed from the architect's reading of the brief, independently of the
       itemset, and nothing reconciles the two. These atoms are available at
       **ACE-direct** (Step 4d already uses the family), which is why the
       reconciliation belongs here rather than in an upstream issue.

       1. For each state-bearing select repaired above, read the module's case
          list — `get_module({app_id, moduleUuid})` off the Step-4a addressing
          map — and select every column with `kind: 'id-mapping'` whose `field`
          is a case property that select writes.
       2. **Derive, do not compare-then-guess.** Build the mapping from the
          form's itemset: one `{value, label}` per option, using the option's
          own value and its repaired label. Keep the column's existing `field`,
          `header`, `sort` and visibility; replace only `mapping`. Where the
          tile deliberately shows a SUBSET of the options, keep that subset —
          the rule is subset, not equality — but every entry it does keep must
          come from the itemset.
       3. `update_case_list_column({app_id, moduleUuid, columnUuid, column})`
          with the full column body (the uuid carries over; never supply one).
       4. Re-fetch via `get_module` and re-assert value-for-value against the
          itemset. **Bounded loop, max 3 iterations**, same shape as 3–4. Still
          disagreeing after the third → structured failure naming each column
          and the values that differ; do NOT write the success summary.
       5. Record in the memo: columns rewritten, values per column, and the
          form each was derived from.

       **Never reconcile the other way.** The itemset is the authority — it is
       what the worker picks from and what the stored value means. Editing the
       form's labels to match a stale enum re-introduces the invented
       vocabulary this step exists to remove.

       *Enforced downstream:* `app-release-qa § Step 4` check 3 runs
       `checkCczCaseListEnumFidelity` over the released CCZ and halts with
       `[BLOCKER]` `case-list-enum-drift` if any of this was missed — that gate
       is what makes this step falsifiable rather than aspirational
       (`lib/ccz-enum-fidelity.ts`, `test/lib/ccz-enum-fidelity.test.ts`).

4n. **Derived-chain guard check (a value computed from a subtree the visit
    never entered) — runs ACE-DIRECT (ace#1823).** Placed immediately before
    4m so every STRUCTURAL check still lands ahead of the language layer,
    which stays LAST. A repair here edits `relevant` / `calculate`
    expressions and never label text, so it cannot demote a translation.

    **The defect.** A form gates a group on consent and then computes derived
    values at form ROOT, where no `relevant` applies. On a vacant / refused /
    no-eligible-respondent visit the group is skipped, `count()` over the empty
    nodeset returns **0**, and the form submits a complete, confident, wrong
    record. Live on `hh-poverty-targeting` (HQ app
    `ce668763ad6c4b48ac5f4cd4502f3f8c`, released build), read straight out of
    `deliver-latest-release.ccz` → `modules-0/forms-0.xml`:

    ```
    /data/roster        relevant="/data/consent_screen/consent = 'yes'"   <- gated
    /data/member_count  = count(/data/roster/is_member[. = 'yes'])        <- NOT guarded
    /data/hh_size_band  = if(/data/member_count <= 3, 'le3', …)           <- NOT guarded
    /data/size_points   = if(/data/hh_size_band = 'le3', 31, …)           <- NOT guarded
    /data/ppi_score     = if(/data/visit_outcome = 'completed', <sum>, '') <- guarded
    ```

    So `member_count = 0`, `hh_size_band = 'le3'`, `size_points = 31` on every
    non-payable door. `ppi_score` is correctly blank, which is exactly why this
    survives: **nothing looks wrong at the score level.** The corruption is one
    layer down, in the band — and the band is the field a band-boundary fraud
    control groups on (PDD § Evidence Model, Layer C). On that run it is
    **1,072 non-payable doors of 3,794** (28%) landing in the 31-point band by
    construction. A worker with more vacant doors looks like a worker
    clustering at the boundary; the signal and the artefact are
    indistinguishable.

    Every gate is blind to it. A `calculate` over an empty nodeset is valid
    XForm, so `validate_app` passes, `app-release-qa` passes (it checks counts
    and install-time behaviour), the app installs, plays and submits, and the
    eval grades against a narrative PDD. Phase 7 blanked the chain in the
    synthetic fixture and declared the deviation — a fixture-side workaround.
    The app still ships this way, so a real deployment would too.

    ```ts
    import { checkDerivedChainGuards, formatDerivedChainReport }
      from '../../lib/derived-chain-guard';
    const report = checkDerivedChainGuards(rootFields);   // from Step 4a's get_form
    ```

    **Two guard shapes count, because the app that motivated this used the
    second:** the field carries its own `relevant`, OR its `calculate` is a
    conditional whose CONDITION reads a field outside the gated subtree (the
    `ppi_score` shape). A conditional whose condition reads only tainted fields
    is **not** a guard — `if(member_count <= 3, 'le3', …)` looks defensive and
    faithfully converts a phantom 0 into a phantom band. Taint therefore
    PROPAGATES: guarding the leaf is not enough and guarding the final score is
    not enough. Every node between the gated subtree and the submitted record
    has to be able to say what its value means on a visit that never happened.

    1. Run the check on the root field list already fetched in Step 4a.
    2. **For each finding, apply the SAME guard the payable path already
       uses** — normally the visit-outcome discriminator (`relevant:
       "/data/visit_outcome = 'completed'"`, or the inline `if(...)` shape if
       the chain already uses one). Re-run to confirm `findings.length === 0`.
       Bounded at 3 iterations like 4a–4g.
    3. **A finding may be CLEARED BY JUSTIFICATION instead**, and this is a
       real case, not an escape hatch: sometimes a zero over an empty nodeset
       is exactly right ("units delivered on a refused visit: 0"). The check
       does not claim otherwise. It claims the form has to SAY so — record one
       sentence per cleared finding in the build memo naming the field and why
       its value is meaningful on a skipped visit. Silence is not a
       justification.
    4. Record `formatDerivedChainReport(...)` in the build memo either way.

    (Forms with no `relevant`-gated container skip cleanly — `gatedSources` is
    empty and there is nothing to find. *Enforced:*
    `test/lib/derived-chain-guard.test.ts` +
    `test/skills/deliver-l0-loop-integrity.test.ts`.)

4m. **Language layer — runs ACE-DIRECT, LAST of the 4x steps (ace#1556).**
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
    English-editing step (4a–4k) is already done, so nothing can demote a
    translation to `out-of-date` behind you.

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
   - If the PDD marks an instrument `[FIXED]`, was every scoring constant
     diffed against the SOURCE file from `inputs-manifest.yaml` (not the brief,
     not the PDD's restatement) on a `trusted` extraction, with zero mismatches
     and a clamp that can still fire (Step 4k)? If the step skipped, does the
     memo say why — and was the reason "no instrument is `[FIXED]`"? An
     unresolvable `[FIXED]` source is a HALT, not a skip (ace#1648).

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
   instrument_constants:    # Step 4k (ace#1527). Omit the block ONLY when no
                            # instrument is [FIXED]. There is no other skip
                            # reason: an unresolvable [FIXED] source HALTS the
                            # step rather than recording a skip (ace#1648).
     source_file_id: <file_id from inputs-manifest.yaml>
     rows_checked: <n>      # rows actually diffed against the source
     mismatches: 0          # anything above 0 means Step 4k halted
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
   **Those state names are the PARTNER's vocabulary, and this archetype
   is the reason they exist at all** — a case list showing state means
   the app must name every state, and the architect will invent the set
   if the brief does not carry it. Emit
   `_app-component-library.md § entity-state-taxonomy` (always, for this
   archetype), carry the PDD's declared taxonomy into the brief verbatim,
   and HALT rather than invent when the PDD declares none. Verified at
   ACE-direct by Step 4l (ace#1564).
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
- **Nova MCP tools ACE calls directly** (Steps 4a–4h): `get_app`,
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

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-09-02 | **New Step 4n — derived-chain guard check (ace#1823).** The released `hh-poverty-targeting` Deliver form guards ONE node of its derived PPI chain and leaves twelve unguarded at form root. `/data/roster` is gated on consent, so on a vacant / refused / no-eligible-respondent visit `count()` over the empty nodeset returns 0 and the form submits `member_count = 0`, `hh_size_band = 'le3'`, `size_points = 31` — the 31-point band, by construction, on **1,072 non-payable doors of 3,794** (28%), on the exact field the PDD's Layer-C band-boundary fraud control groups on. `ppi_score` IS guarded (`if(visit_outcome = 'completed', …)`), which is why it survived: nothing looks wrong at the score level and the corruption sits one layer down. A `calculate` over an empty nodeset is valid XForm, so `validate_app`, `app-release-qa`, install, play and submit all pass. Phase 7 blanked the chain in the fixture and declared the deviation — the app still ships this way, so a real deployment would too. 4n runs `lib/derived-chain-guard.ts` over the Step-4a field list: taint PROPAGATES along the chain (guarding the leaf or the final score is not enough), and a conditional whose TEST reads only tainted fields is not a guard — `if(member_count <= 3, 'le3', …)` is the corruption wearing an `if()`. A finding clears by applying the payable path's own discriminator OR by a recorded justification, because a zero over an empty nodeset is sometimes exactly right; what the check forbids is silence. Placed before 4m so every structural check stays ahead of the language layer. *Enforced:* `test/lib/derived-chain-guard.test.ts` (negative control: a naive detector that ignores the inline-guard shape fails 3 assertions, incl. flagging the correct `ppi_score`) + `test/skills/deliver-l0-loop-integrity.test.ts`. | ACE team |
| 2026-08-27 | **Step 4l gains sub-step 7 — the corrected taxonomy propagates to the CASE-LIST ENUMS (ace#1688).** 4l steps 3-4 repair the FORM's option labels via `edit_field` and stop there, while 4l's own trigger (step 1) names a *case-list column* as a surface the taxonomy reaches. On `spark-facilitator/20260820-0817` the Phase-3 FCAP correction landed on the form itemsets and never on the enums, so the `fcap_community` tile rendered the earlier ACE-invented taxonomy while the form offered Spark's real one — stored `1` read as `1. Introduction` before the visit and `1. Planning` during it, off by one on the surface the Learn app explicitly teaches the worker to read (`m3_start`, quiz `q9`). **ACE does not author these enums — the autonomous architect does**, via `add_case_list_columns` / `configure_case_list`'s `kind: 'id-mapping'` column, whose `mapping` the caller supplies; it composes them from the brief independently of the itemset and nothing reconciles the two. Those atoms ARE available ACE-direct (Step 4d already uses the family), so the reconciliation lands here rather than as an upstream Nova issue: derive `mapping` from the itemset, `update_case_list_column`, re-assert, bounded 3-iteration loop. A SUBSET is allowed (a tile may deliberately label fewer options); reconciling the other way is forbidden — the itemset is the authority. Paired with the downstream gate that makes it falsifiable rather than aspirational: `app-release-qa § Step 4` check 3 halts with `[BLOCKER]` `case-list-enum-drift`. *Enforced:* `lib/ccz-enum-fidelity.ts` + `test/lib/ccz-enum-fidelity.test.ts`, whose negative control is the shipped drift itself and must FAIL. | ACE team |
| 2026-08-26 | **Step 4k's skip is split, and its source is resolvable through the manifest's own folder ids (ace#1648).** 4k's trigger ANDed "the PDD marks an instrument `[FIXED]`" with "`inputs-manifest.yaml` carries a source file for it" into ONE silent skip, so *nothing to check* and *the thing I must check is unreachable* were indistinguishable and both reported green. They were not equally rare: `inputs[]` records direct child FILES only, so a published instrument bundle sitting in a SUBFOLDER of `inputs/` — the natural shape for a vendor download — always took the second branch. On `hh-poverty-targeting/20260824-1404` the workbook sat in `official-nigeria-ppi-2020 (povertyindex.org)/` and none of the five `inputs[]` entries was it, so a 4k run following its documented path checks nothing. **A skip that disables a correctness check is worse than one that degrades an output, because the run still says green.** Two changes: step 2 may now resolve through ids the manifest ALREADY records (`subfolders_not_listed[].folder_id`, `source_folder_id`) by walking them ONE level with `drive_list_folder` — walking a recorded id is not guessing, composing a path by name still is and is still forbidden — and orchestrator Step 5c now MANDATES recording those ids. Step 1's trigger is split: no `[FIXED]` instrument → skip cleanly; a `[FIXED]` instrument whose source does not resolve → **HALT**, never a skip. The decision is delegated to `resolveInstrumentSource` in `lib/instrument-constants.ts` so it is unit-tested rather than prose-only. *Enforced:* `test/skills/instrument-source-resolution.test.ts` (5 assertions red against the pre-fix text), `test/lib/instrument-constants.test.ts`, `test/mcp/gdrive/generate-inputs-manifest.test.ts`. | ACE team |
| 2026-08-24 | **Step 4f gains a partner-register halt (ace#1621).** 4f's halt was scoped to payment correctness — a still-degraded select halts only when it `feeds_entity_id` on a PAYABLE deliver unit — so a field that fails neither test recorded an `option_source_gaps` entry and proceeded. That is right for a genuinely unknowable set and wrong for a register that EXISTS: on `spark-facilitator/20260820-0817` the meeting-activity repeat shipped 11 ACE-authored placeholders identical on all 24 FCAP steps while Spark's own 78-activity register sat in the run's `inputs/`, and the recorded gap deferred the catch to an operator reading the residual days later. When the PDD declares `<field> from <tag> [source: …] [filtered by …]`, an inline invented option list is now a **HALT** whatever the payability status, and is never dischargeable as a named gap; both inline rungs of the step-5 escape ladder are withdrawn for such a field. Mechanical via `lib/option-register.ts` (`parseRegisterDeclaration` + `diffOptionRegister`), sourcing rows from the partner's `.ccz` fixture XML in preference to a prose guide because a production CCZ carries the REAL value codes the partner's M&E joins on. Where ACE cannot finish, the terminal behaviour is extract → build the table → halt naming the remaining operator step. *(The reason recorded here on 2026-08-24 — a missing create atom — was SUPERSEDED 2026-09-01: `create_lookup_table` ships columns and rows atomically. The halt survives because the BINDING is refused, `voidcraft-labs/commcare-nova#545`.)* Paired with `_app-component-library § partner-option-register` and the eval's `option_register_fidelity` hard-gate. *Enforced:* `test/lib/option-register.test.ts`. | ACE team |
| 2026-08-23 | **New Step 4l — entity state-taxonomy fidelity (ace#1564).** The followed entity's state model lived only as PROSE in the PDD's § Entity Lifecycle, and nothing in Step 3's brief-composition checklist asked for it — while `longitudinal-visits` REQUIRES a case list showing state, so the architect must name every state and invents the set when the brief carries none. On `spark-facilitator/20260820-0817` the PDD's `1 = Planning (steps 1–14)` … `4 = Transition (steps 23–24)`, sourced from Spark's own published FCAP guide sitting in the run's `inputs/`, shipped as four invented labels over a different partition, with all 24 step names invented too. Learn then teaches one mapping while Deliver offers another, and the invented words reach real workers and the partner. Step 3 now emits `_app-component-library § entity-state-taxonomy` (always for this archetype) and parses `program_parameters.entity_state_taxonomy` with `parseStateTaxonomy` BEFORE briefing — `declared: false` or non-empty `problems` is a **HALT** with a Phase-1 finding, never a licence to invent; where the row names a source document the brief is composed from THAT file out of `inputs/`. 4l then diffs the built option set with `diffStateTaxonomy`: any invented, dropped, relabelled or re-partitioned state is a **HALT with a bounded 3-iteration repair loop**, not a warn. Deliberately ships NO canonical vocabulary — hard-coding one would impose ACE's words on every partner, the mirror image of the defect. Paired with the eval's `entity_state_fidelity` hard-gate. *Enforced:* `test/lib/entity-state-taxonomy.test.ts` + `test/skills/entity-state-taxonomy-component.test.ts` + `test/skills/deliver-l0-loop-integrity.test.ts`. **The language layer moved 4l → 4m** in the same change: it must stay LAST of the 4x steps because every English-editing step has to precede it, and 4l's repair loop calls `edit_field` on option labels — running it after the layer would demote those translations to `out-of-date`. Pointers updated in `_app-component-library § app-language-layer`, both `-eval` change logs, and `test/skills/app-language-layer.test.ts`. | ACE team |
| 2026-08-20 | **New Step 4k — fixed-instrument constant fidelity (ace#1527).** Nothing on this path opened the `[FIXED]` source instrument in `inputs/` and diffed it, so on `hh-poverty-targeting/20260819-1435` the digitised Nigeria PPI 2020 shipped with **9 of 17 point values wrong and all 101 poverty-likelihood values invented** — and every gate passed it, because each one is structurally blind to a constant's VALUE (`validate_app` checks structure, the eval grades against a narrative PDD, `app-release-qa` checks counts and install-time behaviour, and the architect transcribes from a model-authored brief). 4k resolves the source file from `inputs-manifest.yaml`, fetches it with `drive_download_binary` + `writeToPath`, and runs `lib/instrument-constants.ts`: `assertExtractionTrusted` FIRST (endpoints + strict monotonicity + row count — the first repair-round extraction produced `score 4 -> 79.0` from an undecoded `t="s"` shared-string index), then `diffScoringConstants` and `compareMaxScore` over the built literals read via `get_field`. Any mismatch, or a `clampDead` verdict, is a **HALT with a bounded 3-iteration repair loop**, not a warn — a built max of 96 against an official 102 made the PDD's `min(ppi_score, 100)` clamp dead code, which is how the instrument stayed internally consistent with its own wrong numbers. Paired with `_app-component-library § fixed-instrument-transcription` and the eval's `fixed_instrument_fidelity` hard-gate. *Enforced:* `test/lib/instrument-constants.test.ts` + `test/skills/deliver-l0-loop-integrity.test.ts`. | ACE team |
