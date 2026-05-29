---
name: synthetic-workflow-seed-eval
description: >
  Grade synthetic-workflow-seed's run summary for workflow wiring, KPI
  population, coaching-task creation, and saved-runs completion.
disable-model-invocation: true
---

# Synthetic Workflow Seed — Eval

See `skills/_eval-template.md` for shared verdict / severity / stock-block
contracts. Provisional rubric.

Stage 4 of ACE Phase 7 (Plan B). Grades whether the seed step landed
two correctly-wired workflows on labs (LLO weekly review + program
admin audit), populated their pipeline schemas with KPI-derived fields,
spawned coaching tasks per `coaching_arcs[]`, and landed the Week 1
+ Week 2 saved-runs snapshots cleanly.

**Out-of-chain fitness axis** (added 2026-05-29 per
`docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`): every original
dimension was "ID present AND matches the manifest count" — pure
conformance inside the AI authoring chain. A workflow can carry N
correctly-wired, schema-valid KPI fields that no LLO supervisor would
ever act on. The new `kpi_decision_relevance` dimension grades the
seeded KPIs against a real-ops lens — would they actually drive a
supervisor's weekly decision — with a hard-gate on meaningless-but-
populated fields.

**Status:** Provisional.

## Inputs

- `ACE/<opp-name>/runs/<run-id>/7-synthetic/synthetic-workflow-seed.md`
- `ACE/<opp-name>/runs/<run-id>/7-synthetic/synthetic-narrative-plan.yaml` OR `synthetic-data-generate_manifest.yaml` — anchor for KPI count + coaching arc count expected
- `ACE/<opp-name>/opp.yaml` — `synthetic.workflows.{llo_weekly_review_id, program_admin_audit_id}`
- `ACE/<opp-name>/inputs/pdd.md` — the PDD's success metrics / monitoring
  intent (the out-of-chain anchor for `kpi_decision_relevance`: what an
  LLO supervisor is actually trying to manage week-to-week).
- **The rendered workflow output** (out-of-chain anchor): run
  `pipeline_preview` (or `pipeline_sql`) against the LLO weekly review's
  workflow id to see the columns + sample values a supervisor would
  actually look at — judge relevance against the rendered view, not the
  `kpi_config` array's labels.

## Rubric

Score each dimension 0–10.

1. **Workflow wiring (weight 0.20).** Both workflow IDs present in the
   summary AND in `products.synthetic.workflows` of the current run's
   `run_state.yaml`. The audit's
   `watched_workflow_id` matches the LLO weekly review's id (verify
   from the summary's recorded patch). Hard-deduct -5 if either ID
   missing or if the audit's `watched_workflow_id` is null/wrong.

2. **KPI population (weight 0.15).** The LLO weekly review's
   `definition.config.kpi_config` length matches
   `manifest.kpi_config.length`. The pipeline schema's `fields` is
   non-empty (KPI-derived). Hard-deduct -3 if `kpi_config` is empty in
   the workflow definition (the seeded scaffold ships with empty —
   skill must populate).

