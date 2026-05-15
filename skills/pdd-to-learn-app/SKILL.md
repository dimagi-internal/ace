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

1a. **Archetype short-circuit — focus-group is a no-op.** If the PDD's
    `Archetype:` is `focus-group`, this skill does NOT produce a Learn
    app. Facilitator training for FGDs lives out-of-band (OCS chatbot +
    handbook gdoc + coordinator-graded practice-session audio review).
    See `docs/superpowers/specs/2026-05-15-focus-group-archetype-redefinition.md`.

    Action: write a one-line summary doc to
    `3-commcare/pdd-to-learn-app_summary.md` with frontmatter
    `{archetype: focus-group, status: skipped}` and a body explaining
    "focus-group archetype does not produce a Learn app; facilitator
    training lives in the per-opp OCS chatbot + a handbook gdoc + a
    coordinator-graded practice-session audio review. See PDD §
    Facilitation Protocol for the training plan." Skip steps 2–8.
    Return cleanly; Phase 3's `commcare-setup` already knows to expect
    this for focus-group archetype.

    For `multi-stage` PDDs where Stage 1 is `focus-group` and Stage 2
    is `atomic-visit`, the multi-stage branch (see `## Archetypes`
    below) takes precedence — produce a Learn app for the atomic-visit
    stage; the focus-group stage gets the same skip treatment as a
    standalone focus-group archetype within its stage section.

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

**No Learn app is produced for focus-group archetype.** This skill is a
no-op for focus-group; see Process step 1a above for the short-circuit.

Why no Learn app: the FGD operational model captures qualitative
content **in a Google Doc**, not in a CommCare form. The
mobile-app-only artifact is a small attestation form (see
`pdd-to-deliver-app/SKILL.md § Archetypes § focus-group`). Facilitator
training is correspondingly out-of-band — it lives in:

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
  coordinator reviews and either passes (cleared for live fielding) or
  fails-with-notes. This is not an in-app interaction; it's a
  coordinator-graded audio review tracked in the per-run state.

If the operational model later evolves to require in-app training for
focus-group opps (e.g., a quiz the facilitator must pass before the
attestation form unlocks), revisit this skip rule. For the foreseeable
future, focus-group = no Learn app.

See `docs/superpowers/specs/2026-05-15-focus-group-archetype-redefinition.md`
for the full archetype redefinition.

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
| 2026-04-03 | Initial version | ACE team |
| 2026-04-08 | Add `## Archetypes` section: `atomic-visit` (form walkthrough), `focus-group` (facilitation craft training), `multi-stage` (per-stage branching) | ACE team (PM scout, focus-group framework lens) |
| 2026-04-27 | Switch from manual Nova UI handoff to `/nova:autobuild` via the Nova plugin. Output is now `nova_app_id` written to the summary, not a JSON file. The `apps/learn-app.json` snapshot is no longer required. | ACE team |
| 2026-05-15 | Tighten Step 4a (post-build field-count verification) from "the in-context LLM must..." prose into a numbered tool-call recipe. Prompted by `malaria-itn-fgd/20260514-2007` where the cert-assessment shipped 12/15 score fields + 0/1 user_score and the recipe didn't fire — `validate_app` caught it instead. Mirrored in `pdd-to-deliver-app/SKILL.md`. See jjackson/ace#303. | ACE team |
| 2026-05-15 | **focus-group archetype becomes a no-op for this skill.** The FGD operational model captures content in a gdoc (not a CommCare form) and trains facilitators out-of-band (OCS chatbot + handbook gdoc + coordinator-graded practice-session audio review), so no Learn app is produced. Step 1a short-circuits with a `skipped` summary; § Archetypes § focus-group rewritten to document the skip. Prompted by `malaria-itn-fgd/20260514-2007` post-run reframe; see `docs/superpowers/specs/2026-05-15-focus-group-archetype-redefinition.md`. | ACE team |
