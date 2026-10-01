---
name: training-deck-render-eval
description: >
  Judge the rendered training deck slide by slide — overflow, image placement, empty or placeholder slides.
disable-model-invocation: false
---

# Training Deck Render — Eval

Grades the RENDERED Google Slides training deck, as the trainer will project
it. `training-deck-generate-eval` grades the spec; `training-deck-render`'s
self-eval counts slides and confirms each `createImage` call returned. Neither
looks at a slide. A spec that grades 9 can still render text running off a
box, a screenshot squeezed into a corner or cropped, a stencil prompt left
unfilled, or a blank slide — and nothing caught it before the deck reached an
LLO.

**Fitness axis (out-of-chain anchor).** The anchor is the rendered pixels —
the slide thumbnails the Slides API draws — judged with canopy's **Tough Judge**
method (`canopy:visual-judge`: adversarial listing first, score from 3,
projector test), not the spec that produced them. `projector_readiness` carries
a hard gate. See `skills/_eval-template.md § The out-of-chain fitness requirement`.

See `skills/_eval-template.md` for shared contracts. Provisional rubric —
calibration TBD until 3+ graded decks produce ground truth.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 6 | the rendered deck — `run_state` `phases.qa-and-training.products.training.deck` (its Slides file id) | artifact under judgment |
| Phase 6 | `6-qa-and-training/training-deck-spec.yaml` | what each slide was meant to carry (a walkthrough step's screenshot, a module's key numbers) |
| Phase 6 | `6-qa-and-training/training-deck-render_verdict.yaml` | the render's own counts — context, not the anchor |

## Products

- `6-qa-and-training/training-deck-render-eval_verdict.yaml` — verdict YAML per
  `_eval-template.md § Verdict YAML contract` / `lib/verdict-schema.ts`, with one
  `per_item` row per slide judged.

## Process

1. **Capture the deck** — headless, with the Drive service account:
   ```bash
   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/deck-visual-capture.ts" \
     --deck <presentation id> --out <scratch>/deck-eval
   ```
   It reads the deck through the Slides API, runs the structural pre-checks
   (`lib/deck-visual-checks.ts`: `empty-slide`, `placeholder-text`,
   `off-page-element`, `suspected-text-overflow`), and writes a 1600px thumbnail
   of every slide it selects (`slidesToJudge`: all slides when the deck has ≤ 25;
   otherwise every flagged slide plus an evenly-spaced sample of 16 others) to
   `<scratch>/deck-eval/slide-NN.png`, with `slides.json` beside them.
