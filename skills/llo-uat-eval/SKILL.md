---
name: llo-uat-eval
description: >
  Grade an llo-uat results compilation against PDD success metrics —
  coverage completeness, sign-off clarity, blocker resolution.
disable-model-invocation: true
---

# LLO UAT Eval

`llo-uat` is the Phase 8 skill that compiles user-acceptance-test
results from collected LLO responses ahead of `llo-launch`. It is the
last quality gate before activation: blockers surfaced here either
become launch-stoppers or get a documented resolution path. This
rubric grades whether that compilation faithfully covers the PDD's
success metrics, names the LLOs giving sign-off, and resolves every
flagged blocker.

This is a Phase 8 process-skill eval, sibling of `llo-launch-eval`
which grades the activation step that follows. See
`skills/_eval-template.md` for shared contracts and
`skills/eval-calibration/SKILL.md` for calibration methodology.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `1-design/idea-to-pdd.md` | source PDD; Success Metrics + Evidence Model define UAT coverage expectation |
| Phase 8 | `8-execution/llo-uat_results.md` | UAT compilation under judgment |
| Phase 8 | `8-execution/llo-onboarding_*` artifacts | LLO roster (who *should* have signed off) |
| Phase 5/2 | `2-commcare/app-deploy_summary.md` | what was deployed for UAT to exercise |

## Products

- `8-execution/llo-uat-eval_verdict.yaml` — verdict YAML per `_eval-template.md § Verdict YAML contract`. Filename uses the **producer** skill name (`llo-uat`).

## Process

1. **Read inputs from GDrive** (paths in `## Inputs` above). Also read
   `runs/<run-id>/run_state.yaml` to confirm Phase 8 reached `llo-uat`.

2. **Detect "phase not run" mode.** If `run_state.yaml` shows
   `phases.execution-management.llo-uat` not `done` or
   `8-execution/llo-uat_results.md` is missing, emit `verdict:
   incomplete` immediately with `[INFO] Phase 8 llo-uat not run; not
   gradable yet`.

3. **Extract the PDD's UAT-coverage expectation:**
   - Every Success Metric (rows of the `## Success Metrics` table).
   - Every Layer A verification rule from the Evidence Model that the
     UAT should have exercised (GPS, photo, consent gate, etc.).
   - The expected LLO roster (one sign-off per LLO from the
     onboarding artifact).

4. **Grade across 5 dimensions.** Each dimension is 0–10. Overall
   score is the weighted mean.

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **UAT coverage completeness** | 0.30 | Every PDD Success Metric and every Layer A verification rule must be exercised by at least one UAT scenario in `llo-uat_results.md`. Missing a Success Metric = 2-point deduction per metric. Missing a Layer A rule = 1.5-point deduction per rule. **Hard block:** UAT covering < 50% of declared Success Metrics is a fail (≤ 3) — the gate is not actually a gate. |
   | **LLO sign-off clarity** | 0.25 | Every LLO in the onboarding roster must have an explicit sign-off entry: named LLO, named contact, explicit `go` / `no-go` per Success Metric (or per overall opp, when the PDD is metric-light). Implicit sign-off ("LLO 1 didn't object") = 2-point deduction per LLO. Missing entry entirely = 3-point deduction per LLO. **Hard block:** ≥ 1 LLO explicit `no-go` recorded but the doc still recommends launch = fail (≤ 3). |
   | **Blocker resolution** | 0.20 | Every blocker flagged in the UAT must have a resolution path: fixed (with evidence), accepted-with-mitigation (with named owner + mitigation), or escalated (with named decision-maker + deadline). Unresolved blockers = 2-point deduction per blocker. **Hard block:** any blocker recorded as unresolved with no documented path = fail (≤ 3) — that's an open launch risk. |
   | **Evidence-citation discipline** | 0.15 | Every claim ("LLO 2 hit the photo-pass-rate target", "GPS accuracy < 30m on 95% of test visits") must cite a specific UAT artifact (transcript, photo log, calibration sheet) rather than improvise. Uncited claims are 0.5-point deductions per occurrence. The skill is supposed to *compile* evidence, not summarize from memory. |
   | **Launch-readiness recommendation** | 0.10 | The doc must end with a clear `recommend: launch | hold | iterate` decision keyed to the dimensions above. Missing recommendation = fail (≤ 3). Vague recommendation ("looking good", "we should be fine") without a keyword decision = 2-point deduction. Recommendation contradicts the evidence (says `launch` despite an unresolved blocker or LLO `no-go`) = fail (≤ 3). |

   **Deduction rules:**
   - Any single dimension ≤ 3 → suite verdict `fail`, regardless of
     overall mean. (Last gate before activation; failure modes here
     ship to real LLOs and FLWs.)
   - **Inflation guard (mirrors prior rubrics):** if the rubric
     surfaces ≥ 2 `[WARN]`-tier `auto_surfaced` entries, overall is
     capped at **8.5**.
   - **Pre-cap and post-cap reporting** per `eval-calibration` § 0.9.4
     guidance.

   **Verdict tiers:**
   - `pass` — overall ≥ 7.0, no dimension ≤ 3.
   - `warn` — overall ≥ 5.0 < 7.0, or any inflation cap binds.
   - `fail` — overall < 5.0 OR any dimension ≤ 3.
   - `incomplete` — Phase 8 `llo-uat` not run, or artifact missing entirely.

   **Severity tiers** for `auto_surfaced` entries:
   - `[BLOCKER]` — must-fix before launch. Counts as a hard defect.
   - `[WARN]` — should-fix; counts toward inflation guard.
   - `[INFO]` — observational, no action required.

