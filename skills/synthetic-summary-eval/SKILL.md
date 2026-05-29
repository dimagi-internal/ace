---
name: synthetic-summary-eval
description: >
  Grade synthetic-summary's reviewer-facing one-page markdown for
  stakeholder-readiness, narrative coherence, and link/asset completeness.
disable-model-invocation: true
---

# Synthetic Summary — Eval

See `skills/_eval-template.md` for shared verdict / severity / stock-block
contracts. Provisional rubric — calibration TBD once 3+ Phase 7 summaries
have been forwarded to real stakeholders and we have feedback signal
(`skills/eval-calibration/SKILL.md`).

Aggregator-stage eval for `synthetic-summary`'s
`7-synthetic/synthetic-summary.md` artifact. The summary is the document
a Dimagi staffer forwards to a stakeholder — "here is what this
opportunity looks like running well." It composes the labs URL, the
fixture folder, the persona walkthroughs (Stage 2), the demonstrative
workflows (Stage 3), and the prose narrative into one page. The eval
grades whether that page actually works for forwarding.

**Out-of-chain fitness axis** (added 2026-05-29 per
`docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`): the original
five dimensions graded the summary doc against *upstream markdown* —
they never opened the demo the summary is selling. A summary can read
beautifully and trace cleanly to its source artifacts while making
headline claims the actual rendered labs state doesn't support ("12 FLWs
delivering daily" when the dashboard shows 5 sparse rows). The new
`substrate_fidelity` dimension cross-references the summary's headline
claims against the ACTUAL rendered labs state (record-level + dashboard),
not the upstream markdown — and carries a hard-gate when a headline claim
is contradicted by what a stakeholder would see on the linked page.

**Status:** Provisional.

## Inputs

- `ACE/<opp-name>/runs/<run-id>/7-synthetic/synthetic-summary.md`
- `ACE/<opp-name>/runs/<run-id>/7-synthetic/synthetic-data-generate.md` — labs URL + fixture folder ground truth
- `ACE/<opp-name>/runs/<run-id>/7-synthetic/synthetic-narrative-plan.{md,yaml}` (when present) — narrative ground truth
- `ACE/<opp-name>/opp.yaml` — `display_name`, `synthetic.walkthroughs[]`, `synthetic.workflows.*` for completeness checks
- **The actual rendered labs state** (out-of-chain anchor for
  `substrate_fidelity`): the live records + dashboard the summary links
  to. Read via `synthetic_local_record_dump` /
  `synthetic_local_records_count` against `synthetic.labs_opp_id`, and/or
  `mbw_dashboard_v3` for the rendered dashboard the URL points at. This
  is what a stakeholder actually sees when they click the link — the
  ground truth the headline claims must match.

## Rubric

Score each dimension 0–10. Hard-deduct rules inline.

1. **Stakeholder-readiness (weight 0.25).** Could a Dimagi staffer
   forward this page to an external stakeholder unchanged? Reads as
   stakeholder-grade prose, not implementation notes. No leftover
   internal jargon (`run_id`, `manifest`, `opp.yaml.*`, "TBD",
   `<placeholder>`), no "this skill writes...". Hard-deduct -3 if the
   page contains placeholder tokens (`<...>`, `TBD`, `TODO`) or
   internal-only artifact paths a stakeholder shouldn't see.

2. **Narrative coherence (weight 0.20).** Reads as a story arc — opp
   context → cast → what stakeholders will see — not a bag of links and
   bullets. The three "What you'll see" paragraphs link the data work
   (cast / anomalies / KPIs) to what the stakeholder will notice in
   labs. Generic "synthetic data was generated" prose is a fail (3 or
   below).

