---
name: verdict-yaml-qa
description: >
  Static QA on verdict YAML files written by any `-eval` skill.
  Validates schema (lib/verdict-schema.ts) plus cross-field invariants
  (weight sum, weighted-mean consistency, verdict-tier ranges, gate
  disposition, live_state_verified cap). Binary verdict; static-only,
  no LLM. Single shared helper covering all 27 -eval skills.
disable-model-invocation: true
---

# Verdict YAML QA

Cross-cutting QA skill that checks any `<producer>-eval_verdict.yaml` for structural correctness — the contract every consumer of an eval verdict (notably `opp-eval`) depends on. Single shared helper, NOT one QA skill per eval; this is the "eval-self-QA" deferred workstream from `_eval-decisions.md` finally landing.

Companion to per-producer `-qa` skills (`idea-to-pdd-qa`, `synthetic-narrative-plan-qa`, etc.) which check artifact correctness *before* the eval grades it. `verdict-yaml-qa` runs *after* the eval, on the verdict the eval emitted.

The 7 checks are split into specific, actionable failures (each with its own `auto_fix_hint`) rather than one bulk schema validation, so when a producing `-eval` skill ships a malformed verdict the orchestrator's auto-fix loop has a single concrete instruction to pass back ("redistribute weights to sum to 1.0"; "align verdict and overall_score"; etc.).

See `skills/_qa-template.md` for the shared QA contract (verdict YAML format, auto-fix protocol, static-vs-LLM rules). Companion to `lib/verdict-schema.ts` (which defines the verdict shape) — this skill validates instances against that shape.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Any `-eval` skill | `<phase>/<producer>-eval_verdict.yaml` (the `--artifact` argument) | the verdict YAML under structural check |

The skill takes the verdict file path as an argument; it has no other inputs. Each invocation checks one verdict file.

## Products

- `<phase>/<producer>-eval-yaml-qa_result.yaml` — QA result per `lib/qa-types.ts` schema. Filename uses `-eval-yaml-qa` to disambiguate from the producer's own QA result (`<producer>-qa_result.yaml`).

## Checks

| # | id | type | description | auto-fix on fail |
|---|---|---|---|---|
| 1 | `yaml_parses` | static | Verdict file is parseable YAML. If this fails, all subsequent checks return `skipped`. | regenerate the verdict — most often a quoting / indentation error in a long `note:` or `auto_surfaced.message:` field |
| 2 | `schema_validates` | static | Parsed object matches `lib/verdict-schema.ts § VerdictSchema` (top-level required fields, enum values for `verdict` / `mode` / `severity`, per-field ranges). | fix the listed schema violations. Reference: `lib/verdict-schema.ts` |
| 3 | `dimension_weights_sum_to_one` | static | `dimensions[].weight` values sum to 1.0 ± 0.01. | redistribute weights so they sum to 1.0; cross-reference the eval skill's SKILL.md `## LLM-as-Judge Rubric` table for canonical weights |
| 4 | `overall_score_consistent_with_dimensions` | static | `overall_score` (or `overall_score_pre_cap` when an inflation cap was applied) ≈ Σ(score × weight) / Σ(weight) over scored dimensions, ± 0.5 tolerance. | recompute `overall_score`; if the rubric applied a cap, also set `overall_score_pre_cap` to the raw mean |
| 5 | `verdict_tier_matches_score` | static | `pass` ≥ 7.0, `warn` 5.0–7.0, `fail` < 5.0. `incomplete` / `partial` are gradability tiers, not score-driven; skipped. | align `verdict` and `overall_score`: change the verdict tier to match the score, or re-grade dimensions to match the verdict |
| 6 | `live_state_verified_consistency` | static | `live_state_verified: false` caps verdict at `partial` (never `pass`) and overall_score at 8.5. Skipped when `live_state_verified` is omitted. | set verdict='partial' and cap overall_score at 8.5; `overall_score_pre_cap` may stay at the higher raw value |
| 7 | `gate_disposition_consistent` | static | If `gate` block is present: `approve` requires `overall_score ≥ gate.threshold`; `reject` requires `<`; `iterate` is unconstrained. | align disposition and threshold; change disposition or rebalance the rubric |

