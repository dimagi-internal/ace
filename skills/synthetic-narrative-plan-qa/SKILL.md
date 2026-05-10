---
name: synthetic-narrative-plan-qa
description: >
  Structural QA on the synthetic-narrative-plan manifest YAML. Zod-schema
  primitive + cross-field checks. Binary pass/fail. Catches malformed
  manifests before connect-labs MCP boundary, with structured auto-fix hints.
disable-model-invocation: true
---

# Synthetic Narrative Plan QA

Structural correctness checks on `6-synthetic/synthetic-narrative-plan.yaml`,
the manifest authored by `synthetic-narrative-plan` and consumed by
`synthetic-data-generate` → `mcp__connect-labs__synthetic_generate_from_manifest`.

The Connect-Labs MCP validates the manifest at its boundary, but boundary
validation is slow + costly to discover (one full dispatch round-trip). This
QA gives faster failure + structured `auto_fix_hint` per check so the
orchestrator can drive a tight regen loop without burning a labs call.

Zod is the primary primitive — schema + cross-field invariants. All checks
are static, all run in <100ms via `checks.ts`. No LLM.

See `skills/_qa-template.md` for the shared QA contract (verdict YAML
format, auto-fix protocol, static-vs-LLM rules).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 6 producer | `6-synthetic/synthetic-narrative-plan.yaml` | the manifest under structural check |
| Phase 2 (optional context) | `2-commcare/app-deploy_summary.md` | field-path resolvability for KPIs / anomalies (skipped with INFO when absent) |

## Outputs

- `6-synthetic/synthetic-narrative-plan-qa_result.yaml` — QA result per `lib/qa-types.ts`

## Checks

| # | id | type | description | auto-fix on fail |
|---|---|---|---|---|
| 1 | `manifest_yaml_parses` | static | File parses as a YAML mapping (not null, not a sequence at top level) | re-emit valid YAML — likely truncated mid-write or hand-edit broke quoting |
| 2 | `required_keys_present` | static | Top-level required keys present: `opportunity_id`, `opportunity_name`, `random_seed`, `timeline`, `flw_personas`, `beneficiary_cohorts`, `kpi_config` | re-emit the manifest with the missing top-level keys (default values OK; eval grades quality separately) |
| 3 | `flw_personas_well_formed` | static | `flw_personas` is a non-empty array; each item has `id` (REQUIRED, snake_case per upstream) + `archetype`; archetype value is in {rockstar, steady, struggling, new_hire} | regenerate flw_personas with required fields + valid archetypes; default mix is 1 rockstar / 2 steady / 1 struggling / 1 new_hire |
| 4 | `kpi_field_paths_resolvable` | static (with optional context) | If deliver-app summary is in `ctx.deliver_summary`, each `kpi_config[].field_path` appears in the summary text. If summary absent, returns INFO-style pass with detail noting the skip. | fix the field_path to reference a real form question path from the deliver app; common paths are listed in the deliver-app summary |
| 5 | `anomalies_traceable` | static | `anomalies` (when present) is an array; each anomaly has `id`, `type` (in {field_outlier, missing_visits, duplicate_submission}), `flw_ids` (non-empty list — **plural per upstream Pydantic**), a week reference (`week` or `weeks`), and one of `field_path` / `detection_path` | populate id + type + flw_ids (list, not singular flw_id) + week + detection_path per anomaly; an anomaly without detection is reviewer-invisible downstream |
| 6 | `coaching_arcs_match_personas` | static | Every `coaching_arcs[].flw_id` is in `flw_personas[].id`. Empty `coaching_arcs` passes trivially. | fix the flw_id to match a persona id, or add the persona |
| 7 | `random_seed_present` | static | `random_seed` is a non-negative integer (upstream allows 0; deterministic generation requirement) | set `random_seed:` to today's date as YYYYMMDD |
| 8 | `timeline_dates_consistent` | static | `timeline.start_date` < `timeline.end_date` (ISO date strings) and `timeline.weeks` ≥ 1 | fix the timeline so start_date precedes end_date and weeks ≥ 1 |

The static check functions live at `skills/synthetic-narrative-plan-qa/checks.ts` as importable TS. Every check returns a `QACheckResult` (`{pass, detail?, auto_fix_hint?}`) per `lib/qa-types.ts`.

