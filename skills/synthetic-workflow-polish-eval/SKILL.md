---
name: synthetic-workflow-polish-eval
description: >
  Grade synthetic-workflow-polish's render-code patches for narrative-data
  coherence, smoke-render success, and visual quality (via canopy:visual-judge).
disable-model-invocation: true
---

# Synthetic Workflow Polish — Eval

See `skills/_eval-template.md` for shared verdict / severity / stock-block
contracts. Provisional rubric.

Stage 4 of ACE Phase 7 (Plan B). The polish step is what moves a demo
from "competent" to "amazing" — it's the most consequential step for
demo quality. This eval is correspondingly strict.

**Visual judging:** dimensions 6 + 7 (visual hierarchy, brand fit) are
scored by dispatching `canopy:visual-judge` against a captured screenshot
of the rendered workflow page. canopy ships the Tough Judge methodology
(adversarial-listing → score-from-3 default → projector-test gate →
sanity-floor cross-check) extracted from `canopy:walkthrough` in canopy
v0.2.79. ACE provides the polish-specific rubric YAML; canopy provides
the calibrated judge.

**Status:** Provisional. Calibration ground-truth catalogue TBD until
3+ real polish runs land — see `skills/eval-calibration/SKILL.md`.

## Inputs

- `ACE/<opp-name>/runs/<run-id>/7-synthetic/synthetic-workflow-polish.md`
- `ACE/<opp-name>/runs/<run-id>/7-synthetic/synthetic-narrative-plan.{md,yaml}` — anchor for FLW names + anomaly descriptions that should appear in patches
- `ACE/<opp-name>/runs/<run-id>/7-synthetic/synthetic-workflow-seed.md` — `scaffold_unsuitable` flag, baseline render-code version
- `ACE/<opp-name>/opp.yaml` — `synthetic.workflows.llo_weekly_review_id` + `synthetic.labs_opp_id` (needed for the screenshot capture in step 6)
- `inputs/pdd.md` — opp domain (used as the `domain` context for canopy:visual-judge's brand-fit anchoring)

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

4. **Domain-language fit (weight 0.10).** Patches use the PDD's
   domain language (turmeric → market/vendor terms; KMC → maternal-
   health). Generic "FLW visit" framing where the PDD has specific
   vocabulary is a fail. Score 9-10 if 3+ domain-specific phrases
   appear; 5-7 for one phrase; 0-3 for generic.

5. **Mode honesty (weight 0.05).** When `scaffold_unsuitable: true`
   from seed, polish ran in L2-rewrite mode and the summary names it.
   When seed flagged suitable, polish ran in surgical mode. Hard-
   deduct -5 if the modes don't match (skill ran L2 rewrite without
   the flag, or surgical when scaffold was unsuitable).

6. **Visual hierarchy (weight 0.10) — visual-judge dimension.**
   Hero panel reads at a glance, per-FLW cards have clear
   primary/secondary text, anomaly badges are visually distinct from
   normal-state cards. This dimension is scored by
   `canopy:visual-judge` against a captured screenshot of the rendered
   workflow page (see § Process step 6 below for the dispatch).

7. **Brand fit (weight 0.05) — visual-judge dimension.** Color palette
   + iconography match the opp's domain (turmeric → market vendor cues;
   KMC → maternal-health iconography). No leftover scaffold
   blue-on-white look. Scored by `canopy:visual-judge` against the
   same screenshot as dimension 6.

Weights of dimensions 1–7 sum to 1.00 (0.30 + 0.20 + 0.20 + 0.10 +
0.05 + 0.10 + 0.05). Pre-extraction (canopy v0.2.78 era) the rubric
had only dimensions 1–5 with weights 0.30 + 0.20 + 0.20 + 0.15 + 0.15
summing to 1.00 and [INFO]-flagged "vision-model judging deferred";
dimensions 6+7 unblocked when canopy v0.2.79 shipped
`canopy:visual-judge`. Domain-language-fit + mode-honesty drop 0.05
each to absorb the new visual dimensions while keeping the heaviest
weight on narrative-data coherence (the most consequential signal
for stakeholder demos).

