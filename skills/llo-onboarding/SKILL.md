---
name: llo-onboarding
description: >
  First LLO-facing step. Issues the Connect system invite and sends the ACE
  onboarding email (training materials, getting-started, OCS widget link).
  Uses ace@dimagi-ai.com as sender.
---

# LLO Onboarding

First LLO contact for the opportunity. Takes the `prepared` invite list from
Phase 3 (`connect-setup/invites.md`) and the OCS widget config from Phase 4
(`ocs-agent-config.md`), issues the Connect system invite, and sends the
ACE-authored onboarding email with the widget link embedded.

## Process

1. **Read inputs from GDrive:**
   - Invite list: `ACE/<opp-name>/connect-setup/invites.md` (entries with
     status `prepared`)
   - Training materials: `ACE/<opp-name>/training-materials/`
   - Opportunity details: `ACE/<opp-name>/connect-setup/opportunity.md`
   - OCS widget config: `ACE/<opp-name>/ocs-agent-config.md`
     (`public_id`, `embed_key`)

2. **Send Connect system invites** for each `prepared` LLO entry via
   Connect `send_invite` (**NOT YET BUILT** — see workaround below). Flip
   status to `sent` in the invite list.

3. **Read the PDD's `archetype:` field.** Email content — framing, "getting
   started" steps, timeline language, and which pieces of training material
   to emphasize — branches by archetype. See `## Archetypes` below. Fall
   back to `atomic-visit` if unspecified.

4. **For each invited LLO, compose an onboarding email:**
   - From: `$ACE_GMAIL_ACCOUNT` (via `email-communicator` skill)
   - CC: CRISPR Admin Dimagi Google Group
   - Subject: "[Opportunity Name] — Welcome and Next Steps"
   - Body (archetype-aware — see `## Archetypes` for per-archetype content):
     - Welcome and opportunity overview — frame the recipient correctly for
       the archetype (FLW-managing org for `atomic-visit`; facilitator-owning
       org for `focus-group`; staged-execution org for `multi-stage`)
     - Links to training materials (GDrive links or attachments) —
       foreground the materials the recipient needs FIRST for this archetype
     - Step-by-step "getting started" — archetype-specific (download app vs.
       review question guide vs. stage-1 prep)
     - Timeline and expectations — archetype-specific cadence (continuous
       fieldwork vs. N sessions over T weeks vs. staged milestones)
     - **OCS widget** — embed link / URL derived from `public_id` + `embed_key`
       so LLOs can chat with the ACE support bot directly. Also mention the
       email fallback (`$ACE_GMAIL_ACCOUNT`)
     - Contact info for escalation

5. **Send emails** via the `email-communicator` skill (or draft for review).

6. **Log communications** to `ACE/<opp-name>/comms-log/onboarding-emails.md`.

## Archetypes

The onboarding email is the first LLO-facing artifact of the entire
pipeline. Atomic-visit framing in a focus-group opp lands as obviously
wrong to the recipient — emails that say "your FLWs will start collecting
deliveries" when the recipient is running discussion groups corrode trust
before the first session. Branch on `archetype:` from the PDD.

### `atomic-visit` (default)

**Welcome framing:** address the recipient as an LLO whose FLWs will
execute atomic deliveries in the field. Mention target FLW count and
geographic coverage.

**Getting-started steps (ordered list in the email):**
1. Download the CommCare app on the issued device
2. Register FLWs and assign them to the opportunity
3. Walk through the first training module with at least one FLW
4. Run a dry-run visit and confirm data lands in the opportunity dashboard

**Materials to foreground:** `flw-training-guide.md` and
`quick-reference.md` (field-facing). `llo-manager-guide.md` is the
overview; link it but don't lead with it.

**Timeline language:** "Continuous fieldwork over the opportunity window.
Target delivery volume is X/week per FLW — see the opportunity brief."

### `focus-group`

**Welcome framing:** address the recipient as the **facilitator-owning
org** for the FGD study. Name the session count and topic area in the
opening line. Do NOT say "FLW" or "delivery" — the recipient's team is
running discussions, not visits.

**Getting-started steps (ordered list in the email):**
1. Review the question guide (`question-guide.md` if present, else
   `pdd.md` § Research Questions) and the facilitator guide
2. Confirm venue + recording-equipment arrangements for Session 1
3. Complete participant recruitment per the PDD's eligibility criteria
4. Schedule a 20-minute pre-kickoff call with the ACE admin if this is
   the facilitator's first FGD on Connect (mention only if the PDD or
   `llo-invite` rationale flagged training need)
5. Run Session 1; upload the audio + the session note template within
   48 hours

**Materials to foreground:** facilitator guide, question guide, consent
form, audio-upload instructions. These live under `training-materials/`
but paths differ per archetype — if an FGD-specific training bundle
isn't present, link the atomic-visit materials with a note that the
team should adapt the framing for discussion sessions (flag as an
open-question for the admin group).

**Timeline language:** "N sessions over T weeks. Expect ~4–6 hours of
prep + facilitation + write-up per session (not continuous fieldwork)."
Pull N and T from the PDD; if absent, say "per the session plan in
your kick-off materials" and open-question it.

**Smaller-N reality:** FGD opps typically invite 1–2 LLOs
(per `llo-invite` § Archetypes). If the recipient list exceeds 2,
include a sentence naming the other facilitators and the cross-session
coordination expectation (same question guide, consistent write-up
template).

### `multi-stage`

**Welcome framing:** address the recipient as the org executing Stage N
of the pipeline (where N is their assigned stage per the invite list's
`rationale`). If the org spans multiple stages, list all of them with a
sentence naming what they own at each.

**Getting-started steps:** staged. List Stage 1 steps first (typically
the format/protocol that Stage 1 uses — FGD, interview, or atomic
visit). Don't front-load steps that only apply to a later stage;
mention downstream stages by name and note "separate onboarding
communication will go out before Stage 2 starts" if the stage transition
is far enough out.

**Materials to foreground:** Stage-1 materials first. Later-stage
materials link'd as reference but not required reading for week 1.

**Timeline language:** "Stage 1 runs weeks 1–N. Stage 2 begins after
the Stage 1 gate (see pipeline diagram)." Include the gate/transition
criteria explicitly so the recipient knows what finishes Stage 1.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`, `drive_list_folder`

## Current Workaround
1. Guide the operator to send Connect invites through the Connect UI for each
   `prepared` LLO; update `invites.md` statuses to `sent`
2. Generate the onboarding email content for each LLO (with widget link)
3. Write drafts to `ACE/<opp-name>/comms-log/onboarding-drafts/`
4. Ask the user to send the emails from ace@dimagi-ai.com
5. Update the comms log with send confirmation

## Mode Behavior
- **Auto:** Send emails directly, log to GDrive
- **Review:** Present email drafts for review before sending

## Dry-Run Behavior
When `--dry-run` is active:
- Write the onboarding email content (recipients, subject, body, attachments) to `comms-log/dry-run-llo-onboarding.md`
- Do not send emails
- State tracks as `dry-run-success`

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
| 2026-04-14 | Own Connect system invite send (moved from `llo-invite`) and include OCS widget link in onboarding email; this is the first LLO-facing step in the lifecycle | ACE team |
| 2026-04-20 | Added `## Archetypes` section with per-archetype email framing, "getting started" steps, and timeline language. `focus-group` addresses the recipient as a facilitator-owning org (not FLW-managing), leads with question guide + audio upload, and uses session-count cadence language. `multi-stage` front-loads Stage 1 content. Prevents atomic-visit framing from landing as the first LLO-facing artifact on FGD opps | ACE team |
