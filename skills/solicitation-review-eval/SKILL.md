---
name: solicitation-review-eval
description: >
  Compare ACE's top-ranked solicitation recommendation against the
  human's actual award. Detection-rate metric.
disable-model-invocation: true
---

# Solicitation Review — Eval

Cross-artifact LLM-as-Judge eval. Compares ACE's recommendation in
`solicitation/review/recommendation.md` against the actual outcome
in `solicitation/award-record.md`.

The heaviest dimension (`recommendation_alignment`, 0.4) is the only
out-of-chain anchor here: it grades ACE's recommendation against the
**human's actual award decision** — real ground truth, outside the AI
authoring chain. The other 0.6 (rationale quality, specificity, edge-case
coverage) are intra-chain craft checks. Critically, the ground-truth anchor
**only exists once a human has awarded.** Before that, scoring the soft 0.6
alone would let a well-written but unvalidated recommendation pass — exactly
the inflation this eval is supposed to prevent. So the award-existence gate
(below) is load-bearing: **no award → `verdict: incomplete`**, never a pass.

**Status:** Provisional. Calibration TBD until 3+ real awards have shipped.

## Inputs

- `ACE/<opp-name>/runs/<run-id>/8-solicitation-management/solicitation-review_scoring-rubric.md`
- `ACE/<opp-name>/runs/<run-id>/8-solicitation-management/solicitation-review_recommendation.md`
- `ACE/<opp-name>/runs/<run-id>/8-solicitation-management/solicitation-review_award-record.md`
- `ACE/<opp-name>/runs/<run-id>/8-solicitation-management/solicitation-create_published.md` (rubric reference)

## Award-existence gate (run FIRST, before any scoring)

`recommendation_alignment` (0.4) is the only dimension anchored to ground
truth outside the AI authoring chain — and it requires a **human award
decision** to exist. If no award has been made yet, that anchor has nothing
to score against, and scoring only the softer 0.6 (rationale quality,
specificity, edge-case coverage) would let an articulate-but-unvalidated
recommendation pass on craft alone. That is the precise inflation failure
mode this eval exists to prevent.

Therefore, before scoring any dimension, check for a real award:

1. Read `solicitation/award-record.md` and the current run's
   `run_state.yaml`.
2. If `award-record.md` is **missing**, or has `status` other than
   `success`, or
   `phases.solicitation-management.products.selected_llo.org_slug` is
   **null/absent** — i.e. **no human award decision exists yet** — emit
   `verdict: incomplete` immediately. Do NOT score the soft dimensions and
   do NOT emit a `pass`. Surface `[INFO] No human award recorded yet;
   recommendation_alignment ground-truth anchor unavailable — not gradable.`
   The soft 0.6 dimensions must never carry a pass on their own.
3. Only when a real award exists (`status: success` + populated
   `selected_llo.org_slug`) proceed to the rubric below.

This gate is the out-of-chain enforcement: it structurally prevents the
0.4 ground-truth anchor from being silently dropped and the intra-chain
0.6 from standing in for it.

## Rubric

Score each dimension 0-10. Hard-deduct rules listed inline.
**Only reached after the award-existence gate above passes.**

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
  `phases.solicitation-management.products.selected_llo.org_slug` is
  populated in the current run's `run_state.yaml` (contract violation).
- `[BLOCKER]` if `recommendation.md` is missing while
  `award-record.md` has `status: success` (HITL gate was bypassed).
- `[WARN]` per response in `solicitation/responses/` that has no entry in
  `scoring-rubric.md`.

## Verdict shape

Write `8-solicitation-management/solicitation-review-eval_verdict.yaml` per `lib/verdict-schema.ts`:

```yaml
schema_version: 1
skill: solicitation-review-eval
target: <opp-name>
mode: deep
ran_at: <ISO timestamp>
capture_path: solicitation/review/recommendation.md

overall_score: <weighted mean>
overall_score_pre_cap: <weighted mean before any cap>
verdict: pass | warn | fail | incomplete   # incomplete when no human award exists yet

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

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-29 | Added the award-existence gate: when no human award decision exists yet (`award-record.md` missing / not `success` / `selected_llo.org_slug` null), emit `verdict: incomplete` instead of scoring the soft 0.6 dimensions and passing. The 0.4 `recommendation_alignment` anchor is the only out-of-chain (human-ground-truth) dimension; before an award exists it has nothing to score, so the gate prevents the softer intra-chain dims (rationale quality, specificity, edge-case coverage) from silently carrying a pass on craft alone. Process change only — weights unchanged (0.4/0.3/0.2/0.1 = 1.0). Per `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`. | ACE team |
