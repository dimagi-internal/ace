---
name: synthetic-workflow-seed-eval
description: >
  Grade synthetic-workflow-seed's run summary for workflow wiring, KPI
  population, coaching-task creation, and saved-runs deferral honesty.
disable-model-invocation: true
---

# Synthetic Workflow Seed — Eval

See `skills/_eval-template.md` for shared verdict / severity / stock-block
contracts. Provisional rubric.

Stage 4 of ACE Phase 6 (Plan B). Grades whether the seed step landed
two correctly-wired workflows on labs (LLO weekly review + program
admin audit), populated their pipeline schemas with KPI-derived fields,
spawned coaching tasks per `coaching_arcs[]`, and surfaced the
`workflow_create_run` deferral honestly.

**Status:** Provisional.

## Inputs

- `ACE/<opp-name>/runs/<run-id>/6-synthetic/synthetic-workflow-seed.md`
- `ACE/<opp-name>/runs/<run-id>/6-synthetic/synthetic-narrative-plan.yaml` OR `synthetic-data-generate_manifest.yaml` — anchor for KPI count + coaching arc count expected
- `ACE/<opp-name>/opp.yaml` — `synthetic.workflows.{llo_weekly_review_id, program_admin_audit_id}`

## Rubric

Score each dimension 0–10.

1. **Workflow wiring (weight 0.30).** Both workflow IDs present in the
   summary AND in `opp.yaml.synthetic.workflows`. The audit's
   `watched_workflow_id` matches the LLO weekly review's id (verify
   from the summary's recorded patch). Hard-deduct -5 if either ID
   missing or if the audit's `watched_workflow_id` is null/wrong.

2. **KPI population (weight 0.25).** The LLO weekly review's
   `definition.config.kpi_config` length matches
   `manifest.kpi_config.length`. The pipeline schema's `fields` is
   non-empty (KPI-derived). Hard-deduct -3 if `kpi_config` is empty in
   the workflow definition (the seeded scaffold ships with empty —
   skill must populate).

3. **Coaching-task creation (weight 0.20).** Number of tasks created
   matches `manifest.coaching_arcs.length`. Each task ID is recorded
   in the summary with the FLW it was assigned to. Hard-deduct -3 if
   any arc didn't produce a task and no failure was recorded.

4. **Aggregation-mapping honesty (weight 0.10).** When the manifest's
   higher-level KPI aggregation labels (`validated_rate`,
   `non_null_rate`, `distinct_count`) are mapped to labs primitives
   (`avg`, `count`, `count_distinct`, etc.), the summary documents
   the mapping. Silent substitution is a fail.

5. **Saved-runs deferral honesty (weight 0.15).** The summary
   surfaces `[WAITING ON LABS] workflow_create_run` (or the equivalent)
   so the operator knows snapshots are deferred. Hard-deduct -5 if the
   summary claims snapshots ran when they didn't.

## Hard-deduct triggers

- `[BLOCKER]` if any dimension scores ≤ 3.
- `[BLOCKER]` if either workflow ID is missing.
- `[BLOCKER]` if `opp.yaml.synthetic.workflows` was not updated.
- `[WARN]` per coaching arc that failed to produce a task without a
  recorded failure reason.
- `[WARN]` if `scaffold_unsuitable: true` was set but the summary
  doesn't explain why.

## Verdict shape

Write `<6-synthetic-folder>/synthetic-workflow-seed-eval_verdict.yaml`
per `lib/verdict-schema.ts`:

```yaml
schema_version: 1
skill: synthetic-workflow-seed-eval
target: <opp-name>
mode: deep
ran_at: <ISO timestamp>
capture_path: 6-synthetic/synthetic-workflow-seed.md

overall_score: <weighted mean post-cap>
overall_score_pre_cap: <raw weighted mean>
verdict: pass | warn | fail

dimensions:
  workflow_wiring:               { score: <0-10>, weight: 0.30 }
  kpi_population:                { score: <0-10>, weight: 0.25 }
  coaching_task_creation:        { score: <0-10>, weight: 0.20 }
  aggregation_mapping_honesty:   { score: <0-10>, weight: 0.10 }
  saved_runs_deferral_honesty:   { score: <0-10>, weight: 0.15 }

hard_deduct_triggered: [ ... ]
auto_surfaced: [ ... ]
gate:
  threshold: 7.0
  disposition: approve | iterate | reject
```

## Calibration target

Provisional. Calibrate once 3+ runs have shipped — see
`skills/eval-calibration/SKILL.md`.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-06 | Initial provisional rubric — Stage 4 of Plan B. | ACE team |
