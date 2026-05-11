---
name: pdd-to-app-journeys-eval
description: >
  Quality eval on the pdd-to-app-journeys.md artifact. Six dimensions
  graded via LLM-as-Judge: persona specificity, archetype alignment,
  coverage completeness, happy-path voice, edge-case recoverability,
  pass-criteria measurability.
disable-model-invocation: true
---

# PDD-to-App-Journeys Eval

Quality grader for the `pdd-to-app-journeys.md` artifact. This skill grades whether the journey set is *good*.

There is **no companion QA skill** for this artifact — see `skills/_qa-decisions.md` for the rationale (downstream consumers `app-test-cases` and `app-ux-eval` are LLM-driven and grade content, not bold-label punctuation, so structural QA gates nothing real). See `skills/_eval-template.md` for the shared eval contract.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 producer | `1-design/pdd-to-app-journeys.md` | the journeys doc under judgment |
| Phase 1 producer | `1-design/idea-to-pdd.md` | the source PDD; archetype + Target FLW for grading alignment |

## Products

- `1-design/pdd-to-app-journeys-eval_verdict.yaml` — verdict YAML per `_eval-template.md § Verdict YAML contract`

## Process

1. **Use inputs already in context (preferred) or read from Drive.**
   When invoked from the `design-review` subagent (the common
   `/ace:run` path), the journeys artifact and PDD are already loaded
   by the parent's Step 3 / Step 1 — do NOT re-issue
   `drive_read_file`. See `agents/design-review.md` § Performance
   conventions. Only re-read when invoked standalone via
   `/ace:step pdd-to-app-journeys-eval <opp>/<run-id>`.

   Inputs (location for standalone reads):
   - `runs/<run-id>/1-design/pdd-to-app-journeys.md` (artifact under judgment)
   - `runs/<run-id>/1-design/idea-to-pdd.md` (PDD; for archetype + Target FLW reference)