The static check functions live at `skills/verdict-yaml-qa/checks.ts` as importable TS. Every check returns a `QACheckResult` (`{pass, detail?, auto_fix_hint?}`) per `lib/qa-types.ts`.

**Adding a check:** append to the `CHECKS` array in `checks.ts`, add a row to the table above (matching `id`), add a unit test in `test/skills/verdict-yaml-qa/checks.test.ts`.

## Process

1. **Read the verdict YAML artifact** from Drive:
   `drive_read_file(file_id=<verdict.yaml drive id>)`.

2. **Save to a local temp path** (so the CLI runner can read it as a file):
   `Bash: TMP=$(mktemp); drive content saved to $TMP`.

3. **Run all checks** via the generic CLI runner:
   `Bash: npx tsx scripts/qa-run.ts --skill verdict-yaml-qa --artifact "$TMP" --target "<opp-name>" --capture-path "<phase>/<producer>-eval_verdict.yaml"`.

   The runner:
   - Imports `CHECKS` from `skills/verdict-yaml-qa/checks.ts`
   - Runs each check via `lib/qa-runner.ts`
   - Prints a fully-shaped `QAResult` YAML to stdout

4. **Write the QA result** to Drive at `<phase>/<producer>-eval-yaml-qa_result.yaml`.
   `drive_create_file(parentFolderId=<run-folder/<phase>>, name='<producer>-eval-yaml-qa_result.yaml', content=<runner stdout>)`.

5. **Return the verdict** to the orchestrator:
   - `pass` → verdict is well-formed; `opp-eval` can aggregate it.
   - `fail` → orchestrator passes each `failures[].auto_fix_hint` back to the producing `-eval` skill, asks for a corrected verdict, re-runs this skill.
   - `incomplete` → verdict file missing entirely; halt with operator-actionable error.

## When to dispatch

Two natural dispatch points:

1. **Inline self-check by each `-eval` skill** — after writing the verdict, the eval dispatches `verdict-yaml-qa` against its own output before returning. Catches malformations before they propagate. Adds ~50ms per eval (7 static checks, all <1ms each plus YAML parse).

2. **Pre-aggregation gate in `opp-eval`** — `opp-eval` runs `verdict-yaml-qa` on every verdict it discovers under `runs/<run-id>/**/*-eval_verdict.yaml` before aggregating. Verdicts that fail QA are flagged in the rollup but not aggregated (preserves rollup integrity).

The shared-helper shape supports both; the SKILL is a single dispatch surface, not a per-eval skill.

## Auto-fix protocol

See `skills/_qa-template.md § Auto-fix protocol` for the canonical contract. Briefly:

- Default 2 auto-fix attempts per QA run.
- On fail, orchestrator passes each `auto_fix_hint` to the producing `-eval` skill with explicit "fix this and re-emit verdict YAML" instructions.
- Re-run QA after each attempt.
- If still failing after 2 attempts, halt with `verdict: incomplete` and surface the unresolved failures + hints.

The auto-fix loop is more constrained than producer-facing QA — most `-eval` skills emit verdicts deterministically from a rubric, so a verdict that fails QA usually means the eval prompt itself is malformed (not the artifact). Two attempts should resolve any stochastic float-drift; persistent failures point at a rubric bug.

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

## Coverage

Covers all 27 `-eval` skills' verdicts (see `_eval-decisions.md`). Cross-referenced from each `-eval` row's `## Eval-self-QA` section. Adding a new `-eval` skill automatically picks up coverage — no per-eval QA skill to ship.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-09 | Initial skill. Closes the "eval-self-QA" deferred workstream from `_eval-decisions.md`. 7 static checks: yaml_parses, schema_validates (calls `VerdictSchema`), dimension_weights_sum_to_one, overall_score_consistent_with_dimensions, verdict_tier_matches_score, live_state_verified_consistency, gate_disposition_consistent. Single shared helper covers all 27 -eval skills' verdicts. | ACE team (qa-eval-registry initial buildout follow-up) |
