---
name: connect-program-setup
description: >
  Create or reuse a Connect Program for the opportunity, archetype-matched
  to the PDD. Captures program_id for downstream skills.
disable-model-invocation: true
---

# Connect Program Setup

Create or select a Connect program for this opportunity.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `1-design/idea-to-pdd.md` | archetype-aware program naming + domain match |
| Connect MCP | `connect_list_programs({organization_slug})` | reuse-vs-create decision |

## Products

- `4-connect/connect-program-setup.md` — program-id, decision rationale (reuse / create), admin program URL
- `opp.yaml.connect.program.{id, url}` — written on first create (and refreshed on reuse with verified live values). This is the single durable cross-run reference for the Connect program; every subsequent run of this opp reads it to skip program-create.

## Process

1. **Read the PDD** from `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md`, including the
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

5. **Write program details** to `ACE/<opp-name>/runs/<run-id>/4-connect/connect-program-setup.md`:
   - Program ID (UUID)
   - Program name
   - Archetype declared at program creation (if new)
   - Whether reused or newly created; note any archetype mismatch if reused
   - Configuration details (delivery_type name + id, budget, currency,
     country, dates)

6. **Persist program reference to `opp.yaml`** via
   `mcp__plugin_ace_ace-gdrive__update_yaml_file` with the default
   `shallow` merge — `connect:` is a top-level scalar key:

   ```yaml
   connect:
     program:
       id: <UUID from step 3 reuse or step 4 create>
       url: <CONNECT_BASE_URL>/a/<org>/program/<uuid>/
   ```

   `opp.yaml` is the **only** cross-run identity surface for the
   Connect program — every subsequent run of this opp reads this
   block to skip program-create (Step 3 reuse path). The Connect
   *opportunity*, OCS chatbot, solicitation, etc. are per-run and
   live in the producing run's `run_state.yaml.phases.*.products.*`;
   only `program` is durable here.

   Skip this write on the reuse path **only** if the existing
   `opp.yaml.connect.program.id` value already matches what we just
   verified live — no-op writes are fine but unnecessary. On any
   value mismatch, overwrite (the live value wins; opp.yaml gets
   corrected).

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`, `update_yaml_file` (write `opp.yaml.connect.program` block, `merge: 'shallow'`)
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
| 2026-04-28 | Replace HITL workaround with `connect_*_program` atoms (ace-connect 0.8.1) | ACE team |
| 2026-04-30 | Switch `connect_create_program` to `POST /api/programs/` (commcare-connect PR #1135). `delivery_type` now accepts the slug; `country` is the human country name. (0.10.47) | ACE team |
