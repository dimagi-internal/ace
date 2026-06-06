---
name: partnership-deck-build-eval
description: >
  LLM-as-judge quality eval for the partnership pitch deck. Grades arc match,
  grounding, completeness, and visual polish. Writes a verdict YAML.
disable-model-invocation: true
---

# Partnership Deck Build Eval

Independent LLM-as-Judge quality evaluation of the `deck_spec.yaml` artifact produced by `partnership-deck-build`. Grades across four dimensions that test whether the deck faithfully mirrors the chosen video angle's arc, is grounded in cited research facts (prospect-facing — the highest-stakes surface), contains all required modules, and is visually deployable without rework. Writes a verdict YAML that `opp-eval` aggregates. Gated by `partnership-deck-build` inline QA — if QA failed, this skill emits `verdict: incomplete` without grading.

See `skills/_eval-template.md` for shared contracts (verdict YAML shape, severity rules, inflation guard, stock blocks). See `skills/eval-calibration/SKILL.md` for the calibration methodology.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| `partnership-deck-build` | `ACE/partnerships/<slug>/runs/<run-id>/deck_spec.yaml` | Primary artifact under judgment |
| `partnership-angles` | `ACE/partnerships/<slug>/runs/<run-id>/angles.yaml` | Ground truth for arc_match dimension — what the picked angle's arc actually requires |
| `partnership-research` | `ACE/partnerships/<slug>/research/deep-research.md` | Ground truth for grounding dimension — what stats are actually cited in the research |
| Phase 1 profile | `ACE/partnerships/<slug>/prospect.yaml` | Prospect name, sector — sanity check for brand safety |
| `partnership-deck-build` inline QA | `phases.deck-build.verdict` in `run_state.yaml` | QA gate — if `fail` or `incomplete`, skip eval |
| `run_state.yaml` | `phases.angles.products.selected_angle` | Active angle id; used to verify `arc_match` judges the right angle |

## Products

- `ACE/partnerships/<slug>/runs/<run-id>/8-deck-build/partnership-deck-build-eval_verdict.yaml` — verdict YAML per `skills/_eval-template.md § Verdict YAML contract`

## Process

1. **Check the QA gate.**

   Read `ACE/partnerships/<slug>/runs/<run-id>/run_state.yaml` via `drive_read_file`. Inspect `phases.deck-build.verdict`. If the verdict is `fail` or `incomplete`, write `verdict: incomplete` immediately and halt:

   ```yaml
   skill: partnership-deck-build-eval
   target: <prospect-slug>
   ran_at: <ISO timestamp>
   capture_path: deck_spec.yaml
   overall_score: 0
   verdict: incomplete
   dimensions: {}
   auto_surfaced:
     - severity: INFO-SKIPPED
       message: "Skipped — partnership-deck-build inline QA returned verdict: <qa-verdict>. Fix QA failures first."
   ```

2. **Read the artifacts.**

   Read from Drive via `drive_read_file`:
   - `ACE/partnerships/<slug>/runs/<run-id>/deck_spec.yaml`
   - `ACE/partnerships/<slug>/runs/<run-id>/angles.yaml`
   - `ACE/partnerships/<slug>/research/deep-research.md`
   - `ACE/partnerships/<slug>/prospect.yaml` (for `name`, `sector`)
   - `phases.angles.products.selected_angle` from `run_state.yaml` (already read in step 1)

   Extract from `angles.yaml` the angle entry matching `selected_angle`. Capture its: `logline`, `beats` arc (all seven beat texts: `hook`, `cycle`, `handoff`, `scene`, `problem`, `product`, `impact`), `primary_capability`.

3. **Apply the LLM-as-Judge rubric** (see `## LLM-as-Judge Rubric` below). Grade each of the four dimensions 0–10. Compute the weighted overall score.

4. **Apply the `grounding` hard floor.**

   Before computing the verdict, check for any fabricated or uncited claim in any `body`, `title`, or `stats[].label` field across all deck slides. A single confirmed fabricated statistic, invented partnership history, or invented program detail automatically:
   - Floors `grounding` at ≤ 3.0
   - Sets suite `verdict: fail`
   - Surfaces a `BLOCKER` auto-surfaced entry naming the fabricated claim

   This floor is non-negotiable: `deck_spec.yaml` is the direct source for the prospect-facing Google Slides deck. A fabricated claim reaching a prospect is the worst possible failure (design §8, CLAUDE.md "No inferred backstory").

