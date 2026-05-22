---
name: pdd-to-learn-app
description: >
  Build the CommCare Learn (training) app from the PDD via Nova's
  /nova:autobuild. Captures nova_app_id and writes a structure summary.
disable-model-invocation: true
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
    check, not a full training curriculum. The sentinel exists for two
    reasons:

    1. **Connect API requirement.** `connect_create_opportunity`
       requires a non-null `learn_app` at the schema, REST request, and
       cross-field-validator layers (verified `malaria-itn-fgd/20260514-2352`).
       A no-Learn-app focus-group cannot be wired into a Connect opp.
    2. **In-app readiness gate.** The sentinel form gates whether the
       facilitator has completed the out-of-band training (OCS chatbot +
       handbook gdoc + coordinator-graded practice-session audio review).
       A facilitator must acknowledge readiness in CommCare before
       Connect treats them as cleared to submit attestation forms.

    The actual training content lives **out-of-band** (the sentinel
    doesn't carry it). See `docs/superpowers/specs/2026-05-15-focus-group-archetype-redefinition.md`
    for the operational model.

    Proceed to step 2 with the focus-group sentinel brief described in
    `## Archetypes § focus-group` below. The brief is short (one form,
    ~7 fields, both Connect markers set); Nova autobuild typically
    completes in 1-2 minutes.

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
     every content form needs `connect.learn_module` and every quiz
     form needs `connect.assessment` per CommCare Connect's rules.**
     Load-bearing language — without it, autobuild often skips the
     per-form Connect blocks. See
     `docs/learnings/2026-04-29-nova-connect-marker-bugs.md` § Bug 1.
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

     Filed upstream as voidcraft-labs/nova-plugin issue
     "XForm emitter does not entity-encode `<`/`>` in label text"; this
     skill-side constraint is the workaround. Phase 3's `app-release`
     Step 2.7 surfaces a typed `BuildRejectedError` (with form
     name + line/col) if the architect violates this constraint anyway,
     so the operator gets a clear diagnostic instead of "Cannot make
     new version" and a CCHQ UI peek.
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
     > Vellum's plugin help text says verbatim "Estimated time to complete
     > the module in hours" (`src/commcareConnect.js:158`) and Connect's
     > `LearnModule.time_estimate` model field docstring says "Estimated
     > hours to complete the module". For typical Learn modules this is
     > 1 (one hour) or 2; never a two-digit minute count. If a module
     > genuinely takes less than an hour, round up to 1 — Connect displays
     > the value in dashboards as hours-to-complete and FLW-onboarding
     > timing calculations downstream assume the unit.

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

     Reproducer: `leep-paint-collection` run 20260517-1515 Phase 4 hit
     this on M6 (52-char slug derived from "Stage 2: Sample Preparation,
     Drying, Bagging, Shipment"). The structural backstop is `app-release`
     Step 6's `projected_connect_state.oversized_slugs` gate — even if
     the architect ships an over-length slug, the release-time projection
     halts before Phase 4 ever calls Connect. Removal criteria: (a) drop
     the ≤40-char fallback when the upstream commcare-connect PR widens
     `LearnModule.slug` / `DeliverUnit.slug` to `max_length=255` (PR
     dimagi/commcare-connect#1195) and `SLUG_LENGTH_LIMIT` in
     `mcp/connect/backends/commcare.ts` is bumped in lock-step. (b) KEEP
     the explicit-id rule even after the column widens — it's a
     cleanliness invariant matching Vellum's slug-vs-name separation,
     not just a workaround for the column width.
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

     See `docs/learnings/2026-04-29-nova-connect-marker-bugs.md`
     § Bug 3 for the full failure analysis.
   - **REQUIRED — Learn forms must NOT carry `<case>` blocks.** This is the
     load-bearing rule that keeps `commcare-form-patch` runnable on the
     Learn CCZ. Insert this paragraph **verbatim** into the brief, in its
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
     >
     > Why: `pdd-to-learn-app/SKILL.md` STEP 8 documents that
     > `commcare-form-patch` runs after Learn release to strip
     > `commcareconnect`-namespaced wrappers from form XML — but the
     > patcher's `commcare_patch_xform` → `make_build` cycle fails with
     > "Cannot use Case Management UI if you already have a case block in
     > your form" whenever the patched form carries a `<case>` block,
     > because CCHQ's Vellum form-designer caches case-block metadata
     > separately from the XForm bytes and the patcher's `edit_form_attr`
     > call doesn't refresh that cache. Tracking: `commcare-form-patch/
     > SKILL.md § blocker class cchq-vellum-cache-drift`. Until either
     > Nova's wrapper-emission bug (voidcraft-labs/nova-plugin#7) ships
     > OR the patcher gains Vellum-cache invalidation, the only path
     > that keeps the Learn CCZ AVD-launchable is to author Learn
     > forms without case blocks in the first place.

     Reproducer: `malaria-itn-app/20260521-1400` Phase 3 — the architect
     bound calibration pass flags (`standardization_gate_cleared`,
     `*_passed`) to case properties on `flw_calibration` cases. Phase 3
     released successfully but `commcare-form-patch` was blocked by
     `cchq-vellum-cache-drift` on all 6 Learn forms; Phase 6
     `app-screenshot-capture` then halted on Connect → Learn CCZ install
     with `"Unknown failure during app install"` because the released
     Learn CCZ still carried the wrappers the AVD runtime cannot install.
     Removal criteria: drop this rule when voidcraft-labs/nova-plugin#7
     ships (no wrappers → no patcher → no vellum-cache-drift class) OR
     when `commcare_patch_xform` gains the Vellum-cache invalidation
     path documented in `commcare-form-patch/SKILL.md`.

4. **Invoke `/nova:autobuild "<brief>"`.** This is a one-shot autonomous
   build — Nova will not ask clarifying questions. Capture from the
   response:
   - `app_id` — durable Nova handle, written to the summary as `nova_app_id`
   - Build summary
   - Any warnings Nova emits

4a. **Post-build field-count verification — runnable recipe (skill-side safety net).**

    The architect-brief language above puts retry-then-verify discipline
    on the architect agent. This step is the skill-side safety net for
    cases where the architect finished short — including the case where
    the architect ran out of budget mid-final-module and silently
    persisted N-of-M expected fields with no error. (Seen on
    `malaria-itn-fgd/20260514-2007`: cert assessment shipped 12/15
    score fields + 0/1 user_score, caught downstream by `validate_app`
    rather than here; see jjackson/ace#303.)

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
       Connect-marker `user_score` that isn't in `persisted_ids`.
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

    Why we run this even though `validate_app` will catch some
    shortfalls downstream: `validate_app`'s reference-integrity check
    only catches missing fields that ARE referenced elsewhere
    (e.g., a `user_score` sum referenced by the Connect `assessment`
    block). A form that's missing 3 of 5 quiz questions with no
    cross-reference between them passes `validate_app` cleanly and
    ships to the FLW broken at training time. Step 4a is the
    coverage-on-the-brief safety net `validate_app` is structurally
    unable to provide.

    Same shape as `app-connect-coverage` — verify+fix in a bounded
    loop, post-Nova.

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
   ---
   ```

   Body content stays the same as before: module list, Connect
   configuration, decisions made, Nova warnings.

8. **Notify admin group** that Learn app generation is complete, with the
   Nova app URL and a link to the summary in GDrive.

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
`connect.assessment` with passing_score 1).

The sentinel satisfies two constraints simultaneously:

1. **Connect API needs a Learn app.** `connect_create_opportunity`
   requires non-null `learn_app` (schema + REST + validator). One sentinel
   per FGD opp is the working pattern (operator decision, 2026-05-15).
2. **In-app readiness gate.** The sentinel's one form is a
   coordinator-confirmed readiness check — the facilitator can't
   acknowledge readiness in CommCare until they've completed the
   out-of-band practice-session-pass.

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
   `. = 'yes'`). Saves to case property `readiness_acknowledged`.
4. `acknowledgement_date` (date, required, default `today()`). Saves
   to `readiness_date`.
5. `q1_score` (hidden, `calculate: if(#form/acknowledge_readiness = 'yes', 1, 0)`).
6. `user_score` (hidden, `calculate: #form/q1_score`). Referenced by
   the `connect.assessment` block.
7. `result_label` (label) — readiness-acknowledged closing message.

**Real facilitator training lives out-of-band:**

- **OCS chatbot** (Phase 5, per-opp) — primary reference surface for
  facilitation craft (silence handling, neutral probing,
  anti-anchoring, group dynamics) + post-session writing guidance
  ("what should I put in section 3 of my gdoc?"). Loaded with the
  PDD's Facilitation Protocol + Question Guide + Output Specification
  + a handbook gdoc.
- **Facilitator handbook gdoc** — the LLO's prep doc; distributed
  out-of-band, referenced from the OCS chatbot's RAG content.
- **Practice-session audio review** — the pre-fielding certification
  gate. Facilitator records a practice FGD, uploads the audio,
  coordinator reviews and either passes (cleared for live fielding,
  $50 training stipend released, and the facilitator can answer
  `yes` to the sentinel's `acknowledge_readiness`) or fails-with-notes.

The sentinel **does not duplicate or replace** the out-of-band training.
It's a thin in-app artifact whose only operational job is to gate
attestation submissions on coordinator-confirmed practice-session-pass.

**Why "sentinel" and not "real training":** the FGD content lives in a
Google Doc out-of-band, not in a CommCare form (see
`pdd-to-deliver-app/SKILL.md § Archetypes § focus-group`). The real
training is correspondingly out-of-band — putting it into CommCare
would mean re-authoring all the facilitation craft content as in-app
quizzes, which is the old-shape pattern that the operator explicitly
walked back ("not a 'thin focus group' — the only way we will do
the focus group"). The sentinel is the minimum needed to satisfy
Connect's API and add one operational gate.

See `docs/superpowers/specs/2026-05-15-focus-group-archetype-redefinition.md`
for the full archetype redefinition + the sentinel rationale.

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

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-15 | **focus-group archetype becomes a no-op for this skill.** The FGD operational model captures content in a gdoc (not a CommCare form) and trains facilitators out-of-band (OCS chatbot + handbook gdoc + coordinator-graded practice-session audio review), so no Learn app is produced. Step 1a short-circuits with a `skipped` summary; § Archetypes § focus-group rewritten to document the skip. Prompted by `malaria-itn-fgd/20260514-2007` post-run reframe; see `docs/superpowers/specs/2026-05-15-focus-group-archetype-redefinition.md`. | ACE team |
| 2026-05-15 | **focus-group switches from no-op to minimal sentinel pattern.** Re-run `malaria-itn-fgd/20260514-2352` Phase 4 surfaced a hard blocker: `connect_create_opportunity` requires `learn_app` at the schema, REST, and validator layers. Operator chose per-opp sentinel (one minimal 1-form readiness check, ~7 fields, both Connect markers, ~1-2 min build) over a server-side fix. Step 1a no longer short-circuits — focus-group runs the full skill flow but with the sentinel-shaped brief documented in § Archetypes § focus-group. Sentinel doubles as in-app readiness gate: facilitator must `acknowledge_readiness = yes` (coordinator-confirmed practice-session-pass) before they're cleared to submit attestations. | ACE team |
| 2026-05-21 | **Forbid `<case>` blocks in Learn forms.** Added a new REQUIRED paragraph to Step 3 instructing the architect to NOT declare `case_type` on Learn modules, NOT create cases from Learn registration forms, and NOT bind any field to a case property via `case_property_on`. Calibration scores / pass flags / `user_score` MUST live as form-level hidden fields only. Reason: `commcare-form-patch` (Step 8 wrapper-strip) hits `cchq-vellum-cache-drift` whenever a patched form carries a `<case>` block — CCHQ's Vellum form-designer cache isn't refreshed by `edit_form_attr`, and `make_build` rejects with "Cannot use Case Management UI if you already have a case block in your form." Reproducer: `malaria-itn-app/20260521-1400` Phase 3 — architect bound `standardization_gate_cleared` + `*_passed` flags to case properties, all 6 Learn forms blocked at form-patch, Phase 6 then halted on Connect → Learn CCZ install with "Unknown failure during app install." Removal criteria: drop the rule when voidcraft-labs/nova-plugin#7 ships (no wrappers → no patcher → no drift class) OR when `commcare_patch_xform` gains Vellum-cache invalidation. | ACE team |