**Adding a check:** append to the `CHECKS` array in `checks.ts`, add a row to the table above (matching `id`), add a unit test in `test/skills/synthetic-narrative-plan-qa/checks.test.ts`.

## Process

1. **Read the manifest artifact** from Drive:
   `drive_read_file(file_id=<synthetic-narrative-plan.yaml drive id>)`.

2. **(Optional) Read the deliver-app summary** if available at
   `runs/<run-id>/2-commcare/app-deploy_summary.md`; pass its text via the
   runner's `--context-file` (or skip — check 4 returns INFO when absent).

3. **Save to a local temp path** so the CLI runner can read it.
   `Bash: TMP=$(mktemp); drive content saved to $TMP`.

4. **Run all checks** via the generic CLI runner:
   `Bash: npx tsx scripts/qa-run.ts --skill synthetic-narrative-plan-qa --artifact "$TMP" --target "<opp-name>" --capture-path "6-synthetic/synthetic-narrative-plan.yaml"`.

   The runner imports `CHECKS` from `skills/synthetic-narrative-plan-qa/checks.ts`,
   runs each check via `lib/qa-runner.ts`, and prints a fully-shaped
   `QAResult` YAML to stdout.

5. **Write the QA result** to Drive at
   `6-synthetic/synthetic-narrative-plan-qa_result.yaml` via
   `drive_create_file`.

6. **Return the verdict** to the orchestrator:
   - `pass` → eval can proceed
   - `fail` → orchestrator attempts auto-fix using `failures[].auto_fix_hint`; re-runs `synthetic-narrative-plan` then re-runs this skill
   - `incomplete` → manifest missing entirely; halt with operator-actionable error

## Auto-fix protocol

See `skills/_qa-template.md § Auto-fix protocol` for the canonical contract. Briefly:

- Default 2 auto-fix attempts per QA run.
- On fail, orchestrator passes each `auto_fix_hint` to `synthetic-narrative-plan` with explicit "fix this and re-emit" instructions.
- Re-run QA after each attempt. If still failing after 2 attempts, halt with `verdict: incomplete` and surface the unresolved failures + hints.

QA is **necessary but not sufficient**. A passing QA result means the manifest is structurally gradable, NOT that the data story is good — the eval (`synthetic-narrative-plan-eval`) grades that.

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_create_file`
- Bash: `npx tsx scripts/qa-run.ts ...` (runs static checks via `lib/qa-runner.ts`)

## Mode Behavior

- **Auto:** Run checks, write QA result, return verdict.
- **Review:** Same as Auto. QA is binary — there's no human pause-and-review step.

## Dry-Run Behavior

When `--dry-run` is active:
- All reads happen normally (read-only).
- The QA result IS written (it's an internal artifact, not an external comm).
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-09 | Initial skill — closes the deferred has-QA row in `_qa-decisions.md` for `synthetic-narrative-plan`. Eight static checks anchored on a Zod schema mirror of the connect-labs `synthetic_generate_from_manifest` manifest contract: YAML parse, required keys, flw_personas shape + archetype enum, KPI field-path resolvability (context-dependent), anomaly traceability, coaching-arc cross-ref, random_seed presence, timeline date consistency. | ACE team |
| 2026-05-09 | **Cross-checked Zod against upstream Pydantic** at `commcare_connect/labs/synthetic/generator/manifest.py` (connect-labs origin/main commit `c20a91b6`). Five drift fixes: (1) `anomalies[].flw_ids` is a list, not singular `flw_id` (was the highest-cost drift — earlier draft would have failed on every valid manifest); (2) `flw_personas[].id` is REQUIRED upstream (was optional); (3) `random_seed` is `NonNegativeInt` (0 OK), was `PositiveInt` (≥1); (4) `opportunity_name` added to required keys; (5) `kpi_config` is min_length=1, was unbounded. AnomalyZ now also requires `id` and `type` (enum). KpiZ requires `kpi`, `field_path`, `aggregation` (enum). Schema-skeleton approach: mirror upstream's required field structure (names, arity, list-vs-scalar) but don't re-validate every value constraint upstream enforces. | ACE team |