3. **Completeness (weight 0.20).** Required surfaces are present and
   populated:
   - Labs URL — clickable, matches the URL in `synthetic-data-generate.md`.
   - Fixture folder URL — present, GDrive link.
   - Generated-at timestamp — present.
   - Cast paragraph — names FLW personas from the manifest.
   - Stage 2 walkthroughs section — present iff the current run's `products.synthetic.walkthroughs[]` is non-empty. Absent when empty — promising-but-not-shipped is worse than silent.
   - Stage 3 workflows section — same conditional rendering.
   Hard-deduct -5 if labs URL OR fixture folder URL is missing/broken.

4. **Substrate fidelity (weight 0.20) — OUT-OF-CHAIN FITNESS dimension.**
   Cross-reference the summary's HEADLINE claims against the ACTUAL
   rendered labs state — NOT the upstream markdown (that's dimension 5,
   source fidelity). Open the linked records + dashboard (via
   `synthetic_local_record_dump` / `mbw_dashboard_v3` against
   `synthetic.labs_opp_id`) and verify:
   - Every quantitative headline claim the summary makes ("N FLWs
     delivering", "X% verified", "anomaly Y visible") is borne out by
     what a stakeholder actually sees on the linked page. A claim the
     records contradict is a fabrication against reality, distinct from a
     number that merely doesn't trace to an upstream doc.
   - The narrative the summary sells ("here's the struggling FLW we
     coached back") is actually demonstrable in the live state — the
     records exist, the anomaly renders, the coaching arc is visible. A
     summary that promises a demo the substrate can't deliver fails here.
   - This dimension grades the summary against observed reality, so it is
     exempt from any "trace to upstream artifact" carve-out: even if a
     claim faithfully echoes an upstream markdown number, if the live
     labs state contradicts it, that's a substrate-fidelity failure.
     Score 9-10 when every headline claim is verifiable on the linked
     page; 5-7 when claims are directionally right but overstated vs the
     rendered state; 0-3 when a headline claim is flatly contradicted by
     what the stakeholder would see.
   - **Hard-gate:** if any headline claim is contradicted by the rendered
     labs state (this dimension ≤ 3), the whole eval `verdict: fail` — a
     forwardable-looking summary that misrepresents the live demo is the
     worst failure mode, since it's the artifact that actually reaches a
     stakeholder.

5. **Source fidelity (weight 0.10).** Numbers and names in the
   summary match upstream sources — record-counts come from
   `synthetic-data-generate.md`, FLW names come from
   `synthetic-narrative-plan.yaml` (when present) or the Stage 1
   manifest, KPI thresholds match the manifest. Hard-deduct -3 per
   fabricated number/name (a number stated in the summary that doesn't
   appear in the source artifacts is invented; the eval flags it).
   (This is the *in-chain* consistency check; dimension 4 is the
   *out-of-chain* reality check — they are orthogonal.)

6. **What's-next clarity (weight 0.05).** The "What's next" section
   accurately describes which Phase 7 stages have NOT run for this opp,
   and gives the right `/ace:step` invocations. Skipping the section
   entirely is correct iff every stage is filled (the demo is complete);
   describing stages as "not run" when the artifacts exist is a fail.

## Hard-deduct triggers

- `[BLOCKER]` if any dimension scores ≤ 3.
- `[BLOCKER]` (hard-gate, `verdict: fail`) if `substrate_fidelity` ≤ 3 —
  a headline claim in the summary is contradicted by the actual rendered
  labs state. The summary is the artifact that reaches a stakeholder;
  misrepresenting the live demo blocks regardless of how polished the
  prose is.
- `[BLOCKER]` if labs URL or fixture folder URL is missing or broken.
- `[BLOCKER]` if the summary contains unsubstituted placeholder tokens
  (`<...>`, `TBD`, `TODO`).
- `[WARN]` per fabricated number/name that doesn't trace to an upstream
  artifact.
- `[WARN]` if Stage 2 walkthroughs section is rendered but empty (or
  promised in "What's next" while the artifacts already exist).
- `[INFO]` if current run's `products.synthetic.walkthroughs[]` is
  empty AND the summary is Stage 1 only — calibration signal that
  this is a baseline-state grade.

## Inflation guard (substrate-claim audit)

The producing skill (`synthetic-summary`) ships no internal self-eval —
it's a pure aggregator — so the classic "cap when self-eval is 5/5"
guard had no signal to act on and was a no-op. It is now a real,
substrate-anchored guard with teeth:

> **If the summary's prose dimensions (stakeholder_readiness +
> narrative_coherence) average ≥ 8.0 but `substrate_fidelity` < 7.0,
> cap overall at `substrate_fidelity + 0.5` and surface a `WARN`.** A
> summary that reads as polished and forwardable while overstating the
> live demo is the canonical inflation failure for an aggregator: the
> prose hides a thin substrate. The cap forces the overall score to
> track reality, not polish.

If a producer self-eval ever lands, additionally cap overall at 8.0
when self-eval is `pass` and overall is ≤ 8.0; surface a `WARN`
recommending self-eval rubric tightening.

## Verdict shape

Write `<7-synthetic-folder>/synthetic-summary-eval_verdict.yaml` per
`lib/verdict-schema.ts`:

```yaml
schema_version: 1
skill: synthetic-summary-eval
target: <opp-name>
mode: deep
ran_at: <ISO timestamp>
capture_path: 7-synthetic/synthetic-summary.md

overall_score: <weighted mean post-cap>
overall_score_pre_cap: <raw weighted mean>
verdict: pass | warn | fail

dimensions:
  stakeholder_readiness:    { score: <0-10>, weight: 0.25 }
  narrative_coherence:      { score: <0-10>, weight: 0.20 }
  completeness:             { score: <0-10>, weight: 0.20 }
  substrate_fidelity:       { score: <0-10>, weight: 0.20 }   # OUT-OF-CHAIN fitness; ≤3 hard-gates the eval
  source_fidelity:          { score: <0-10>, weight: 0.10 }
  whats_next_clarity:       { score: <0-10>, weight: 0.05 }

hard_deduct_triggered: [ ... ]
auto_surfaced: [ ... ]
gate:
  threshold: 7.0
  disposition: approve | iterate | reject
```

Weights sum: 0.25 + 0.20 + 0.20 + 0.20 + 0.10 + 0.05 = 1.00.

## Calibration target

Provisional. Once 3+ Phase 7 summaries have been forwarded to
stakeholders:
- Build ground-truth catalogue at
  `eval-calibration/known-issues.md § Synthetic summary`.
- Target detection rate ≥ 80% on catalogued issues.
- Inter-run variance ≤ 0.5 across 3 same-model runs.
- Defer firmer calibration until first stakeholder forwarding signal —
  per registry rationale, this eval ships speculative until then.

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used` for the stock Drive block.
In addition, `substrate_fidelity` reads the live labs state via
`connect-labs`: `synthetic_local_record_dump`,
`synthetic_local_records_count`, and `mbw_dashboard_v3` (against
`synthetic.labs_opp_id`).

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior`.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior`.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-09 | Initial provisional rubric — five dimensions covering stakeholder-readiness (0.30), narrative coherence (0.25), completeness (0.25), source fidelity (0.10), what's-next clarity (0.10). Closes the deferred has-eval row in `_eval-decisions.md` for `synthetic-summary`. | ACE team |
| 2026-05-29 | Add `substrate_fidelity` (0.20) out-of-chain fitness dimension — cross-references the summary's HEADLINE claims against the ACTUAL rendered labs state (records + dashboard via `synthetic_local_record_dump` / `mbw_dashboard_v3`), NOT upstream markdown, with a ≤3 hard-gate (`verdict: fail`) when a headline claim is contradicted by what a stakeholder would see. Reweight prose/completeness dims (stakeholder 0.30→0.25, narrative 0.25→0.20, completeness 0.25→0.20, whats_next 0.10→0.05) to absorb it; weights still sum to 1.00. Replaced the no-op inflation guard with a real substrate-claim audit guard (caps overall when polished prose masks a thin substrate). Closes the grades-the-doc-never-the-demo gap flagged in `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`. | ACE team |
