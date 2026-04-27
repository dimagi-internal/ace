---
name: pdd-to-learn-app
description: >
  Pass an PDD to Nova (via the `nova` Claude Code plugin) to generate the
  Learn app. Capture `nova_app_id` and write a structure summary to GDrive
  for downstream skills.
---

# PDD to Learn App

Generate the Learn (training) app from the PDD using the Nova plugin
(`voidcraft-labs/nova-marketplace`, slash command `/nova:autobuild`).

## Process

1. **Read the PDD** from `ACE/<opp-name>/pdd.md` via Google Drive MCP.

2. **Extract the Learn app spec** from the PDD. The spec drives the Nova
   brief; what to extract depends on `archetype:` (see `## Archetypes` below).

3. **Compose a Nova brief** — a single natural-language description that
   `/nova:autobuild` consumes as its sole argument. Nova does not accept
   file paths or markdown attachments; whatever Nova needs to build the
   right app must be inline in the description string. The brief should:
   - Open with the app's purpose and target FLW persona (1–2 sentences)
   - State the archetype framing explicitly (e.g. "this is a facilitation
     training app, not a form-walkthrough app")
   - Describe each module / form, in order
   - List the required Connectify fields (Learn Module, Assessment Score)
   - Reference the relevant PDD section when it shapes Nova's choices

4. **Invoke `/nova:autobuild "<brief>"`.** This is a one-shot autonomous
   build — Nova will not ask clarifying questions. Capture from the
   response:
   - `app_id` — durable Nova handle, written to the summary as `nova_app_id`
   - Build summary
   - Any warnings Nova emits

5. **(Optional) Inspect the built app** via `/nova:show <app_id>` to
   cross-check the structure against the PDD before writing the summary.

6. **Self-evaluate (LLM-as-Judge):**
   - Does the app structure match the PDD Learn spec?
   - Are all required Connectify fields configured (Learn Module,
     Assessment Score, passing score)?
   - For `focus-group`: does the app actually teach facilitation craft
     rather than form completion?

7. **Write the summary** to
   `ACE/<opp-name>/app-summaries/learn-app-summary.md`. Required
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

## Tools

- **Google Drive MCP:** `drive_read_file`, `drive_create_file`
- **Nova plugin slash commands:** `/nova:autobuild`, `/nova:show`,
  `/nova:list`, `/nova:edit` (for follow-up tweaks)

The Nova plugin is installed separately
(`/plugin install nova@nova-marketplace`) and signs in via OAuth on first
use. ACE does not call Nova MCP tools by name; it invokes the user-facing
slash commands listed above. See
`playbook/integrations/nova-integration.md` for current status (notably
the dimagi-ai.com OAuth allowlist blocker).

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
