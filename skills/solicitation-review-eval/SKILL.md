---
name: solicitation-review-eval
description: >
  Provisional LLM-as-Judge rubric for solicitation-review. Compares ACE's
  top-ranked recommendation against the human's actual award decision.
  Detection-rate metric: did ACE's recommended awardee match the human's
  pick? Calibrated per skills/eval-calibration once 3+ awards have shipped.
---

# Solicitation Review — Eval

Cross-artifact LLM-as-Judge eval. Compares ACE's recommendation in
`solicitation/review/recommendation.md` against the actual outcome
in `solicitation/award-record.md`.

**Status:** Provisional. Calibration TBD until 3+ real awards have shipped.

## Inputs

- `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/solicitation-review_scoring-rubric.md`
- `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/solicitation-review_recommendation.md`
- `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/solicitation-review_award-record.md`
- `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/solicitation-create_published.md` (rubric reference)

## Rubric

Score each dimension 0-10. Hard-deduct rules listed inline.

1. **Recommendation alignment (weight 0.4).** Did ACE's top-ranked
   recommendation match the awarded response_id? Score 10 if yes, 5 if
   awardee was in ACE's top 3, 0 otherwise. **Hard-deduct -3 if
   `award-record.md` has `status: failed` while `selected_llo` is
   populated** (data-integrity violation — that path should be impossible
   per the skill's contract, and any verdict must flag it as a `[BLOCKER]`
   regression).

2. **Scoring rationale quality (weight 0.3).** Are the scores in
   `scoring-rubric.md` traceable to the criteria in `published.md`? Are
   the per-criterion notes specific or generic? Penalize one-line "good
   experience" justifications. Score 9-10 if every score has a note that
   cites concrete response content; 5-7 if some notes are generic; 0-3 if
   most notes are unsupported.

3. **Recommendation specificity (weight 0.2).** Does `recommendation.md`
   surface concrete differentiators between candidates, or is it a
   ranked list with no narrative? Higher score for surfacing the close
   calls and explaining trade-offs.

4. **Edge case coverage (weight 0.1).** Did the recommendation flag any
   responses that were structurally unscoreable (incomplete answers,
   wrong-archetype, off-topic)? Penalize silent skipping — every response
   should appear somewhere, even if at the bottom marked "unscoreable."

## Hard-deduct triggers

- `[BLOCKER]` if any dimension scores ≤ 3.
- `[BLOCKER]` if `award-record.md` has `status: failed` while
  `opp.yaml.selected_llo.org_slug` is populated (contract violation).
- `[BLOCKER]` if `recommendation.md` is missing while
  `award-record.md` has `status: success` (HITL gate was bypassed).
- `[WARN]` per response in `solicitation/responses/` that has no entry in
  `scoring-rubric.md`.

## Verdict shape

Write `verdicts/solicitation-review.yaml` per `lib/verdict-schema.ts`:

```yaml
schema_version: 1
skill: solicitation-review-eval
target: <opp-name>
mode: deep
ran_at: <ISO timestamp>
capture_path: solicitation/review/recommendation.md

overall_score: <weighted mean>
overall_score_pre_cap: <weighted mean before any cap>
verdict: pass | warn | fail

dimensions:
  recommendation_alignment:  { score: <0-10>, weight: 0.4 }
  scoring_rationale_quality: { score: <0-10>, weight: 0.3 }
  recommendation_specificity:{ score: <0-10>, weight: 0.2 }
  edge_case_coverage:        { score: <0-10>, weight: 0.1 }

hard_deduct_triggered: [ ... ]
auto_surfaced: [ ... ]
gate:
  threshold: 7.0
  disposition: approve | iterate | reject
```

## LLM-as-Judge calibration

Provisional. Once 3+ real awards have shipped:
- Build a ground-truth catalogue at
  `eval-calibration/known-issues.md § Solicitation review`.
- Detection rate target: ≥ 80% on catalogued recommendation-vs-award
  divergences.
- Inter-run variance ≤ 0.5 across 3 same-model runs.

The detection-rate target is meaningful here because the human's award
decision IS ground truth — we're measuring whether ACE's recommendation
aligned with the human's chosen winner.

See `skills/eval-calibration/SKILL.md` for the methodology.
