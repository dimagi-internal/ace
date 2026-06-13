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

**Out-of-chain fitness axis** (strengthened 2026-05-29 per
`docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`): the visual-judge
dimensions are the only ones graded against *observed rendered state* (a
real screenshot of the live workflow page) rather than against the
manifest/PDD — i.e. the out-of-chain fitness anchor for this eval. They
were under-weighted at a combined 0.15, which let a polish run with a
broken-looking dashboard still pass on text-based conformance. Their
combined weight is now 0.40 (visual_hierarchy 0.27 + brand_fit 0.13), and
a `verdict: blocked` from the visual-judge now hard-caps the whole eval to
`verdict: fail` — not merely a trigger on visual hierarchy ≤ 2.

**Status:** Provisional. Calibration ground-truth catalogue TBD until
3+ real polish runs land — see `skills/eval-calibration/SKILL.md`.

## Inputs

- `ACE/<opp-name>/runs/<run-id>/7-synthetic/synthetic-workflow-polish.md`
- `ACE/<opp-name>/runs/<run-id>/7-synthetic/synthetic-narrative-plan.{md,yaml}` — anchor for FLW names + anomaly descriptions that should appear in patches
- `ACE/<opp-name>/runs/<run-id>/7-synthetic/synthetic-workflow-seed.md` — `scaffold_unsuitable` flag, baseline render-code version, **and the saved-run ids (`Week 1 run_id` / `Week 2 run_id`) — required for the render deep-link in step 6** (the polished completed-run view only mounts when a `run_id` is in the URL; see step 6)
- `ACE/<opp-name>/opp.yaml` — `synthetic.workflows.llo_weekly_review_id` + `synthetic.labs_opp_id` (needed for the screenshot capture in step 6)
- `inputs/pdd.md` — opp domain (used as the `domain` context for canopy:visual-judge's brand-fit anchoring)

## Rubric

Score each dimension 0–10.

1. **Narrative-data coherence (weight 0.20).** FLW names mentioned in
   patches actually appear in `manifest.flw_personas[].display_name`.
   Anomaly callouts use plain-language descriptions (NOT field paths
   — "photos missing MTN card" beats `form.location_id.photo`).
   Hard-deduct -5 if any patched name doesn't match the manifest
   (e.g. polish features "Asha M." but manifest has only "Bao N.").

2. **Patch quality (weight 0.15).** Surgical mode applied at least one
   patch per polish category recommended in the skill's prose: hero
   panel, named FLW story cards, anomaly callouts, coaching arc
   visualization, domain branding. Hard-deduct -3 per missing category
   when the manifest had material to support it (e.g. anomalies
   present but no anomaly-callout patch).

3. **Smoke-render success (weight 0.15).** `pipeline_preview` after
   patches returned rows (workflow data contract not broken).
   Hard-deduct -10 if `pipeline_preview` returned a schema error
   AND the polish run summary didn't roll back — that's a live
   broken render.

4. **Domain-language fit (weight 0.05).** Patches use the PDD's
   domain language (turmeric → market/vendor terms; KMC → maternal-
   health). Generic "FLW visit" framing where the PDD has specific
   vocabulary is a fail. Score 9-10 if 3+ domain-specific phrases
   appear; 5-7 for one phrase; 0-3 for generic.

5. **Mode honesty (weight 0.05).** When `scaffold_unsuitable: true`
   from seed, polish ran in L2-rewrite mode and the summary names it.
   When seed flagged suitable, polish ran in surgical mode. Hard-
   deduct -5 if the modes don't match (skill ran L2 rewrite without
   the flag, or surgical when scaffold was unsuitable).

6. **Visual hierarchy (weight 0.27) — visual-judge / OUT-OF-CHAIN
   FITNESS dimension.** Hero panel reads at a glance, per-FLW cards have
   clear primary/secondary text, anomaly badges are visually distinct
   from normal-state cards. This dimension is scored by
   `canopy:visual-judge` against a captured screenshot of the rendered
   workflow page (see § Process step 6 below for the dispatch) — i.e.
   against observed rendered state, the out-of-chain anchor.

7. **Brand fit (weight 0.13) — visual-judge / OUT-OF-CHAIN FITNESS
   dimension.** Color palette
   + iconography match the opp's domain (turmeric → market vendor cues;
   KMC → maternal-health iconography). No leftover scaffold
   blue-on-white look. Scored by `canopy:visual-judge` against the
   same screenshot as dimension 6.

Weights of dimensions 1–7 sum to 1.00 (0.20 + 0.15 + 0.15 + 0.05 +
0.05 + 0.27 + 0.13). The visual-judge dimensions (6+7) carry a combined
0.40 — they are the only out-of-chain fitness anchor (graded against an
actual screenshot of the rendered page), so they now dominate the
rubric. Weight history: pre-extraction (canopy v0.2.78 era) the rubric
had only dimensions 1–5 (0.30 + 0.20 + 0.20 + 0.15 + 0.15) and
[INFO]-flagged "vision-model judging deferred"; canopy v0.2.79 shipped
`canopy:visual-judge` and dimensions 6+7 landed at a combined 0.15
(0.10 + 0.05); the 2026-05-29 fitness-gap pass raised them to a combined
0.40 (0.27 + 0.13), pulling the difference off the text-based
conformance dimensions (narrative_data_coherence 0.30→0.20, patch_quality
0.20→0.15, smoke_render 0.20→0.15, domain_language_fit 0.10→0.05).

## Hard-deduct triggers

- `[BLOCKER]` if any dimension (1–7) scores ≤ 3.
- `[BLOCKER]` if `pipeline_preview` returned a schema error AND no
  rollback was recorded.
