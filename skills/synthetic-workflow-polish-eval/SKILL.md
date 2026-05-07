---
name: synthetic-workflow-polish-eval
description: >
  Grade synthetic-workflow-polish's render-code patches for narrative-data
  coherence, smoke-render success, and visual-tier polish indicators.
disable-model-invocation: true
---

# Synthetic Workflow Polish — Eval

See `skills/_eval-template.md` for shared verdict / severity / stock-block
contracts. Provisional rubric — visual-tier scoring is text-based today;
vision-model judging on rendered screenshots is a separate calibration
extension (Plan B Stage 4 § "Visual eval extension").

Stage 4 of ACE Phase 6 (Plan B). The polish step is what moves a demo
from "competent" to "amazing" — it's the most consequential step for
demo quality. This eval is correspondingly strict.

**Status:** Provisional. Vision-model rubric pending —
`docs/superpowers/specs/2026-05-05-ace-synthetic-data-phase-design.md`
§ 4.4 Polish-eval.

## Inputs

- `ACE/<opp-name>/runs/<run-id>/6-synthetic/synthetic-workflow-polish.md`
- `ACE/<opp-name>/runs/<run-id>/6-synthetic/synthetic-narrative-plan.{md,yaml}` — anchor for FLW names + anomaly descriptions that should appear in patches
- `ACE/<opp-name>/runs/<run-id>/6-synthetic/synthetic-workflow-seed.md` — `scaffold_unsuitable` flag, baseline render-code version

## Rubric

Score each dimension 0–10.

1. **Narrative-data coherence (weight 0.30).** FLW names mentioned in
   patches actually appear in `manifest.flw_personas[].display_name`.
   Anomaly callouts use plain-language descriptions (NOT field paths
   — "photos missing MTN card" beats `form.location_id.photo`).
   Hard-deduct -5 if any patched name doesn't match the manifest
   (e.g. polish features "Asha M." but manifest has only "Bao N.").

2. **Patch quality (weight 0.20).** Surgical mode applied at least one
   patch per polish category recommended in the skill's prose: hero
   panel, named FLW story cards, anomaly callouts, coaching arc
   visualization, domain branding. Hard-deduct -3 per missing category
   when the manifest had material to support it (e.g. anomalies
   present but no anomaly-callout patch).

3. **Smoke-render success (weight 0.20).** `pipeline_preview` after
   patches returned rows (workflow data contract not broken).
   Hard-deduct -10 if `pipeline_preview` returned a schema error
   AND the polish run summary didn't roll back — that's a live
   broken render.

4. **Domain-language fit (weight 0.15).** Patches use the PDD's
   domain language (turmeric → market/vendor terms; KMC → maternal-
   health). Generic "FLW visit" framing where the PDD has specific
   vocabulary is a fail. Score 9-10 if 3+ domain-specific phrases
   appear; 5-7 for one phrase; 0-3 for generic.

5. **Mode honesty (weight 0.15).** When `scaffold_unsuitable: true`
   from seed, polish ran in L2-rewrite mode and the summary names it.
   When seed flagged suitable, polish ran in surgical mode. Hard-
   deduct -5 if the modes don't match (skill ran L2 rewrite without
   the flag, or surgical when scaffold was unsuitable).

## Hard-deduct triggers

- `[BLOCKER]` if any dimension scores ≤ 3.
- `[BLOCKER]` if `pipeline_preview` returned a schema error AND no
  rollback was recorded.
- `[BLOCKER]` if a patched FLW name isn't in the manifest.
- `[WARN]` per missing polish category from rubric §2 when manifest
  had material to support it.
- `[WARN]` if domain-language fit scores ≤ 5 (generic patches).
- `[INFO]` until vision-model judging lands — score §1+§2+§4 as
  "best-effort text-based" and surface this caveat.

## Vision-model extension (deferred)

When the vision-model judging extension lands, two new dimensions
will be added to this rubric:

- **Visual hierarchy (weight 0.10).** Hero panel reads at a glance,
  per-FLW cards have clear primary/secondary text, anomaly badges are
  visually distinct from normal-state cards.
- **Brand fit (weight 0.05).** Color palette + iconography match the
  opp's domain; no leftover scaffold blue-on-white look.

Until vision lands, weights for §1-§5 sum to 1.0; once vision lands,
weights re-normalize to sum to 1.0 with the new dimensions. See
`skills/eval-calibration/SKILL.md`.

## Verdict shape

Write `<6-synthetic-folder>/synthetic-workflow-polish-eval_verdict.yaml`
per `lib/verdict-schema.ts`:

```yaml
schema_version: 1
skill: synthetic-workflow-polish-eval
target: <opp-name>
mode: deep
ran_at: <ISO timestamp>
capture_path: 6-synthetic/synthetic-workflow-polish.md

overall_score: <weighted mean post-cap>
overall_score_pre_cap: <raw weighted mean>
verdict: pass | warn | fail

dimensions:
  narrative_data_coherence: { score: <0-10>, weight: 0.30 }
  patch_quality:            { score: <0-10>, weight: 0.20 }
  smoke_render_success:     { score: <0-10>, weight: 0.20 }
  domain_language_fit:      { score: <0-10>, weight: 0.15 }
  mode_honesty:             { score: <0-10>, weight: 0.15 }

hard_deduct_triggered: [ ... ]
auto_surfaced: [ ... ]
gate:
  threshold: 7.5      # stricter than other Phase 6 evals — polish is the headline
  disposition: approve | iterate | reject
```

## Calibration target

Provisional. Calibrate once 3+ polished workflows + paired vision-judge
rubrics have shipped.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-06 | Initial provisional rubric — Stage 4 of Plan B. Vision-model dimensions deferred. | ACE team |