2. **Add the spec's must-carry slides.** From `training-deck-spec.yaml`, every
   slide the spec gives a screenshot (walkthrough / `your-opportunity` /
   `practice` stencils) must be judged; if `slidesToJudge` skipped any, re-run
   with `--all`. A sample that skips the slides that SHOULD carry screens is not
   evidence (ace#856).
3. **Judge each selected slide with the Tough Judge method.** For each,
   `Skill('canopy:visual-judge', {screenshot_path: <slide-NN.png>, page_text:
   <slides.json text>, rubric: <the 3 slide dimensions below>, context:
   {slide_index, spec_stencil, structural_findings}})`. When that skill is not
   installed, apply its method inline: Read the PNG, LIST every defect before
   scoring, start each dimension at 3/5, move only on evidence, and apply the
   projector test (would this read from the back of a room?). A structural
   finding is a suspect, not a verdict: confirm or dismiss it on the image.
4. **Roll up and write the verdict** (rubric below) via `drive_upload_binary`
   (`text/yaml`) into `6-qa-and-training/`; read it back. Surface concerns per
   `_eval-template.md § Auto-surfaced severity rules`, naming slide numbers.

## LLM-as-Judge Rubric

**Per slide** (0–5 each, Tough Judge scale):

| Slide dimension | 5 | 3 | 1 |
|---|---|---|---|
| `legibility` | all text inside its box, readable at projector distance | crowded, small, or one line clipped | text overflows / overlaps / is cut off |
| `image_placement` | the screenshot is the hero, uncropped, readable, aligned, and shows the screen the slide is about | present but small, awkwardly cropped, off-balance, or uninformative (a near-empty screen, mostly keyboard — score 2) | missing where the slide needs one, cropped to uselessness, or off the slide |
| `content_present` | the slide carries what its stencil promises | thin — a heading and little else | empty, or a template prompt / `{{token}}` showing |

**Applicability.** `image_placement` applies only to a slide that should
carry a screenshot — decided from the SPEC (`training-deck-spec.yaml`: walkthrough
/ `your-opportunity` stencils, and any slide whose spec names an image), and when
the spec cannot be read, from the slide's own text promising a screen ("you see
the welcome screen"). Practice / quiz prompts carry no screen unless the spec
says so. On a divider or text-only slide it is N/A. A slide's score is the MIN of
its applicable dimensions; per slide, ≥ 4 `pass`, 3 `warn`, ≤ 2 `fail`.

**Deck dimensions** (0–10, weights sum to 1.0), computed from the slide scores:

| Dimension | Weight | Anchored criteria |
|---|---|---|
| **Projector readiness** (fitness — out-of-chain) | 0.40 | Could a trainer project this deck tomorrow without editing it? Computed: `(mean of per-slide scores − 1) × 2.5` (10 = every judged slide ≥ 4 on all applicable dimensions; ~6 = a few slides need a one-minute fix; ≤ 3 = several are broken in front of a room). **Hard gate: any slide with `content_present` = 1 (empty, or a visible placeholder) or `legibility` = 1 (overflowing / cut-off text) caps this at 3 → suite verdict `fail`.** |
| **Image placement** | 0.30 | Mean `image_placement` over slides that should carry an image (from the spec), scaled to 0–10. A missing screenshot on a walkthrough slide counts as 1. |
| **Legibility** | 0.20 | Mean `legibility` over judged slides, scaled to 0–10. |
| **Content presence** | 0.10 | Mean `content_present` over judged slides, scaled to 0–10. |

Weights sum to 1.0: 0.40 + 0.30 + 0.20 + 0.10 = 1.00. Scale a slide mean `m`
(1–5) to 0–10 as `(m − 1) × 2.5`.

**Hard-deduct rules:**
- The projector-readiness hard gate → BLOCKER naming each slide.
- A judged sample that omitted a spec screenshot slide → verdict `incomplete`
  (re-run with `--all`), never a pass.
- Any dimension ≤ 3 → suite verdict `fail`.

**Verdict bands** (overall, post-cap): ≥ 7.0 `pass`; 5.0–6.9 `warn`; < 5.0
`fail`. A hard gate or a dimension ≤ 3 is `fail` at any overall. Gate threshold
7.0.

**Inflation guard.** If `training-deck-render`'s self-eval passed and this
rubric's overall ≤ 6.0, say so in a `[WARN]` — the self-eval's counts were
satisfied by a deck that does not project.

**Calibration target:** detection ≥ 80% of catalogued render defects in
`eval-calibration/known-issues.md § Training deck render` (catalogue TBD);
inter-run variance ≤ 0.5 across 3 same-model runs.

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)`. The slide capture is a
script (Slides API through the service account); the verdict is written with
`drive_upload_binary`.

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior (stock)`.

## Related skills

- `canopy:visual-judge` — the per-slide Tough Judge.
- `training-deck-generate-eval` — grades the spec upstream of this.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-10-01 | First live grade (spark-facilitator/20260926-1800, all 54 slides): **4.66 `fail`** — slide 53's body text overlaps its title (hard gate), and 10 walkthrough / app-screen slides carry no screenshot. Rubric made explicit from the judge's notes: per-slide pass/warn/fail bands and min-of-applicable scoring, `image_placement` applicability from the spec (practice prompts excluded unless the spec says otherwise), an anchor for a present-but-uninformative screenshot, projector readiness as a formula, deck verdict bands. The overflow pre-check is now a paragraph-aware wrap estimate; it still misses slide 53 (paragraph spacing is not modelled) — the look is authoritative. | ACE team |
| 2026-10-01 | Initial version. Nothing judged the RENDERED deck: generate-eval grades the spec, render's self-eval counts slides. Captures slide thumbnails headlessly via the Slides API (`scripts/deck-visual-capture.ts`), pre-checks the page model (`lib/deck-visual-checks.ts`: empty, placeholder, off-page, suspected overflow), and judges each slide with canopy's Tough Judge on legibility / image placement / content presence, rolled up into projector readiness (0.40, hard gate) + image placement + legibility + content presence. Dispatched by `agents/qa-and-training.md` after `training-deck-render`. | ACE team |
