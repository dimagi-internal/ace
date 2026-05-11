---
name: synthetic-summary-eval
description: >
  Grade synthetic-summary's reviewer-facing one-page markdown for
  stakeholder-readiness, narrative coherence, and link/asset completeness.
disable-model-invocation: true
---

# Synthetic Summary — Eval

See `skills/_eval-template.md` for shared verdict / severity / stock-block
contracts. Provisional rubric — calibration TBD once 3+ Phase 6 summaries
have been forwarded to real stakeholders and we have feedback signal
(`skills/eval-calibration/SKILL.md`).

Aggregator-stage eval for `synthetic-summary`'s
`6-synthetic/synthetic-summary.md` artifact. The summary is the document
a Dimagi staffer forwards to a stakeholder — "here is what this
opportunity looks like running well." It composes the labs URL, the
fixture folder, the persona walkthroughs (Stage 2), the demonstrative
workflows (Stage 3), and the prose narrative into one page. The eval
grades whether that page actually works for forwarding.

**Status:** Provisional.

## Inputs

- `ACE/<opp-name>/runs/<run-id>/6-synthetic/synthetic-summary.md`
- `ACE/<opp-name>/runs/<run-id>/6-synthetic/synthetic-data-generate.md` — labs URL + fixture folder ground truth
- `ACE/<opp-name>/runs/<run-id>/6-synthetic/synthetic-narrative-plan.{md,yaml}` (when present) — narrative ground truth
- `ACE/<opp-name>/opp.yaml` — `display_name`, `synthetic.walkthroughs[]`, `synthetic.workflows.*` for completeness checks

## Rubric

Score each dimension 0–10. Hard-deduct rules inline.

1. **Stakeholder-readiness (weight 0.30).** Could a Dimagi staffer
   forward this page to an external stakeholder unchanged? Reads as
   stakeholder-grade prose, not implementation notes. No leftover
   internal jargon (`run_id`, `manifest`, `opp.yaml.*`, "TBD",
   `<placeholder>`), no "this skill writes...". Hard-deduct -3 if the
   page contains placeholder tokens (`<...>`, `TBD`, `TODO`) or
   internal-only artifact paths a stakeholder shouldn't see.

2. **Narrative coherence (weight 0.25).** Reads as a story arc — opp
   context → cast → what stakeholders will see — not a bag of links and
   bullets. The three "What you'll see" paragraphs link the data work
   (cast / anomalies / KPIs) to what the stakeholder will notice in
   labs. Generic "synthetic data was generated" prose is a fail (3 or
   below).

3. **Completeness (weight 0.25).** Required surfaces are present and
   populated:
   - Labs URL — clickable, matches the URL in `synthetic-data-generate.md`.
   - Fixture folder URL — present, GDrive link.
   - Generated-at timestamp — present.
   - Cast paragraph — names FLW personas from the manifest.
   - Stage 2 walkthroughs section — present iff the current run's `outputs.synthetic.walkthroughs[]` is non-empty. Absent when empty — promising-but-not-shipped is worse than silent.
   - Stage 3 workflows section — same conditional rendering.
   Hard-deduct -5 if labs URL OR fixture folder URL is missing/broken.

4. **Source fidelity (weight 0.10).** Numbers and names in the
   summary match upstream sources — record-counts come from
   `synthetic-data-generate.md`, FLW names come from
   `synthetic-narrative-plan.yaml` (when present) or the Stage 1
   manifest, KPI thresholds match the manifest. Hard-deduct -3 per
   fabricated number/name (a number stated in the summary that doesn't
   appear in the source artifacts is invented; the eval flags it).

5. **What's-next clarity (weight 0.10).** The "What's next" section
   accurately describes which Phase 6 stages have NOT run for this opp,
   and gives the right `/ace:step` invocations. Skipping the section
   entirely is correct iff every stage is filled (the demo is complete);
   describing stages as "not run" when the artifacts exist is a fail.

## Hard-deduct triggers

- `[BLOCKER]` if any dimension scores ≤ 3.
- `[BLOCKER]` if labs URL or fixture folder URL is missing or broken.
- `[BLOCKER]` if the summary contains unsubstituted placeholder tokens
  (`<...>`, `TBD`, `TODO`).
- `[WARN]` per fabricated number/name that doesn't trace to an upstream
  artifact.
- `[WARN]` if Stage 2 walkthroughs section is rendered but empty (or
  promised in "What's next" while the artifacts already exist).
- `[INFO]` if current run's `outputs.synthetic.walkthroughs[]` is
  empty AND the summary is Stage 1 only — calibration signal that
  this is a baseline-state grade.

## Inflation guard

The producing skill (`synthetic-summary`) ships no internal self-eval —
it's a pure aggregator. This guard is a no-op for now. If a self-eval
ever lands, cap overall at 8.0 when self-eval is `pass` and overall is
≤ 8.0; surface a `WARN` recommending self-eval rubric tightening.

## Verdict shape

Write `<6-synthetic-folder>/synthetic-summary-eval_verdict.yaml` per
`lib/verdict-schema.ts`:

```yaml
schema_version: 1
skill: synthetic-summary-eval
target: <opp-name>
mode: deep
ran_at: <ISO timestamp>
capture_path: 6-synthetic/synthetic-summary.md

overall_score: <weighted mean post-cap>
overall_score_pre_cap: <raw weighted mean>
verdict: pass | warn | fail

dimensions:
  stakeholder_readiness:    { score: <0-10>, weight: 0.30 }
  narrative_coherence:      { score: <0-10>, weight: 0.25 }
  completeness:             { score: <0-10>, weight: 0.25 }
  source_fidelity:          { score: <0-10>, weight: 0.10 }
  whats_next_clarity:       { score: <0-10>, weight: 0.10 }

hard_deduct_triggered: [ ... ]
auto_surfaced: [ ... ]
gate:
  threshold: 7.0
  disposition: approve | iterate | reject
```

Weights sum: 0.30 + 0.25 + 0.25 + 0.10 + 0.10 = 1.00.

## Calibration target

Provisional. Once 3+ Phase 6 summaries have been forwarded to
stakeholders:
- Build ground-truth catalogue at
  `eval-calibration/known-issues.md § Synthetic summary`.
- Target detection rate ≥ 80% on catalogued issues.
- Inter-run variance ≤ 0.5 across 3 same-model runs.
- Defer firmer calibration until first stakeholder forwarding signal —
  per registry rationale, this eval ships speculative until then.

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used`.

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior`.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior`.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-09 | Initial provisional rubric — five dimensions covering stakeholder-readiness (0.30), narrative coherence (0.25), completeness (0.25), source fidelity (0.10), what's-next clarity (0.10). Closes the deferred has-eval row in `_eval-decisions.md` for `synthetic-summary`. | ACE team |
