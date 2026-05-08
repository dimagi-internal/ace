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

## Outputs

- `2-commcare/pdd-to-learn-app_summary.md` — Learn-app structure summary (modules, forms, fields, `nova_app_id`)

## Process

1. **Read the PDD** from `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md` via Google Drive MCP.

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

4a. **Post-build field-count verification (skill-side safety net).**
    The architect-brief language above puts retry-then-verify discipline
    on the architect agent, but a skill-side check catches cases where
    the agent finished without enforcing it. After autobuild returns,
    **the in-context LLM running this skill** must:

    1. Call `get_app({app_id})` and enumerate
       every form across every module.
    2. For each form, call `get_form` and count
       the persisted fields.
    3. Cross-reference each form's count against the PDD's expected
       field list (from the module/form descriptions).
    4. If any form's persisted count is short, dispatch
       `/nova:edit <app_id> "Add the following missing fields to form
       <name>: <list>. After each add_fields call, get_form and verify
       persistence."` and loop step 1–3.
    5. **Bounded loop, max 3 iterations.** If still short after 3,
       surface a clear failure listing the affected forms and the
       missing fields — do not write the success summary.

    Same pattern as `app-connect-coverage` — verify+fix in a bounded
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
   `ACE/<opp-name>/runs/<run-id>/2-commcare/pdd-to-learn-app_summary.md`. Required
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
Learn app teaches FLWs to **facilitate group discussions** — this is a
**craft, not a checklist**. The brief to Nova is fundamentally different
from atomic-visit:

- **Facilitation basics**: opening the session, introducing yourself,
  setting ground rules
- **Probing techniques**: how to ask "tell me more," "can you give an
  example," "what do you mean by that," without leading
- **Neutral framing**: how to ask sensitive questions (vaccination
  decisions, religious objections) without conveying judgment
- **Group dynamics**: managing dominant participants, drawing out quiet
  ones, handling disagreement, recognizing groupthink
- **Question guide walkthrough**: the PDD's prioritized question list,
  with probes — covered in the order specified (program-specific
  questions last to avoid anchoring)
- **Session form walkthrough**: how to capture per-domain themes, notable
  quotes, level of consensus, time spent, facilitator reflection —
  referencing the Output Specification from the PDD
- **Consent and ethics**: verbal consent script, audio recording consent,
  what to do if a participant withdraws
- **Logistics**: venue setup, attendance register, audio recording
  start/stop, compensation distribution

The Nova brief should explicitly say "this is a facilitation training
app, not a form-walkthrough app" and reference the PDD's Facilitation
Protocol section.

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