## Hard-deduct triggers

- `[BLOCKER]` if any dimension (1–7) scores ≤ 3.
- `[BLOCKER]` if `pipeline_preview` returned a schema error AND no
  rollback was recorded.
- `[BLOCKER]` if a patched FLW name isn't in the manifest.
- `[BLOCKER]` if `canopy:visual-judge` returns `verdict: blocked`
  (its blocking rules: visual hierarchy ≤ 2 OR projector test == NO
  with hero claim asserted).
- `[WARN]` per missing polish category from rubric §2 when manifest
  had material to support it.
- `[WARN]` if domain-language fit scores ≤ 5 (generic patches).
- `[WARN]` if `canopy:visual-judge` couldn't capture the screenshot
  (browse session expired, workflow page redirected to login, etc.) —
  dimensions 6+7 fall back to `null` and the overall_score
  re-normalizes against the remaining 5 dimensions. Surface the
  capture failure so the operator can re-run `/ace:labs-login` and
  retry.

## Process — visual judging

Steps 1–5 run as text-based grading against the polish run summary +
manifest + PDD (see `## Rubric` above for what each dimension reads).
Step 6 captures a screenshot of the rendered workflow page; step 7
dispatches `canopy:visual-judge` to score the visual dimensions.

### Step 6: Capture the workflow render

```bash
B=~/.claude/skills/gstack/browse/dist/browse
export BROWSE_STATE_FILE=/tmp/polish-eval-${OPP_SLUG}.json

# Pre-flight: ensure labs session is fresh.
if [ ! -f ~/.ace/labs-session.json ] || ! $B goto "${LABS_BASE_URL}/labs/overview/" >/dev/null 2>&1; then
  bash ~/.claude/plugins/cache/ace/ace/$(cat ~/.claude/plugins/marketplaces/ace/VERSION)/bin/ace-labs-walkthrough-login
fi

WORKFLOW_URL="${LABS_BASE_URL}/labs/workflow/${LLO_WEEKLY_REVIEW_ID}/?opportunity_id=${LABS_OPP_ID}"
$B goto "$WORKFLOW_URL"
$B wait --networkidle
PAGE_TEXT=$($B text)

SHOT="/tmp/polish-eval-${OPP_SLUG}/llo-weekly-review.png"
mkdir -p "$(dirname "$SHOT")"
$B screenshot "$SHOT"
```

### Step 7: Dispatch canopy:visual-judge

```
Skill('canopy:visual-judge', args={
  screenshot_path: <SHOT>,
  page_text:       <PAGE_TEXT>,
  rubric: {
    name: "synthetic-workflow-polish",
    default_score: 3,
    overall_rule: "weighted-mean",
    dimensions: [
      {
        id: "visual_hierarchy",
        label: "Visual Hierarchy",
        weight: 0.67,    # local weights inside the visual sub-rubric;
                         # outer eval re-weights at 0.10 vs 0.05.
        anchor: {
          "5": "Hero KPI prominent. Per-FLW cards have clear primary/secondary text. Anomaly badges visually distinct.",
          "4": "Strong, with one specific designer-polish thing left to do.",
          "3": "Functional. (DEFAULT)",
          "2": "Cramped spacing OR low contrast OR inconsistent button variants visible.",
          "1": "Unstyled, broken layout, or actively unprofessional.",
        },
        deduction_rules: [
          "Hero panel absent or shows no headline number: max 3",
          "Per-FLW cards missing names or archetype labels: max 3",
        ],
      },
      {
        id: "brand_fit",
        label: "Brand Fit",
        weight: 0.33,
        anchor: {
          "5": "Color palette + iconography clearly match the opp's domain (e.g. turmeric → market/vendor cues).",
          "4": "Domain-appropriate with one specific gap.",
          "3": "Neutral / scaffold default. (DEFAULT)",
          "2": "Mismatched cues (e.g. maternal-health iconography on a market-survey opp).",
          "1": "Visually disconnected from the opp's domain entirely.",
        },
      },
    ],
  },
  context: {
    audience: { name: "stakeholder reviewing the demo deck", decision: "deciding whether to fund this opp" },
    competitors: ["Linear", "Notion", "Superhuman", "Datadog dashboards", "Looker"],
    projector_test_phrasing: "Would you forward this dashboard URL to a stakeholder right now, without ANY caveats?",
    narrative_anchors: [
      "Hero panel must show a headline number (e.g. '<N> visits / <%> verified')",
      "At least 3 named FLWs visible with archetype labels",
      "<anomaly[0].id> visually called out (badge or alert styling)",
    ],
    domain: <opp.domain from PDD §Problem Statement>,
    blocking_rules: ["narrative_falsified"],   # opt out of demo_readiness_low — we have our own [BLOCKER] table
  },
})
```

