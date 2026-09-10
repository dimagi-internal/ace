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

## Run hh-poverty-targeting-answer-quality-2026-08-29-001 (ACE Phase 7, canopy 0.2.450)

### The judges agreed on the symptom and were wrong about the cause
Thirteen of sixteen iter0 judges reported the first table row sliced under the sticky
header and prescribed `scroll-margin-top`. The `td` ALREADY had `scrollMarginTop: 118`.
A live geometry probe found the actual mechanism: the sticky `th`'s containing block is
the card (an overflow-hidden ancestor), not the viewport, so `top: 58` displaced the
header DOWN 58px from its natural position — landing 21px inside the first row on both
dashboards. `top: 0` fixed it (`overlap: false`, verified before/after).
**A unanimous judge consensus on a REMEDY is not evidence about the CAUSE.** They can
only see the frame. Measure the mechanism before patching what they name.

### The same probe demoted an `options` finding to `mechanical`
Five judges across two iterations raised the clipped GPS column as `options` (needing a
column-priority product call), because a screenshot cannot show why a column is clipped.
Measurement showed the container was `overflow-x: hidden` with `scrollWidth ==
clientWidth` and the headers were `white-space: nowrap`; letting headers wrap took both
tables from 1429/1362px to exactly 1230px with zero overflow. A determinate fix existed
the whole time and no judge could have found it.
**When several judges independently return `options` on a LAYOUT finding, probe the
geometry — the choice they could not make may not be a real choice.**

### Preflight dirties the state the payoff depends on
`recipe_preflight` walks scenes in order and APPLIES state-changing actions. It had
already set the disposition, so the recorder's `select` was a no-op re-set: iter0's
before/after frames differed by 0.12% of pixels (all cursor) and the "discriminating"
wait_for resolved instantly because its marker was already true. **Order is
preflight -> reset the mutated state -> record.** Never preflight after the reset.

### An edit that spans a wrapped line silently does nothing
Two spec edits no-op'd because the target phrase crossed a YAML line break; the script
still printed success because its assert only checked that SOMETHING changed. Both were
caught only because a deterministic checker still failed afterwards.
**Verify an edit with the checker that motivated it, never with the edit script's own
exit code.** Operate on the joined block, not the raw lines.

### Widening one header clipped the payoff control
Renaming a column to fix a clarity finding pushed the DECISION column — the entire
point of the finale — out of its container. Caught by re-measuring after patching, not
by any judge. **After a copy/label change to a fixed-width layout, re-measure the
geometry; a text fix can be a layout regression.**

### Weakest-link scoring hides real progress
Concept/user/arc all read 2.0 at iter0 and 2.0 at iter2 while the underlying
distribution moved a great deal (visual_polish 2->3 on ALL scenes, persona_coherence
2->4, arc_shape 2->3, opening_and_close 3->4). Report the per-dimension movement
alongside the overall, or a genuinely improving run reads as a stalled one.

### The arc lens found what 14 per-scene judges structurally could not
Both arc hard caps (scenes 1-2 the same surface 12px apart; 5 of 7 scenes one page at
four scroll offsets) are invisible to a judge holding one screenshot. It also correctly
separated a PRODUCT constraint (the ops page cannot scroll) from a DIRECTORIAL choice
(the analysis page scrolls freely). Keep the arc judge gating.

### A passing duplicate-frame check does not mean two scenes are distinct
iter3 scenes 1-2 differ by 28.95% of pixels — comfortably past the 2% duplicate
threshold — while `scene_1_page_text.json` and `scene_2_page_text.json` are BYTE-IDENTICAL
including `render_id`. The page had simply shifted 12px. The pixel check measures
whether the camera moved; only the arc judge could see that nothing NEW was shown.
**Pair the pixel check with a page_text/render_id equality check** — identical text with
a large pixel delta is the signature of a camera move that reveals nothing.

### The duplicate-frame gate compares ADJACENT pairs only, and that is the wrong window
This loop produced a duplicate analysis-page frame in THREE consecutive iterations —
iter1 (6,7), iter2 (5,7) at 0.0026, iter3 (3,5) at EXACTLY 0.0000 over 1,296,000 px —
and `duplicate_frames` reported PASS every time, because every instance was
non-adjacent. Each of my fixes moved the duplicate to a new index instead of removing
it. The mechanism is deterministic and index-independent: several scenes issue
`scroll_to css:table`, which always resolves to the same offset, so any two of them
collide by construction. Only the ARC judge caught it, all three times.
**Run an ALL-PAIRS diff, not adjacent-only** (six lines using the module's own
`_difference`/`_scene_pngs`), and treat a bare `scroll_to css:table` on a page that
also has row-targeted beats as a spec smell. Filed as a DEFER finding against
canopy's `scripts/ddd/duplicate_frames.py`.