5. **Write the verdict YAML** to
   `8-execution/llo-uat-eval_verdict.yaml` using the shape from
   `skills/_eval-template.md § Verdict YAML contract`. Dimensions:

   ```yaml
   dimensions:
     uat_coverage_completeness:       { weight: 0.30 }
     llo_signoff_clarity:             { weight: 0.25 }
     blocker_resolution:              { weight: 0.20 }
     evidence_citation_discipline:    { weight: 0.15 }
     launch_readiness_recommendation: { weight: 0.10 }
   ```

6. **Auto-surfaced concerns** (per `_eval-template.md § Auto-surfaced
   severity rules`, plus skill-specific surfaces):
   - `[BLOCKER]` for any dimension scoring ≤ 3.
   - `[BLOCKER]` for any unresolved UAT blocker without a documented
     resolution path.
   - `[BLOCKER]` for any LLO `no-go` recorded but doc still recommends launch.
   - `[BLOCKER]` if overall score is below 7.0.
   - `[WARN]` per PDD Success Metric not exercised by any UAT scenario.
   - `[WARN]` per missing or implicit LLO sign-off.
   - `[WARN]` per uncited cycle-level claim.
   - `[INFO]` per Layer A rule the UAT did not exercise but
     `connect-opp-setup` already enforces structurally.

## LLM-as-Judge Rubric

Calibration target on a real UAT compilation:

- **Detection rate:** ≥ 80% of catalogued UAT-compilation issues from
  `eval-calibration/known-issues.md § LLO UAT`.
- **Inter-run variance:** ≤ 0.5 across 3 same-model runs.
- **Cross-model variance:** ≤ 1.0 for strong calibration.

This rubric ships at **provisional** until a real Phase 8 UAT
compilation produces ground truth. Until then, it correctly emits
`incomplete` on opps where Phase 8 hasn't reached `llo-uat`.

## Archetypes

| Archetype | What this skill does |
|---|---|
| `atomic-visit` | Default. Grades per-visit Success Metric coverage (visits/day, photo pass rate, GPS accuracy). |
| `focus-group` | Grades per-session Success Metric coverage (session completion, transcript quality, theme synthesis). Adds a "facilitator-vs-participant sign-off" sub-check under `llo_signoff_clarity` (FGD UAT requires both roles to sign off). |
| `multi-stage` | Grades stage-by-stage UAT coverage. Adds a "per-stage gate-pass evidence" sub-check under `uat_coverage_completeness` (each stage transition's pre-conditions must be exercised). |

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)`. No external
API calls beyond Drive.

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

## Dry-Run Behavior

Per `skills/_eval-template.md § Dry-Run Behavior (stock)`. Read-only,
verdict + report written to Drive.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-09 | Initial version. 5 dimensions: uat_coverage_completeness (0.30 — most load-bearing for "did we actually test what we said we'd test"), llo_signoff_clarity (0.25), blocker_resolution (0.20), evidence_citation_discipline (0.15), launch_readiness_recommendation (0.10). Inflation guard at 8.5. Three hard-block rules: <50% Success Metric coverage; LLO no-go but recommend launch; unresolved blocker with no path. Explicit `incomplete` verdict when Phase 8 hasn't reached `llo-uat`. Last quality gate before `llo-launch` activation. Ships at provisional calibration until a real UAT compilation produces ground truth. Closes the "not yet migrated" registry row for `llo-uat`. | ACE team |