Capture the verdict's `dimensions.visual_hierarchy.score` and
`dimensions.brand_fit.score` directly into this eval's verdict YAML
(rubric dimensions 6+7 above). Capture the verdict's `adversarial`
listing into this eval's `auto_surfaced` array as `[INFO]` entries
so the operator sees the embarrassments + competitor comparisons.

When the visual-judge dispatch returns `verdict: "blocked"`, this
eval's overall verdict becomes `[BLOCKER]` per the hard-deduct table.

## Verdict shape

Write `<7-synthetic-folder>/synthetic-workflow-polish-eval_verdict.yaml`
per `lib/verdict-schema.ts`:

```yaml
schema_version: 1
skill: synthetic-workflow-polish-eval
target: <opp-name>
mode: deep
ran_at: <ISO timestamp>
capture_path: 7-synthetic/synthetic-workflow-polish.md

overall_score: <weighted mean post-cap>
overall_score_pre_cap: <raw weighted mean>
verdict: pass | warn | fail

dimensions:
  narrative_data_coherence: { score: <0-10>, weight: 0.30 }
  patch_quality:            { score: <0-10>, weight: 0.20 }
  smoke_render_success:     { score: <0-10>, weight: 0.20 }
  domain_language_fit:      { score: <0-10>, weight: 0.10 }
  mode_honesty:             { score: <0-10>, weight: 0.05 }
  visual_hierarchy:         { score: <0-10>, weight: 0.10, source: canopy:visual-judge }
  brand_fit:                { score: <0-10>, weight: 0.05, source: canopy:visual-judge }

hard_deduct_triggered: [ ... ]
auto_surfaced: [ ... ]
gate:
  threshold: 7.5      # stricter than other Phase 7 evals — polish is the headline
  disposition: approve | iterate | reject
```

## Calibration target

Provisional. Calibrate once 3+ polished workflows have shipped — at
which point dimensions 1–5 get an ACE-side ground-truth catalogue at
`eval-calibration/known-issues.md § Synthetic workflow polish`.
Dimensions 6+7 (visual judge) calibrate against
`canopy/evals/walkthrough/fixtures/` since they share the
`canopy:visual-judge` methodology.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-06 | Initial provisional rubric — Stage 4 of Plan B. Vision-model dimensions deferred. | ACE team |
| 2026-05-07 | Add `visual_hierarchy` (0.10) + `brand_fit` (0.05) dimensions; weights re-normalize from the 5-dim original. New § Process steps 6+7: capture screenshot via gstack browse, dispatch `canopy:visual-judge` with polish-specific rubric. Removes the deferral. canopy v0.2.79 ships the underlying judge. | ACE team |

<!-- 0.13.73 ships canopy:visual-judge wire-up. -->
