---
name: connect-program-setup
description: >
  Create or configure a Program in Connect for the CRISPR-Connect opportunity.
  Checks if an existing program fits before creating a new one.
---

# Connect Program Setup

Create or select a Connect program for this opportunity.

## Process

1. **Read the PDD** from `ACE/<opp-name>/pdd.md`, including the
   `archetype:` field. Program shape is mostly archetype-agnostic, but
   program NAME and DESCRIPTION should signal archetype so future opps
   under the same program can be grouped coherently. See
   `## Archetypes` below.

2. **Check for existing programs** that match this opportunity's domain/scope.
   Call `connect_list_programs` (with `organization_slug` from the
   opportunity context — typically `ai-demo-space` for ACE-managed
   programs). Prefer archetype-matched programs when reusing — running
   an FGD opp under a program whose other opps are all atomic-visit
   creates a mixed-method reporting headache downstream.

3. **Decide: reuse or create**
   - If an existing program fits AND shares the archetype, note the
     program ID; skip step 4.
   - If an existing program matches the domain but not the archetype,
     flag the mismatch in the gate brief / program notes; default to
     creating a new one unless the admin explicitly opts in.
   - If no match: proceed to step 4.

4. **Create the program** via `connect_create_program`:
   - `organization_slug`: `ai-demo-space` (or whichever PM-side org the
     opportunity is configured for; must be a program-manager org)
   - `name`: archetype-signaling name (e.g. `"Vaccine Hesitancy Pilot
     (FGD) — Q2 2026"`)
   - `description`: PDD's intervention summary
   - `delivery_type`: slug (preferred — e.g. `"nutrition"`) or int FK
     from `connect_list_delivery_types`. The new automation API accepts
     the slug directly; the old form-driven backend required the int.
   - `budget`: total program budget from the PDD
   - `currency`: 3-letter ISO (e.g. `USD`)
   - `country`: human country name as Connect renders it
     (e.g. `"United States of America"`, not `"USA"`)
   - `start_date` / `end_date`: PDD timeline (YYYY-MM-DD)

5. **Write program details** to `ACE/<opp-name>/connect-setup/program.md`:
   - Program ID (UUID)
   - Program name
   - **URL** — the program detail page on Connect (mirrors the URL line
     `connect-opp-setup` writes for the opportunity). Pattern:
     `https://connect.dimagi.com/a/<organization_slug>/program/<program-uuid>/view`
     (note: `program/` singular, matching upstream
     `commcare-connect/program/urls.py`'s `<slug:pk>/view` pattern). Format
     as `**URL:** <url>` so downstream readers (ace-web's public
     summary page) can extract it the same way they do the opportunity URL.
   - Archetype declared at program creation (if new)
   - Whether reused or newly created; note any archetype mismatch if reused
   - Configuration details (delivery_type name + id, budget, currency,
     country, dates)

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Connect (`ace-connect` MCP, 0.10.47+):
  - `connect_list_programs` — discovery
  - `connect_list_delivery_types` — resolve human name → slug/int FK if needed
  - `connect_create_program` — create (REST `POST /api/programs/`)
  - `connect_get_program` — verify after create

## Mode Behavior
- **Auto:** Create program (or reuse), proceed
- **Review:** Present program choice for approval before calling
  `connect_create_program`

## Dry-Run Behavior
When `--dry-run` is active:
- Write the program configuration (name, description, settings) to
  `comms-log/dry-run-connect-program-setup.md`
- Do not call `connect_create_program`
- State tracks as `dry-run-success`

## Archetypes

Program-level naming + description should hint the archetype for
downstream coherence:
- `atomic-visit`: prefer names like `"<Domain> Survey — <Year>"` or
  `"<Domain> Field Deployment"`. Description leads with FLW deployment.
- `focus-group`: prefer names like `"<Domain> FGD Pilot"` or
  `"<Domain> Qualitative Research"`. Description leads with discussion-
  group method.
- `multi-stage`: prefer names like `"<Domain> Multi-Stage Study"`.
  Description names each stage's protocol.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
| 2026-04-28 | Replace HITL workaround with `connect_*_program` atoms (ace-connect 0.8.1) | ACE team |
| 2026-04-30 | Switch `connect_create_program` to `POST /api/programs/` (commcare-connect PR #1135). `delivery_type` now accepts the slug; `country` is the human country name. (0.10.47) | ACE team |
