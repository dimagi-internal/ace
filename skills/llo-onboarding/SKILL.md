---
name: llo-onboarding
description: >
  First LLO-facing step. Issues the Connect system invite and sends the ACE
  onboarding email (training materials, getting-started, OCS widget link).
  Uses ace@dimagi-ai.com as sender.
---

# LLO Onboarding

First LLO contact for the awarded LLO. Reads `opp.yaml.selected_llo`
(populated by Phase 6 `solicitation-review` after a solicitation is
awarded), issues the Connect system invite to that single org, and sends
the ACE-authored onboarding email with the OCS widget link embedded.

**Phase 7 entry guard:** if `opp.yaml.selected_llo.org_slug` is null,
this skill halts immediately with:

> FATAL: Phase 7 cannot start — `opp.yaml.selected_llo.org_slug` is
> empty. Run `/ace:step solicitation-review --opp <opp-name>` to score
> Phase 6 solicitation responses and award an awardee. The orchestrator's
> pre-Phase-7 gate should have caught this; if you're seeing this from a
> manual `/ace:step` invocation, the gate was bypassed.

The single-awardee model replaces the previous multi-LLO roster model
that read `connect-setup/invites.md`. With Phase 6 publishing a
solicitation and selecting one winner, Phase 7 onboards exactly one org.

## Process

1. **Read inputs from GDrive:**
   - `opp.yaml.selected_llo` — populated by Phase 6 `solicitation-review`.
     Must contain `org_slug`, `contact_email`, `source: 'solicitation'`,
     `response_id`. Halt with the FATAL message above if `org_slug` is
     null or empty.
   - Training materials: `ACE/<opp-name>/runs/<run-id>/5-qa-and-training/`
   - Opportunity details: `ACE/<opp-name>/runs/<run-id>/3-connect/connect-opp-setup.md`
   - Program details: `ACE/<opp-name>/runs/<run-id>/3-connect/connect-program-setup.md` (program
     UUID for the Connect invite)
   - OCS widget config: `ACE/<opp-name>/runs/<run-id>/4-ocs/ocs-agent-setup.md`
     (`public_id`, `embed_key`)
   - Award record: `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/solicitation-review_award-record.md` (for
     the awarded amount and award context to mention in the onboarding
     email)

2. **Send the Connect system invite** for the awarded org via
   `connect_send_llo_invite` (ace-connect MCP, 0.10.47+). The atom hits
   `POST /api/programs/<program_id>/applications/` and creates a
   `ProgramApplication` row in `INVITED` status; Connect emails the LLO
   workspace admins via the `send_program_invite_email` task. Args:
   - `organization_slug`: PM-side org running the program
   - `program_id`: program UUID (from `connect-setup/program.md`)
   - `organization`: `opp.yaml.selected_llo.org_slug`

   Capture the returned `program_application_id` and write it back into
   `opp.yaml.selected_llo.program_application_id` for the auto-accept
   step (2a). Single org, single call — no roster iteration.

   **2a. (Optional, ACE-driven dogfood runs only.)** If the target org
   is an ACE-controlled fixture and there's no real LLO who will accept
   manually, call `connect_accept_program_application` to flip the
   application from `INVITED` → `ACCEPTED`:
   ```
   connect_accept_program_application({
     organization_slug: <PM-side org>,
     program_id: <program UUID>,
     application_id: <program_application_id from step 2>,
   })
   ```
   This is required before `connect_create_opportunity` will accept the
   org as the managed-opportunity owner. For real-LLO runs, skip this
   step — the LLO accepts via the Connect UI.

3. **Read the PDD's `archetype:` field.** Email content — framing, "getting
   started" steps, timeline language, and which pieces of training material
   to emphasize — branches by archetype. See `## Archetypes` below. Fall
   back to `atomic-visit` if unspecified.

4. **Compose the onboarding email for the awarded LLO:**
   - From: `$ACE_GMAIL_ACCOUNT` (via `email-communicator` skill)
   - To: `opp.yaml.selected_llo.contact_email`
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

5. **Send the email** via the `email-communicator` skill (or draft for review).

6. **Log communications** to `ACE/<opp-name>/runs/<run-id>/7-execution-manager/llo-onboarding_comms-log.md`.

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
form, audio-upload instructions. These live under
`runs/<run-id>/5-qa-and-training/` but paths differ per archetype — if
an FGD-specific training bundle isn't present, link the atomic-visit
materials with a note that the
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
- Connect (`ace-connect` MCP, 0.10.47+):
  - `connect_send_llo_invite` — REST `POST /api/programs/<id>/applications/`
  - `connect_accept_program_application` — REST `POST .../accept/`
    (ACE-driven dogfood only; skip for real-LLO runs)
  - `connect_list_invites` — verify status / detect already-invited (HTML)
- Email: `email-communicator` skill (sends from `ace@dimagi-ai.com`)

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
| 2026-04-28 | Replace HITL workaround with `connect_send_llo_invite` (ace-connect 0.8.1). Connect's invite is program-level, so the atom takes the program UUID and an `organization` slug for the target LLO workspace | ACE team |
| 2026-04-30 | Switch `connect_send_llo_invite` to `POST /api/programs/<id>/applications/` (commcare-connect PR #1135). Args drop `contact_email` (server emails workspace admins via `send_program_invite_email`). Add new step 2a: `connect_accept_program_application` for ACE-driven dogfood runs that need to auto-accept the invite. (0.10.47) | ACE team |
| 2026-05-04 | Read awardee from `opp.yaml.selected_llo` instead of iterating `connect-setup/invites.md` roster. Phase 7 entry guard halts with an actionable message if `selected_llo.org_slug` is null (Phase 6 `solicitation-review` must run first). Single-org onboarding replaces multi-LLO roster model. (0.12.0) | ACE team |
