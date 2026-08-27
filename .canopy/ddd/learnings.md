## bednet-two-visit-spot-check-2026-08-26-001 (iter 0 -> 1)

- **Labs' Tailwind CSS is a content-purged JIT build and workflow `render_code` is never
  scanned by it** (filed: dimagi-internal/connect-labs#1294). render_code lives in the DB, so
  any colour utility labs' own Django templates don't use is silently absent. The element
  renders, carries the right text, and is invisible: `bg-rose-400` computes to
  `rgba(0, 0, 0, 0)`. The label stays in the DOM and in `$B text`, so page-text assertions,
  `data_fidelity` and `narrated_numbers` ALL pass while a human sees nothing — every
  text-based lens in the DDD pipeline is structurally blind to this class of defect.
  **The purge is per-UTILITY, not per-family** — there is no rule to hold in your head:
  `text-slate-700` resolves, `bg-slate-400` does not; `bg-emerald-500` resolves,
  `bg-emerald-600` does not; `bg-indigo-600` resolves, `bg-indigo-500` does not.
  So on this dashboard the "no" halves AND the weekly-chart bars had been invisible all along.
  **Never assume a Tailwind colour resolves on a labs dashboard — enumerate the deployed
  stylesheet and check, and re-check anything you substitute in.** Substituting blind is how
  I turned a half-broken bar into a fully-broken one (rose→slate and emerald-500→emerald-600,
  both absent).

- **A live-DOM probe beats both the judges and the source.** The render code plainly
  emitted the "no" segment, so reading the source alone would have dismissed six correct
  findings as hallucination. Reading the screenshot alone would have found the symptom
  with no mechanism. The probe settled it in one call.

- **Copy `unified_spec.yaml` into the run dir AFTER the last spec edit, not before.**
  Judge context is built from the run-dir copy; a stale copy made two scene-7 judges
  review narration that had already been fixed, producing one phantom finding.
  `ddd-upload` reads the same file, so the staleness would also have shipped.

- **`recipe_preflight` cannot preflight a `setup:`/`${var}` spec** (canopy#523): it runs the
  setup command but never loads its outputs or substitutes, then concatenates `base_url`
  with an already-absolute scene URL. Workaround: probe the surfaces directly with
  Playwright + the labs storage-state to confirm every testid resolves.

- **Judges see one scene and cannot see cross-scene state dependencies.** Two judges asked
  to drop scene 6's period restore so the recompute shows in the still. Doing so would
  leave the page on week 9, where scene 7's divergence prompt falls below its minimum
  sample and stops firing. Kept the restore; re-framed the scene end instead.

- **The walkthrough cursor is a deliberate synthetic overlay** (`CURSOR_OVERLAY_JS`,
  injected via `add_init_script`), not a capture artifact. Judges repeatedly flag it as a
  stray OS pointer on read-only scenes. Do not "fix" it in the product or the spec.

- **`support-<username>` on the LLO weekly review persists server-side and is one-way**
  (`onUpdateState` -> `worker_states`; no transition back to `pending`). Never click it to
  satisfy a frame — and note `recipe_preflight` REPLAYS state-changing actions, so an
  irreversible click must be removed from the spec before preflight, not just before render.

- **Two of the three broken utilities on the weekly-review dashboard were PRE-EXISTING,
  not introduced by the fix pass.** `text-rose-700` styled `consent 89.7% · below the 90%
  floor` — the single most load-bearing red on the page, on the ONLY pay-affecting figure —
  and had been rendering as default near-black (`oklch(0.145 0 0)`, exactly the unstyled
  baseline) since before this run. The review surface has been unable to visually signal a
  consent-floor breach the entire time, silently. That is the SECOND instance in this phase
  of the review surface failing to show the thing it exists to show; the first was the
  `status`/`flagged` SSE omission (ace#1657). When a dashboard's core signal looks absent,
  suspect the rendering layer before concluding the data is missing.

- **`border-*` and `text-*` availability does NOT mirror `bg-*`.** Enumerate each prefix
  separately from the deployed stylesheet. Slate has `bg` 50/100/200/600 but `border` ONLY
  200. Rose has `bg` 50/100, `border` only 200, `text` only 600/900. Inferring one prefix's
  palette from another's is the same error as inferring a family from one shade.

- **A no-op utility lands exactly on the unstyled baseline**, which is why it is invisible to
  review: `text-rose-700 -> oklch(0.145 0 0)` reads as ordinary body text, and
  `bg-emerald-600 -> rgba(0,0,0,0)` reads as background. Probe computed style against the
  element's expected value, never just "is it styled".

- **A timed-out `workflow_patch_render_code` did NOT apply.** Re-fetch and check the version
  before retrying; do not assume a partial write.

- **Re-render AFTER the last product fix lands, and verify the surface version at render
  time.** iter1 rendered at 08:28:44 against workflow 5230 v11; v12 (the consent-red fix)
  landed minutes later, so scenes 6-7 were judged on an already-superseded surface. Same
  class as the stale `unified_spec.yaml` copy earlier in this run: the artifact under
  judgement must be the artifact as it now exists. Check the live version, not the clock.

- **The labs Tailwind purge is NOT a colour problem — it drops sizing and layout utilities
  too, and those fail worse.** Measured live: `h-28` -> computed height `0px`; the arbitrary
  value `min-w-[52px]` -> `auto`. On workflow 5227 this made the entire 12-week bar chart
  render at zero height: every bar carried a valid inline `style.height` (89%, 70%, 78%...)
  and a background colour that resolved, but the `h-28` wrapper had no height, so each
  percentage resolved against 0. Twelve bars, all `renderedPx: 0`, no error.
  - A missing COLOUR leaves readable text on the wrong background — visible on inspection.
    A missing HEIGHT collapses the element to nothing while the DOM still reports it as
    present and the inline style still reads as correct. Only `getBoundingClientRect()`
    catches it.
  - **The rule is EXACT-STRING COVERAGE, not arbitrary-vs-standard.** I first concluded
    "arbitrary values can never work" and published it; that is FALSE and I corrected it.
    Measured: `text-[11px]` and `text-[10px]` resolve fine, while `min-w-[52px]` does not,
    and `h-28` — a wholly ordinary utility — does not either. The governing rule:
    *any utility whose exact class string is absent from labs' own scanned templates is
    unavailable to DB-stored render_code — arbitrary or not, colour or not.* 95 of 97
    classes in the file resolved. This makes safelisting MORE viable, not less.
  - **Remedy: inline `style={{...}}`**, which is immune to purging by construction. Reach for
    it for any sizing that must hold, rather than guessing at another class.

- **Three separate invisible-element defects in one dashboard, three different mechanisms**
  (transparent colour utility; zero-height container; and earlier, a whole panel suppressed by
  a payload gap). The generalisable rule: when a judge says "X is not visible", get the
  computed geometry AND the computed colour before believing either the source or the judge.
  Source-reading alone said all three were fine.

- **Probing method, learned the hard way (three wrong readings in one run):**
  1. `getComputedStyle` returns `oklch(...)` on this Tailwind v4 build. Parsing those three
     numbers as RGB yields silent nonsense — my first contrast pass reported emerald-500 at
     13.75:1 when it is 2.47:1. Paint the colour to a canvas and sample the pixel.
  2. Use BOTH a `document.styleSheets` walk and a rendering diff. Some stylesheets are
     CORS-blocked from `cssRules`, so the stylesheet signal alone under-reports; the
     rendering probe is CORS-immune.
  3. "No rendering diff => missing" is a false-positive generator: `space-y-*` targets
     `:not(:last-child)`, `list-disc` is the CSS initial value, and `mx-auto` computes to
     0px on a full-width block — all four read as no-diff while genuinely present.
  4. `inner_text()` returns RENDERED text, so a `text-transform: uppercase` header yields
     `CONSENT RATE` while `textContent` is `Consent rate`. Compare case-insensitively or a
     landed fix reads as missing.

- **`scene_<N>_before.png` on a CONTINUATION scene is byte-identical to scene N-1's end frame BY
  CONSTRUCTION — it is not evidence of anything.** The recorder writes the before-frame *before any
  action of the scene runs* (`· before-frame scene_7_before.png` precedes the first action in the
  render log). A scene with no `url:` continues on the previous scene's page, so nothing has
  happened in between and the two frames MUST match.
  - I got this wrong in a way worth remembering: the arc judge reported `md5(scene_7_before) ==
    md5(scene_6)` as PROOF that a `scroll_to` I had added was a no-op, and I acted on it without
    checking the mechanism. The md5 identity was structurally guaranteed and proved nothing. The
    scroll may or may not have moved; that experiment could not tell us either way.
  - **To test whether a scene's actions changed anything, compare the AFTER frames**
    (`scene_N.png` vs `scene_N-1.png`) and the captured page TEXT. Done properly here: scene 6's
    text lists all five workers, scene 7's lists only Joseph and Peter, and the after-frames differ
    — so the filter demonstrably fires and is captured.
  - General rule, and the second time this run: **a judge's INFERENCE is not evidence, even when its
    underlying observation is real.** Verify the mechanism before acting. The observation (identical
    md5) was true; the conclusion drawn from it was not.

- **Per-scene judges cannot see a fix that breaks a NEIGHBOURING scene's evidence.** Two iter1
  judges (correctly, for scene 6 in isolation) asked to retarget scene 6's ending scroll from
  Joseph's card to Peter's, because Peter's callout was clipped. Doing so skipped past the ONLY card
  carrying scene 6's own `concept_claim` — Joseph at 89.7% consent, "below the 90% floor", which is
  literally what scene 6's `single-thresholded-kpi` feature says to verify — AND rendered scene 7's
  payoff a full scene early, inverting the climax. Only the ARC lens could see it, and it was right.
  **When a per-scene finding proposes moving the camera, check the scene's own feature `verify`
  first: if the fix moves the verifying evidence out of frame, it is a regression.**

## Meta-learning: four self-corrections in one run, all the same shape

Every wrong claim I made in this run came from **asserting a mechanism I had not measured**, and
each was caught only by going and measuring. Recording the shape because the failure is far more
uniform than the four topics suggest:

1. **oklch parsed as RGB** — reported emerald-500 at 13.75:1 contrast; it is 2.47:1. Would have
   dismissed a real blocking WCAG defect that two judges measured correctly.
2. **"arbitrary Tailwind values can never work in DB-stored render_code"** — published to
   connect-labs#1294 as reasoning, not observation. False: `text-[11px]` resolves, ordinary `h-28`
   does not. It also pointed the fix AWAY from safelisting, the cheapest remedy.
3. **"md5(scene_7_before) == md5(scene_6) proves the scroll was a no-op"** — accepted a judge's
   inference. The identity is structural for any continuation scene; the experiment could not
   distinguish the hypotheses. I changed the recipe on it.
4. **"`?embed=1` exists and strips the chrome"** — stated in a final report BEFORE the check that
   would have answered it returned. Nine params including `embed=1` return a byte-identical body.
   I then invented a title-vs-chrome tradeoff on top of a mechanism that does not exist.

**The tell in all four: a confident causal claim with no command output behind it.** #1 and #3 had
real observations attached, which is what made them persuasive — a true observation with a false
conclusion is more dangerous than a guess, because it looks like evidence.

**Rules earned:**
- Before asserting *why* something behaves as it does, run the thing that would falsify it. A
  measurement I have not run is not a fact I hold.
- A judge's OBSERVATION and a judge's INFERENCE are different artifacts. Verify the inference.
- Never state a pending subagent's result. If the answer is not back, say it is not back.
- Getting a number from a browser: probe COMPUTED values (canvas-sample colour,
  `getBoundingClientRect` geometry, injected probe elements for class resolution). Reading source,
  reading class names, and reasoning from a framework's documented defaults all failed here at least
  once, on a deployment whose build silently diverges from those defaults.
