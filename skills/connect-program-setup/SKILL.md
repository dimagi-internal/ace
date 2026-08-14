---
name: connect-program-setup
description: >
  Create or reuse a Connect Program for the opportunity, archetype-matched
  to the PDD. Captures program_id for downstream skills.
disable-model-invocation: false
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
   Call `connect_list_programs({organization_slug})` **with NO `name`
   filter** and consider the full org list (dimagi-internal/ace#1252).
   A name-substring scan is structurally blind to a same-domain,
   same-archetype program under different words — live case: a
   `name: 'Bednet'` query returned 12 programs and could never return
   `Malaria ITN Exploration Multi-Stage Study`, the one same-domain
   multi-stage candidate in the org. Program names are generated
   per-archetype by this very skill, so two runs of the same real
   intervention that describe their domain differently will never find
   each other by name, by construction — and the silent miss creates
   exactly the duplicate program the reuse rule exists to prevent.

   Match candidates on **delivery type + archetype** (both structured,
   both known at this point); use the name only for ranking/display.
   Unfiltered rows carry `null` for delivery_type/budget/currency/
   country/dates — hydrate the shortlisted candidates via
   `connect_get_program` before judging fit on those. (The `name` filter
   remains available as a case-insensitive substring match whose rows
   come back fully hydrated, jjackson/ace#1089 — fine for a targeted
   lookup, never for the reuse scan.)
   Prefer archetype-matched programs when reusing — running
   an FGD opp under a program whose other opps are all atomic-visit
   creates a mixed-method reporting headache downstream.

   **Record the candidate set in the artifact:** `connect-program-setup.md`
   § Reuse-vs-create decision must state how many programs were
   considered (the full org count) and on what axis they were matched,
   so "no reusable program existed" is falsifiable by a reader. A count
   that silently reflects a name-filtered subset is the #1252 defect.

3. **Decide: reuse or create**
   - If an existing program fits AND shares the archetype, note the
     program ID; run step 3a, then skip step 4.
   - If an existing program matches the domain but not the archetype,
     flag the mismatch in the gate brief / program notes; default to
     creating a new one unless the admin explicitly opts in.
   - If no match: proceed to step 4.

3a. **Reconcile reused program content against THIS run's PDD
   (jjackson/ace#1078).** Only the program's *identity* is durable
   (UUID, org, delivery type, currency, country, name — see
   `agents/orchestrator-reference.md § Fork Points`). Its *content*
   (description, budget, dates) was authored from the PDD of whichever
   run created it, and a later run's PDD can contradict it — the live,
   LLO-facing program once advertised an enforced 500m GPS payment gate
   the current PDD deliberately made non-enforcing. On every reuse:

   1. `connect_get_program({ organization_slug, program_id })` → live
      refreshable fields.
   2. Compare against this run's PDD-derived values with
      `reconcileProgramWithPdd` (`lib/program-reconcile.ts` — pure
      helper; run it via `npx tsx -e` or replicate its semantics
      exactly: description/dates compare whitespace-normalized; budget
      diverges only when the live ceiling is *below* the PDD budget,
      since Step 4a deliberately raises it above for headroom).
   3. If `inSync`: note "program content verified against this run's
      PDD" in the program notes and continue.
   4. If diverging AND updating is safe (the normal case at Phase 4 —
      this run has not published a solicitation yet): apply the
      helper's `updateArgs` via `connect_update_program({
      organization_slug, program_id, ...updateArgs })` (it accepts
      exactly `name/description/budget/start_date/end_date`; never
      send delivery_type/currency/country — durable). Log each
      refreshed field (old → new) in the program notes.
   5. If updating is unsafe (a live solicitation or external artifact
      already references the current text, or review mode withheld
      approval): emit the helper's `[WARN]` lines verbatim into the
      program notes and the run summary — one per diverging field —
      so the divergence lands somewhere visible instead of nowhere.

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
   2. `connect_list_opportunities({ organization_slug, hydrate: true })` →
      then filter to this program yourself and sum `total_budget` across
      the managed opps.

      **Do NOT pass `program_id`, and `hydrate` is required (ace#1022).**
      The opportunity list page carries no program column and no budget, so
      the atom used to silently ignore the filter and return the whole org
      — and `total_budget` was never in the returned shape at all. Both
      inputs to this sum were therefore unobtainable and the headroom check
      **silently no-opped**, which is exactly the failure ace#588 was filed
      to prevent; it surfaced later as an un-actionable "Budget exceeds the
      program budget" rejection on `connect_create_opportunity`.
      `program_id` is now refused loudly rather than dropped.

      If a hydrated row still carries no `total_budget`, treat the sum as
      **unknown** and raise the ceiling on the conservative assumption
      rather than computing a headroom from partial data — a wrong Σ is
      what makes this check worse than no check.
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
  - `connect_list_programs` — discovery (`name` = case-insensitive substring; filtered rows hydrated)
  - `connect_list_delivery_types` — resolve human name → slug/int FK if needed
  - `connect_create_program` — create (REST `POST /api/programs/`)
  - `connect_get_program` — verify after create; read live fields for reconcile (Step 3a) and `budget` for the headroom check (Step 4a)
  - `connect_list_opportunities` — sum managed-opp budgets for the headroom check (Step 4a)
  - `connect_update_program` — refresh stale description/dates on reuse (Step 3a); raise the program budget ceiling idempotently (Step 4a)

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
| 2026-07-30 | Step 3a: reconcile reused program content (description/budget/dates) against the current run's PDD via `lib/program-reconcile.ts` — update or `[WARN]` per diverging field (jjackson/ace#1078). Note substring-match + hydration semantics of `connect_list_programs` (jjackson/ace#1089). | ACE team |
