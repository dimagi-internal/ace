---
name: pdd-to-learn-app-eval
description: >
  Grade a Nova-built Learn app against the PDD that specified it —
  module count, order, Assessment Score wiring, content coverage.
disable-model-invocation: true
---

# PDD-to-Learn-App Eval

The Learn app is the FLW-training side of every CRISPR-Connect opp.
The PDD specifies modules, durations, content topics, and the
Connectify Assessment Score gates that govern when an FLW unlocks the
Deliver app. This skill grades whether the Nova-built Learn app
matches that spec.

Sibling rubric to `pdd-to-deliver-app-eval`. Same calibration
methodology, different dimensions tuned to Learn-app concerns. See
`skills/_eval-template.md` for shared contracts.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `1-design/idea-to-pdd.md` | source PDD; archetype + Learn App Specification drive expectation |
| Phase 2 | `2-commcare/pdd-to-learn-app_summary.md` | Learn-app structure summary (`nova_app_id`, modules) |
| Nova MCP (optional) | `get_app({app_id: <nova_app_id>})` | authoritative live blueprint (recommended over summary) |

## Products

- `2-commcare/pdd-to-learn-app-eval_verdict.yaml` — verdict YAML per `_eval-template.md § Verdict YAML contract`

## Process

1. **Read inputs from GDrive** (paths in `## Inputs` above).

