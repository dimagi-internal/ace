---
name: pdd-to-deliver-app-eval
description: >
  Grade a Nova-built Deliver app against the PDD that specified it —
  field count, ordering, conditional logic, Connectify wiring.
disable-model-invocation: true
---

# PDD-to-Deliver-App Eval

The Deliver app is the most testable artifact ACE produces: the PDD
specifies a precise field count, order, conditional logic, and gate
semantics, and the Nova build either matches them or doesn't. This
skill grades that match.

Sibling rubric to `pdd-to-learn-app-eval`. See `skills/_eval-template.md`
for shared contracts (verdict shape, severity rules, stock blocks)
and `skills/eval-calibration/SKILL.md` for calibration methodology.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `1-design/idea-to-pdd.md` | source PDD; archetype + Deliver App Specification + delivery unit drive expectation |
| Phase 2 | `2-commcare/pdd-to-deliver-app_summary.md` | Deliver-app structure summary (`nova_app_id`, forms, fields) |
| Nova MCP (optional) | `get_app({app_id: <nova_app_id>})` | authoritative field-by-field blueprint (recommended) |

## Outputs

- `2-commcare/pdd-to-deliver-app-eval_verdict.yaml` — verdict YAML per `_eval-template.md § Verdict YAML contract`

## Process

1. **Read inputs from GDrive** (paths in `## Inputs` above).

