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

**Out-of-chain fitness axis** (added 2026-05-29 per
`docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`): the original
rubric was a coverage / falsifiability *checklist* — it confirmed every
priority had a scene and every assertion was falsifiable, but never asked
the only question that matters from the viewer's chair: *would this
viewer actually be persuaded?* A spec can tick every coverage box and
still produce a deck a funder skims and forgets. The new
`persona_resonance` dimension grades the spec from the viewer/funder's
POV — emotional + decision arc, not coverage — and carries teeth. The
inflation guard (removed in an earlier pass) is restored.

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

1. **Persona-priority coverage (weight 0.20).** Each priority listed
   in the persona's `## Priorities` section has at least one scene
   that targets it. E.g., funder priority "Cost-efficiency narrative"
   → spec has a "cost panel" scene. Hard-deduct -3 per priority with
   no scene coverage. (This is the *coverage* check — distinct from
   dimension 6, which asks whether the covered priorities actually
   land.)

2. **Wow-moment specificity (weight 0.20).** Every `impressive_because`
   field references a concrete element from the manifest (a named FLW,
   a specific anomaly, a KPI threshold number). Generic "looks good",
   "shows the data", "demonstrates the platform" entries fail. Score
   9-10 if every scene's wow moment names a specific manifest element;
   5-7 if half do; 0-3 if most are generic.

3. **AI-quality falsifiability (weight 0.15).** Every `ai_quality`
   field is a falsifiable assertion the canopy walkthrough's LLM
   judge can apply: names what to look for, includes a numeric bar
   when applicable. "The page should look nice" → fail.
   "Roster must show ≥3 named FLWs with archetype labels visible" →
   pass. Score 9-10 if every assertion is falsifiable; 0-3 if most
   are vibes.

4. **Persona resonance (weight 0.25) — OUT-OF-CHAIN FITNESS dimension.**
   Read the spec as the actual viewer would experience the rendered deck
   and ask the real-world question: *would this viewer be persuaded?*
   Anchor on the persona's real decision context (a funder deciding
   whether to fund; a prospective LLO deciding whether to bid), NOT on
   the coverage checklist:
   - **Decision arc:** do the scenes build toward the decision the
     persona is actually making? A funder deck that covers every
     priority but never lands the "this is fundable / low-risk / high-
     leverage" conclusion does not resonate.
   - **Emotional + credibility beats:** is there a moment that makes the
     viewer *feel* the program works (the named struggling FLW coached
     back; the verification rate climbing), not just a panel that
     reports it? Resonance is the difference between "informed" and
     "convinced."
   - **Viewer fit over author intent:** judge from the chair of the
     viewer, not the spec author. Covering a priority ≠ moving the
     viewer on it. A spec can be 100% coverage-complete and still score
     low here if the scenes are inert.
   - This dimension is exempt from any "only grade declared priorities"
     carve-out: if the persona would need a beat the spec never
     scheduled to be persuaded, that's a *finding* here. Score 9-10 when
     a real funder/LLO would walk away convinced and ready to act; 5-7
     when the deck informs but doesn't move; 0-3 when it's a coverage
     checklist with no persuasive arc.
   - **Hard-gate:** if the spec would not persuade its target viewer
     (this dimension ≤ 3) — inert, no decision arc, all-checklist — the
     whole eval `verdict: fail` regardless of coverage/falsifiability
     conformance. A deck that won't land is not worth the AVD time.

5. **Anomaly-to-scene mapping (weight 0.10).** Every entry in
   `manifest.anomalies[]` maps to at least one spec scene that calls
   it out (the scene's wow_moment or ai_quality references the
   anomaly's id or description). Anomaly seeded but never visible
   in the deck = wasted manifest authoring. Hard-deduct -3 per
   anomaly without scene coverage.

6. **Persona turn-off avoidance (weight 0.10).** No scene's
   narration triggers a persona turn-off from the persona file's
   `## Turn-offs` list. E.g., funder file says "soft language
   without numbers" → spec narration must not say "improved
   outcomes" without a denominator. Hard-deduct -3 per detected
   turn-off.

## Hard-deduct triggers

- `[BLOCKER]` if any dimension scores ≤ 3.
- `[BLOCKER]` (hard-gate, `verdict: fail`) if `persona_resonance` ≤ 3 —
  the spec would not persuade its target viewer (inert, no decision arc,
  all-checklist). Fires regardless of coverage/falsifiability scores; a
  deck that won't land is not worth the AVD time.
- `[BLOCKER]` if scene count is < 4 (deck too thin for the persona
  story arc).
- `[BLOCKER]` if `auth.command.login` references a path that doesn't
  exist (`bin/ace-labs-walkthrough-login` typo would block
  `/canopy:walkthrough` execution).
- `[WARN]` per generic wow_moment.
- `[WARN]` per non-falsifiable ai_quality assertion.
- `[WARN]` per anomaly without scene coverage.

## Inflation guard (coverage-vs-resonance)

`synthetic-walkthrough-spec` ships no internal self-eval, so the classic
self-eval cap has no signal. The restored guard is anchored on the
coverage-vs-resonance gap instead — the exact way a checklist rubric
inflates:

> **If the coverage/conformance dimensions (persona_priority_coverage +
> ai_quality_falsifiability) average ≥ 8.0 but `persona_resonance` <
> 7.0, cap overall at `persona_resonance + 0.5` and surface a `WARN`.** A
> spec that is coverage-complete and falsifiable but inert is the canonical
> inflation case for a checklist rubric: it scores high on everything
> mechanical while failing the only out-of-chain question. The cap forces
> the overall score to track persuasiveness, not box-ticking.

If a producer self-eval ever lands, additionally cap overall at 8.0 when
self-eval is `pass` and overall is ≤ 8.0; surface a `WARN` recommending
self-eval rubric tightening.

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
  persona_priority_coverage:   { score: <0-10>, weight: 0.20 }
  wow_moment_specificity:      { score: <0-10>, weight: 0.20 }
  ai_quality_falsifiability:   { score: <0-10>, weight: 0.15 }
  persona_resonance:           { score: <0-10>, weight: 0.25 }   # OUT-OF-CHAIN fitness; ≤3 hard-gates the eval
  anomaly_scene_mapping:       { score: <0-10>, weight: 0.10 }
  turn_off_avoidance:          { score: <0-10>, weight: 0.10 }
# Weights sum: 0.20 + 0.20 + 0.15 + 0.25 + 0.10 + 0.10 = 1.00.

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
| 2026-05-29 | Add `persona_resonance` (0.25) out-of-chain fitness dimension — grades the spec from the viewer/funder's POV ("would this viewer actually be persuaded", distinct from "covers every priority"), with a ≤3 hard-gate (`verdict: fail`) on inert/checklist-only specs. Reweight the coverage/checklist dims (priority_coverage 0.30→0.20, wow_specificity 0.25→0.20, ai_falsifiability 0.20→0.15, anomaly_mapping 0.15→0.10) to absorb it; weights still sum to 1.00. Restored an inflation guard (coverage-vs-resonance cap). Closes the coverage-checklist-without-persuasion gap flagged in `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`. | ACE team |