- `[BLOCKER]` if a patched FLW name isn't in the manifest.
- `[BLOCKER]` (hard-cap, `verdict: fail`) if `canopy:visual-judge`
  returns `verdict: blocked` (its blocking rules: visual hierarchy ≤ 2
  OR projector test == NO with hero claim asserted). A visual-judge
  `blocked` forces this eval's overall `verdict: fail` regardless of how
  high the text-based dimensions score — the rendered dashboard is what a
  stakeholder actually sees, so an unforwardable render blocks even on a
  conformant patch set. (Previously this only triggered on visual
  hierarchy ≤ 2; it now hard-caps on any visual-judge `blocked` verdict,
  which also covers the projector-test-NO case.)
- `[WARN]` per missing polish category from rubric §2 when manifest
  had material to support it.
- `[WARN]` if domain-language fit scores ≤ 5 (generic patches).
- `[WARN]` if `canopy:visual-judge` couldn't capture the screenshot
  (browse session expired, workflow page redirected to login, etc.) —
  dimensions 6+7 fall back to `null` and the overall_score
  re-normalizes against the remaining 5 dimensions. Surface the
  capture failure so the operator can re-run `/ace:labs-login` and
  retry. Two specific render-not-reached cases to name in the WARN:
  (a) **no `run_id`** → step 6 hit the run picker, not the dashboard
  (fix: ensure synthetic-workflow-seed saved a run and recorded its
  `run_id`); (b) **labs landed on the context selector / "please select
  an opportunity" banner** despite `?opportunity_id=` — the headless
  labs session has empty `organization_data` (the Connect org-list API
  flaked at OAuth login), so labs strips the context param. This is
  fixed labs-side (connect-labs `559b…` / jjackson/connect-labs#541);
  if it recurs, re-run `/ace:labs-login` to refresh org_data.

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

# Deep-link to a SAVED RUN so the polished completed-run view renders.
# The bare /labs/workflow/<id>/?opportunity_id=<opp> URL renders the run
# *picker* (select_run_mode), NOT the per-FLW dashboard — the polished render
# only mounts when the URL carries a run_id (the workflow's render code gates
# its completed view on the `view` prop, which is populated only for a saved
# run). LLO_WEEKLY_REVIEW_RUN_ID = the latest saved run_id from
# synthetic-workflow-seed.md (prefer "Week 2 run_id"; fall back to "Week 1
# run_id"). Verified live against labs prod (jjackson/ace#769; recipe form
# /labs/workflow/<id>/run/<run_id>/?opportunity_id=<opp>).
if [ -n "${LLO_WEEKLY_REVIEW_RUN_ID}" ]; then
  WORKFLOW_URL="${LABS_BASE_URL}/labs/workflow/${LLO_WEEKLY_REVIEW_ID}/run/${LLO_WEEKLY_REVIEW_RUN_ID}/?opportunity_id=${LABS_OPP_ID}"
else
  # Degraded: no saved run recorded (synthetic-workflow-seed didn't save a run).
  # This lands on the run picker, not the polished render — emit a [WARN] so the
  # operator knows the visual dims are scored against the picker, not the dashboard.
  WORKFLOW_URL="${LABS_BASE_URL}/labs/workflow/${LLO_WEEKLY_REVIEW_ID}/?opportunity_id=${LABS_OPP_ID}"
fi
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
                         # outer eval re-weights at 0.27 vs 0.13.
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
eval's overall verdict is hard-capped to `fail` per the hard-deduct
table — the visual-judge `blocked` overrides the weighted-mean score
entirely (it does not merely deduct points).

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
  narrative_data_coherence: { score: <0-10>, weight: 0.20 }
  patch_quality:            { score: <0-10>, weight: 0.15 }
  smoke_render_success:     { score: <0-10>, weight: 0.15 }
  domain_language_fit:      { score: <0-10>, weight: 0.05 }
  mode_honesty:             { score: <0-10>, weight: 0.05 }
  visual_hierarchy:         { score: <0-10>, weight: 0.27, source: canopy:visual-judge }   # OUT-OF-CHAIN fitness
  brand_fit:                { score: <0-10>, weight: 0.13, source: canopy:visual-judge }   # OUT-OF-CHAIN fitness
# Weights sum: 0.20 + 0.15 + 0.15 + 0.05 + 0.05 + 0.27 + 0.13 = 1.00.
# A canopy:visual-judge `verdict: blocked` hard-caps overall verdict to `fail`.

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
| 2026-05-29 | Raise the canopy:visual-judge dimensions (visual_hierarchy + brand_fit) to a combined 0.40 (0.27 + 0.13, up from 0.15) — they are the only out-of-chain fitness anchor (graded against the actual rendered screenshot). Pulled the difference off the text-based conformance dims (narrative 0.30→0.20, patch 0.20→0.15, smoke 0.20→0.15, domain 0.10→0.05); weights still sum to 1.00. A `canopy:visual-judge verdict: blocked` now hard-caps the whole eval to `verdict: fail` (was previously only a trigger on visual hierarchy ≤ 2). Per `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`. | ACE team |
| 2026-06-13 | **Step 6 capture targets the saved-run render deep-link** (`/labs/workflow/<id>/run/<run_id>/?opportunity_id=<opp>`), not the bare workflow URL — the bare URL renders the run picker, so the visual dims were scoring the picker, not the dashboard. `run_id` (Week 2, else Week 1) read from `synthetic-workflow-seed.md`; degraded fallback to the bare URL emits a `[WARN]` naming the no-run_id vs empty-org_data failure mode. Recipe verified live (jjackson/ace#769; labs-side empty-org_data fix jjackson/connect-labs#541). See `docs/learnings/2026-06-13-labs-workflow-run-deeplink.md`. | ACE team |

<!-- 0.13.73 ships canopy:visual-judge wire-up. -->
