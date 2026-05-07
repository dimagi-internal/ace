---
name: synthetic-data-generate-eval
description: >
  Grade synthetic-data-generate's run summary for record-count health,
  schema-question coverage, and pre-flight warning handling.
disable-model-invocation: true
---

# Synthetic Data Generate — Eval

See `skills/_eval-template.md` for shared verdict / severity / stock-block
contracts. Provisional rubric.

Stage 4 of ACE Phase 6 (Plan B). Grades whether the labs-side synthetic
generation actually produced demo-quality data: enough visits, named FLWs
with archetype labels round-tripped, deliver-app schema reached, and
warnings (payment-units = 0, share-gap, schema-questions = 0) surfaced
honestly in the run summary.

**Status:** Provisional.

## Inputs

- `ACE/<opp-name>/runs/<run-id>/6-synthetic/synthetic-data-generate.md`
- `ACE/<opp-name>/runs/<run-id>/6-synthetic/synthetic-data-generate_manifest.yaml` OR `synthetic-narrative-plan.yaml` (whichever was the source)
- `ACE/<opp-name>/opp.yaml` — `synthetic.fixture_record_counts`, `synthetic.labs_opp_id`

## Rubric

Score each dimension 0–10.

1. **Record-count health (weight 0.30).** `user_visits >= 50` AND
   `user_data == flw_personas.length` from the manifest. Hard-deduct
   -5 if `user_visits == 0` (engine ran but generated nothing — typically
   timeline misconfig). Hard-deduct -3 if `user_data != flw_personas.length`
   (named FLWs didn't all round-trip).

2. **Form schema coverage (weight 0.25).** `form_schema_questions > 0`
   means the deliver-app's HQ schema was reached and visit `form_json`
   has populated paths. Hard-deduct -5 if `form_schema_questions == 0`
   (visits exist but form fields are sparse — demo can't show FLW data).

3. **Warning honesty (weight 0.20).** When pre-flight detected
   `payment_unit_count == 0` OR labs-share gap OR schema = 0, the run
   summary must surface a clear `[WARN]` banner at the top with the
   consequence stated. Hard-deduct -3 per silent gap (warnings exist
   in pre-flight signals but the summary doesn't carry them through).

4. **Manifest provenance (weight 0.10).** The summary names which
   manifest source was consumed (`synthetic-narrative-plan.yaml`,
   `synthetic-data-generate_manifest.yaml`, or `--manifest <path>`).
   The Stage 2 narrative-plan path is preferred when both exist;
   the summary must say so explicitly when the Stage-1 default
   manifest is used despite a narrative-plan being present.

5. **Operator-actionable next steps (weight 0.15).** Summary names
   the labs URL where data is now visible AND the teardown command
   (`synthetic_disable(<opp-int-id>)`). Generic "see labs" without a
   concrete URL is a fail.

## Hard-deduct triggers

- `[BLOCKER]` if any dimension scores ≤ 3.
- `[BLOCKER]` if `user_visits == 0` (generation effectively failed).
- `[BLOCKER]` if the labs URL in the summary is wrong (e.g., references
  a connect.dimagi.com pattern instead of labs.connect.dimagi.com).
- `[WARN]` if `completed_works == 0` and the summary doesn't note the
  payment-unit cause.
- `[WARN]` per silent pre-flight gap (warnings dropped from summary).

## Verdict shape

Write `<6-synthetic-folder>/synthetic-data-generate-eval_verdict.yaml`
per `lib/verdict-schema.ts`:

```yaml
schema_version: 1
skill: synthetic-data-generate-eval
target: <opp-name>
mode: deep
ran_at: <ISO timestamp>
capture_path: 6-synthetic/synthetic-data-generate.md

overall_score: <weighted mean post-cap>
overall_score_pre_cap: <raw weighted mean>
verdict: pass | warn | fail

dimensions:
  record_count_health:        { score: <0-10>, weight: 0.30 }
  form_schema_coverage:       { score: <0-10>, weight: 0.25 }
  warning_honesty:            { score: <0-10>, weight: 0.20 }
  manifest_provenance:        { score: <0-10>, weight: 0.10 }
  operator_next_steps:        { score: <0-10>, weight: 0.15 }

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
