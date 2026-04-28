---
name: llo-invite
description: >
  Identify candidate LLOs for a Connect opportunity and prepare the invite
  list. First step of Phase 5 (LLO Management), running after the OCS
  chatbot has cleared its deep-eval gate. Sending happens next in
  `llo-onboarding`.
---

# LLO Invite

Identify and prepare the invite list for LLOs to participate in the opportunity.
This skill runs as the first step of Phase 5 (LLO Management), after the
OCS chatbot has passed its deep-eval quality gate in Phase 4. The list
is reviewed (gate), then `llo-onboarding` (next step in the same phase)
issues the Connect invites and sends the ACE onboarding email with the
OCS widget link.

**Why Phase 5, not Phase 3:** we don't want to commit to an LLO roster
(or burn a review-mode gate on it) before the chatbot they'll be using is
known-good. Moving invite prep after the OCS deep-eval gate means we
only propose names once we're ready to follow through.

## Process

1. **Read inputs from GDrive:**
   - PDD: `ACE/<opp-name>/pdd.md` (LLO preferences section)
   - Opportunity details: `ACE/<opp-name>/connect-setup/opportunity.md`

2. **Read the PDD's `archetype:` field.** Selection criteria differ by
   archetype — see `## Archetypes` below. Use the archetype's criteria
   set in step 3 below; fall back to `atomic-visit` if unspecified.

3. **Look up LLO contacts:**
   - Check PDD for preferred/known LLOs
   - Search LLO Directory for matching organizations, using the
     archetype-appropriate capability criteria from `## Archetypes`
   - Get contact details for each LLO

4. **Prepare invite list:**
   - LLO name, contact person, email
   - Why this LLO was selected — rationale must reference the
     archetype-specific criteria from `## Archetypes` (not just
     "geographic match"). For FGD archetypes: facilitator skill,
     language/cultural fit, audio-equipment access, training-readiness
     if facilitator skill is thin
   - Opportunity summary for the invite

5. **Write invite list** to `ACE/<opp-name>/connect-setup/invites.md` with
   status `prepared` for each entry. `llo-onboarding` (the next step in
   Phase 5) picks this up, issues the Connect invite, and flips the
   status to `sent`. Path is kept under `connect-setup/` for back-compat
   with opps that had this file written under the old Phase-3 placement.

6. **Write the gate brief** to `ACE/<opp-name>/gate-briefs/llo-invite.md`
   using the shape defined in `agents/ace-orchestrator.md § Gate Brief Contract`.
   See `## Gate Brief` below for the exact fields this skill populates.

## Gate Brief

The gate brief at `ACE/<opp-name>/gate-briefs/llo-invite.md` lets the admin
validate the invite list before `llo-onboarding` (the very next step in
this phase) actually sends invites. This is the last review step before
ACE contacts external LLOs — the highest bad-send risk in the pipeline.

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
    (for `focus-group`, also WARN if count > 2 without multi-site
    justification — FGD quality degrades with facilitator variance)
  - `[WARN]` for `focus-group` opps if any rationale is silent on
    facilitation capability (experience or training plan)
  - `[INFO]` for each LLO that has not previously worked with Dimagi
    (onboarding will take longer)
  - "None — all auto-checks passed." if the list is clean
- **Recommended Disposition:** `Approve` if zero `[BLOCKER]`; `Iterate` if
  any row is incomplete or duplicated; `Reject` if the list size or
  composition is off — re-run with corrected PDD LLO preferences

## Archetypes

Different archetypes demand different LLO capabilities. Selection
criteria and expected invite count both shift with archetype — a
6-session FGD pilot needs 1–2 qualitative-capable LLOs, not the 3–5
field-execution LLOs a typical atomic-visit opp wants.

### `atomic-visit` (default)

**Selection criteria:**
- Geographic coverage of the intervention area
- Established FLW network ready to deploy
- History of comparable atomic-visit work (household data collection,
  market surveys, etc.)
- Capacity to deliver planned volume within the PDD timeline

**Expected count:** matches the PDD's LLO reach (usually 2–5 LLOs to
cover geography + capacity).

### `focus-group`

**Selection criteria:**
- **Qualitative research experience** (prior FGDs, semi-structured
  interviews, ethnographic fieldwork) OR demonstrated willingness to
  invest in facilitator training — don't assume generic CHW networks
  have this skill
- **Language + cultural fit** for the target segment — sensitive topics
  (health beliefs, stigmatized practices) require a facilitator the
  participants will open up to
- **Audio-recording capability** — quality phone/recorder, quiet venue
  access, ability to upload large files reliably
- **Facilitator time availability** — FGD facilitation is intensive
  prep + delivery + write-up per session, not stackable like atomic
  visits. A per-session payment rate should reflect this
- **Smaller-N bias** — 1–2 LLOs covering all sessions is usually better
  than 5 LLOs each doing one session. Variance across facilitators
  confounds cross-session theme comparison

**Expected count:** 1–2 LLOs total, unless the PDD has multi-site
coverage needs that force more. Flag explicitly if the PDD's LLO
reach reads "several LLOs" without justifying why for FGD work.

**Training consideration:** if no candidate LLO has strong facilitation
experience, explicitly add a training line in the rationale — this is
input to `training-materials` in Phase 2 and to the LLO's capacity
planning. Don't silently assume skills that don't exist.

### `multi-stage`

Pick the appropriate selection set per stage. The same LLO can execute
multiple stages if it has the capabilities for each; otherwise list
per-stage LLOs in the invite list with the stage named in the
rationale (e.g., "Stage 1 facilitator, Stage 2 field lead").

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- This skill is **preparation-only** — no Connect mutation calls.
  Sending happens in `llo-onboarding` (the next step in Phase 5) via
  `connect_send_llo_invite`. The eventual `list_llo_contacts` /
  Directory API would replace the manual PDD-driven candidate selection
  but is still pending in CCC-301.

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
| 2026-04-20 | Move entire skill from Phase 3 (connect-setup) to Phase 5 (llo-manager) as the first step. We now don't commit to an invite roster until the OCS chatbot has cleared its deep-eval gate — no point proposing LLOs until we know what we'll hand them | ACE team |
| 2026-04-17 | Emit gate brief at `ACE/<opp-name>/gate-briefs/llo-invite.md` so the last-human-check-before-external-send surfaces incomplete rows and count drift | ACE team (PM scout, internal-admin lens) |
| 2026-04-19 | Added `## Archetypes` section with per-archetype selection criteria; `focus-group` emphasizes qualitative research experience, language/cultural fit, audio-recording capability, facilitator time, small-N bias (1–2 LLOs). Gate brief WARNs for FGD count > 2 without justification and for silent-on-facilitation rationale. Motivated by cosmetics-fgd-pilot recon (2026-04-19) backlog item | ACE team (qa/eval iteration loop) |
| 2026-04-28 | Removed `## Current Workaround` (no atom needed — this is a prep-only skill; sending moved to `llo-onboarding` via `connect_send_llo_invite` in 0.8.1) | ACE team |
