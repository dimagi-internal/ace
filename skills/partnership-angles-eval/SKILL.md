---
name: partnership-angles-eval
description: >
  LLM-as-judge quality eval for the partnership-angles artifact. Grades
  grounding, distinctness, capability fit, and persuasiveness. Writes a
  verdict YAML. Gated by partnership-angles inline QA.
disable-model-invocation: true
---

# Partnership Angles Eval

Independent LLM-as-Judge quality evaluation of the `angles.yaml` artifact produced by `partnership-angles`. Grades across four dimensions that test whether the three grounded angles are factually safe (every beat traces to a cited research fact), genuinely distinct from each other, tied to real Connect capabilities, and persuasive enough to serve as the foundation for a prospect-facing video. Writes a verdict YAML that `opp-eval` aggregates. Gated by `partnership-angles` inline QA — if QA failed, this skill emits `verdict: incomplete` without grading.

See `skills/_eval-template.md` for shared contracts (verdict YAML shape, severity rules, inflation guard, stock blocks). See `skills/eval-calibration/SKILL.md` for the calibration methodology.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| `partnership-angles` | `ACE/partnerships/<slug>/runs/<run-id>/angles.yaml` | Primary artifact under judgment |
| `partnership-research` | `ACE/partnerships/<slug>/research/deep-research.md` | Ground truth for the grounding dimension |
| `partnership-research` | `ACE/partnerships/<slug>/research/connect-fit.md` | Ground truth for capability_tied dimension |
| Phase 1 profile | `ACE/partnerships/<slug>/prospect.yaml` | Expansion thesis + target geography |
| `partnership-angles` inline QA | `phases.angles.verdict` in `run_state.yaml` | QA gate — if verdict is `fail` or `incomplete`, skip eval |

## Products

- `2-research/partnership-angles-eval_verdict.yaml` — verdict YAML per `skills/_eval-template.md § Verdict YAML contract`

## Process

1. **Check the QA gate.**

   Read `ACE/partnerships/<slug>/runs/<run-id>/run_state.yaml` via `drive_read_file`. Inspect `phases.angles.verdict`. If the verdict is `fail` or `incomplete`, write `verdict: incomplete` immediately and halt:

   ```yaml
   skill: partnership-angles-eval
   target: <prospect-slug>
   ran_at: <ISO timestamp>
   capture_path: angles.yaml
   overall_score: 0
   verdict: incomplete
   dimensions: {}
   auto_surfaced:
     - severity: INFO-SKIPPED
       message: "Skipped — partnership-angles inline QA returned verdict: <qa-verdict>. Fix QA failures first."
   ```

2. **Read the artifacts and prospect context.**

   Read from Drive via `drive_read_file`:
   - `ACE/partnerships/<slug>/runs/<run-id>/angles.yaml`
   - `ACE/partnerships/<slug>/research/deep-research.md`
   - `ACE/partnerships/<slug>/research/connect-fit.md`
   - `ACE/partnerships/<slug>/prospect.yaml` (for `target_geography`, `sector`, `name`)

3. **Apply the LLM-as-Judge rubric** (see `## LLM-as-Judge Rubric` below). Grade each of the four dimensions 0–10. Compute the weighted overall score.

4. **Apply the `factual_safety` hard floor.**

   Before computing the verdict, check for any fabricated or uncited claim in any beat of any angle. A single confirmed fabricated statistic, invented partnership history, or invented program detail in `angles.yaml` automatically:
   - Floors `grounded` at ≤ 3.0 (the fabrication check is the primary grounding failure mode)
   - Sets suite `verdict: fail`
   - Surfaces a `BLOCKER` auto-surfaced entry naming the fabricated claim

   This floor is non-negotiable: `angles.yaml` feeds directly into a prospect-facing video narration. A single fabricated claim reaching a prospect is the worst possible failure (design §8, CLAUDE.md "No inferred backstory").

5. **Write the verdict YAML** to `2-research/partnership-angles-eval_verdict.yaml`.

   Resolve or create `runs/<run-id>/2-research/` via `drive_create_folder` with `findOrCreate: true`. Write via `drive_create_doc_from_markdown`.

   Dimensions must sum to 1.0:

   ```yaml
   dimensions:
     grounded:          { score: <0-10>, weight: 0.40 }
     distinct:          { score: <0-10>, weight: 0.20 }
     capability_tied:   { score: <0-10>, weight: 0.25 }
     persuasiveness:    { score: <0-10>, weight: 0.15 }
   ```