2. **Detect HITL-pending stub.** If the learn app summary contains
   any of:
   - `nova_app_id: null`, `nova_app_id: TBD`, or no `nova_app_id` at all
   - explicit status text marking the build as HITL-pending
     (e.g. "actual app JSON/CCZ not yet produced", "awaiting human
     completion", "HITL-pending", "stub-only")
   - the summary lists *only* module titles with no Connectify
     wiring detail or content-topic breakdowns (the "skeleton" shape
     Phase 2 emits before Nova finishes a build)

   then emit `verdict: incomplete` immediately with `[INFO] HITL-stub
   summary; no built app to grade against PDD spec`. Do NOT score zero
   or warn — this is a structural gap in the upstream environment, not
   a quality defect. Surfaced 0.9.11 cross-opp validation: trying to
   grade a HITL-pending Learn summary makes Assessment Score wiring
   (the most load-bearing dimension at 30%) entirely missing — and the
   ≤3 → fail rule then fires on a stub, not on a real defect.

3. **Extract the PDD's Learn spec.** Parse `## Learn App
   Specification`. Build a structured expectation:
   - Total module count (PDD-numbered, not counting bonus
     certification modules Nova may add).
   - Module list with title + estimated duration + content topics.
   - Connectify Assessment Score requirements: which module(s) emit
     a score, what the threshold is (e.g. 10/12 calibration, 8/10
     final MCQ), retake count.
   - Reference-photo / reference-content requirements (often
     placeholders the LLO populates).
   - Archetype-specific: for `focus-group` Learn, the "facilitation
     craft" content (probing techniques, neutral framing, group
     dynamics) is load-bearing.

4. **Extract the built app's actual structure** from the blueprint
   (or app summary). Build the matching snapshot.

5. **Grade across 5 dimensions.** Each dimension is 0–10. Overall
   score is the weighted mean.

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Module-count match** | 15% | Total module count matches PDD spec. **Bonus-module rule (pinned 0.9.4):** if Nova adds a final certification-check module that meets BOTH conditions: (a) explicitly tagged as `assessment-only` (no `learn_module` wrapper) AND (b) PDD-specified content for the embedded check is preserved verbatim — score this dimension at **exactly 10.0**, not 9.5. Either condition unmet = 9.0 (small structural deviation). Other module additions or omissions are 1-point deductions per gap. |
   | **Module-order match** | 10% | Modules appear in the order the PDD specified (atomic-visit narrative: intro → flow → consent → photo → calibration → safety → vendor talk). **Cap clarification (pinned 0.9.4):** "capped at 3 points" means the dimension floor is **7.0** — i.e., reordering deductions stop accumulating after 3 points off, so the worst possible score is 7. Pre-0.9.4 wording was ambiguous (could be read as "stop counting after 3 swaps"). |
   | **Assessment Score wiring** | 30% | Most load-bearing dimension. The Connectify Assessment Score(s) MUST be wired correctly: numerator/denominator match the PDD's threshold (e.g. 10/12, 8/10), the score is tagged so Connect can read it as the gate to unlock Deliver, and the threshold matches the PDD spec exactly. Missing Assessment tag is a fail (≤3). Wrong threshold is a 3-point deduction. **Documented platform limitations rule (pinned 0.9.4):** when an internal score is documented in `eval-calibration/known-issues.md` as "informational-only / platform-limitation" (e.g. Module 3's `consent_score` not gated by Connect), it surfaces as `[INFO]` in `auto_surfaced` and does NOT deduct from this dimension. Platform limitations the LLO can't fix shouldn't bite the build's score. |
   | **Content-topic coverage** | 25% | Each module's content covers the PDD-specified topics. **Placeholder rule (clarified 0.9.4):** content the LLO must localize (reference photos, phone numbers, market lists) scores **as present** if the Nova field is wired to receive the content with proper structure (correct count of placeholders, correctly-typed fields). **Stub-answer-keys carve-out (added 0.9.4):** when a placeholder field is the *answer key* for a Connectify Assessment gate (e.g. Module 5's `expected_color_*` / `expected_shininess_*` fields), it does NOT score as present — a calibration gate scoring against stub answers is meaningless and the dimension must reflect that. Score these as 0.5-point deductions per missing answer key, capped at 2 points off the dimension. The auto_surfaced section flags ALL placeholders for the LLO regardless. |
   | **Archetype coherence** | 20% | For `atomic-visit`: the Learn app teaches form-walkthrough + observation calibration + safety, NOT facilitation craft. **M7 vendor-education-talk reading (pinned 0.9.4):** the M7 module's content is the FLW-reads-script-TO-vendor pattern, NOT a facilitation pattern (vendor doesn't speak in response to a structured question guide). atomic-visit coherent. For `focus-group`: the Learn app teaches facilitation craft (probing, neutral framing, group dynamics), NOT form completion. Wrong-archetype framing is a 4-point deduction. For `multi-stage`: per-stage Learn apps each grade against their own archetype branch. |

   **Deduction rules:**
   - Any single dimension ≤3 → suite verdict `fail`, regardless of
     overall mean.
   - **Inflation guard (mirrors OCS / deliver-app rubrics):** if the
     rubric surfaces ≥2 `[WARN]`-tier `auto_surfaced` entries,
     overall is capped at **8.5** regardless of per-dimension math.
   - **Pre-cap and post-cap reporting (added 0.9.4):** the verdict
     YAML's `overall_score` is the post-cap value. Add a sibling
     `overall_score_pre_cap` field showing the raw weighted mean.
     This is essential for the Learn rubric specifically because
     the cap binds on every Learn build today (every build has 3+
     placeholder WARNs by design — M4 photos, M5 calibration, M6
     phone numbers). Without pre-cap reporting the variance
     protocol collapses to 0.00 post-cap and we lose visibility
     into the underlying judge discretion.

6. **Write the verdict YAML** to
   `2-commcare/pdd-to-learn-app-eval_verdict.yaml` using the shape from
   `skills/_eval-template.md § Verdict YAML contract`. Dimensions:

   ```yaml
   dimensions:
     module_count_match:        { weight: 0.15 }
     module_order_match:        { weight: 0.10 }
     assessment_score_wiring:   { weight: 0.30 }
     content_topic_coverage:    { weight: 0.25 }
     archetype_coherence:       { weight: 0.20 }
   ```

7. **Auto-surfaced concerns** (per `_eval-template.md § Auto-surfaced
   severity rules`, plus skill-specific surfaces):
   - `[BLOCKER]` for any dimension scoring ≤ 3.
   - `[BLOCKER]` if overall is below 7.0.
   - `[WARN]` for each placeholder-content gap that the LLO MUST
     fill before deploy (reference photos, phone numbers, market
     list). These don't fail the eval but do gate live deployment.
   - `[WARN]` for each Assessment Score wiring deviation (wrong
     threshold, missing tag, score path that Connect can't read).
   - `[INFO]` for each defensible Nova structural addition (e.g. the
     bonus final-cert module split).

## LLM-as-Judge Rubric

Calibration target on the smoke-20260428-1242 Learn build:

- **Detection rate:** ≥ 80% of catalogued Learn-build issues from
  `eval-calibration/known-issues.md § Learn app build`.
- **Inter-run variance:** ≤ 0.5 across 3 same-model runs.
- **Score reflects defects:** a build with placeholder content that
  blocks live deployment (every Learn app today, until the LLO
  populates) should NOT score in the 9+ band. Placeholder-WARN flags
  should bring overall into the 8.0–8.7 range.

## Archetypes

| Archetype | What this skill does |
|---|---|
| `atomic-visit` | Default. Grades form-walkthrough + calibration + safety against PDD spec. |
| `focus-group` | Grades facilitation-craft training: probing techniques, neutral framing, group dynamics, question-guide walkthrough. The PDD's Facilitation Protocol is load-bearing here; cross-checks live in archetype_coherence dimension. |
| `multi-stage` | One Learn-app verdict per stage. Each verdict grades against the stage's own archetype branch. |

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)` for the Drive
block. Plus:
- Nova MCP: `get_app` (authoritative blueprint, recommended)

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior (stock)`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-28 | Initial version. 5 dimensions: module_count_match (0.15), module_order_match (0.10), assessment_score_wiring (0.30 — most load-bearing), content_topic_coverage (0.25), archetype_coherence (0.20). Mirror of pdd-to-deliver-app-eval. Inflation guard at 8.5 when ≥2 WARN auto_surfaced. | ACE team (eval system buildout — 0.9.2) |
| 2026-04-29 | Added step-2 HITL-pending stub detection. If the learn app summary has no `nova_app_id`, has `TBD`/`null`, is explicitly marked HITL-pending, or lists only module titles without Connectify wiring or content-topic detail, emit `verdict: incomplete` immediately. Without this guard the rubric's most load-bearing dimension (assessment_score_wiring at 30%) graded a stub as "wiring entirely missing" → forced ≤3 → fail, on a build that wasn't actually a defect. Mirrors the deliver-app-eval HITL guard. | ACE team (0.10.8) |