2. **Detect HITL-pending stub.** If the deliver app summary contains
   any of:
   - `nova_app_id: null`, `nova_app_id: TBD`, or no `nova_app_id` at all
   - explicit status text marking the build as HITL-pending
     (e.g. "actual app JSON/CCZ not yet produced", "awaiting human
     completion", "HITL-pending", "stub-only")
   - the summary lists *only* placeholders/section names with no
     field-level structure (the "skeleton" shape Phase 2 emits before
     Nova finishes a build)

   then emit `verdict: incomplete` immediately with `[INFO] HITL-stub
   summary; no built app to grade against PDD spec`. Do NOT score zero
   or warn — like degraded mode in `connect-program-setup-eval`, this
   is a structural gap in the upstream environment, not a quality
   defect. Once Nova produces a real `nova_app_id` and field-level
   structure, the rubric becomes gradable. Surfaced 0.9.11 cross-opp
   validation: trying to grade a HITL-pending summary makes 2 of 5
   dimensions ungradable (field-order, conditional-logic) and inflates
   the others toward "looks fine" because there's nothing concrete to
   discriminate against.

3. **Extract the PDD's Deliver spec.** Parse the `## Deliver App
   Specification` section (or equivalent for `multi-stage`). Build a
   structured expectation:
   - Total field count (sum across all sections).
   - Section list with question count per section.
   - Question order (the LLO-spec'd numbering).
   - Required-yes consent gate location (which question, what semantics).
   - Conditional-display rules (e.g. "only shown if Q11 = yes").
   - Connectify Deliver Unit name and Entity ID composite formula.
   - Operational caps that should appear in form intro copy.

4. **Extract the built app's actual structure** from the Nova
   blueprint (or app summary). Build the matching structured snapshot.

5. **Grade across 5 dimensions.** Each dimension is 0–10. Overall
   score is the weighted mean.

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Field-count match** | 20% | Total field count in the built app matches the PDD's spec exactly. Extra hidden/computed fields (case_name, entity_id) are fine; extra user-facing fields are not. **Split rule (added 0.9.1):** when one PDD field is implemented as a parent + a relevance-conditional child (e.g. PDD Q8 "Price per unit, required if disclosed" → built Q8 `price_disclosed` + Q8b `price_per_unit` relevant when Q8=yes), count this as **one half-deviation (-0.5 points)**, not two adds. The split is defensible UX but does change the user-visible field count. **Sub-question rule:** when PDD spec says "free-text 'other' allowed" and the build adds a separate `_other` field for that input, count as **zero deviation (-0)** — that's spec-implied. ±1 net deviation = 0.5-point deduction; ±2+ = 2-point deduction. |
   | **Question-order match** | 15% | Per-section question order matches the LLO numbering. Out-of-order is a 1-point deduction per question, **capped at 5 points off the dimension** (so the dimension floor is 5.0; "capped at 5 points" was ambiguous in 0.9.0 — pinned 0.9.4). Section-level reorder (e.g. consent gate placement) is graded under "Gate semantics." |
   | **Gate semantics match** | 25% | Required-yes consent gate (or equivalent) is present, in the correct form-flow position, and with the correct branch behavior (e.g. "if no, short-circuit to refusal-reason and submit"). Missing gate is a fail. Wrong branch behavior is ≤4. |
   | **Conditional logic match** | 15% | **Scope (pinned 0.9.4): relevance/display-conditional fields ONLY.** Examples: "Q12 only shown if Q11=yes"; "Q21 only shown if Q20=no". Does NOT include in-app camera framing prompts, pre-submit validation expressions on geopoint accuracy, or other client-side enforcement — those are graded under `gate_semantics_match`. Missing relevance condition makes a field always-shown — that's a 2-point deduction per missed condition. Inverted relevance condition is ≤3. |
   | **Connectify wiring** | 25% | (Sub-checks made explicit 0.9.4 — previously a single continuous score; split into 3 sub-rows in the verdict YAML to surface which sub-check is the swing factor.) Three sub-checks, each worth ~8.3 points contributing to the dimension score: (a) **Deliver Unit name match** — exact match to PDD spec; (b) **Entity ID composite** — matches the PDD's stated formula (or, where the PDD doesn't fully specify, is sensible — e.g. includes market_name + GPS hash for atomic-visit); (c) **Required-for-credit fields** — typically photo + GPS + consent — wired correctly with relevant `validate` rules. |

   **Deduction rules:**
   - Any single dimension ≤3 → suite verdict `fail`, regardless of
     overall mean.
   - **Inflation guard (added 0.9.1, mirrors `ocs-chatbot-eval`):** if
     the rubric surfaces ≥2 `[WARN]`-tier `auto_surfaced` entries,
     overall is capped at **8.5** regardless of per-dimension math.
     Multiple defects compound — a build with 2+ documented spec
     deviations can still pass but should not score in the
     "essentially-perfect" 8.7+ band.
   - 2+ dimensions in 4–6 range → suite verdict `warn`.
   - All 5 dimensions ≥ 7 AND overall ≥ 7.5 → suite verdict `pass`.

6. **Write the verdict YAML** to
   `2-commcare/pdd-to-deliver-app-eval_verdict.yaml` using the shape
   from `skills/_eval-template.md § Verdict YAML contract`. Dimensions:

   ```yaml
   dimensions:
     field_count_match:        { weight: 0.20 }
     question_order_match:     { weight: 0.15 }
     gate_semantics_match:     { weight: 0.25 }
     conditional_logic_match:  { weight: 0.15 }
     connectify_wiring:        { weight: 0.25 }
   ```

7. **Write the human-readable report** to
   `2-commcare/pdd-to-deliver-app-eval_report.md` summarizing each
   dimension's score, surfaced discrepancies (WARN/INFO table), and
   suggested Nova edits to bring the build into spec.

8. **Auto-surfaced concerns** (per `_eval-template.md § Auto-surfaced
   severity rules`, plus skill-specific surfaces):
   - `[WARN]` for each user-facing field present in the build but not
     in the PDD spec.
   - `[INFO]` for hidden/computed fields added beyond spec (case_name,
     entity_id, etc.) — those are typical Nova decisions, not bugs.

## LLM-as-Judge Rubric

This rubric is **structural-first, semantic-second**. Most
discrepancies between PDD and built app are mechanical: count, order,
condition, name. The judge prompt should compute these
deterministically from the two snapshots before spending tokens on
"is this Connectify wiring sensible?" semantic judgments.

When invoking the LLM judge, seed the prompt with both snapshots in
structured form (parsed JSON or YAML), not the raw artifact text.
That way the judge spends its tokens on the comparison, not on
parsing the markdown.

**Calibration:** the rubric is calibrated against the
`eval-calibration` ground-truth catalogue. For
`smoke-20260428-1242`, known discrepancies the rubric MUST detect
are listed in
`ACE/smoke-20260428-1242/eval-calibration/known-issues.md` (the
Q8/Q8b split, the Q21b sub-question, the operational-caps
server-side note). Detection rate must be ≥ 80% on a calibration
run.

## Archetypes

| Archetype | What this skill does |
|---|---|
| `atomic-visit` | Default. Grades the single-form Deliver app against the PDD's Deliver Specification. |
| `focus-group` | Grades the FGD facilitation form (typically multi-section, attendance + per-domain summaries) against the PDD's session-form spec. The "consent gate" criterion shifts to the participant-consent script's location and semantics. |
| `multi-stage` | Run once per stage that has its own delivery work, branching on each stage's archetype. The stage-gate field is graded under `gate_semantics_match`. |

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)` for the Drive
block. Plus:
- Nova MCP: `get_app` (authoritative blueprint, recommended over the
  human summary alone)

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior (stock)`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-28 | Initial version. Cross-artifact rubric: 5 dimensions (field_count_match, question_order_match, gate_semantics_match, conditional_logic_match, connectify_wiring). Calibrated against `eval-calibration/known-issues.md`. Template for future cross-artifact evals. | ACE team (eval system buildout) |
| 2026-04-29 | Added step-2 HITL-pending stub detection. If the deliver app summary has no `nova_app_id`, has `TBD`/`null`, is explicitly marked HITL-pending, or carries only skeleton structure, emit `verdict: incomplete` immediately. Surfaced 0.9.11 cross-opp validation against `turmeric-dogfood-20260427`: trying to grade a HITL-pending summary made 2 of 5 dimensions ungradable (field-order, conditional-logic) and inflated the others. The early-return pattern mirrors `connect-program-setup-eval`'s degraded-mode detection — both treat upstream environmental gaps as `incomplete`, not as quality defects. | ACE team (0.10.8) |
| 2026-05-05 | Step 7 report path migrated to `runs/<run-id>/2-commcare/pdd-to-deliver-app-eval_report.md` (was opp-level `eval-reports/YYYY-MM-DD-pdd-to-deliver-eval.md`). No methodology change. | ACE team |