6. **Surface auto-concerns** per `skills/_eval-template.md § Auto-surfaced severity rules`. Skill-specific surfaces:
   - `[BLOCKER]` if `grounded` scores ≤ 3.0 — fabricated or uncited claims in a prospect-facing angle are a hard stop.
   - `[BLOCKER]` if any dimension scores ≤ 3.0.
   - `[BLOCKER]` if overall score is below 7.0.
   - `[BLOCKER]` for each fabricated or uncited claim detected in any angle beat.
   - `[WARN]` if any angle has `grounded: false` in `angles.yaml` — an ungrounded angle may still be usable (the operator can discard it), but the eval flags it for human attention.
   - `[WARN]` if `capability_tied` scores 4.0–6.9 — angles may not compellingly showcase real Connect capabilities.
   - `[WARN]` if two angles ground the same beat with the same research fact — indicates insufficient differentiation.
   - `[INFO]` if all three angles are `grounded: false` — the prospect research may be insufficient to produce a viable angle set; the operator should run additional research before proceeding to production.

## LLM-as-Judge Rubric

Grade `angles.yaml` against `deep-research.md`, `connect-fit.md`, and `prospect.yaml`. Every dimension is a quality/fitness judgment — structural presence was already checked by inline QA.

The out-of-chain fitness requirement (per `skills/_eval-template.md § The out-of-chain fitness requirement`): `grounded` grades against **independently verifiable research citations** (out-of-chain anchor), testing whether the beats could survive a prospect's fact-check. This is the primary fitness dimension that escapes the AI authoring chain. `capability_tied` grades against **real documented Connect capabilities**, not asserted from memory — a second out-of-chain anchor.

### Dimension: `grounded` (weight 0.40)

Does every beat in every angle trace back to a specific, citable fact in the research artifacts? This dimension grades whether the angles are built on evidence or on plausible-sounding invention.

This is the highest-stakes fitness dimension. `angles.yaml` feeds directly into a prospect-facing video narration — a fabricated fact discovered by the prospect is the worst possible outcome (design §8).

**Anchors:**
- 9.0–10.0: Every beat in all three angles is grounded with a specific cited fact from `deep-research.md` or `connect-fit.md`. The grounding is traceable — a reader can point to the sentence in the research that backs the beat. No unexplained hedged language or invented precision.
- 7.0–8.9: Nearly all beats are grounded; ≤2 beats across the three angles are asserted without a clear research citation, but none are demonstrably false. No fabrications.
- 5.0–6.9: Several beats are thinly grounded — the research fact exists but the beat text significantly inflates or distorts it. OR 3–5 beats across angles lack traceable citations.
- 3.0–4.9: Systematic grounding gaps. Multiple beats read as plausible generalizations rather than cited facts. Risk that a well-researched prospect will catch incorrect or invented claims.
- 0.0–2.9: Beats are fabricated or cannot be traced to the research artifacts. **Auto-surfaced as BLOCKER — halt before this angle set is used in a prospect-facing artifact.**

**Hard deduction (fabrication floor):** Any confirmed fabricated claim (a specific number, a named partnership, a program history that does not appear in the research) → `grounded` ≤ 3.0 regardless of other content. Auto-surface as BLOCKER.

**Hard deduction (ungrounded beats):** Each beat text containing `[UNGROUNDED` is a 0.5-point deduction from the raw score, capped at a 3.0 total deduction. Ungrounded beats are honest (the skill flags rather than fabricates); the deduction is smaller than fabrication but the signal matters.

### Dimension: `distinct` (weight 0.20)

Are the three grounded angles genuinely different stories — different heroes, different emotional arcs, different research facts used, different Connect capabilities foregrounded — or do they read as paraphrases of each other?

**Anchors:**
- 9.0–10.0: All three angles are clearly differentiated by hero, emotional beat, AND the research facts they foreground. A reader cannot swap beats between angles without breaking the coherence of any one angle.
- 7.0–8.9: Two of the three angles are clearly differentiated; the third shares some beats or research facts with another but still has a distinct overall arc.
- 5.0–6.9: Two angles feel like variations on the same story — similar hero, similar facts emphasized, overlapping capability lean. A reader might struggle to choose between them on substance.
- 3.0–4.9: The three angles are largely paraphrases. Different `angle_id` labels, same underlying story beat by beat. Providing these to an operator as "distinct options" would be misleading.
- 0.0–2.9: The three angles are functionally identical. No meaningful choice between them.

**Hard deduction:** If any two angles use the same research fact as the `problem` beat, deduct 2.0 from the raw score (the problem beat is the most differentiation-critical beat for a partnership pitch).

### Dimension: `capability_tied` (weight 0.25)

Does each angle lean compellingly on a real, validated Connect capability — one that is specific to that angle's arc and traceable to the `connect-fit.md` memo?

