---
name: solicitation-create-eval
description: >
  Grade a published solicitation against its source PDD — scope
  fidelity, field completeness, deadline sensibility.
disable-model-invocation: true
---

# Solicitation Create — Eval

See `skills/_eval-template.md` for shared verdict / severity / stock-block
contracts. See `skills/_solicitation-template.md` for the labs-MCP atom
inventory. Calibrated per `skills/eval-calibration/SKILL.md` once 3+
real solicitations have shipped (provisional today).

Cross-artifact LLM-as-Judge eval. Reads the source PDD plus
`solicitation/draft.md` and `solicitation/published.md`, scores the
result, and writes a verdict YAML in the shared QA/eval shape so
`opp-eval` can aggregate it.

**Status:** Provisional. Calibration TBD until 3+ real solicitations have
shipped — see `skills/eval-calibration/SKILL.md`.

## Inputs

- `ACE/<opp-name>/inputs/pdd.md`
- `ACE/<opp-name>/runs/<run-id>/8-solicitation-management/solicitation-create_draft.md`
- `ACE/<opp-name>/runs/<run-id>/8-solicitation-management/solicitation-create_published.md`

## Rubric

Score each dimension 0-10. Hard-deduct rules listed inline.

The first four dimensions grade **fidelity to the PDD** (the upstream AI
artifact). On their own they certify only that the solicitation faithfully
carries a possibly-thin PDD forward — they cannot tell whether a real
candidate LLO could read this listing and respond. `respondability` is the
out-of-chain fitness dimension (per `_eval-template.md § The out-of-chain
fitness requirement`): it grades the solicitation from the **applicant's**
point of view, independent of the PDD, and carries teeth (a `≤3 → fail`
floor) so a PDD-faithful but unanswerable solicitation cannot pass.