5. **Resolve the produce-phase folder and write the verdict YAML.**

   Ensure folder `runs/<run-id>/8-deck-build/` exists via `drive_create_folder` with `findOrCreate: true`. Write via `drive_create_file` to `8-deck-build/partnership-deck-build-eval_verdict.yaml`.

   Dimensions must sum to 1.0:

   ```yaml
   dimensions:
     arc_match:     { score: <0-10>, weight: 0.30 }
     grounding:     { score: <0-10>, weight: 0.40 }
     completeness:  { score: <0-10>, weight: 0.20 }
     visual_polish: { score: <0-10>, weight: 0.10 }
   ```

6. **Surface auto-concerns** per `skills/_eval-template.md § Auto-surfaced severity rules`. Skill-specific surfaces:
   - `[BLOCKER]` if `grounding` scores ≤ 3.0 — fabricated or uncited claims in a prospect-facing deck are a hard stop.
   - `[BLOCKER]` if `arc_match` scores ≤ 3.0 — a deck that tells a different story than the picked video angle is not a usable partnership asset.
   - `[BLOCKER]` if any dimension scores ≤ 3.0.
   - `[BLOCKER]` if overall score is below 7.0.
   - `[BLOCKER]` for each fabricated or uncited stat detected in any slide body.
   - `[WARN]` if `completeness` scores 4.0–6.9 — one or more required modules may be missing or skeletal.
   - `[WARN]` if any `stats`-layout slide has a `big:` value prefixed with `[TBD] ` — the operator must source the stat before external send.
   - `[WARN]` if the `proof` module's walkthrough slide has no image alias and uses `content` layout — the deck ships without a micro-demo visual; operator should add a screenshot before the prospect meeting.
   - `[INFO]` if `visual_polish` scores ≥ 8.0 but `arc_match` or `grounding` scores < 7.0 — flags polish-over-substance imbalance for human attention.

## LLM-as-Judge Rubric

Grade `deck_spec.yaml` against `angles.yaml` (picked angle entry), `deep-research.md`, and `prospect.yaml`. Every dimension is a quality/fitness judgment — structural presence was already checked by inline QA.

The out-of-chain fitness requirement (per `skills/_eval-template.md § The out-of-chain fitness requirement`): `grounding` grades against **independently verifiable research citations** (out-of-chain anchor), testing whether each stat could survive a prospect's fact-check. This is the primary fitness dimension that escapes the AI authoring chain.

### Dimension: `arc_match` (weight 0.30)

Does the deck's narrative arc faithfully mirror the chosen angle from `angles.yaml`? The deck and video are the same story in two formats — a prospect who watches the video and then opens the deck should experience the same narrative journey. This dimension grades whether the deck arc is coherent with the picked angle or drifts into a different framing.

