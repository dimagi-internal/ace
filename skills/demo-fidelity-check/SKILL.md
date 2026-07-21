---
name: demo-fidelity-check
description: >
  Clone-only QA gate. Confirms a cloned/profiled synthetic dataset reproduces the
  real source's statistical shape before it reaches a funder. Wraps the labs
  synthetic_fidelity_report atom. Binary pass/fail, no LLM.
disable-model-invocation: true
---

# Demo Fidelity Check

Runs **only** in the `clone` provider path of `demo-data-setup`. A cloned demo
claims to mirror a real program — so before it's shown to a funder, verify the
synthetic fixtures actually reproduce the source's distributions. A low-fidelity
clone shown as "this is the real program" is the worst failure mode this pipeline
has; this gate prevents it.

See `skills/_qa-template.md` for the shared QA contract (verdict YAML, auto-fix
protocol, static-vs-LLM rules).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| `demo-data-setup` (clone) | the profile bundle dir (from `synthetic_profile_from_prod` / `synthetic_clone_profile`) | the fixtures under fidelity check |
| `demo-data-setup` (clone) | `run_state…products.synthetic.source` | provider must be `clone` (skip otherwise) |

## Products

- `<demo-run>/7-synthetic/demo-fidelity-check_result.yaml` — QA result per `lib/qa-types.ts`

## Process

1. **Provider guard.** If `source.provider != clone`, emit `verdict: skipped` with
   detail "fidelity check is clone-only" and stop. (denovo/ace-run invent their own
   shape; there is no real source to compare against.)
2. **Run the report.** `mcp__connect-labs__synthetic_fidelity_report(bundle_dir)` —
   returns per-field mean/std/**TVD** deltas and a correlation **Frobenius**
   distance between the generated fixtures and the manifest they came from.
3. **Score against thresholds** (below). Any BLOCKER breach → `fail`; else `pass`.

## Checks

| # | id | type | description | auto-fix on fail |
|---|---|---|---|---|
| 1 | `report_ran` | static | `synthetic_fidelity_report` returned a report for the bundle | re-check `bundle_dir` path; re-profile if the bundle is missing |
| 2 | `field_distributions_close` | static | every profiled field's **TVD** ≤ 0.15 and \|mean delta\| within tolerance (tune per rubric) | regenerate with `mirror=true` (or pin `form_json_paths`) so the clone tracks the source shape |
| 3 | `correlations_preserved` | static | correlation **Frobenius** distance ≤ threshold — the clone preserves cross-field structure, not just marginals | use `mirror=true` (transplant pool) — marginal-only mode loses per-entity structure |
| 4 | `trajectories_present` | static | for a longitudinal demo (e.g. per-child MUAC recovery), each entity has its multi-visit series (mirror pool populated) | re-profile with `mirror=true`; marginal mode collapses trajectories |

Thresholds are provisional pending calibration against ≥3 real clones (mark the
rubric provisional per `docs/eval-calibration-learnings.md`). On `fail`, the safe
fallback is to author the demo `denovo` rather than show a low-fidelity clone.
