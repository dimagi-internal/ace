---
name: partnership-research-eval
description: >
  LLM-as-judge quality eval for the partnership-research artifacts. Grades
  grounding, relevance, capability fit, and factual safety. Writes a verdict
  YAML. Gated by partnership-research-qa.
disable-model-invocation: true
---

# Partnership Research Eval

Independent LLM-as-Judge quality evaluation of the two artifacts produced by `partnership-research`: the deep web research report and the Connect/Dimagi capability-fit memo. Grades across four dimensions that test whether the research is factually safe, grounded in cited evidence, relevant to the prospect's expansion thesis, and connected to real Connect capabilities. Writes a verdict YAML that `opp-eval` aggregates. Gated by `partnership-research-qa` — if QA failed irrecoverably, this skill emits `verdict: incomplete` without grading.

See `skills/_eval-template.md` for shared contracts (verdict YAML shape, severity rules, inflation guard, stock blocks). See `skills/eval-calibration/SKILL.md` for the calibration methodology.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| `partnership-research` | `research/deep-research.md` | Primary artifact under judgment |
| `partnership-research` | `research/connect-fit.md` | Companion artifact under judgment |
| `partnership-research-qa` | `2-research/partnership-research-qa_result.yaml` | QA gate — if verdict is `fail` or `incomplete`, skip eval |
| Operator (Phase 1) | `ACE/partnerships/<slug>/prospect.yaml` | Expansion thesis + target geography to grade relevance against |

## Products

- `2-research/partnership-research-eval_verdict.yaml` — verdict YAML per `skills/_eval-template.md § Verdict YAML contract`

## Process

1. **Check the QA gate.**

   Read `2-research/partnership-research-qa_result.yaml` via `drive_read_file`. If QA verdict is `fail` or `incomplete`, write `verdict: incomplete` immediately and halt:

   ```yaml
   skill: partnership-research-eval
   target: <prospect-slug>
   ran_at: <ISO timestamp>
   capture_path: research/deep-research.md
   overall_score: 0
   verdict: incomplete
   dimensions: {}
   auto_surfaced:
     - severity: INFO-SKIPPED
       message: "Skipped — partnership-research-qa returned verdict: <qa-verdict>. Fix QA failures first."
   ```

2. **Read the research artifacts and prospect context.**

   Read from Drive (via `drive_read_file`) unless the orchestrator has already loaded them into context:
   - `ACE/partnerships/<slug>/research/deep-research.md`
   - `ACE/partnerships/<slug>/research/connect-fit.md`
   - `ACE/partnerships/<slug>/prospect.yaml` (for `target_geography` and `current_program`)

3. **Apply the LLM-as-Judge rubric** (see `## LLM-as-Judge Rubric` below). Grade each of the four dimensions 0–10. Compute the weighted overall score.

4. **Write the verdict YAML** to `2-research/partnership-research-eval_verdict.yaml`.

   Resolve or create `runs/<run-id>/2-research/` via `drive_create_folder` with `findOrCreate: true`. Write via `drive_create_doc_from_markdown`.

   Dimensions must sum to 1.0:

   ```yaml
   dimensions:
     grounding:        { score: <0-10>, weight: 0.35 }
     relevance:        { score: <0-10>, weight: 0.25 }
     capability_fit:   { score: <0-10>, weight: 0.25 }
     factual_safety:   { score: <0-10>, weight: 0.15 }
   ```

5. **Surface auto-concerns** per `skills/_eval-template.md § Auto-surfaced severity rules`. Skill-specific surfaces:
   - `[BLOCKER]` if `factual_safety` scores ≤ 3.0 — fabricated stats or invented partnership histories in a prospect-facing artifact is a hard stop.
   - `[BLOCKER]` if any dimension scores ≤ 3.0.
   - `[BLOCKER]` if overall score is below 7.0.
   - `[WARN]` for each specific fabricated or unverifiable claim detected in the artifacts.
   - `[WARN]` if `capability_fit` scores 4.0–6.9 — the Connect-fit memo may be too generic to anchor the narrative angles in the next phase.
   - `[INFO]` if the deep-research report has fewer than 3 citations — `partnership-research-qa` checks for a citations section, but low citation count is a quality signal.

## LLM-as-Judge Rubric

Grade the two research artifacts together against `prospect.yaml`. Every dimension is a quality/fitness judgment — structural presence was already checked by QA.

The out-of-chain fitness requirement (per `skills/_eval-template.md § The out-of-chain fitness requirement`): `grounding` grades against **independently verifiable citations** (an out-of-chain anchor), and `factual_safety` grades against the **real-world impossibility bar** (would a domain expert immediately flag a claim as wrong or made-up). These are the two fitness dimensions that escape the AI authoring chain.

### Dimension: `grounding` (weight 0.35)

Are the factual claims in the deep-research report backed by cited, verifiable sources? This dimension grades the research's evidentiary quality.