2. **Halt on missing inputs.** If `pdd-to-app-journeys.md` is absent or empty, emit `verdict: incomplete` with `[INFO] producer artifact missing; eval skipped`. (No QA gate replaces this fast-path; the eval itself short-circuits when there's nothing to grade.)

3. **Grade across 6 dimensions.** Each 0–10. Overall = weighted mean.

4. **Write the verdict YAML** to `1-design/pdd-to-app-journeys-eval_verdict.yaml`.

5. **Auto-surfaced concerns** per `_eval-template.md § Auto-surfaced severity rules`.

## LLM-as-Judge Rubric

This skill ships **provisional** until calibrated against ground truth. Initial anchors below; refine per `eval-calibration` methodology.

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Persona specificity** | 15% | Does the persona block describe a SPECIFIC FLW (named or archetypal) with concrete, gradable attributes (smartphone proficiency tier, daily volume, connectivity context, prior-research-experience baseline)? **Anchors:** named FLW with all attributes specific = **9.5**; specific attributes but generic role = **7.5**; generic "FLWs are smartphone-literate" = **5.0**; absent or template-placeholder content = **2.0**. |
   | **Archetype alignment** | 15% | The journey set's category mix matches the declared archetype's expected branches (per skills/pdd-to-app-journeys/SKILL.md § Archetypes). **Anchors:** every expected category has a journey, no off-archetype journeys = **9.5**; one expected category missing = **7.0**; off-archetype journey present (e.g. eligibility-edge in a focus-group set) = **5.0**; majority of journeys mismatch archetype = **3.0**. |
   | **Coverage completeness** | 15% | Within the archetype, are the journey set's edge cases comprehensive enough that `app-ux-eval` can grade real failure modes? **Anchors:** ≥2 distinct error-recovery edge cases per journey covering data-quality, eligibility, connectivity, and submission-confirmation paths = **9.0**; covers most failure modes but ≥1 obvious gap = **7.0**; happy paths only with thin edge cases = **5.0**; no recovery edge cases at all = **3.0**. |
   | **Happy-path narrative voice** | 20% | Each Happy path narrative uses **user-outcome language** ("FLW confirms household by name and phone, completes screening, photographs the MTN card, and submits") not **field/form mechanics** ("tap next, fill household_id, click submit button"). **Anchors:** every narrative is user-outcome-grounded with concrete actions = **9.5**; mostly user-outcome with ≥1 mechanics-leaning narrative = **8.0**; mixed; mechanics dominate ≥1 narrative = **6.0**; field/form mechanics throughout = **3.5**; UI-callout descriptions ("the button on screen 3") = **2.0**. |
   | **Edge-case recoverability** | 20% | Each edge case is phrased as a **UX outcome the FLW experiences** with a clear recovery path, NOT a backend error code. **Anchors:** every edge case names the FLW outcome + the recovery action = **9.5**; mostly UX outcomes but ≥1 backend-error-flavored = **7.5**; mixed; ≥half are error-code-flavored ("returns 409 Conflict") = **5.0**; backend errors throughout = **3.0**. |
   | **Pass-criteria measurability** | 15% | Pass criteria are concrete enough that `app-ux-eval` (LLM-as-Judge over screenshots + transcripts) can grade them. **Anchors:** every criterion has a concrete measurement (time bound, error visibility, recoverability with no data loss) = **9.5**; most measurable but ≥1 vague ("works correctly") = **7.5**; multiple vague criteria = **5.0**; criteria are aspirational/un-gradable = **3.0**. |

   **Deduction rules:**
   - Any single dimension ≤3 → suite verdict `fail`.
   - **Inflation guard:** if every dimension scores ≥9, this is the rare ideal — no cap. If overall ≤6 with 0 dimension flagged ≤3, that's a calibration signal that the rubric isn't discriminating; surface `[INFO]`.
   - Pre-cap and post-cap reporting per the standard contract.

## Verdict YAML

   ```yaml
   skill: pdd-to-app-journeys-eval
   target: <opp-name>
   ran_at: <ISO>
   capture_path: 1-design/pdd-to-app-journeys.md

   overall_score: 0.0-10.0
   overall_score_pre_cap: 0.0-10.0
   verdict: pass | warn | fail | incomplete

   dimensions:
     persona_specificity:           { weight: 0.15 }
     archetype_alignment:           { weight: 0.15 }
     coverage_completeness:         { weight: 0.15 }
     happy_path_narrative_voice:    { weight: 0.20 }
     edge_case_recoverability:      { weight: 0.20 }
     pass_criteria_measurability:   { weight: 0.15 }

   auto_surfaced:
     - severity: BLOCKER | WARN | INFO
       message: "..."
   ```

## Calibration target

- **Detection rate:** ≥ 80% of catalogued journeys-doc issues from `eval-calibration/known-issues.md § journeys` (when populated).
- **Inter-run variance:** ≤ 0.5 across 3 same-model runs.
- **Cross-model variance:** ≤ 1.0 for strong calibration.

Ships **provisional**; promote to strongly-calibrated after first cross-opp validation.

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_create_file`

## Mode Behavior

- **Auto:** Grade, write verdict, return overall + disposition.
- **Review:** Pause for human inspection of the verdict before propagating.

## Dry-Run Behavior

When `--dry-run`: read inputs and write verdict normally (verdict is an internal artifact, not external comm).

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-08 | Initial skill. Phase 1 PR #2 of the QA/Eval split migration (greenfield — pdd-to-app-journeys had neither QA nor eval before this PR). 6 quality dimensions; gates on pdd-to-app-journeys-qa. Provisional calibration. | ACE team (0.13.89) |
| 2026-05-08 | Companion `pdd-to-app-journeys-qa` removed (downstream consumers are LLM-driven; structural QA gates nothing real — see `skills/_qa-decisions.md`). Eval no longer reads a QA verdict; halts itself on missing/empty producer artifact. | ACE team |
