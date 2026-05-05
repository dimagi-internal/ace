---
name: pdd-to-deliver-app
description: >
  Pass an PDD to Nova (via the `nova` Claude Code plugin) to generate the
  Deliver app. Capture `nova_app_id` and write a structure summary to
  GDrive for downstream skills.
---

# PDD to Deliver App

Generate the Deliver (service delivery) app from the PDD using the Nova
plugin (`voidcraft-labs/nova-marketplace`, slash command
`/nova:autobuild`).

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
     about them. The `app-connect-coverage` skill in Phase 2 Step 1.5
     is the safety net for cases where the brief was vague, but the
     more robust path is for this brief to be unambiguous up front.
     See `docs/learnings/2026-04-29-nova-connect-marker-bugs.md`
     § Bug 1 for the prompt-quality dependency.
   - Describe the delivery form's structure section by section
   - List the required Connectify fields (Deliver Unit, Entity ID)
   - Reference the relevant PDD section (Evidence Model, Output
     Specification, etc.)
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

4. **Invoke `/nova:autobuild "<brief>"`.** Capture from the response:
   - `app_id` — durable Nova handle, written to the summary as
     `nova_app_id`
   - Build summary
   - Any warnings

4a. **Post-build field-count verification (skill-side safety net).**
    The architect-brief language above puts the retry-then-verify
    discipline on the architect agent, but a skill-side check catches
    the case where the agent finished without enforcing it. After
    autobuild returns, **the in-context LLM running this skill** must:

    1. Call `mcp__plugin_nova_nova__get_app({app_id})` and enumerate
       every form across every module.
    2. For each form, call `mcp__plugin_nova_nova__get_form` and count
       the persisted fields.
    3. Cross-reference each form's count against the PDD's expected
       field list (from §Forms / §Output Specification, depending on
       archetype).
    4. If any form's persisted count is short, dispatch
       `/nova:edit <app_id> "Add the following missing fields to form
       <name>: <list>. After each add_fields call, get_form and verify
       persistence."` and loop step 1–3.
    5. **Bounded loop, max 3 iterations.** If still short after 3,
       surface a clear failure listing the affected forms and the
       missing fields — do not write the success summary.

    Why both the architect-brief instruction and the skill-side check?
    The architect's verification is faster (one round-trip per
    `add_fields`); the skill-side check is the safety net for cases
    where the architect skipped it. Same pattern as
    `app-connect-coverage` — verify+fix in a bounded loop, post-Nova.

5. **(Optional) Inspect the built app** via `/nova:show <app_id>` to
   cross-check structure against the PDD before writing the summary.

6. **Self-evaluate (LLM-as-Judge):**
   - Does the app structure match the PDD Deliver spec?
   - Is the delivery unit framed correctly for the archetype?
   - Are all Connectify fields configured (Deliver Unit, Entity ID)?
   - Are verification criteria encoded in form questions?

7. **Write the summary** to
   `ACE/<opp-name>/runs/<run-id>/2-commcare/pdd-to-deliver-app_summary.md` with required
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
Delivery unit = **one completed group session with all required
artifacts**. The form is a session-documentation form, not an
individual-beneficiary form. Required artifacts:

- **Pre-session**: date, GPS, venue, segment, participant count, consent
  confirmed (per participant), recording started
- **Per question domain (one section per domain in the PDD's question
  guide)**: themes observed, notable quotes (verbatim, with translation
  if needed), level of consensus, time spent
- **Post-session**: facilitator reflection (what went well, what didn't,
  anything surprising), attendance photo, audio file upload, total
  session duration

Case management is **per session**, not per participant. There's no
"case lifecycle" for participants — they're not the unit. The
opportunity-level case is the segment (e.g., "Women, remote,
under-vaccinated children"), and each session against that segment is a
delivery against that case.

The Nova brief should explicitly call out that this is **session
documentation, not atomic data collection**, and reference the PDD's
Output Specification section for the per-domain summary fields.

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

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
| 2026-04-08 | Add `## Archetypes` section: `atomic-visit` (per-beneficiary form), `focus-group` (per-session documentation form, segment-level case), `multi-stage` (per-stage branching) | ACE team (PM scout, focus-group framework lens) |
| 2026-04-27 | Switch from manual Nova UI handoff to `/nova:autobuild` via the Nova plugin. Output is now `nova_app_id` written to the summary, not a JSON file. The `apps/deliver-app.json` snapshot is no longer required. | ACE team |
