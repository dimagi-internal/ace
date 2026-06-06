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

## Phase folder anchor

The connect-setup agent passes a `phaseFolderId` (the `4-connect` folder ID,
anchored to the run folder per `agents/orchestrator-reference.md § Per-Phase
Folder Lifecycle`). **Every `drive_create_file` write in this skill MUST set
`parentFolderId = phaseFolderId`** — `drive_create_file`'s `parentFolderId` is
required and must be a folder ID, never a path string. Writing by path-string
alone makes the artifact land outside `4-connect` and fail
`verify_phase_artifacts(phase='connect')` (jjackson/ace#635).

## Products

- `4-connect/connect-program-setup.md` (written with `parentFolderId = phaseFolderId`) — program-id, decision rationale (reuse / create), admin program URL
- `opp.yaml.connect.program.{id, url, connect_int_id}` — written on first create (and refreshed on reuse with verified live values). `connect_int_id` is ConnectProd's integer program id (from the create response's `int_id`), used by Phase 8 solicitation surfaces. This is the single durable cross-run reference for the Connect program; every subsequent run of this opp reads it to skip program-create.

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

4a. **Ensure program budget headroom (idempotent — both reuse and create
   paths) (jjackson/ace#588).** Connect's program-budget validation on
   `connect_create_opportunity` ("Budget exceeds the program budget") sums
   the `total_budget` of **all** managed opps on the program — including
   the inactive opps left by every prior `/ace:run` — against the fixed
   program ceiling. There is no budget reclamation when a per-run opp goes
   inactive, and per-run opp accumulation is expected by design (see
   CLAUDE.md). So the ceiling monotonically fills until Phase 4 can no
   longer create *any* opp (observed on malaria-rdt 20260531-0739: even a
   2000 opp rejected against a 25000 ceiling with ~14 prior opps).

   Because this is the durable, reused program (the reuse path skips
   create, so its budget never grows on its own), size the headroom here:

   1. `connect_get_program({ organization_slug, program_id })` →
      `program.budget`.
   2. `connect_list_opportunities({ organization_slug, program_id })` →
      `Σ(total_budget)` across all managed opps.
   3. If `program.budget − Σ < EXPECTED_OPP_BUDGET × 3` (keep room for at
      least a few more runs; `EXPECTED_OPP_BUDGET` = the PDD's per-opp
      budget, default the program's own per-opp figure), raise the ceiling
      via `connect_update_program({ organization_slug, program_id,
      budget: Σ + EXPECTED_OPP_BUDGET × 10 })` — a generous buffer so this
      step rarely re-fires. Idempotent: a no-op when headroom is already
      ample. Log the before/after budget in the program notes (Step 5).
      **Single-opp floor:** `EXPECTED_OPP_BUDGET` must itself be at least
      `min_budget_for_one_user × FUND_USERS` (= `Σ(max_total × (amount +
      org_amount))` over the planned payment units × ~3, the same floor
      `connect-opp-setup` Step 4 enforces). If the PDD's per-opp budget is
      below that floor, use the floor — the program ceiling must be able to
      fund at least one opp that funds ≥1 FLW at its payment-unit max, or
      Phase 4 will halt on the budget-funds-≥1-FLW guard.

   This makes the by-design per-run accumulation safe without a
   reclamation mechanism (none exists yet — a payment-unit-delete /
   opp-budget-zeroing capability is tracked upstream, see
   jjackson/ace#573). When Connect's budget check is changed to count
   only *active* managed opps (the real fix, jjackson/ace#588), this
   headroom step can be relaxed.

5. **Write program details** via `drive_create_file` with
   `parentFolderId = phaseFolderId` (the `4-connect` folder; surfaced at
   `ACE/<opp-name>/runs/<run-id>/4-connect/connect-program-setup.md`):
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
       connect_int_id: <integer | omit>   # ConnectProd integer program id, from the create response's `int_id` when present. NOT a labs-minted id. Lets solicitation-create skip a Labs round-trip. Omit if the create response didn't carry it (older Connect builds) — solicitation-create resolves it as a fallback.
   ```

   Capture `connect_int_id` from the `connect_create_program` response
   (`int_id`) on the create path. On the reuse path, leave any existing
   `connect_int_id` in `opp.yaml` as-is (don't clear it); if it's absent
   and `connect_get_program` returns an `int_id`, write it.

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
- Google Drive: `drive_read_file`, `drive_create_file` (always with `parentFolderId = phaseFolderId` — the `4-connect` folder ID, never a path string), `update_yaml_file` (write `opp.yaml.connect.program` block, `merge: 'shallow'`)
- Connect (`ace-connect` MCP, 0.10.47+):
  - `connect_list_programs` — discovery
  - `connect_list_delivery_types` — resolve human name → slug/int FK if needed
  - `connect_create_program` — create (REST `POST /api/programs/`)
  - `connect_get_program` — verify after create; read `budget` for the headroom check (Step 4a)
  - `connect_list_opportunities` — sum managed-opp budgets for the headroom check (Step 4a)
  - `connect_update_program` — raise the program budget ceiling idempotently (Step 4a)

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