**Anchors (grade against the picked angle's actual arc, not a generic pitch):**
- 9.0–10.0: Every load-bearing arc beat is reflected: the `their-world` module opens in the angle's framing; the `thesis-divider` names the angle's core tension (verbatim or close paraphrase); `thesis-content` explains the angle's capability lean; the `business-case` closes the loop on the opening tension. A viewer who saw the video would recognize the deck as the same story.
- 7.0–8.9: The deck broadly follows the angle's arc; one module uses generic Connect framing instead of the angle's specific framing, but the overall narrative is coherent with the pick.
- 5.0–6.9: The arc partially matches — the `thesis-divider` or `their-world` module uses the angle's framing but the `business-case` or `the-ask` module resolves a different tension (e.g., "scale gap" deck ends with a "trust" close). A viewer would not recognize it as the same story as the video.
- 3.0–4.9: The deck is a generic Connect pitch with no meaningful tie to the chosen angle. Could have been produced from any of the three angles.
- 0.0–2.9: The deck's arc is incoherent or contradicts the picked angle — an investor might be confused about the proposition.

**Hard deduction:** If `their-world` uses a different angle's framing (e.g., picked `trust-travels` but deck opens with the scale math), deduct 3.0 from the raw score and surface a BLOCKER — the video + deck are misaligned, which undermines the partnership asset.

### Dimension: `grounding` (weight 0.40)

Does every cited stat, program claim, and capability assertion in the deck trace back to a specific, verifiable source in `deep-research.md` or `connect-fit.md`? This dimension grades whether the deck can survive a fact-check by a well-informed prospect.

This is the highest-stakes fitness dimension. `deck_spec.yaml` feeds directly into a Google Slides deck that will be seen by the prospect's decision-makers. A fabricated stat discovered in a meeting is the worst possible outcome (design §8).

**Anchors:**
- 9.0–10.0: Every `stats[].big` value, every specific program figure in `body` fields, and every Connect capability claim is traceable to a sentence in `deep-research.md` or `connect-fit.md`. The `source.pdd_doc_id` is set to the actual fileId. No `[TBD]` in any slide title or body.
- 7.0–8.9: Nearly all claims are sourced; ≤1 stat is asserted without a clear research citation (but is not demonstrably false). `[TBD]` appears at most in one `stats[].big` value with an honest placeholder.
- 5.0–6.9: Multiple stats or capability claims appear in the deck that are not in the research docs. The deck inflates or distorts figures that do appear in the docs. Risk that a prospect would catch incorrect claims.
- 3.0–4.9: Systematic grounding gaps. The deck reads like a generic Connect pitch dressed up with plausible-sounding figures. High risk of a prospect calling out invented claims.
- 0.0–2.9: Stats or partnership claims are fabricated and do not appear in the research. **Auto-surfaced as BLOCKER — deck must not be sent to prospect.**

**Hard deduction (fabrication floor):** Any confirmed fabricated claim (a specific number, a named partnership, a program history that does not appear in `deep-research.md` or `connect-fit.md`) → `grounding` ≤ 3.0 regardless of other content. Auto-surface as BLOCKER.

**Hard deduction (`[TBD]` in prospect-facing fields):** Each `[TBD]` token in a slide `title` or `body` (not `stats[].big`) is a 0.5-point deduction from the raw score, capped at 2.0 total deduction. `[TBD]` in a `stats[].big` is acceptable (honest about a gap) and is not a hard deduction, but is surfaced as a WARN.

### Dimension: `completeness` (weight 0.20)

Are all seven required modules present and substantively filled? The template declares seven modules: `opening`, `their-world`, `the-thesis`, `how-connect-works`, `proof`, `business-case`, `the-ask`. Every module must exist with at least the minimum required slides (per `spec.template.yaml`), and each slide must be substantively filled — not left with stub content.

This dimension also checks that the total slide count is in the 10–12 range declared by `template.yaml` as the intended deck length.

**Anchors:**
- 9.0–10.0: All 7 modules present, each with the minimum required slides. Total slide count 10–12. Every slide has a non-empty `body` or `stats[]` or `steps[]` with substantive content. Speaker notes present on every slide (50+ words).
- 7.0–8.9: All 7 modules present; one module has a slide that is thinly filled (one-sentence body on a content slide that warrants more context). OR slide count is 13 (one over the declared max — acceptable for a very detailed prospect).
- 5.0–6.9: One module is missing OR two or more slides across modules have stub content (a single line that doesn't meet the minimum for its layout). OR slide count is outside 10–13.
- 3.0–4.9: Two or more modules are missing or present but empty. The deck is not deliverable without significant authoring.
- 0.0–2.9: The deck is a skeleton — most modules missing or stub-only.

**Hard deduction (missing required module):** Each missing module (from the 7 required) → deduct 2.0 from raw score, minimum score 0. Auto-surface each missing module as a BLOCKER if `completeness` drops below 5.0.

### Dimension: `visual_polish` (weight 0.10)

Is the deck spec ready for visual rendering without operator intervention? This dimension grades whether layout choices are appropriate for the content, image references are either populated or gracefully degraded, and the overall design intent matches a prospect-facing pitch context (not an FLW training deck).

This is a `spec`-level judgment — it cannot observe the rendered deck, only whether the spec's layout choices and content fields would produce a visually coherent result.

**Out-of-chain anchor:** The reference is a *deployable prospect-facing pitch deck* standard — "would a Dimagi sales rep be comfortable sharing this deck at a first prospect meeting?" — rather than compliance with the spec schema. The schema check already ran in QA; this dimension asks whether the design choices (layout selection, stats count, image usage, CTA language) are appropriate for the audience and purpose.

**Anchors:**
- 9.0–10.0: Layout choices are optimal for the content (stats layouts used for quantitative claims, walkthrough used for the micro-demo proof, section used for the thesis pivot, closing for the ask). The `proof` module either has a populated image alias or has gracefully degraded to `content` with an honest note. The `closing` CTA names Dimagi + Connect explicitly and states a concrete next step. Notes are present and complete. Prospect name fits the cover stencil (≤28 chars verified in content).
- 7.0–8.9: One layout choice is suboptimal (e.g., a `content` layout where `stats` would be clearer, or a `their-reach` slide with only 1 stat when 2 are available). No critical failures.
- 5.0–6.9: Two or more layout mismatches, or the `proof` module is missing both a screenshot alias AND a fallback note, or the closing CTA is generic/unnamed.
- 3.0–4.9: Multiple layout issues that would produce a visually incoherent deck. The `their-reach` stats slide has `[TBD]` in `big:` for both stats (operator would need significant rework before sharing).
- 0.0–2.9: The spec would produce a deck that is not appropriate to show to a prospect — corporate chrome missing, layout choices actively misleading, CTA omits Dimagi branding.

### Deduction rules

- Any single dimension ≤ 3.0 → suite verdict `fail`, regardless of overall mean.
- `grounding` ≤ 3.0 → suite verdict `fail` + `BLOCKER` auto-surfaced (fabrication risk).
- `arc_match` ≤ 3.0 → suite verdict `fail` + `BLOCKER` (deck-video story misalignment).
- Overall score below 7.0 → suite verdict `fail` + `BLOCKER`.
- Overall score 7.0–7.9 → suite verdict `warn`.
- Overall score ≥ 8.0 → suite verdict `pass`.

### Calibration targets

- **Detection rate:** ≥ 80% of catalogued deck issues from `eval-calibration/known-issues.md § partnership-deck-build` (once populated after the first two real runs).
- **Inter-run variance:** ≤ 0.5 across 3 same-model runs.
- **Dimension coverage:** the rubric must distinguish (a) a deck that faithfully mirrors the picked angle's arc with cited stats from (b) a generic Connect pitch with the prospect's name on the cover. `arc_match` + `grounding` together are the primary fitness dimensions enforcing this distinction.
- **Agreement with inline self-check:** The inline QA in `partnership-deck-build` runs binary structural checks; this eval grades quality. A QA-passing spec is structurally correct; `grounding` + `arc_match` are what separate conformant-but-generic from deployable.
- **Grounding must carry teeth:** a spec where every stat field reads `[TBD]` (honest but unusable) must score below `pass` on `grounding` alone (≤ 5.0), even though QA would pass it. The fabrication floor is the extreme; the deployment-readiness anchor covers the honest-but-incomplete case.

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)`.

- Google Drive: `drive_read_file`, `drive_create_folder`, `drive_create_file`

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

- **Auto:** Grade, write verdict + auto-surfaced concerns, return overall score and disposition.
- **Review:** Pause after grading to let a human eyeball the verdict before it propagates to the publish phase.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior (stock)`.

When `--dry-run` is active:
- Read inputs normally (read-only operations are safe in dry-run).
- Write the verdict YAML to Drive normally (human-facing artifact; safe to write in dry-run).
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-06-06 | Initial version. Four dimensions: arc_match (0.30), grounding (0.40), completeness (0.20), visual_polish (0.10). Hard BLOCKER on grounding ≤ 3 (fabrication) and arc_match ≤ 3 (deck-video misalignment). Gated by partnership-deck-build inline QA. Produce-phase folder: 8-deck-build/. | ACE team |
