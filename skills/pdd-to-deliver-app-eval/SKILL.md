---
name: pdd-to-deliver-app-eval
description: >
  Judge a Nova-built Deliver app against the PDD that specified it.
  Cross-artifact LLM-as-Judge eval — checks that field count, ordering,
  conditional logic, Connectify wiring, and required-field rules in the
  built app actually match what the PDD asked for. Writes a verdict YAML
  in the shared QA/eval shape so opp-eval can aggregate it.
---

# PDD-to-Deliver-App Eval

The Deliver app is the most testable artifact ACE produces: the PDD
specifies a precise field count, order, conditional logic, and gate
semantics, and the Nova build either matches them or doesn't. This
skill grades that match.

This is a **cross-artifact eval** — it judges agreement between two
artifacts (`pdd.md` and the Nova-built deliver app) rather than the
quality of one artifact in isolation. It's the template for future
cross-artifact rubrics (`pdd-to-learn-app-eval`,
`learn-vs-deliver-eval`, `connect-opp-vs-pdd-eval`).

See `skills/README.md § QA vs Eval — the two-phase pattern` and
`skills/eval-calibration/SKILL.md` for the calibration methodology.

## Process

1. **Read inputs from GDrive:**
   - PDD: `ACE/<opp-name>/pdd.md`
   - Deliver app summary: `ACE/<opp-name>/app-summaries/deliver-app-summary.md`
     (contains the `nova_app_id` and the human-readable summary).
   - Optionally fetch the live blueprint via Nova MCP
     `get_app({app_id: <nova_app_id>})` — provides the authoritative
     field-by-field structure, not the human summary.

2. **Extract the PDD's Deliver spec.** Parse the `## Deliver App
   Specification` section (or equivalent for `multi-stage`). Build a
   structured expectation:
   - Total field count (sum across all sections).
   - Section list with question count per section.
   - Question order (the LLO-spec'd numbering).
   - Required-yes consent gate location (which question, what semantics).
   - Conditional-display rules (e.g. "only shown if Q11 = yes").
   - Connectify Deliver Unit name and Entity ID composite formula.
   - Operational caps that should appear in form intro copy.

3. **Extract the built app's actual structure** from the Nova
   blueprint (or app summary). Build the matching structured snapshot.

4. **Grade across 5 dimensions.** Each dimension is 0–10. Overall
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

5. **Write the verdict YAML** to
   `ACE/<opp-name>/verdicts/pdd-to-deliver-app-eval.yaml` using the
   shared shape (see `skills/README.md § QA vs Eval`):

   ```yaml
   skill: pdd-to-deliver-app-eval
   target: <nova_app_id>
   mode: deep
   ran_at: <ISO timestamp>
   capture_path: app-summaries/deliver-app-summary.md  # the snapshot judged

   overall_score: 8.4
   verdict: pass | warn | fail | incomplete

   dimensions:
     field_count_match:        { score: 9.0, weight: 0.20 }
     question_order_match:     { score: 9.5, weight: 0.15 }
     gate_semantics_match:     { score: 8.5, weight: 0.25 }
     conditional_logic_match:  { score: 7.5, weight: 0.15 }
     connectify_wiring:        { score: 8.0, weight: 0.25 }

   per_item:
     - ref: "Q20 consent gate"
       score: 8.5
       verdict: pass
       note: "Present, first in form order, correct short-circuit branch on Q20=no"
     - ref: "Field count"
       score: 9.0
       verdict: pass
       note: "21 LLO-numbered fields present; 2 hidden computed (case_name, entity_id) and 1 sub-question (Q21b for 'other' reason) added beyond spec"
     # ... one per check

   auto_surfaced:
     - severity: WARN
       message: "Q8 split into Q8 + Q8b in the build (not in PDD spec). Defensible but worth flagging — recheck PDD intent."

   gate:
     threshold: 7.5
     disposition: approve | reject | iterate
   ```

6. **Write the human-readable report** to
   `ACE/<opp-name>/eval-reports/YYYY-MM-DD-pdd-to-deliver-eval.md`:

   ```markdown
   # PDD-to-Deliver App Eval Report
   Date: YYYY-MM-DD
   PDD: pdd.md
   Built app: <nova_app_id>
   Overall Score: X.X / 10
   Verdict: PASS | WARN | FAIL

   ## Dimension Breakdown
   - Field-count match: X.X / 10
   - Question-order match: X.X / 10
   - Gate semantics match: X.X / 10
   - Conditional logic match: X.X / 10
   - Connectify wiring: X.X / 10

   ## Discrepancies surfaced

   | Severity | Detail |
   |---|---|
   | WARN | Q8 split into Q8 + Q8b in the build (not in PDD spec) |
   | INFO | Operational caps documented in form intro copy as expected; enforcement is server-side |

   ## Suggested Nova edits
   <One bullet per actionable discrepancy. Imperative voice. e.g.
   "Combine Q8 and Q8b into a single optional numeric field with a
   `not_disclosed` skip option to match the PDD spec." Skip if no
   actionable edits.>
   ```

7. **Auto-surfaced concerns** feed the gate brief (when invoked from
   the Phase 2→3 gate):
   - `[BLOCKER]` for any dimension scoring ≤ 3.
   - `[BLOCKER]` if overall score is below 7.0.
   - `[WARN]` for each dimension scoring 4.0–6.9.
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

- Google Drive: `drive_read_file`, `drive_create_file`,
  `drive_list_folder`
- Nova MCP: `get_app` (authoritative blueprint, recommended over the
  human summary alone)
- No OCS calls — this skill judges artifacts, not chatbot responses

## Mode Behavior

- **Auto:** Grade, write verdict + report, return overall score and
  disposition to the caller (the orchestrator's commcare-setup
  procedure).
- **Review:** Pause after grading to let a human eyeball the verdict
  before the gate brief propagates.

## Dry-Run Behavior

When `--dry-run` is active:
- Read the PDD and app summary normally — these are read-only inputs.
- Write the verdict + report to Drive (human-facing artifacts; not
  treated as effectful).
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-28 | Initial version. Cross-artifact rubric: 5 dimensions (field_count_match, question_order_match, gate_semantics_match, conditional_logic_match, connectify_wiring). Calibrated against `eval-calibration/known-issues.md`. Template for future cross-artifact evals. | ACE team (eval system buildout) |