### I introduced a regression and it became the gating cap
The `top: 58 -> top: 0` sticky fix removed the row overlap (measured, both states) and
in doing so let the header slide under the 64px app bar when scrolled. By iter3 that
single side effect was capping FOUR of seven concept scenes — visual_polish 2 on s3/s5
(nav slicing the SCORE DISTRIBUTION label) and motion_friction 2 on s4/s6 (KPI numerals
sliced, seventh row clipped) — i.e. the thing holding concept at 2.0 was my own fix.
**After shipping a fix, check the NEXT iteration's caps for its fingerprint** rather
than assuming the remaining caps are pre-existing.

### Do not hand a judge a measurement without re-checking it still holds
I told the iter3 arc judge the ops page was 912px against a 900px viewport (~12px of
scroll). It measured ~66px of actual movement and said so. The 912 figure was taken
BEFORE the header-wrap change altered the page height. A stale measurement passed to a
judge as fact is worse than no measurement, because the judge reasons from it.
- [2026-09-02T19:27:05Z] hh-poverty-targeting-census-sweep iter2: the arc judge VACATED its own iteration-1 structural_ceiling. It had claimed the operations dashboard fits one viewport and capped visual_variety as a PRODUCT limit; re-derived at 1440x900 it returns capped_by_ceiling=[] with all five dimensions fixable_in_spec. A ceiling claim from a stalled iteration is a hypothesis, not a fact — always re-derive it rather than carrying it forward.
- [2026-09-02T19:27:05Z] canopy walkthrough: scroll_to centres its target unconditionally (window.scrollTo top = y + scrollY - innerHeight/2). A target near page top clamps to scrollTop 0, so the scene silently films the PREVIOUS scene frame. Two DDD iterations lost to this. Anchor a scene on content BELOW the fold-line you want, never on a section heading, and verify with an all-pairs pixel diff — the bundled duplicate_frames gate only compares CONSECUTIVE pairs.
- [2026-09-02T19:27:05Z] DDD loop: raising video_viewport_height fixes below-the-fold findings but SHRINKS scroll range and can collapse two scenes into one frame (1359px page at 900px viewport = 459px of range). Measure scrollHeight before bumping the viewport, and re-diff all pairs after.
- [2026-09-02T19:27:05Z] DDD concept gate: CONCEPT_GATE_MAX_DEFERRALS=1 is spent per RUN, not per iteration. A run whose iteration-1 judge round died mid-assembly still burns its deferral, so the next completed iteration opens the gate with its own mechanical findings unapplied. Worth knowing before assuming a stop_concept_change means no mechanical work is left.
- [2026-09-09T03:06:03Z] spark-fcap-facilitation iters 3-4: run 5508's `spawned_tasks` state PERSISTS server-side, so a scene whose payoff CREATES a coaching task leaves the create button absent on the next render and its must_succeed click aborts. Fixed durably with a `rerun: per_render` setup script (reset_and_realize.py) that POSTs {"state": {...}} to /labs/workflow/api/run/<id>/state/ using the DOM csrfmiddlewaretoken (there is no csrftoken cookie for the labs domain). Iterations 0-2 only passed because someone reset it by hand, which left no trace in run_state.
- [2026-09-09T03:06:03Z] spark-fcap-facilitation iter 3: the 9-column facilitator table overflowed 1440px, so Playwright's click on the far-right button scrolled the container sideways and dropped the narrated 'thirteen filed' plus the Action CTA off-frame. The recorder's `scroll` action is window.scrollTo only and CANNOT scroll a container horizontally, so there was no recipe fix — the product fix is tableLayout:'fixed' + percentage colgroup, which made fit viewport-independent (verified false overflow at both 1440 and 1280, including after the click).
- [2026-09-09T03:06:03Z] spark-fcap-facilitation iter 3: de-duplicating the redundant '155 of 173' tiles DELETED 155 from the overview while the locked narration still said 'a hundred and fifty-five of them qualify'. Only `narrated_numbers` caught it. Run the cheap deterministic lenses after every product fix, before re-judging.
- [2026-09-09T03:06:03Z] spark-fcap-facilitation iters 3-4: the arc lens and the per-scene lens want opposite framing for scene 3. Resting at page bottom showed all 12 rows but clipped the four KPI VALUES (per-scene clarity 2); resting at page top showed title+KPIs and took the per-scene floor 2->3 on every scene but made 3->4 the weakest transition (arc escalation 4->3). The filtered weekly page is 1112px against a 900px viewport, so 212px of total scroll range means scene 4 CANNOT scroll past the carried KPI header. Geometry, not scripting.
- [2026-09-09T03:06:03Z] spark-fcap-facilitation: confirmed at source via pipeline_preview(5501,10060) that cbf_thandiwe_phiri/Zunde files 25 meetings over 24 distinct days in a ~12-week span against a cohort of 11-16 — ~2/week in a weekly-meeting programme, with 0 committee and 0 not-held to explain it, at 100%. Three independent judges found it from the screenshot alone. NOT auto-fixable: bringing it into band takes the cohort to ~161/~143 and falsifies the approved narration's verbatim 173/155.
- [2026-09-09T03:06:03Z] canopy 0.2.479 spec_qa crashes (AttributeError: 'list' object has no attribute 'strip', spec_qa.py:491) on Scene.narrative in its LIST form, which models.py:638 declares legal and models.py:526 scene_narration_text() exists to normalise. Blocks the ddd-run gate outright; workaround is to join the beats before gating.
- [2026-09-09T03:06:03Z] canopy 0.2.479 regression_guard hard-FAILS when a no-op scroll_to is intentionally replaced by a pixel scroll — i.e. on canopy's own prescribed framing fix — reporting 'ran last iteration and is absent now' as a gate failure on a strictly better run (23/23 vs 20/20).
- [2026-09-09T03:06:03Z] canopy 0.2.479: the render viewport is the SPEC fields video_viewport_width/height defaulting to 1280x720. A spec rebuild that drops them silently re-renders a 1440x900 run at 1280x720, invalidating every measured pixel offset and making the cross-iteration score comparison unsound, with no warning.
- [2026-09-09T03:06:03Z] [gate-tracking] class=concept_change decision=defer run=spark-fcap-facilitation-2026-09-08-001 resolved_by=unattended_default
- [2026-09-09T14:59:23Z] spark-fcap-facilitation-2026-09-09-001: replacing a CLAMPED scroll_to with a pixel scroll can LOWER the arc score, and that is the fix working. iter0 scene 5 scroll_to was a no-op so scenes 4/5 inherited one frame; the arc judge read 4->5 as a genuine state change and did not fire its cap. iter1 pixel scrolls at 700/850 made them mechanically distinct (duplicate_frames 15/15 pass) but only 150px apart on a page sharing its top 800px, so the same-surface-plus-scroll cap fired and escalation went 3->2. The defect was always there; the no-op was hiding it from the only lens that can see it.
- [2026-09-09T14:59:23Z] spark-fcap-facilitation-2026-09-09-001: canopy 0.2.480 regression_guard hard-FAILS when a scroll_to is deliberately replaced by a pixel scroll, reporting "ran last iteration and is absent now" on a strictly better run (24/24 ok vs 22/22). Same false-positive class as 0.2.479. Read the named actions before treating a regression_guard fail as real.
- [2026-09-09T14:59:23Z] spark-fcap-facilitation-2026-09-09-001: putting a narrated number on screen to satisfy narrated_numbers can CREATE an arc escalation finding. Adding "38% of records paid" to the ledger caption fixed the narrated_numbers fail, and the arc judge then found that 38% is already a cell in the previous scene table, demoting scene 3 from a new claim to a restatement. Deterministic lenses and the sequence lens can want opposite things; expect the trade and name it.
- [2026-09-09T14:59:23Z] spark-fcap-facilitation-2026-09-09-001: the DDD run-level user-artifact verdict needs a top-level dimensions map (score+weight per dimension) or scripts.ddd.verdicts.load_verdict raises a pydantic ValidationError and assemble_run_state cannot run. A per-scene matrix alone does not satisfy narrative.models.Verdict. Under overall_rule lowest the run-level value for a dimension is its minimum across scenes.
- [2026-09-09T14:59:23Z] spark-fcap-facilitation-2026-09-09-001: a stakeholder dashboard sentence naming the payment keys first component could not be verified either way - PDD 7.1 says concat(<case id>,...) with case type community, the RELEASED Deliver app v10 builds entity_key from the facilitators username with no community identifier. At 1 CBF per community they coincide so no data can distinguish them. Resolved by asserting only what is true under both readings (step + capped meeting number), which is also what the on-screen collision demonstrates. ace#2330.
- [2026-09-09T14:59:23Z] spark-fcap-facilitation-2026-09-09-001: re-measure page geometry after EVERY content edit before writing a scroll offset. A peer-supplied figure of 364px against a 1110px range was stale by ~400px once a caption edit changed the page height; live re-measure gave a 1586px page, 686px range, caption at y=700.
- [2026-09-09T14:59:23Z] canopy 0.2.480 runtime: bare python is not on PATH on this machine and exits 0 with command-not-found, so a gate invoked as `python -m scripts.ddd.<x>` reads as a SILENT PASS. Always invoke via uv run python or python3.
- [2026-09-09T14:59:23Z] [gate-tracking] class=concept_change decision=defer run=spark-fcap-facilitation-2026-09-09-001 resolved_by=unattended_default
- [2026-09-09T23:45:57Z] spark-fcap-facilitation-2026-09-09-002 iter0: the arc AND user judges both found the programme-overview Share-paid column monochrome and called for green/red badges ("nine rows in green, three in red" has no referent). Shipping them would be WRONG. Workflow 5505 render_code carries an explicit comment refusing that colour: the 85% target is defined against meetings SCHEDULED and the pilot records no schedule (the why-brief CAPABILITY gap no-schedule-of-intended-meetings), so a pass/fail colour would assert a comparison the data cannot support. The same judges credited that honesty elsewhere. The artifact is the authority: this is an ACCURACY finding whose fix is the NARRATION (drop the colour claim and the "against a target of eighty-five" comparison the on-screen caption expressly refuses), not the product. A judge naming a remedy is not evidence the remedy is available - read the render code before shipping a fix it deliberately refuses.
- [2026-09-10T00:17:11Z] spark-fcap-facilitation-2026-09-09-002 (scene-order experiment): moving the ACTION to last and the open-parameters disclosure into the FRAMING did NOT clear the arc_shape cap. arc_shape stayed 3/5 both iterations and the hard cap 'the final scene is not the strongest moment: max 3' fired both times. What DID change is the failure's shape: the previous 6-scene run declined for two scenes after its peak; the 4-rung ladder peaks at scene 3 and lands softer at 4 with nothing after it. Reordering fixed the decline and not the cap, because the cap is about the FINALE's strength, not about where the peak sits relative to the end. A finale that AGREES with the machine (a review confirming a Not-paid the page already showed) is structurally quieter than the reveal before it; the arc judge's own suggestion was to make the reviewer CONTRADICT the machine.
- [2026-09-10T00:17:11Z] spark-fcap-facilitation-2026-09-09-002: the real iteration-0 defect was that scene_N.png is the scene END frame, so a scene that clicks to a prose tab last has its data-rich view in NO captured frame. Scene 1 declared two features and could only film the second; the twelve-row step table and the narrated 'thirteen weeks'/'seven steps' were absent from every frame, and narrated_numbers FAILED on exactly those two words. Fix was one added click back to the delivery tab - narrated_numbers went 47-checked-FAIL to 48-checked-PASS. When a scene declares two features on two tabs, the recipe must END on the one the deck needs.
- [2026-09-10T00:17:11Z] spark-fcap-facilitation-2026-09-09-002: a JSX comment {/* ... */} placed directly inside a ternary's parenthesised branch, before the single root element, is parsed as an OBJECT LITERAL and breaks the whole render ('Unexpected token, expected ","'). It is only legal in JSX CHILDREN position. Labs render_code compiles in-browser via Babel, so the failure surfaces as a blank 'Render error' page, not as a patch error - workflow_patch_render_code accepted it happily. Always load the page after patching render_code; never trust the patch's success response.
- [2026-09-10T00:17:11Z] spark-fcap-facilitation-2026-09-09-002: regression_guard hard-FAILED for the THIRD recorded time on the same false positive - deliberately replacing a scroll_to with a pixel scroll reports 'ran last iteration and is absent now' on a strictly better run (29/29 ok vs 21/21, one of the replaced scroll_to's having been a measured no-op). Read the named actions before treating a regression_guard fail as real.
- [2026-09-10T00:17:11Z] spark-fcap-facilitation-2026-09-09-002: the concept judge's de-noise pass CHANGED the verdict. Four cells drew <=2 on first pass and none of the four reproduced at k=3 (scene 1/3/4 motion_friction, scene 4 design_soundness); the raw minimum would have printed 2/FAIL where the confirmed floor is 3/WARN. Systematic cause worth knowing: scenes narrating two surfaces at once (records table + decision panel) leave judges disagreeing about which is 'the narrated artifact', and that disagreement is worth two points under the fits-but-mis-framed rule. Never gate on an unconfirmed cap.
- [2026-09-10T00:17:11Z] spark-fcap-facilitation-2026-09-09-002: a tall sticky inspector puts its own identity header above the fold, so the narrated record fields were recited over a frame showing none of them. The durable fix was NOT a camera move - it was collapsing the six-row recorded-fields list once the trace opens and carrying the same facts as a one-line summary INSIDE the trace. That put step/36/85/21/decision in frame for BOTH scenes on that page at once, which no scroll offset could have done, and shortened the panel enough that the payoff panel fits too.
- [2026-09-10T00:17:19Z] [gate-tracking] class=concept_change decision=defer run=spark-fcap-facilitation-2026-09-09-002 resolved_by=unattended_default
