---
name: synthetic-narrative-plan-eval
description: >
  Grade synthetic-narrative-plan's manifest + narrative companion for
  story coherence, manifest schema validity, and PDD anchoring.
disable-model-invocation: true
---

# Synthetic Narrative Plan — Eval

See `skills/_eval-template.md` for shared verdict / severity / stock-block
contracts. Provisional rubric — calibration TBD once 3+ Phase 7 narrative
plans have shipped (`skills/eval-calibration/SKILL.md`).

Stage 4 of ACE Phase 7 (Plan B). Grades the artifact pair
`synthetic-narrative-plan.{md,yaml}` for the story this opp's synthetic
demo will tell. The narrative-plan is what makes the demo land — a
coherent cast + plausible anomalies + closed-loop coaching arcs is the
difference between "synthetic data" and "actual demo content."

**Out-of-chain fitness axis** (reinforced 2026-05-29 per
`docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`): this eval
already carries fitness dimensions (cast realism, anomaly + coaching
coherence) that grade against a real-world "would this land" bar rather
than pure manifest conformance — so it needed only a light touch.
`anomaly_coaching_coherence` is now explicitly anchored against an
external "would this land in a *real demo* in front of a real
stakeholder" bar (not just internal narrative consistency), and 0.05 of
weight shifts off the conformance dimension (`manifest_schema_validity`,
a QA-adjacent presence check) onto the stakeholder-narrative fitness
dimension.

**Status:** Provisional.

## Inputs

- `ACE/<opp-name>/runs/<run-id>/7-synthetic/synthetic-narrative-plan.md`
- `ACE/<opp-name>/runs/<run-id>/7-synthetic/synthetic-narrative-plan.yaml`
- `ACE/<opp-name>/inputs/pdd.md` — anchor for archetype + intervention design
- `ACE/<opp-name>/runs/<run-id>/3-commcare/app-deploy_summary.md` — for field-path validation in anomalies + KPIs

## Rubric

Score each dimension 0–10. Hard-deduct rules inline.

1. **PDD anchoring (weight 0.25).** Does the cast + anomalies + KPIs
   reflect the PDD's intervention design? E.g., a turmeric market
   survey's KPIs should be photo-quality + price-completeness, NOT
   maternal-health metrics. Hard-deduct -5 if the manifest declares
   KPIs/anomalies on field paths that don't exist in the deliver app
   summary.

2. **Cast realism (weight 0.20).** Five FLWs with archetype-appropriate
   distribution (1 rockstar / 2 steady / 1 struggling / 1 new_hire by
   default). Names + notes that sound like real CHWs in the program's
   geography. Hard-deduct -3 if names are placeholders ("Worker 1",
   "FLW A") or if archetypes are uniform (no struggling FLW = no
   coaching arc to feature).

3. **Anomaly + coaching coherence (weight 0.30) — OUT-OF-CHAIN FITNESS
   dimension.** Every anomaly traces to a specific FLW + week + field
   path. Every `improvement_arc` FLW has a corresponding `coaching_arcs`
   entry. Coaching transcripts sound like real coaches (specific,
   non-patronizing, FLW-arrives-at-correction). Beyond internal
   consistency, grade against the external bar: **would this anomaly +
   coaching arc actually land in a *real demo* in front of a real
   stakeholder?** A funder/LLO watching the deck should find the arc
   believable and affecting — a contrived anomaly (one no real CHW would
   produce) or a wooden coaching exchange fails this bar even if it's
   internally consistent and field-path-valid. Score 9-10 when the arc
   would visibly move a real stakeholder in a demo; 5-7 when it's
   plausible but flat; 0-3 when it's contrived or wooden. Hard-deduct -5
   if anomalies have no detection path or no reviewer-visible artifact
   downstream.

4. **Manifest schema validity (weight 0.10).** Every field in the YAML
   matches the connect-labs Pydantic schema (see
   `mcp__connect-labs__synthetic_generate_from_manifest` description).
   Required keys present: `opportunity_id`, `random_seed`, `timeline`,
   `flw_personas`, `beneficiary_cohorts`, `kpi_config`. Hard-deduct
   -10 if `synthetic_generate_from_manifest` would reject the manifest
   (eval re-validates by reading the YAML schema, NOT by calling the
   labs MCP).

5. **Stakeholder narrative quality (weight 0.15).** The companion
   `.md` reads as a real story arc: opening → cast → week-by-week →
   what stakeholders should notice. Generic "synthetic data was
   generated" prose is a fail.

## Hard-deduct triggers

- `[BLOCKER]` if any dimension scores ≤ 3.
- `[BLOCKER]` if manifest schema would fail
  `synthetic_generate_from_manifest`'s Pydantic validation.
- `[BLOCKER]` if anomalies/KPIs reference field paths absent from the
  deliver-app summary.
- `[WARN]` if all FLWs share the same archetype (no struggling →
  coaching arc has nothing to feature; demo lacks tension).
- `[WARN]` if no coaching arc transcript is included (Stage 3's
  `task_create_synthetic` will spawn empty tasks).
- `[WARN]` per anomaly without `detection_path` set.

## Inflation guard

If the producing skill emits no internal self-eval (synthetic-narrative-plan
doesn't ship one in Stage 2), this guard is a no-op for now. When a self-eval
is added, cap at 8.0 if self-eval is `pass` and overall is ≤ 8.0.

## Verdict shape

Write `<7-synthetic-folder>/synthetic-narrative-plan-eval_verdict.yaml`
per `lib/verdict-schema.ts`:

```yaml
schema_version: 1
skill: synthetic-narrative-plan-eval
target: <opp-name>
mode: deep
ran_at: <ISO timestamp>
capture_path: 7-synthetic/synthetic-narrative-plan.yaml

overall_score: <weighted mean post-cap>
overall_score_pre_cap: <raw weighted mean>
verdict: pass | warn | fail

dimensions:
  pdd_anchoring:               { score: <0-10>, weight: 0.25 }
  cast_realism:                { score: <0-10>, weight: 0.20 }
  anomaly_coaching_coherence:  { score: <0-10>, weight: 0.30 }   # OUT-OF-CHAIN fitness ("would this land in a real demo")
  manifest_schema_validity:    { score: <0-10>, weight: 0.10 }
  stakeholder_narrative:       { score: <0-10>, weight: 0.15 }
# Weights sum: 0.25 + 0.20 + 0.30 + 0.10 + 0.15 = 1.00.

hard_deduct_triggered: [ ... ]
auto_surfaced: [ ... ]
gate:
  threshold: 7.0
  disposition: approve | iterate | reject
```

## Calibration target

Provisional. Once 3+ Phase 7 narrative plans have shipped:
- Build ground-truth catalogue at
  `eval-calibration/known-issues.md § Synthetic narrative plan`.
- Target detection rate ≥ 80% on catalogued issues.
- Inter-run variance ≤ 0.5 across 3 same-model runs.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-06 | Initial provisional rubric — Stage 4 of Plan B. | ACE team |
| 2026-05-29 | Anchor `anomaly_coaching_coherence` (0.30) against an external "would this land in a real demo in front of a real stakeholder" bar (beyond internal consistency) — confirming it as the out-of-chain fitness dimension. Light reweight: shift 0.05 off conformance (`manifest_schema_validity` 0.15→0.10) onto the stakeholder-narrative fitness dim (0.10→0.15); weights still sum to 1.00. Per `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md` (lighter touch — this eval already carried real fitness dims). | ACE team |
