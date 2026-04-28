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

1. **Read the PDD** from `ACE/<opp-name>/pdd.md` via Google Drive MCP.

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
   - Describe the delivery form's structure section by section
   - List the required Connectify fields (Deliver Unit, Entity ID)
   - Reference the relevant PDD section (Evidence Model, Output
     Specification, etc.)

4. **Invoke `/nova:autobuild "<brief>"`.** Capture from the response:
   - `app_id` — durable Nova handle, written to the summary as
     `nova_app_id`
   - Build summary
   - Any warnings

5. **(Optional) Inspect the built app** via `/nova:show <app_id>` to
   cross-check structure against the PDD before writing the summary.

6. **Self-evaluate (LLM-as-Judge):**
   - Does the app structure match the PDD Deliver spec?
   - Is the delivery unit framed correctly for the archetype?
   - Are all Connectify fields configured (Deliver Unit, Entity ID)?
   - Are verification criteria encoded in form questions?

7. **Write the summary** to
   `ACE/<opp-name>/app-summaries/deliver-app-summary.md` with required
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
