---
name: partnership-microdemo-eval
description: >
  LLM-as-judge quality eval for the partnership-microdemo artifact. Grades
  clip fidelity, angle relevance, and provenance honesty. Writes a verdict
  YAML. Gated by partnership-microdemo inline QA.
disable-model-invocation: true
---

# Partnership Micro-Demo Eval

Independent LLM-as-Judge quality evaluation of the `micro-demo/provenance.yaml` artifact produced by `partnership-microdemo`. Grades across three dimensions that test whether the sourced or mocked clip(s) credibly show the product beat claim, match the picked angle's proof intent, and honestly document whether the footage is reused or mocked. The `provenance_honesty` dimension is the heaviest because passing a mock off as real footage to a prospect is a trust violation — the eval must surface this class of failure hard. Writes a verdict YAML that `opp-eval` aggregates. Gated by `partnership-microdemo` inline QA — if QA failed, this skill emits `verdict: incomplete` without grading.

See `skills/_eval-template.md` for shared contracts (verdict YAML shape, severity rules, inflation guard, stock blocks). See `skills/eval-calibration/SKILL.md` for the calibration methodology.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| `partnership-microdemo` | `ACE/partnerships/<slug>/runs/<run-id>/micro-demo/provenance.yaml` | Primary artifact under judgment |
| `partnership-angles` | `ACE/partnerships/<slug>/runs/<run-id>/angles.yaml` | Ground truth for the relevance dimension — the picked angle's `product` beat intent |
| Phase 1 profile | `ACE/partnerships/<slug>/prospect.yaml` | Sector, geography — for fidelity anchor |
| `partnership-microdemo` inline QA | `phases.microdemo.verdict` in `run_state.yaml` | QA gate — if verdict is `fail` or `incomplete`, skip eval |

## Products

- `7-microdemo/partnership-microdemo-eval_verdict.yaml` — verdict YAML per `skills/_eval-template.md § Verdict YAML contract`

## Process

1. **Check the QA gate.**

   Read `ACE/partnerships/<slug>/runs/<run-id>/run_state.yaml` via `drive_read_file`. Inspect `phases.microdemo.verdict`. If the verdict is `fail` or `incomplete`, write `verdict: incomplete` immediately and halt:

   ```yaml
   skill: partnership-microdemo-eval
   target: <prospect-slug>
   ran_at: <ISO timestamp>
   capture_path: micro-demo/provenance.yaml
   overall_score: 0
   verdict: incomplete
   dimensions: {}
   auto_surfaced:
     - severity: INFO-SKIPPED
       message: "Skipped — partnership-microdemo inline QA returned verdict: <qa-verdict>. Fix QA failures first."
   ```

