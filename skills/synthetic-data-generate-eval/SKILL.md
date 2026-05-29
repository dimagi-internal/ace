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

Stage 4 of ACE Phase 7 (Plan B). Grades whether the labs-side synthetic
generation actually produced demo-quality data: enough visits, named FLWs
with archetype labels round-tripped, deliver-app schema reached, and
warnings (payment-units = 0, share-gap, schema-questions = 0) surfaced
honestly in the run summary.

**Out-of-chain fitness axis** (added 2026-05-29 per
`docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`): the original
five dimensions all graded the run *summary* against the *manifest* —
count/field/URL conformance, entirely inside the AI authoring chain. A
manifest-faithful run can still emit records that any domain expert would
clock as garbage at a glance (flat distributions, robotic visit cadence,
no archetype-driven variance). The new `data_plausibility` dimension reads
the ACTUAL generated records on labs (NOT the manifest) and judges whether
the data would survive a domain expert's glance at the labs dashboard.
This is the dimension that carries teeth — it can fail an otherwise
conformant run.

**Status:** Provisional.

## Inputs

- `ACE/<opp-name>/runs/<run-id>/7-synthetic/synthetic-data-generate.md`
- `ACE/<opp-name>/runs/<run-id>/7-synthetic/synthetic-data-generate_manifest.yaml` OR `synthetic-narrative-plan.yaml` (whichever was the source)
- `ACE/<opp-name>/opp.yaml` — `synthetic.fixture_record_counts`, `synthetic.labs_opp_id`
- **The actual generated records on labs** (the out-of-chain anchor for
  `data_plausibility`): read a sample via `synthetic_local_record_dump`
  (or `synthetic_local_records_count` + `mbw_dashboard_v3` for the
  rendered dashboard view) against `synthetic.labs_opp_id`. This is the
  observed substrate, not the manifest's claim about it.

## Rubric

Score each dimension 0–10.

1. **Record-count health (weight 0.20).** `user_visits >= 50` AND
   `user_data == flw_personas.length` from the manifest. Hard-deduct
   -5 if `user_visits == 0` (engine ran but generated nothing — typically
   timeline misconfig). Hard-deduct -3 if `user_data != flw_personas.length`
   (named FLWs didn't all round-trip).

2. **Form schema coverage (weight 0.15).** `form_schema_questions > 0`
   means the deliver-app's HQ schema was reached and visit `form_json`
   has populated paths. Hard-deduct -5 if `form_schema_questions == 0`
   (visits exist but form fields are sparse — demo can't show FLW data).

3. **Data plausibility (weight 0.25) — OUT-OF-CHAIN FITNESS dimension.**
   Read a sample of the ACTUAL generated records (via
   `synthetic_local_record_dump` against `synthetic.labs_opp_id`) — NOT
   the manifest — and judge whether the data would fool a domain expert
   glancing at the labs dashboard. Anchor on observed substrate, not the
   spec:
   - **Distributions:** visit volume per FLW varies in a believable
     shape (the rockstar out-delivers the struggler; no suspiciously
     flat or perfectly-uniform counts). Verification rates, timestamps,
     and geo points spread realistically — not clustered at one value
     or evenly stepped.
   - **FLW behavior:** the named personas' record streams actually
     reflect their archetype (struggling FLW shows the gaps/late visits
     the narrative promised; rockstar's records are dense + clean). A
     manifest can declare archetypes the records don't embody — that's
     the failure this dimension catches.
   - **Anomalies:** seeded anomalies are present *and look organic* in
     the records (a missing-photo run that's plausibly scattered, not a
     mechanical every-Nth-row toggle).
   - This dimension grades fitness, NOT conformance: it asks "would a
     real-ops reviewer believe this is field data?" Score 9-10 when the
     sample is indistinguishable from real FLW data at a glance; 5-7 when
     it's schema-valid but visibly templated; 0-3 when records are
     obviously synthetic/garbage (constant fields, nonsense
     distributions, archetypes not embodied).
   - **Hard-gate:** if records are schema-valid but obviously
     synthetic/garbage to a domain expert (this dimension ≤ 3), the
     whole eval `verdict: fail` regardless of the other dimensions'
     scores. Schema-validity is QA's bar; plausibility is eval's.

4. **Warning honesty (weight 0.15).** When pre-flight detected
   `payment_unit_count == 0` OR labs-share gap OR schema = 0, the run
   summary must surface a clear `[WARN]` banner at the top with the
   consequence stated. Hard-deduct -3 per silent gap (warnings exist
   in pre-flight signals but the summary doesn't carry them through).

5. **Manifest provenance (weight 0.10).** The summary names which
   manifest source was consumed (`synthetic-narrative-plan.yaml`,
   `synthetic-data-generate_manifest.yaml`, or `--manifest <path>`).
   The Stage 2 narrative-plan path is preferred when both exist;
   the summary must say so explicitly when the Stage-1 default
   manifest is used despite a narrative-plan being present.

6. **Operator-actionable next steps (weight 0.15).** Summary names
   the labs URL where data is now visible AND the teardown command
   (`synthetic_disable(<opp-int-id>)`). Generic "see labs" without a
   concrete URL is a fail.

## Hard-deduct triggers

- `[BLOCKER]` if any dimension scores ≤ 3.
- `[BLOCKER]` (hard-gate, `verdict: fail`) if `data_plausibility` ≤ 3 —
  records are schema-valid but obviously synthetic/garbage to a domain
  expert. This gate fires regardless of how high the conformance
  dimensions score; a faithful-but-unbelievable dataset does not pass.
- `[BLOCKER]` if `user_visits == 0` (generation effectively failed).
- `[BLOCKER]` if the labs URL in the summary is wrong (e.g., references
  a connect.dimagi.com pattern instead of labs.connect.dimagi.com).
- `[WARN]` if `completed_works == 0` and the summary doesn't note the
  payment-unit cause.
- `[WARN]` per silent pre-flight gap (warnings dropped from summary).

## Verdict shape

Write `<7-synthetic-folder>/synthetic-data-generate-eval_verdict.yaml`
per `lib/verdict-schema.ts`:

```yaml
schema_version: 1
skill: synthetic-data-generate-eval
target: <opp-name>
mode: deep
ran_at: <ISO timestamp>
capture_path: 7-synthetic/synthetic-data-generate.md

overall_score: <weighted mean post-cap>
overall_score_pre_cap: <raw weighted mean>
verdict: pass | warn | fail

dimensions:
  record_count_health:        { score: <0-10>, weight: 0.20 }
  form_schema_coverage:       { score: <0-10>, weight: 0.15 }
  data_plausibility:          { score: <0-10>, weight: 0.25 }   # OUT-OF-CHAIN fitness; ≤3 hard-gates the eval
  warning_honesty:            { score: <0-10>, weight: 0.15 }
  manifest_provenance:        { score: <0-10>, weight: 0.10 }
  operator_next_steps:        { score: <0-10>, weight: 0.15 }
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
| 2026-05-29 | Add `data_plausibility` (0.25) out-of-chain fitness dimension — reads the ACTUAL generated records via `synthetic_local_record_dump` and judges whether they'd fool a domain expert, with a ≤3 hard-gate (`verdict: fail`) on schema-valid-but-garbage data. Reweight the conformance dims (record_count 0.30→0.20, form_schema 0.25→0.15, warning_honesty 0.20→0.15) to absorb it; weights still sum to 1.00. Closes the all-conformance gap flagged in `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`. | ACE team |
