---
name: connect-opp-setup
description: >
  Create and configure an Opportunity in Connect — including verification rules,
  delivery units, payment units, and all other configuration needed for the opp.
---

# Connect Opportunity Setup

Create and fully configure a Connect opportunity.

## Process

1. **Read inputs from GDrive:**
   - PDD: `ACE/<opp-name>/pdd.md`
   - Program details: `ACE/<opp-name>/connect-setup/program.md`
   - App deployment details: `ACE/<opp-name>/deployment-summary.md`

2. **Read the PDD's `archetype:` and `## Evidence Model` section.** These are the inputs for steps 3–5 below. The Evidence Model's Layer A column is the spec for verification rules; Layer B/C inform soft flags. **If the PDD has no Evidence Model section, stop and return an error** — the PDD is incomplete and `idea-to-pdd` should re-run with the stress-test rubric.

3. **Create the Opportunity** in Connect:
   - Name from PDD
   - Link to Program from previous step
   - Delivery type: "Experiment" (generic type) or the type required by the archetype (see `## Archetypes` below)
   - Start/end dates from PDD timeline
   - Link to CCHQ apps

4. **Configure verification rules from Evidence Model Layer A.**
   - Each Layer A row in the PDD's Evidence Model maps to one verification rule. Quote the row's "Verified by" condition directly in the rule definition so the rule's intent traces back to the PDD.
   - Hard gates only — Layer A rules block payment, not flag.
   - Layer B and Layer C entries become **soft flags** (logged for human review, do not block).

5. **Configure delivery units from the Deliver app structure.**
   - Read the unit definition from the PDD's archetype section (see `## Archetypes` below) — for `atomic-visit` it's per-beneficiary; for `focus-group` it's per-session.
   - Set expected total count from the PDD's intervention design (e.g., "6 sessions across 6 segments").
   - Set timeline from the PDD timeline.

6. **Configure payment units:**
   - Based on delivery units and budget from PDD
   - Set payment rates and schedules

7. **Write config summary** to `ACE/<opp-name>/connect-setup/opportunity.md`:
   - Opportunity ID and URL
   - All configuration details
   - Verification rules
   - Delivery and payment unit setup

## Archetypes

The opportunity's delivery unit, payment unit, and verification rules depend on the PDD's `archetype:` field. **Read the PDD's `## Evidence Model` section first** — it tells you exactly what Layer A (delivery proof) gates to enforce.

### `atomic-visit`
- **Delivery unit**: one verified beneficiary visit (Layer A passes — GPS + photo + form complete)
- **Payment unit**: per verified visit; optional bonus tier when Layer B passes (e.g., AI photo-quality check)
- **Verification rules** (drawn from Evidence Model Layer A):
  - GPS within expected geographic area
  - Photo present and Layer-B-detectable (e.g., color reference card visible)
  - Form fields complete
  - Per-FLW and per-location daily caps respected
  - Time-of-day and inter-visit-gap behavioral plausibility checks
- **Soft flags** (Layer C): per-FLW outliers, cross-FLW clustering, value distribution anomalies — these don't block payment but flag for human review

### `focus-group`
- **Delivery unit**: one **completed group session with full evidence** — not one participant. The unit is the session.
- **Payment unit**: per verified session. Set the total payment unit count to the PDD's planned number of sessions (e.g., 6 sessions = 6 payment units), not number of participants.
- **Verification rules** (drawn from Evidence Model Layer A):
  - GPS within expected venue area (or simply "within target community" — venue GPS is less meaningful for focus groups than for atomic visits)
  - Audio file uploaded, duration ≥ 45 minutes (or whatever floor the PDD specifies)
  - Attendance form complete (participant count matches segment requirement)
  - Per-domain summary sections all completed
  - Consent confirmation present
  - Facilitator reflection present
- **Soft flags** (Layer B/C): AI quality check on per-domain summaries (specificity, presence of quotes, theme coherence), differentiation across segments
- **Connect delivery type**: use the new generic "Experiment" delivery type, not a standard atomic-visit type. If "Experiment" doesn't exist yet, this is one of the PDDs that requires it (Connect Tech Work item #2 in the planning spreadsheet).

### `multi-stage`
Create one Connect opportunity per stage **OR** one opportunity with two delivery-unit configurations, depending on whether stages overlap in time and whether they involve different LLO sets. Use the PDD's Stage Gate to decide whether Stage 2's opportunity is created up front or only after Stage 1's results are in.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Connect: `create_opportunity`, `set_verification_rules`, `set_delivery_units`, `set_payment_units` — **NOT YET BUILT** (CCC-301)

## Current Workaround
1. Read PDD and determine all configuration requirements
2. Generate a complete configuration spec document
3. Write it to `ACE/<opp-name>/connect-setup/opp-config-spec.md`
4. Ask the user to create the opportunity in Connect UI following the spec
5. Ask for the Opportunity ID and URL
6. Record in the opportunity folder

## Mode Behavior
- **Auto:** Configure (or guide manual config), proceed
- **Review:** Present configuration spec for approval before creating

## Dry-Run Behavior
When `--dry-run` is active:
- Write the full opportunity configuration (name, dates, verification rules, delivery units, payment units) to `comms-log/dry-run-connect-opp-setup.md`
- Do not create or configure the opportunity in Connect
- State tracks as `dry-run-success`

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
| 2026-04-08 | Add `## Archetypes` section: focus-group delivery unit = session (not participant), audio + attendance + per-domain summary verification, requires "Experiment" delivery type | ACE team (PM scout, focus-group framework lens) |
| 2026-04-08 | Add explicit step 2 to read PDD `## Evidence Model`; Layer A → verification rules, Layer B/C → soft flags; error if Evidence Model missing | ACE team (PM scout, focus-group framework lens) |