2. **Read the artifacts and prospect context.**

   Read from Drive via `drive_read_file`:
   - `ACE/partnerships/<slug>/runs/<run-id>/micro-demo/provenance.yaml`
   - `ACE/partnerships/<slug>/runs/<run-id>/angles.yaml` (extract the `selected_angle` entry's `beats.product` intent and `primary_capability`)
   - `ACE/partnerships/<slug>/prospect.yaml` (for `sector`, `target_geography`, `name`)

3. **Apply the LLM-as-Judge rubric** (see `## LLM-as-Judge Rubric` below). Grade each of the three dimensions 0–10. Compute the weighted overall score.

4. **Apply the `provenance_honesty` hard floor.**

   Before computing the verdict, check for any clip whose `source` field contradicts what the clip content plausibly is. A confirmed mock presented as reuse (or vice versa), OR a missing/null `source` field on any clip, automatically:
   - Floors `provenance_honesty` at ≤ 3.0
   - Sets suite `verdict: fail`
   - Surfaces a `BLOCKER` auto-surfaced entry naming the specific clip and the discrepancy

   This floor is non-negotiable: a mock presented as real footage in a prospect-facing video is a material misrepresentation.

5. **Write the verdict YAML** to `7-microdemo/partnership-microdemo-eval_verdict.yaml`.

   Resolve or create `runs/<run-id>/7-microdemo/` via `drive_create_folder` with `findOrCreate: true`. Write via `drive_create_file` (NOT `drive_create_doc_from_markdown` — this is a machine-parsed YAML file).

   Dimensions must sum to 1.0:

   ```yaml
   dimensions:
     fidelity:            { score: <0-10>, weight: 0.30 }
     relevance:           { score: <0-10>, weight: 0.30 }
     provenance_honesty:  { score: <0-10>, weight: 0.40 }
   ```

6. **Surface auto-concerns** per `skills/_eval-template.md § Auto-surfaced severity rules`. Skill-specific surfaces:
   - `[BLOCKER]` if `provenance_honesty` scores ≤ 3.0 — a mock presented as real footage is a material misrepresentation.
   - `[BLOCKER]` if any dimension scores ≤ 3.0.
   - `[BLOCKER]` if overall score is below 7.0.
   - `[BLOCKER]` for each clip where `source` is ambiguous, contradicted by clip content, or missing.
   - `[WARN]` if `fidelity` scores 4.0–6.9 — the clip exists but does not clearly show the claimed capability.
   - `[WARN]` if `relevance` scores 4.0–6.9 — the clip shows *a* Connect capability but not the one the picked angle's product beat requires.
   - `[WARN]` if any clip has `mock_method: null` and `source: mock` — the mock method is missing, which breaks traceability.
   - `[INFO]` if all clips are mocks (`sourcing_strategy: mock`) — inform the operator that no reusable library clip was found; a reuse clip would be preferred for fidelity.

## LLM-as-Judge Rubric

Grade `provenance.yaml` against `angles.yaml` (the picked angle's `product` beat intent) and `prospect.yaml`. Every dimension is a quality/fitness judgment — structural presence was already checked by inline QA.

The out-of-chain fitness requirement (per `skills/_eval-template.md § The out-of-chain fitness requirement`): `fidelity` grades against the **product beat intent as stated in `angles.yaml`** (out-of-chain anchor — the angle's intent is the observable contract), testing whether a human watching the clip would conclude it shows what the beat claims. `provenance_honesty` grades against **directly observable clip metadata** (the `source`, `mock_method`, `caption`, and `origin` fields must be internally consistent and not contradicted by each other), a second out-of-chain anchor that cannot be satisfied by a structurally correct but dishonest provenance record.

### Dimension: `fidelity` (weight 0.30)

Does the clip credibly show the product beat's claim? Given that this clip will appear in a prospect-facing partnership video at the moment the script says "here is how it works," does it actually show that?

This dimension grades the **visual/content plausibility** of the clip — not whether the exact pixel is perfect, but whether a prospect watching it would believe the claim the product beat makes.

**Anchors:**
- 9.0–10.0: The clip unambiguously shows the specific Connect capability or program workflow the `product` beat intent describes. A prospect watching it could describe what they saw and it would match the beat's claim. The clip is clean (no obvious wrong-screen content, no unrelated app), ≤ 45s.
- 7.0–8.9: The clip shows the right capability but with minor caveats — slightly longer than ideal, one screen that doesn't quite match the beat, or a generic Connect screen that illustrates the point adequately but not precisely.
- 5.0–6.9: The clip shows a Connect or CommCare screen but it's either too generic (could be any workflow, doesn't differentiate the claimed capability) or partially mismatched to the `product` beat intent. A prospect might be somewhat convinced.
- 3.0–4.9: The clip exists but is a poor match to the beat's claim — wrong workflow, wrong capability, or so brief/blurry that it conveys almost nothing. A prospect would not be convinced.
- 0.0–2.9: The clip is entirely absent or entirely irrelevant to the product beat.

**Hard deduction (wrong capability shown):** If the clip shows a capability that is explicitly different from the `primary_capability` listed in the picked angle (not just imprecise, but a different capability entirely), deduct 3.0 from the raw score.

### Dimension: `relevance` (weight 0.30)

Does the clip match the specific proof requirement of the **picked angle's** `product` beat — not just Connect's capabilities in general, but this angle's particular proof story?

Each narrative angle leans on a different capability and tells a different story. The `relevance` dimension grades whether the clip was chosen or built *for this angle* or whether it's a generic Connect screenshot that would have been sourced regardless of which angle was picked.

**Anchors:**
- 9.0–10.0: The clip directly illustrates the `product` beat intent of the picked angle and could not be interchanged with a generic Connect demo. The `caption` in `provenance.yaml` accurately names what the clip shows in angle-specific terms.
- 7.0–8.9: The clip is clearly relevant to the picked angle's `primary_capability`; the match to the specific `product` beat intent is slightly loose but would work in context with narration.
- 5.0–6.9: The clip is a generic Connect screen that could plausibly serve any of the three angles. It is not tailored to the picked angle's specific proof story. The video-build skill will have to work harder to bridge the gap.
- 3.0–4.9: The clip is mismatched to the picked angle — it shows a capability relevant to one of the other two angles, or a completely generic CommCare screen.
- 0.0–2.9: No relationship between the clip and the picked angle's `product` beat.

**Hard deduction:** If the picked angle is `trust-travels` (verification/quality + funder-grade reporting) but the clip shows a Learn module or basic data-entry form (a mismatch of angle arc to clip content), deduct 2.0.

### Dimension: `provenance_honesty` (weight 0.40)

Is the sourcing provenance (reuse vs. mock, origin, mock method) accurately and completely recorded? This dimension guards against the worst failure mode of the skill: a mock clip being represented as real existing footage in a prospect-facing video.

This is the heaviest dimension because the downstream consumer (the video-build skill and, ultimately, the prospect) relies on the provenance record to know what they're looking at. A dishonest or incomplete provenance record is a material misrepresentation risk.

**Anchors:**
- 9.0–10.0: Every clip has an explicit `source: reuse | mock`, a non-null `origin` that accurately names the library ref or mock method, and a `caption` that describes the clip content honestly. The `mock_method` field is present and accurate on all mock clips. `is_demo_clip: true` is set on all clips. The record is internally consistent — there are no contradictions between `source`, `origin`, and `mock_method`.
- 7.0–8.9: Nearly all clips are honestly documented; ≤1 clip has a minor gap (e.g. a `mock_method` that is slightly vague but not contradicted) without any risk of misrepresentation.
- 5.0–6.9: Some clips have incomplete provenance — `mock_method` missing on a mock clip, `origin` too vague to trace the actual source. The intent to be honest is clear but the record is not complete enough to be relied upon.
- 3.0–4.9: Significant provenance gaps — `source` fields are missing or ambiguous on multiple clips. The record could not be used to distinguish reuse from mock.
- 0.0–2.9: Provenance is absent, contradicted, or a mock is represented as `source: reuse`. **Auto-surfaced as BLOCKER — material misrepresentation risk.**

**Hard deduction (misrepresentation floor):** Any clip where `source: reuse` but the `origin` is a mock method description (or `source: mock` but `origin` is a library ref), OR where `source` is null/missing → `provenance_honesty` ≤ 3.0 regardless of other content. Auto-surface as BLOCKER.

**Hard deduction (mock_method missing):** If `source: mock` and `mock_method` is null or absent: deduct 1.0 per clip, capped at a 2.0 total deduction.

### Deduction rules

- Any single dimension ≤ 3.0 → suite verdict `fail`, regardless of overall mean.
- `provenance_honesty` ≤ 3.0 → suite verdict `fail` + `BLOCKER` auto-surfaced (misrepresentation risk).
- Overall score below 7.0 → suite verdict `fail` + `BLOCKER`.
- Overall score 7.0–7.9 → suite verdict `warn`.
- Overall score ≥ 8.0 → suite verdict `pass`.

### Calibration targets

- **Detection rate:** ≥ 80% of catalogued micro-demo issues from `eval-calibration/known-issues.md § partnership-microdemo` (once populated after the first two real runs).
- **Inter-run variance:** ≤ 0.5 across 3 same-model runs.
- **Dimension coverage:** the rubric must distinguish (a) a generic Connect screenshot with no provenance record from (b) a purpose-built clip with an honest provenance entry matching the picked angle. `provenance_honesty` + `relevance` are the primary fitness dimensions enforcing this — they must land on opposite sides of the 7.0 threshold for these two cases.
- **Agreement with inline self-check:** The inline QA in `partnership-microdemo` runs binary structural checks; this eval grades quality. A QA-passing artifact is structurally correct; `fidelity` + `relevance` + `provenance_honesty` are what separate conformant-but-empty from prospect-ready.

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)`.

- Google Drive: `drive_read_file`, `drive_create_folder`, `drive_create_file`

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

- **Auto:** Grade, write verdict + auto-surfaced concerns, return overall score and disposition.
- **Review:** Pause after grading to let a human eyeball the verdict before it propagates to the video-build phase.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior (stock)`.

When `--dry-run` is active:
- Read inputs normally (read-only operations are safe in dry-run).
- Write the verdict YAML to Drive normally (human-facing artifact; safe to write in dry-run).
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-06-06 | Initial version. Three dimensions: fidelity (0.30), relevance (0.30), provenance_honesty (0.40). Hard BLOCKER on provenance_honesty ≤ 3 given misrepresentation risk. Gated by partnership-microdemo inline QA. Phase folder: 7-microdemo/. | ACE team |
