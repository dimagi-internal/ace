---
name: synthetic-walkthrough-spec-eval
description: >
  Grade per-persona walkthrough spec YAMLs for falsifiable ai_quality
  assertions, scene coverage, persona alignment, and anomaly mapping.
disable-model-invocation: true
---

# Synthetic Walkthrough Spec — Eval

See `skills/_eval-template.md` for shared verdict / severity / stock-block
contracts. Provisional rubric.

Stage 4 of ACE Phase 7 (Plan B). Grades each per-persona walkthrough
spec emitted by `synthetic-walkthrough-spec`. The spec is what
`canopy:walkthrough` consumes — bad specs produce bad decks. This eval
catches generic "looks good" assertions, missing wow-moment coverage,
and persona-priority drift before the walkthrough run burns AVD time
on a deck that won't land.

**Status:** Provisional.

## Inputs

For EACH `synthetic-walkthrough-spec_<persona>.yaml` produced (one eval
verdict per persona):

- `ACE/<opp-name>/runs/<run-id>/7-synthetic/synthetic-walkthrough-spec_<persona>.yaml`
- `ACE/<opp-name>/runs/<run-id>/7-synthetic/synthetic-narrative-plan.yaml` — anchor for FLW names + anomalies the spec should reference
- `personas/<persona>.md` — anchor for persona priorities + turn-offs
- `ACE/<opp-name>/personas/<persona>.md` — opp-overlay persona (if present); overrides canned

## Rubric

Score each dimension 0–10.

1. **Persona-priority coverage (weight 0.30).** Each priority listed
   in the persona's `## Priorities` section has at least one scene
   that targets it. E.g., funder priority "Cost-efficiency narrative"
   → spec has a "cost panel" scene. Hard-deduct -3 per priority with
   no scene coverage.

2. **Wow-moment specificity (weight 0.25).** Every `impressive_because`
   field references a concrete element from the manifest (a named FLW,
   a specific anomaly, a KPI threshold number). Generic "looks good",
   "shows the data", "demonstrates the platform" entries fail. Score
   9-10 if every scene's wow moment names a specific manifest element;
   5-7 if half do; 0-3 if most are generic.

3. **AI-quality falsifiability (weight 0.20).** Every `ai_quality`
   field is a falsifiable assertion the canopy walkthrough's LLM
   judge can apply: names what to look for, includes a numeric bar
   when applicable. "The page should look nice" → fail.
   "Roster must show ≥3 named FLWs with archetype labels visible" →
   pass. Score 9-10 if every assertion is falsifiable; 0-3 if most
   are vibes.

4. **Anomaly-to-scene mapping (weight 0.15).** Every entry in
   `manifest.anomalies[]` maps to at least one spec scene that calls
   it out (the scene's wow_moment or ai_quality references the
   anomaly's id or description). Anomaly seeded but never visible
   in the deck = wasted manifest authoring. Hard-deduct -3 per
   anomaly without scene coverage.

5. **Persona turn-off avoidance (weight 0.10).** No scene's
   narration triggers a persona turn-off from the persona file's
   `## Turn-offs` list. E.g., funder file says "soft language
   without numbers" → spec narration must not say "improved
   outcomes" without a denominator. Hard-deduct -3 per detected
   turn-off.

## Hard-deduct triggers

- `[BLOCKER]` if any dimension scores ≤ 3.
- `[BLOCKER]` if scene count is < 4 (deck too thin for the persona
  story arc).
- `[BLOCKER]` if `auth.command.login` references a path that doesn't
  exist (`bin/ace-labs-walkthrough-login` typo would block
  `/canopy:walkthrough` execution).
- `[WARN]` per generic wow_moment.
- `[WARN]` per non-falsifiable ai_quality assertion.
- `[WARN]` per anomaly without scene coverage.

## Multi-persona aggregation

This eval runs once per persona spec. The verdicts are independent;
`opp-eval` aggregates them into the umbrella scorecard. There is no
cross-persona inflation guard — different personas legitimately have
different priorities, so two persona specs can score 9/10 without
suspicion.

## Verdict shape

Write `<7-synthetic-folder>/synthetic-walkthrough-spec-eval_verdict_<persona>.yaml`
per `lib/verdict-schema.ts`:

```yaml
schema_version: 1
skill: synthetic-walkthrough-spec-eval
target: <opp-name>
mode: deep
ran_at: <ISO timestamp>
capture_path: 7-synthetic/synthetic-walkthrough-spec_<persona>.yaml
persona: <persona>

overall_score: <weighted mean post-cap>
overall_score_pre_cap: <raw weighted mean>
verdict: pass | warn | fail

dimensions:
  persona_priority_coverage:   { score: <0-10>, weight: 0.30 }
  wow_moment_specificity:      { score: <0-10>, weight: 0.25 }
  ai_quality_falsifiability:   { score: <0-10>, weight: 0.20 }
  anomaly_scene_mapping:       { score: <0-10>, weight: 0.15 }
  turn_off_avoidance:          { score: <0-10>, weight: 0.10 }

hard_deduct_triggered: [ ... ]
auto_surfaced: [ ... ]
gate:
  threshold: 7.0
  disposition: approve | iterate | reject
```

## Calibration target

Provisional. Once 3+ persona specs have shipped per persona type
(canned `prospective-llo` + `funder`):
- Build ground-truth catalogue at
  `eval-calibration/known-issues.md § Synthetic walkthrough spec`.
- Target detection rate ≥ 80% on catalogued issues.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-06 | Initial provisional rubric — Stage 4 of Plan B. | ACE team |