1. **PDD-fidelity (weight 0.30).** Does the solicitation's `description`
   and `scope_of_work` actually carry the PDD's intervention summary,
   target FLW profile, and visit structure forward? Hard-deduct -3 if
   either field paraphrases away a PDD constraint (e.g. PDD says "weekly
   visits" and solicitation says "regular visits"). Hard-deduct -5 if a
   key PDD element (visit cadence, target population, archetype-specific
   capability requirements) is missing entirely.

2. **Field completeness (weight 0.20).** All required fields present?
   `evaluation_criteria` non-empty (or marked `needs-review`)?
   `response_template` non-empty (default 6-question set or PDD-supplied)?
   `program_id` and `budget` populated from `opp.yaml`/PDD?

3. **Deadline sanity (weight 0.08).** Deadline is `now + 7..30 days`. Hard-
   deduct -5 if deadline is in the past or > 90 days out.

4. **Criteria alignment (weight 0.20).** Do the evaluation criteria reflect
   what the PDD actually cares about (e.g. archetype-specific capabilities,
   geographic fit, language capacity)? Penalize generic criteria like
   "demonstrate experience" when the PDD has specific archetype demands.
   Score 9-10 if every PDD-declared criterion has a matching rubric entry;
   5-7 if criteria are partially aligned; 0-3 if rubric is generic and
   doesn't reflect the PDD.

5. **Respondability (weight 0.22) — OUT-OF-CHAIN FITNESS.** Grade the
   published solicitation purely from the POV of a real candidate LLO
   deciding whether to respond — **do not reference the PDD when scoring
   this dimension** (the PDD is the AI authoring chain; this is the
   independent anchor). Ask the questions an actual applicant would:
   - **Clarity:** Can a reader who has never seen the PDD understand what
     the work is, who it serves, where, and what "done" looks like — from
     the solicitation text alone? Jargon or PDD-internal shorthand that
     leaks into the public listing (archetype names, internal metric IDs)
     is a real applicant blocker, not a style nit.
   - **Answerability:** Do the `response_template` questions ask for things
     a candidate LLO can actually supply (capacity, geographic reach,
     relevant past work) rather than information only ACE/Dimagi holds?
     Questions that can't be answered by an external org are dead weight.
   - **Attractiveness:** Is the scope scoped tightly enough that a
     qualified org would self-select in (or correctly self-select out)?
     A listing so generic that every org "qualifies" is as broken as one
     so narrow no real org fits.
   - **Budget realism:** Is the stated budget plausible for the scope of
     work described — enough to actually deliver the intervention at the
     implied volume, neither a rounding error nor wildly over-spec? A
     budget that no real LLO would accept (or that no funder would
     believe) caps this dimension at ≤ 4 regardless of clarity.

   Scoring: 9-10 = a domain-literate LLO could read this once and decide
   to respond with a credible proposal; 5-7 = respondable but with friction
   (one or two questions unanswerable, budget vague-but-plausible); ≤ 3 =
   an external org could not realistically respond (incomprehensible scope,
   unanswerable questions, or implausible budget). **`respondability ≤ 3`
   forces suite verdict `fail`** even if PDD-fidelity is perfect — a
   solicitation no one can answer is undeployable regardless of how
   faithfully it mirrors the PDD.

## Hard-deduct triggers

- `[BLOCKER]` if any dimension scores ≤ 3.
- `[BLOCKER]` if `respondability` scores ≤ 3 (an external LLO could not
  realistically respond — undeployable regardless of PDD fidelity).
- `[BLOCKER]` if deadline is in the past or > 90 days out.
- `[BLOCKER]` if `published.md` lacks a `solicitation_id` or `public_url`
  (publish silently failed and was not caught upstream).
- `[WARN]` per generic criterion (lacks archetype-specific signal).
- `[WARN]` if `evaluation_criteria` is marked `needs-review` (degenerate
  generate_criteria output that the operator should revisit).
- `[WARN]` per unanswerable `response_template` question (asks for info
  only ACE/Dimagi holds, not the candidate LLO).

## Verdict shape

Write `8-solicitation-management/solicitation-create-eval_verdict.yaml` per `lib/verdict-schema.ts`:

```yaml
schema_version: 1
skill: solicitation-create-eval
target: <opp-name>
mode: deep
ran_at: <ISO timestamp>
capture_path: solicitation/published.md

overall_score: <weighted mean>
overall_score_pre_cap: <weighted mean before any cap>
verdict: pass | warn | fail

dimensions:
  pdd_fidelity:        { score: <0-10>, weight: 0.30 }
  field_completeness:  { score: <0-10>, weight: 0.20 }
  deadline_sanity:     { score: <0-10>, weight: 0.08 }
  criteria_alignment:  { score: <0-10>, weight: 0.20 }
  respondability:      { score: <0-10>, weight: 0.22 }

hard_deduct_triggered: [ ... ]
auto_surfaced: [ ... ]
gate:
  threshold: 7.0
  disposition: approve | iterate | reject
```

Weights sum: 0.30 + 0.20 + 0.08 + 0.20 + 0.22 = 1.00.

## LLM-as-Judge calibration

Provisional. Once 3+ real solicitations have shipped:
- Build a ground-truth catalogue at
  `eval-calibration/known-issues.md § Solicitation create`.
- Target detection rate ≥ 80% on catalogued issues.
- Inter-run variance ≤ 0.5 across 3 same-model runs.
- Cross-model variance ≤ 1.0 for strong calibration.

See `skills/eval-calibration/SKILL.md` for the methodology.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-29 | Added `respondability` (0.22) — the out-of-chain fitness dimension grading the published solicitation from a real candidate LLO's POV (clarity, answerability, attractiveness, budget realism), scored independent of the PDD with a `≤3 → fail` floor. Reweighted PDD-anchored dims down so they no longer carry a pass alone (pdd_fidelity 0.40→0.30, criteria_alignment 0.30→0.20, deadline_sanity 0.10→0.08; field_completeness held at 0.20). Per `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md` — previously every dimension anchored to the PDD (the same AI chain being graded), so a faithful build of a thin PDD scored ~9.6 with no signal on whether anyone could actually respond. Weights sum to 1.00. | ACE team |