This dimension grades against the `connect-fit.md` memo as the out-of-chain anchor: capability claims must be validated there, not asserted from memory. `connect-fit.md` was built by consulting real PDDs, programs, and the documented Connect feature set — that validation work must carry through into the angles.

**Anchors:**
- 9.0–10.0: Each angle's `primary_capability` and `product` beat are grounded in a specific Connect capability documented in `connect-fit.md`. The capability claim explains *why* it matters for *this* prospect's expansion situation. A reader of `connect-fit.md` can confirm the capability exists.
- 7.0–8.9: Most capability claims are traceable to `connect-fit.md`; one angle uses a capability that is real but stated generically without a prospect-specific fit argument.
- 5.0–6.9: Capability claims are present but thin — they name Connect features in the abstract without explaining how they fit this prospect's model or expansion situation. OR one angle's `primary_capability` cannot be found in `connect-fit.md`.
- 3.0–4.9: Capability claims read as a generic "Connect does payment and verification" pitch without prospect-specific grounding. The memo was not consulted or its findings were not incorporated.
- 0.0–2.9: Capability claims are demonstrably absent from the documented Connect feature set, or the angles reference capabilities that Connect doesn't have. Risk of a false pitch claim.

**Hard deduction:** If any angle claims a Connect capability that is demonstrably absent from the documented feature set (not in `connect-fit.md` and not in the documented Connect feature set), deduct 3.0 from the raw score.

### Dimension: `persuasiveness` (weight 0.15)

Are the grounded angles compelling enough to anchor a 90-second partnership video that would move a decision-maker at the prospect org? This dimension grades the *deployability* of the angles — given that the underlying facts are cited, does the grounded story hang together emotionally and logically?

**Anchors:**
- 9.0–10.0: All three angles tell a coherent, emotionally resonant story arc. The `logline` accurately captures what the angle does for *this* prospect. The `problem` beat is sharply scoped to the prospect's expansion situation; the `product` beat clearly shows the Connect capability in action; the `impact` beat closes the loop on the opening claim. A video producer could work from these beats without needing significant rework.
- 7.0–8.9: Most angles are persuasive; one angle has a beat that is mechanically grounded but emotionally flat (a fact cited correctly but without a compelling framing).
- 5.0–6.9: Angles are factually grounded but narratively thin. The beats are checkboxes rather than a story arc. A video producer would need significant narrative enhancement to make them work.
- 3.0–4.9: The angles read as bullet-point summaries of the research rather than narrative arcs. No emotional through-line; a decision-maker would not be moved.
- 0.0–2.9: The angles are not usable as video narration starters. Even with correct facts, the narrative construction is too weak to serve as a partnership pitch.

### Deduction rules

- Any single dimension ≤ 3.0 → suite verdict `fail`, regardless of overall mean.
- `grounded` ≤ 3.0 → suite verdict `fail` + `BLOCKER` auto-surfaced (fabrication risk).
- Overall score below 7.0 → suite verdict `fail` + `BLOCKER`.
- Overall score 7.0–7.9 → suite verdict `warn`.
- Overall score ≥ 8.0 → suite verdict `pass`.

### Calibration targets

- **Detection rate:** ≥ 80% of catalogued angles issues from `eval-calibration/known-issues.md § partnership-angles` (once populated after the first two real runs).
- **Inter-run variance:** ≤ 0.5 across 3 same-model runs.
- **Dimension coverage:** the rubric must distinguish (a) three plausible-sounding angles written from general AI knowledge about NGO programs (factually thin, high fabrication risk) from (b) three angles where every beat is traceable to the cited `deep-research.md` report. `grounded` is the primary fitness dimension enforcing this — a genuinely-grounded set and a fabricated set must land on opposite sides of the 7.0 threshold.
- **Agreement with inline self-check:** The inline QA in `partnership-angles` runs binary structural checks; this eval grades quality. A QA-passing artifact is structurally correct; `grounded` + `capability_tied` are what separate conformant-but-empty from deployable.

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)`.

- Google Drive: `drive_read_file`, `drive_create_folder`, `drive_create_doc_from_markdown`

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

- **Auto:** Grade, write verdict + auto-surfaced concerns, return overall score and disposition.
- **Review:** Pause after grading to let a human eyeball the verdict before it propagates to the production phase.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior (stock)`.

When `--dry-run` is active:
- Read inputs normally (read-only operations are safe in dry-run).
- Write the verdict YAML to Drive normally (human-facing artifact; safe to write in dry-run).
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-06-06 | Initial version. Four dimensions: grounded (0.40), distinct (0.20), capability_tied (0.25), persuasiveness (0.15). Hard BLOCKER on grounded ≤ 3 given prospect-facing fabrication risk. Gated by partnership-angles inline QA. | ACE team |