3. **KPI decision relevance (weight 0.25) — OUT-OF-CHAIN FITNESS
   dimension.** Set conformance aside (that's dimension 2) and ask the
   real-ops question: would the seeded KPIs actually drive an LLO
   supervisor's weekly decision? Anchor on the PDD's success metrics +
   the rendered `pipeline_preview` columns, NOT the manifest's
   `kpi_config` labels:
   - Each KPI must answer a decision a supervisor genuinely makes weekly
     ("which FLW do I coach next?", "is verification slipping?", "is the
     cohort on pace?"). A KPI that is populated, schema-valid, and
     manifest-matched but answers no real management question is
     meaningless-but-populated.
   - The KPI set must be *actionable as a panel*: thresholds /
     comparisons that let the supervisor sort or triage, not a flat list
     of raw counts with no decision affordance.
   - Cross-check against the PDD: KPIs should track what the PDD says
     this program is trying to improve, not generic
     visits/verification-only metrics that apply to every program.
   - This dimension is exempt from any "only grade what the manifest
     declared" carve-out — if the PDD implies a decision-critical metric
     the manifest never seeded, that is a *finding* here, not a free
     pass. Score 9-10 when every KPI maps to a real weekly decision and
     the panel is triage-ready; 5-7 when KPIs are relevant but flat /
     not actionable; 0-3 when KPIs are populated-but-meaningless.
   - **Hard-gate:** if the seeded KPIs are populated-but-meaningless
     (this dimension ≤ 3) — schema-valid fields no supervisor would act
     on — the whole eval `verdict: fail` regardless of wiring/population
     conformance.

4. **Coaching-task creation (weight 0.15).** Number of tasks created
   matches `manifest.coaching_arcs.length`. Each task ID is recorded
   in the summary with the FLW it was assigned to. Hard-deduct -3 if
   any arc didn't produce a task and no failure was recorded.

5. **Aggregation-mapping honesty (weight 0.10).** When the manifest's
   higher-level KPI aggregation labels (`validated_rate`,
   `non_null_rate`, `distinct_count`) are mapped to labs primitives
   (`avg`, `count`, `count_distinct`, etc.), the summary documents
   the mapping. Silent substitution is a fail.

6. **Saved-runs completion (weight 0.15).** Both Week 1 and Week 2
   runs must have `run_id` recorded AND a snapshot at the
   week-boundary date. `n/2 snapshots saved` should equal `2/2` for a
   full-credit score. Hard-deduct -3 per missing snapshot; -5 if the
   summary claims snapshots ran when the underlying labs records
   contradict it.

## Hard-deduct triggers

- `[BLOCKER]` if any dimension scores ≤ 3.
- `[BLOCKER]` (hard-gate, `verdict: fail`) if `kpi_decision_relevance`
  ≤ 3 — the seeded KPIs are populated-but-meaningless (schema-valid
  fields no LLO supervisor would act on). Fires regardless of how clean
  the wiring/population conformance is.
- `[BLOCKER]` if either workflow ID is missing.
- `[BLOCKER]` if the current run's `products.synthetic.workflows` was not updated.
- `[WARN]` per coaching arc that failed to produce a task without a
  recorded failure reason.
- `[WARN]` if `scaffold_unsuitable: true` was set but the summary
  doesn't explain why.

## Verdict shape

Write `<7-synthetic-folder>/synthetic-workflow-seed-eval_verdict.yaml`
per `lib/verdict-schema.ts`:

```yaml
schema_version: 1
skill: synthetic-workflow-seed-eval
target: <opp-name>
mode: deep
ran_at: <ISO timestamp>
capture_path: 7-synthetic/synthetic-workflow-seed.md

overall_score: <weighted mean post-cap>
overall_score_pre_cap: <raw weighted mean>
verdict: pass | warn | fail

dimensions:
  workflow_wiring:               { score: <0-10>, weight: 0.20 }
  kpi_population:                { score: <0-10>, weight: 0.15 }
  kpi_decision_relevance:        { score: <0-10>, weight: 0.25 }   # OUT-OF-CHAIN fitness; ≤3 hard-gates the eval
  coaching_task_creation:        { score: <0-10>, weight: 0.15 }
  aggregation_mapping_honesty:   { score: <0-10>, weight: 0.10 }
  saved_runs_completion:         { score: <0-10>, weight: 0.15 }
# Weights sum: 0.20 + 0.15 + 0.25 + 0.15 + 0.10 + 0.15 = 1.00.

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
| 2026-05-07 | "saved-runs deferral honesty" → "saved-runs completion" after labs PR #168 unblocked the run-create + snapshot loop. Now grades whether both weeks landed cleanly instead of whether the deferral was disclosed. | ACE team (Stage 3b) |
| 2026-05-29 | Add `kpi_decision_relevance` (0.25) out-of-chain fitness dimension — grades whether seeded KPIs would actually drive an LLO supervisor's weekly decision (anchored on PDD success metrics + the rendered `pipeline_preview`), with a ≤3 hard-gate (`verdict: fail`) on meaningless-but-populated KPIs. Reweight conformance dims (workflow_wiring 0.30→0.20, kpi_population 0.25→0.15, coaching_task_creation 0.20→0.15) to absorb it; weights still sum to 1.00. Closes the all-conformance gap flagged in `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`. | ACE team |
