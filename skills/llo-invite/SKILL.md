---
name: llo-invite
description: >
  Identify candidate LLOs for a Connect opportunity and prepare the invite
  list. Sending happens later in Phase 5 (llo-onboarding) once the OCS widget
  is ready to include in the onboarding email.
---

# LLO Invite

Identify and prepare the invite list for LLOs to participate in the opportunity.
This skill runs in Phase 3 (Connect setup) and produces a reviewable list;
invites go out in Phase 5 (`llo-onboarding`) so the onboarding email can
include the OCS widget link configured in Phase 4.

## Process

1. **Read inputs from GDrive:**
   - PDD: `ACE/<opp-name>/pdd.md` (LLO preferences section)
   - Opportunity details: `ACE/<opp-name>/connect-setup/opportunity.md`

2. **Look up LLO contacts:**
   - Check PDD for preferred/known LLOs
   - Search LLO Directory for matching organizations
   - Get contact details for each LLO

3. **Prepare invite list:**
   - LLO name, contact person, email
   - Why this LLO was selected (geographic match, capability match, etc.)
   - Opportunity summary for the invite

4. **Write invite list** to `ACE/<opp-name>/connect-setup/invites.md` with
   status `prepared` for each entry. Phase 5's `llo-onboarding` picks this up,
   issues the Connect invite, and flips the status to `sent`.

5. **Write the gate brief** to `ACE/<opp-name>/gate-briefs/llo-invite.md`
   using the shape defined in `agents/ace-orchestrator.md § Gate Brief Contract`.
   See `## Gate Brief` below for the exact fields this skill populates.

## Gate Brief

The gate brief at `ACE/<opp-name>/gate-briefs/llo-invite.md` lets the admin
validate the invite list before Phase 5 (where the send actually happens).
This is the last review step before ACE contacts external LLOs — the
highest bad-send risk in the pipeline.

- **Artifact Under Review:** path `ACE/<opp-name>/connect-setup/invites.md`;
  summary is `<N> LLOs prepared for <opp-name>` with country/region mix
- **What to Check** (emit these 4 items verbatim):
  - Every LLO row has `name`, `contact_person`, `email`, and `rationale`
    populated — downstream `llo-onboarding` assumes all four exist
  - Rationale is specific (references PDD geography, archetype fit, or
    prior-work history), not a generic "matches profile"
  - No duplicates — same contact email not listed for two different LLOs
  - Count matches the PDD's intended LLO reach (e.g., PDD says "3 LLOs
    across Nigeria and Kenya", list has 3 — not 7)
- **Auto-Surfaced Concerns:** one line per signal:
  - `[BLOCKER]` for any row missing a required field
  - `[WARN]` for any rationale that is empty or under 10 words
  - `[WARN]` if the list count differs materially from the PDD target
  - `[INFO]` for each LLO that has not previously worked with Dimagi
    (onboarding will take longer)
  - "None — all auto-checks passed." if the list is clean
- **Recommended Disposition:** `Approve` if zero `[BLOCKER]`; `Iterate` if
  any row is incomplete or duplicated; `Reject` if the list size or
  composition is off — re-run with corrected PDD LLO preferences

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Connect: `list_llo_contacts` — **NOT YET BUILT**
- (Connect `send_invite` is called from `llo-onboarding` in Phase 5, not here)

## Current Workaround
1. Read the PDD's LLO preference section
2. Generate a recommended invite list with rationale
3. Write to `ACE/<opp-name>/connect-setup/invites.md` with status `prepared`
4. Phase 5 guides the operator to send invites through the Connect UI and
   flip statuses

## Mode Behavior
- **Auto:** Write the invite list, notify admin group
- **Review:** Present invite list for approval (this is a gate step)

## Dry-Run Behavior
When `--dry-run` is active:
- Write the invite list (LLO names, contacts, rationale) to
  `comms-log/dry-run-llo-invite.md`
- State tracks as `dry-run-success`

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
| 2026-04-14 | Split prepare-vs-send: this skill only prepares in Phase 3; sending moves to `llo-onboarding` in Phase 5 so the onboarding email can include the OCS widget link | ACE team |
| 2026-04-17 | Emit gate brief at `ACE/<opp-name>/gate-briefs/llo-invite.md` so the last-human-check-before-external-send surfaces incomplete rows and count drift | ACE team (PM scout, internal-admin lens) |