**Anchors:**
- 9.0–10.0: Every non-trivial factual claim (org scale, geography, evidence of impact, program design) is cited with a URL or named publication. The citations section has ≥5 verifiable sources. No unexplained hedged language ("reportedly", "allegedly") without a source.
- 7.0–8.9: Most claims are cited; ≤2 meaningful claims are asserted without a source. Citations section present.
- 5.0–6.9: Several meaningful claims are unsourced. Citations present but thin (< 3 sources, or sources don't clearly back the cited claims).
- 3.0–4.9: Systematic sourcing gaps. Important scale/model claims are asserted without any citation. OR the citations section exists but most claims aren't actually traceable to it.
- 0.0–2.9: No meaningful citations. The report reads as generative prose about an org without grounding in verifiable sources. **Auto-surfaced as BLOCKER.**

**Hard deduction:** Every claim marked with "Unverified" (the skill's own guardrail flag) is a 1.0-point deduction from the raw score, capped at a 4.0 total deduction.

### Dimension: `relevance` (weight 0.25)

Is the research focused on what matters for the partnership pitch: the prospect's expansion thesis and their ability to operate at scale in the target geography?

**Anchors:**
- 9.0–10.0: Both artifacts are tightly scoped to the expansion thesis. Deep-research covers the target geography specifically (not just org history generically). Connect-fit memo maps capabilities to the *expansion* context, not just "Connect is good for health programs."
- 7.0–8.9: Good focus overall; one section is tangential or too general to the org's global footprint rather than the target geography.
- 5.0–6.9: Relevant but unsharpened — the expansion thesis is present but the research reads as a generic org profile rather than an expansion-focused profile. Capability-fit memo talks about Connect abstractly without anchoring to the prospect's specific expansion context.
- 3.0–4.9: Research misses the expansion thesis. Deep-research covers org history but not the geography or scale gap. Capability-fit is boilerplate not tailored to this prospect.
- 0.0–2.9: The research does not address the prospect's situation. Could describe any NGO.

### Dimension: `capability_fit` (weight 0.25)

Is the Connect/Dimagi capability-fit memo grounded in real, validated Connect capabilities — not asserted from general AI knowledge?

**Anchors:**
- 9.0–10.0: Every Connect capability claim is traceable to a real analog: a specific ACE PDD in Drive, a documented Connect feature with a real program example, or a published case study. The memo explains *why* those capabilities are relevant to *this* org's specific model and expansion situation.
- 7.0–8.9: Most capabilities are validated; one is asserted generically without a real-program anchor. The relevance argument is present but partial.
- 5.0–6.9: Some capabilities are real but stated generically ("Connect enables payment for delivery") without anchoring to a real program or explaining fit for this prospect. OR several capabilities are asserted from AI memory without Drive-based validation.
- 3.0–4.9: The memo reads as a generic "why Connect" pitch with no evidence of consulting real PDDs, case studies, or program outputs. No prospect-specific fit reasoning.
- 0.0–2.9: Capabilities are fictitious or demonstrably wrong. Serious risk of a false pitch claim reaching the prospect.

**Hard deduction:** If the memo states a Connect capability as fact that is demonstrably absent from the documented feature set (e.g., claims Connect has a feature it doesn't), deduct 3.0 from the raw score.

### Dimension: `factual_safety` (weight 0.15)

Are the artifacts free of fabricated statistics, invented partnership histories, and false claims — i.e., would a domain expert immediately flag the artifact as making things up?

This is the highest-stakes dimension for a prospect-facing artifact. A single fabricated statistic or invented partnership history is the worst possible failure (design §8, CLAUDE.md "No inferred backstory").

**Anchors:**
- 9.0–10.0: No detectable fabrications. All org scale claims match publicly verifiable ranges. No invented partnerships, grants, or pilot histories.
- 7.0–8.9: No clear fabrications, but ≥1 claim is suspiciously specific (exact numbers where only ranges are published) without a citation to explain the precision. Low risk.
- 5.0–6.9: Moderate risk — several specific claims that are plausible but not verifiable. Could embarrass Dimagi if the prospect fact-checks. Not clearly wrong but not clearly right either.
- 3.0–4.9: One claim appears to be invented or is demonstrably incorrect (wrong geography, wrong scale by >2×, claim of a partnership that doesn't exist). **Auto-surfaced as WARN; contributes to BLOCKER if combined with overall ≤ 7.0.**
- 0.0–2.9: Multiple fabricated stats, invented pilot histories, or false partnership claims. **Auto-surfaced as BLOCKER — halt before this research is used in any prospect-facing artifact.**

**Hard deduction (floor):** A single confirmed fabricated statistic or invented partnership claim automatically floors this dimension at ≤ 3.0, regardless of other content quality.

### Deduction rules

- Any single dimension ≤ 3.0 → suite verdict `fail`, regardless of overall mean.
- `factual_safety` ≤ 3.0 → suite verdict `fail` + `BLOCKER` auto-surfaced.
- Overall score below 7.0 → suite verdict `fail` + `BLOCKER`.
- Overall score 7.0–7.9 → suite verdict `warn`.
- Overall score ≥ 8.0 → suite verdict `pass`.

### Calibration targets

- **Detection rate:** ≥ 80% of catalogued research issues from `eval-calibration/known-issues.md § partnership-research` (once populated after the first two real runs).
- **Inter-run variance:** ≤ 0.5 across 3 same-model runs.
- **Dimension coverage:** the rubric must distinguish a "conformant but undeployable" research report (one that passes QA but was written from AI memory without sourcing) from a genuinely cited, relevant, prospect-tailored research report. `grounding` + `capability_fit` are the primary fitness dimensions that enforce this.

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)`.

- Google Drive: `drive_read_file`, `drive_create_folder`, `drive_create_doc_from_markdown`

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

- **Auto:** Grade, write verdict + auto-surfaced concerns, return overall score and disposition.
- **Review:** Pause after grading to let a human eyeball the verdict before it propagates to the angles phase.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior (stock)`.

When `--dry-run` is active:
- Read inputs normally (read-only operations are safe in dry-run).
- Write the verdict YAML to Drive normally (human-facing artifact; safe to write in dry-run).
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-06-06 | Initial version. Four dimensions: grounding, relevance, capability_fit, factual_safety. Hard BLOCKER on factual_safety ≤ 3 given prospect-facing risk. | ACE team |
