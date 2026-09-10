---
name: demo-narrative
description: >
  Author a funder-tuned canopy DDD narrative (WhyBrief + UnifiedSpec) on top of
  a demo-data-setup realized map, with scenes that render the live labs
  dashboard (par_url). Validated by canopy's own scripts.ddd.validate — the
  authoritative gate. Hands off to the DDD loop.
disable-model-invocation: false
---

# Demo Narrative

The **story** half of the ACE demo workflow. Given a demo brief and the
`realized.json` map from `demo-data-setup`, it authors the two canopy DDD
artifacts — a `WhyBrief` and a `UnifiedSpec` — whose scenes render the live labs
dashboard (`${par_url}`) and whose `setup` block reproduces the dataset. The
canopy DDD loop then renders / judges / (optionally) videos / uploads.

ACE does **not** own the narrative schema, the renderer, the judges, or the
video path — canopy does. This skill authors against canopy's published models
(`scripts/narrative/models.py`, JSON Schemas under
`scripts/narrative/schema/json/`) and gates on canopy's validator. Do not
paraphrase the schema here — read the model / schema and validate.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Operator | `--brief <text or drive-path>` | the demo story (same brief `demo-data-setup` used) |
| `demo-data-setup` | `<demo-run>/7-synthetic/realized.json` | the flat `${var}` map — `primary_par_url`, one `<key>_par_url` per dashboard, `<name>_url` drills — the scenes render |
| `demo-data-setup` | `run_state…products.synthetic.source` | provider, labs opp id, deliver units, and `dashboards[]` (key/template/role/`interactive`) — one narrative arc per dashboard; `interactive: true` marks the only dashboard whose controls are live |
| `demo-data-setup` | `run_state…products.synthetic.source.record_counts` + `.data_shape` | **the dataset's cardinality** — `record_counts` verbatim from the generator, and the three axes a demonstration can need (`rows` / `periods` / `groups`). Step 2b checks each demonstration against it BEFORE scenes are written (ace#1670). Absent on a pre-2026-08-26 run — then read `record_counts` from `<demo-run>/7-synthetic/demo-data-setup.md` and the week span from `demo-data-setup_manifest.yaml`, and say in the summary that you re-derived them |
| Discovery | canopy runtime (resolved from the installed canopy plugin via its `scripts/canopy-runtime.sh` — see Step 4) | `uv run python -m scripts.ddd.validate` (see `docs/superpowers/plans/2026-07-20-plan-a-task1-findings.md`) |

## Products

- `<demo-run>/7-synthetic/why_brief.yaml` — the `WhyBrief`
- `<demo-run>/7-synthetic/<demo-slug>.yaml` — the `UnifiedSpec`
- `run_state.yaml…products.synthetic.narrative` — `{ why_brief_ref, unified_spec_ref, validated: true }`
- `run_state.yaml…steps.demo-narrative.status: done`

## Process

1. **Read the schema, not this doc.** Open canopy `scripts/narrative/models.py`
   (or the JSON Schemas) for the exact `WhyBrief`, `UnifiedSpec`, `Scene`,
   `Feature`, `Persona`, `SetupBlock` fields + required/optional split. Mirror
   the working reference `docs/walkthroughs/program-admin-report.yaml` in a
   local connect-labs checkout if present (e.g. `~/emdash-projects/connect-labs`
   or `~/emdash/repositories/connect-labs`) — a labs-dashboard walkthrough with
   a `setup` block and `url: ${par_url}` scenes, the closest template. Optional:
   skip it if no checkout exists.

2. **Author `why_brief.yaml`.** `narrative_slug`, `problem` (the funder's
   nutrition-program pain in one paragraph), `spine[]` (each `id`, `claim`,
   `rationale`, `evidence[]`), `gaps[]`. Demo honesty rule: a demo asserts
   aspirational value, so claims the built dashboard doesn't literally prove get
   `evidence.kind: assumed` and a matching `Gap` of type `DECISION` or
   `CAPABILITY`. Every grounded spine item needs ≥1 non-`assumed` evidence;
   every `Gap.claim_ref` must resolve to a spine `id`.

2b. **Check the DATA'S SHAPE before you pick a demonstration (ace#1670).**
   A demonstration is only observable if the data has enough of the thing it
   acts on, and the axis it needs is not always the axis the dataset is big on.
   Read `source.data_shape` (and `source.record_counts` behind it), then hold
   every demonstration you are considering against these minimums — from
   `MIN_CARDINALITY` + `DETECTION_MIN_ROWS` in `lib/ddd-scene-actions.ts`, where
   each is derived with its reasoning:

   | Demonstration | Axis it needs | Minimum | Why |
   |---|---|---|---|
   | filter / search / sort | `rows` | **12** | the after-state must still read as a list (≥3 rows) AND the drop must register at a glance (~8 rows) |
   | trend | `periods` | **4** | a baseline, the turn the narration names, and a period after it — below that the claim is asserted over the plot, not read off it |
   | comparison | `groups` | **3** | with two groups one is always above the other, so the ordering carries no information about whether being behind is unusual |
   | detection / flagging | `rows` | **24** | a detection claims *unaided scanning is not viable*; a cohort that fits in one screenful (12 rows, the filter floor's own anchor) is scannable by definition, so the comparison has to span two — ace#1841 |

   Filter and detection share the `rows` axis and do **not** share a floor — a
   12-row cohort is enough to filter and not enough to detect. The check reads
   each scene's `title`, action targets, `show`, `concept_claim` and
   `features[]`, so it sees a demonstration you name only in prose (ace#1841);
   it also names the axis that DOES have room, which is usually the fix.

   **When the data cannot carry the demonstration there are exactly two
   branches, and both are taken HERE, not after a render:** pick a different
   demonstration for that dashboard (one the shape supports — a single-value
   callout instead of a trend, a drill-in instead of a filter), or go back to
   `demo-data-setup` and regenerate with a larger cohort. A third answer is
   legitimate only if it is written down: if the surface actually enumerates a
   different population than `data_shape.rows` names (a visit table has
   `user_visits` rows, not `user_data` rows), say which and use that count.

   `bednet-check-2-visit/20260825-1310` is why this step exists. It authored a
   filter demonstration over a **five-worker** cohort — filtering 5 rows removes
   at most 4, so the before-frame and after-frame are the same screenshot minus
   a line. `checkSceneActions` passed it, `scripts.ddd.validate` passed it, and
   the concept judge caught it after a full render; the loop ended
   `stopped_not_converged` at concept 3.0 four iterations later, on a defect
   decidable from two numbers before the first frame was recorded.

3. **Author the `UnifiedSpec`** (`<demo-slug>.yaml`):
   - `base_url: https://labs.connect.dimagi.com`; no `auth` block (labs cookies
     seeded out-of-band, per `hal:synthetic-walkthrough`).
   - `personas[]` — first persona is the network manager; each `name, role,
     color, intro, org`. **One arc per dashboard in `source.dashboards[]`** — e.g.
     a program manager on `program_admin` (multi-LLO oversight) and the same or a
     second persona on `child_recovery` (a named child's MUAC recovering
     red→yellow→green). The narrative moves from the overview dashboard to the
     recovery dashboard, not one screen.
   - `why_brief` — embed / reference the Step 2 brief.
   - `setup: { command: <the per-render reset> && <regenerate-realized.json command>,
     outputs: "realized.json", rerun: per_render }`.
     The `command` must (re)produce `realized.json` for the render session. For
     denovo Plan A this re-invokes `demo-data-setup` in ensure mode; **confirm
     idempotency live in the joint test** (if `demo-data-setup` regenerates
     rather than reuses, either add an ensure mode or set the command to emit the
     already-written `realized.json`).

     **`rerun: per_render`, and the command must RESET the interactive run —
     not merely re-emit the map (ace#2297).** This said `rerun: once` until
     2026-09-08, and `once` skips the command whenever the outputs file already
     exists — which is every render after the first. Recording a demo MUTATES
     the world: the coaching task the payoff scene creates is still on the labs
     run for the next take, the button is gone, and a `must_succeed` click
     aborts the whole render. canopy's own `SetupBlock` docstring names this
     case ("demos that MUTATE state during recording … film the wrong UI on
     every re-render"). Re-emitting `realized.json` does not fix it either —
     the data is unchanged; it is the RUN STATE that is dirty. So prefix the
     command with `source.render_reset.command` verbatim from the handoff
     (`demo-data-setup` step 4b), which clears the run's declared
     `state_keys`. Whenever `source.render_reset.required` is true, both halves
     are mandatory: `demo-data-setup-qa` check 18 fails a spec that carries one
     without the other.

     **Refuse a PINNED reset command — halt, do not copy (ace#2351).** Before
     copying `source.render_reset.command` into `setup.command`, check it for
     `/plugins/cache/ace/ace/` or a `/Users/<name>/` (`/home/<name>/`) segment.
     Either means the handoff snapshotted ONE machine's versioned plugin cache:
     the cache keeps every prior version, so the path keeps resolving — to
     STALE code — after every `/ace:update`, and from another account it names
     a home that is not that account's install. On `spark-facilitator/
     20260909-2242` the copied command pinned 0.13.1413 (pre-ace#2325) and
     would have re-introduced `run-not-found` on every render; only a hand
     rewrite caught it. Halt with: *"`source.render_reset.command` is pinned to
     `<the offending segment>`; re-run `demo-data-setup` step 4b to register
     the self-resolving form (`bash "$(python3 -c "…installed_plugins.json…")
     /bin/ace-reset-labs-run" …`)"* — never silently re-resolve it here, because
     the handoff is the record other consumers (forks, `demo-data-setup-qa`)
     read. `classifyPinnedResetCommand()` in `lib/labs-run-state-reset.ts` is
     the exact test check 18 applies.
   - **Put the effecting actions on the INTERACTIVE dashboard, and only there.**
     Exactly one entry in `source.dashboards[]` carries `interactive: true`
     (`role: review-action` / `review` / `decision`); its run is deliberately
     left `in_progress` so the control is live (`demo-data-setup § The
     interactive run stays live`). Every OTHER dashboard's run is completed and
     therefore **read-only** — its page prints "This run is completed…
     Decisions are read-only" and disables the status control, so a scene there
     can only `wait_for` / `hold` / capture. Author the payoff scene — the one
     where a stakeholder *takes* a decision — against the interactive
     dashboard's `${<key>_par_url}`. Writing a click into a completed
     dashboard's scene is what produced the 1.0/5 arc on
     hh-poverty-targeting/20260730-2210: 10 of 10 actions degraded to
     `wait_for`/`hold` and 7 scenes rendered 2 distinct images
     (dimagi-internal/ace#1162).

     **When `source.payoff_control` is set, the payoff scene MUST act on that
     control — it is not a hint (ace#2316).** The producer sets it when the
     opp's cohort sits below the detection floor and it took the
     `below_programme_scale` escape, which is granted only on the promise that
     the payoff rests somewhere that scale supports. You are the half that keeps
     the promise. Do NOT author the payoff against whichever control the
     template happened to ship: on `spark-facilitator/20260908-2215` the
     interactive dashboard came from `llo_weekly_review`, whose affordances are
     an underperforming-only filter and a coaching-task button, and the payoff
     became the filter — hiding 10 rows of 12 on a table that already fitted one
     screen. Four independent judges capped `use_case_soundness` at 3 on it, and
     the run could not converge. `checkEscapedPayoffIsHonoured`
     (`lib/ddd-scene-actions.ts`) is the gate; `demo-data-setup-qa` check 19
     runs it. **If the declared control is not on the page, that is a producer
     defect — send it back rather than re-aiming the scene**, because re-aiming
     is what ships the same demo with a green check.
   **Order the scenes as a LADDER that ends on the action (ace#2339).** The
   arc judge's `arc_shape` carries a **hard cap at 3** when the final scene is
   not the run's strongest moment. It is weighted .30, every judge's overall is
   the MINIMUM across its dimensions, and the convergence bar is 4.0 — so a
   deck that ends on a recap **cannot converge**, however good every frame is.

   The ladder, each rung a genuinely different surface and granularity:

   | Rung | What it shows | Why it earns its place |
   |---|---|---|
   | **Programme** | one row per opportunity / site | only when the programme has genuinely DISTINCT sites — see the warning below |
   | **Opportunity** | the window and the funnel — totals, the rule, the aggregate | orients a stranger in one frame |
   | **Worker** | one row per worker, sorted by the measure that matters | the rung most often skipped, and the one that makes the next drill feel earned |
   | **Record** | the single item, and the rule that decided it | the peak: the thing no aggregate can show |
   | **Action** | the operator DOES something, and the outcome is on screen | **must be last** |

   **The programme rung is usually NOT available, and forcing it is worse than
   omitting it.** ACE mints a fresh Connect opportunity per run, so a program's
   opportunity list is mostly per-run duplicates of one pilot rather than
   distinct sites. Measured 2026-09-09: Connect program 210 carried EIGHT
   opportunities, all run-stamped copies of the same Spark pilot
   (`20260907-1120 · …`, `20260828-0703 · …`). A rollup over those shows one
   pilot eight times, which is the repetition the arc judge penalises directly.
   Check the opportunity NAMES before you plan a programme rung; if they are
   run-stamped, start the ladder at Opportunity.

   **Whatever the trailing commentary is — caveats, open parameters, what the
   pilot has not set — it goes in the FRAMING, not the finale.** It is honest
   and it belongs in the deck; it just cannot be the last thing. Measured on
   `spark-facilitator/20260909-1211`: the peak was scene 4 of 6, the one
   state-changing beat was scene 5, and scene 6 was the open-parameters recap.
   The judge: *"the run's strongest moment is scene 4 of 6, and both remaining
   scenes decline from it … scene 6 is prose-only with no data, delivering the
   payoff sentence over the run's emptiest screen. The finale-strength
   deduction is a hard cap at 3."* Every ingredient of a strong finale was
   already in that deck. **It was a reordering, not missing material.**

   `checkArcLadder` (`lib/demo-arc-ladder.ts`, `demo-data-setup-qa` check 20)
   enforces the floor of this — that the last scene performs a state change —
   and **it is deliberately weaker than the rule above.** It would have PASSED
   the run that motivated it, because that deck's recap scene technically
   clicked a disclosure control. Distinguishing "a click that reveals prose"
   from "a click that changes what the product knows" needs rendered frames and
   is the arc judge's job; a static heuristic for it would be the fourth
   retracted rule in this family. So the check catches a genuinely inert
   finale; the ladder above is what stops a recap finale, and that part is on
   you.

   **Putting the action LAST is necessary and NOT sufficient — the finale has to
   be strong in ABSOLUTE terms (ace#2347).** Measured: ordering the ladder
   correctly moved `spark-facilitator` +1.0 across all three judges (2.0 → 3.0,
   fail → warn) and unblocked the loop, and `arc_shape` **still capped at 3**.
   The judge validated the order and applied the cap anyway — *"The ladder is
   real and load-bearing … No two scenes could be swapped without breaking a
   dependency … That is 5-anchor structure. But the deduction rule 'the final
   scene is not the strongest moment' FIRES."* The cap measures how much the
   last frame DELIVERS, not where the peak sits.

   Two consecutive runs died on the same defect one dimension apart, and both
   redesign findings describe one shape: **a finale that performs a single
   instance of a rated activity, with no aggregate and no consequence.**

   | Run | Dimension | The judge's words |
   |---|---|---|
   | `20260909-1211` | `arc_shape` | the finale *"inherits that whole table unchanged and adds one line of text and one small chip"* |
   | `20260909-2242` | `use_case_soundness` | *"the page states the programme 'reviews at least one meeting in five in person' — roughly 35 of 173 records — and the walkthrough demonstrates exactly one review, producing an anonymous, undated chip, with no coverage measure against the 1-in-5 target anywhere on screen and no visible downstream consequence … A skeptical buyer watching the run's closing beat asks 'is that all it does?'"* |

   So author the finale against three rules, all three read off that text:

   1. **The action must produce something the previous frame did not already
      contain.** A reviewer *confirming* a decision the page already displays
      adds a chip and no information. A reviewer *contradicting* it — recording
      "needs a site visit" on a row the machine marked **Paid** — adds
      information, and it is usually the truer demonstration too: a two-layer
      verification design has a human layer precisely to catch what the
      automatic layer cannot, so a finale where the human agrees is a finale
      that never exercises the design.
   2. **If the page states a RATE for the activity, show the RATE, not one
      instance.** One review against a stated 1-in-5 target is the
      `use_case_soundness` litmus firing verbatim. Put the coverage beside the
      single act — "8 of the 35 reviews this window are done" — so the closing
      frame answers *"is that all it does?"* instead of inviting it.
   3. **The action must have a visible downstream consequence.** *"the record
      still earns nothing, and nothing connects the finding to any effect"* — a
      state change no one can see the effect of is a chip, not a payoff. Show
      what the finding changes: a payment released, a record queued for a visit,
      a counter moving.

   **This is authoring guidance, not a check, and deliberately so.** Whether an
   outcome is *new information* or a restatement is semantic and needs rendered
   frames; a static proxy for it would be the fourth retracted rule in this
   family (ace#1660 retracted, ace#1841 pruned). `checkArcLadder` enforces only
   the floor — that the last scene acts at all. Everything above is on the
   author, and the evidence that authoring guidance works here is the +1.0 the
   ladder itself produced.

   - `scenes[]` — each scene: `persona` (must exist in `personas`), `title`,
     `show`, `concept_claim` (≥5 words, falsifiable, NO banned marketing
     phrases), `provenance` (= a spine `id`), `role: demo`, ≥1 `feature` with
     non-empty `description` AND `verify`, `actions[]` (from the 17-verb
     vocabulary), and `url: ${<key>_par_url}` — the realized var for **that
     scene's dashboard** (`${program_admin_par_url}`, `${child_recovery_par_url}`,
     or a drill var). **Only the first scene on a given surface carries `url`** —
     consecutive same-`url` scenes reload the page (`hal:synthetic-walkthrough`
     anti-pattern); follow-on scenes on the same dashboard omit `url` and just
     act/capture. Crossing to a different dashboard = a new scene WITH its
     `${<key>_par_url}`.

3b. **Check every scene's ACTIONS before validating (ace#1379, #1380, #1660, #2219).**
   Run `checkSceneActions` from `lib/ddd-scene-actions.ts` over `scenes[]`,
   **and `checkSceneCardinality(scenes, shape)` from the same module** — the
   executable form of Step 2b, which re-reads the authored scenes rather than
   your intent. It emits two kinds, and it FLAGS rather than rejects, because it
   reads the data's shape but not the dashboard's rendering and so cannot be
   certain which population a surface enumerates — refusing a legal spec on that
   would be the ace#1238 guard-predicts-a-rejection failure. **A flag is
   therefore never carried past silently: resolve every one** by taking a Step-2b
   branch or by recording which population the surface actually lists.

   - **`insufficient-cardinality`** — the demonstration needs more than the data
     has. Take one of the two Step-2b branches.
   - **`unknown-cardinality`** — the axis is not in the handoff at all. That is
     the ace#1670 starting state; go get the number (§ Inputs names where), do
     not author past it.

   Three more ways a scene reports `ok: true` while demonstrating nothing — all
   found on ONE run, spark-facilitator/20260813-2126:

   - **`ambiguous-text-target`** — target the CONTROL, never the words. A
     `text:` selector resolves `.first()` in DOM order and **clicking a
     non-interactive node succeeds**, so the action reports ok while nothing
     happens. Scene 3's `click text:Needs a look` matched three nodes — a
     card-subtitle DIV, the real LABEL, a reconciliation-sentence DIV — and
     took the DIV. `record_video` reported *39 actions: all ok* on a frame
     showing the checkbox unchecked and "showing 20 of 20 facilitators". Use a
     recorder prefix — `css:` / `testid:` / `aria:` / `role:` (`role:` also
     takes a name: `role:button:Save`). The separator is `:`; canopy's
     `parse_target` has no `=` form, so `css=…` falls through to the
     bare-string heuristic — the ambiguity you were trying to escape
     (ace#1519).
   - **`non-discriminating-gate`** — a `wait_for` must name something only the
     POST state carries (a count, a status word, the new id). `wait_for
     text:Showing` was true before and after, so it could not fail.
   - **`mutation-without-restore`** — a click that creates or destroys a
     persistent object makes the scene non-idempotent. Scene 5's first render
     created coaching draft #5139; the next render found "Open draft #5139"
     instead, failed `target_not_found`, and captured the un-drafted state
     while the narration described a draft being written. Declare a
     `restore:` block — and note it must run before **every** render **and
     before every frame-fit pass**, because the verifier replays these same
     actions and so consumes the precondition for the render after it.

   The gate check is a WORD COUNT, so it only runs on `text:`/bare targets.
   A control-selector gate (`testid:` / `css:` / `aria:` / `role:`) is left
   alone — you have already named one element, and counting the words in its
   id cannot say whether it is post-state-only (ace#1660).

   **Retracted (ace#1660): there is no `scroll-under-fixed-header` check, and
   `scroll_to` needs no offset.** A fourth check used to flag every `scroll_to`
   without `offset: 96`. Both halves were wrong against canopy 0.2.423 and it
   is deleted — **do not re-add it, and never write `offset:` on an action**:

   - canopy's `ScrollToAction` declares only `kind` + `target`, and
     `_ActionBase` sets `extra="forbid"`, so `offset:` makes the spec FAIL
     validation (`Extra inputs are not permitted`). Following the old
     remediation turned a passing spec into one canopy refuses.
   - The premise was stale anyway. `recorder.py::scroll_to` chases
     `scroll_into_view_if_needed` with an explicit centring scroll
     (`window.scrollTo({top: y + scrollY - innerHeight / 2})`), so the element
     lands at the vertical CENTRE — no fixed bar reaches it. That was #1365's
     own fix, closed 2026-08-14.

   If a scene genuinely needs different framing, the levers canopy accepts are
   `scroll_to` (which names an element and lets the recorder centre it — the
   right answer nearly always), `scroll` (whose `value` takes `top` / `bottom` /
   a pixel offset), and a per-scene `viewport`. Which of those you reach for is
   the fourth defect class, below.

   **The fourth defect class**, on a different axis from the three above — the
   scene is well-formed and demonstrates the right thing, and **the frame
   nobody can read it in** (ace#2219):

   - **`pixel-scroll-framing`** — a `kind: scroll` carrying a raw pixel `value`
     decides how a judged still is framed, and a pixel offset is a guess about
     how a page this spec does not own renders. It is right for one viewport,
     one row count and one font stack, and reports nothing when it stops being
     right. `poverty-graduation/20260905-1345` used `kind: scroll` five times
     (`'400'`, `'1280'`, `'bottom'`, `'320'`, `'top'`) against one `scroll_to`;
     scene 5's landed a twelve-row table one row short, and row twelve — Umar
     Bello — rendered *"sliced through its middle at the bottom edge with its
     badge truncated mid-word"*, which the judge said *"spoils scene 6 without
     being readable"*, while the same scroll put the title, the simulated-data
     disclosure and all four KPI cards off the top. `projector_test: false` and
     `five_second_read_correct: false` on **7 of 7** scenes; the run ended at
     concept 2.0/5. **The remedy is `scroll_to` naming the element the frame is
     about** — canopy resolves and centres it live, so it holds at any page
     length. If the header block and the whole table cannot co-exist in one
     frame, split the beat into two scenes rather than compromising both. Park
     the cursor outside the content column before a hold, too: on the same run
     it occluded the chart subtitle in scene 2 and the header in scene 5.
   - `top` / `bottom` are **reported, not rejected**. They name a landmark the
     page defines and survive a layout change, but they decide only one edge of
     the frame — scene 4's `bottom` guillotined two histogram bars at the top
     edge, dropping their value labels and rendering bars differing by 140
     households at identical heights, while the panel the scene was about sat
     fully framed below. Right whenever the frame's subject IS the page's first
     or last content; confirm that it is.

   **This is NOT the retracted ace#1660 check, and it adds no `offset:`.** That
   check flagged `scroll_to` for LACKING an offset — the exact inverse. Here
   `scroll_to` is the remedy, written as canopy declares it: `kind` + `target`
   and nothing else. Worth saying because the judge's own remedy on this run
   reads *"offset so no partial histogram sits above it"*, which is the
   retracted syntax verbatim and makes the spec fail validation if followed.
   Run `checkScrollFraming` from `lib/demo-frame-legibility.ts` over the spec —
   `demo-data-setup-qa` check 14 is the backstop that runs it again.

   **Then judge the deck as a SEQUENCE, not scene by scene.** Run
   `checkSceneVariety` from `lib/demo-scene-variety.ts` over the same spec. The
   arc judge is the only lens in the DDD loop that can see repetition, and two
   of its five dimensions are capped by rules that are decidable from the scene
   table before anything is rendered:

   - **`visual_variety`** — *"more than half the scenes are the same surface at
     different scroll offsets"*.
   - **`escalation`** — *"two scenes showing the same surface with only a scroll
     between them"*.

   On `spark-facilitator/20260907-1120` both fired: 4 of 7 scenes were the
   payment ledger at four offsets, and scenes 2, 3 and 4 each followed the
   previous one with nothing but a scroll. The judge's verdict was that the run
   *"contains exactly two shapes across seven frames"*, and of scene 2 that *"the
   panel it narrates is already fully readable in scene 1's frame, so it adds
   voiceover, not a new thing to look at"*. Arc scored 2 of 5, `fail`.

   **The loop cannot recover from this and will stop rather than fix it** —
   collapsing or reordering scenes is a narrative change behind the
   `concept_change` gate, so an unattended run reports it and terminates
   `stopped_not_converged`. Catching it here costs one edit. Catching it after
   the render costs the phase.

   A scene that shows the viewer something the previous frame already contained
   is voiceover with a picture attached: fold it into the scene before it, or
   give it an action that changes what the page shows — a filter, a selection, a
   drill-in. `demo-data-setup-qa` check 17 is the backstop that runs this again.

   These are the halves decidable from the SPEC. The runtime halves —
   resolving an ambiguous target to the interactive node, comparing a gate
   against the captured before-frame, replaying restores — belong in
   canopy's walkthrough runner and are tracked upstream.

4. **Validate — the gate.** Resolve canopy's runtime from its installed
   plugin, then run the validator from there (pass the artifact paths as
   absolute paths — the subshell's cwd is the runtime, not yours):
   ```bash
   _CANOPY_PLUGIN="$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['canopy@canopy'][0]['installPath'])")"
   CANOPY_RT="$(bash "$_CANOPY_PLUGIN/scripts/canopy-runtime.sh")" || { echo "ERROR: canopy runtime not found — run /canopy:update"; exit 1; }
   (cd "$CANOPY_RT" && uv run python -m scripts.ddd.validate why_brief   <demo-run>/7-synthetic/why_brief.yaml)
   (cd "$CANOPY_RT" && uv run python -m scripts.ddd.validate unified_spec <demo-run>/7-synthetic/<demo-slug>.yaml)
   ```
   (Confirm the exact `<kind>` tokens from `validate()`'s dispatch on first use.)
   Exit `0` = valid. Loop: fix reported problems, re-validate, until BOTH pass.
   Do not hand off an unvalidated narrative.

5. **Write back** `narrative` refs + `steps.demo-narrative.status: done` via
   `mcp__plugin_ace_ace-gdrive__update_yaml_file` (`merge: 'deep'`).

## Gotchas

- **`concept_claim` is falsifiability-gated** by `ddd-spec-qa`: ≥5 words, no
  marketing filler ("seamless", "powerful", …). Write claims a skeptic could
  check against the on-screen dashboard.
- **Three overreach shapes that PASS the falsifiability gate and are still
  wrong** (ace#1395 — all three shipped in the same walkthrough, so the gate
  above is necessary and not sufficient). Each is checkable while writing:
  1. **Renaming the quantity.** The scene was titled *"What a verified
     community meeting costs"* and narrated *"what a funder buys here"*, over a
     panel headed **FACILITATOR EARNINGS**. A piece rate paid to facilitators
     is not the programme's cost: by the frame's own footnote every payment
     also passes a human reviewer, and the 56 recorded-but-unpayable records
     still consumed facilitator time. **Use the label the panel actually
     shows.** If you want the derived figure, render it as its own labelled row
     naming what it excludes — don't rename it in narration.
  2. **Causality from n=1.** The coaching-arc panel plotted eight weekly
     medians for ONE facilitator, no n per bar, no cohort baseline, and a
     bolded before/after conclusion. A reader is led to "the coaching caused
     this" from an uncontrolled single-subject pre/post. Either plot the cohort
     median behind it as a reference band (making the causal read testable) or
     lead with the claim the frame CAN carry — here, that the tolerance
     withheld no payment, evidenced by all four above-tolerance records reading
     `Paid · USD 3`.
  3. **A summary adjective that doesn't match the plotted series.** Narration
     said the weekly median *"sat in the low fifties across the three weeks
     before"*; the visible bars are **52.5 / 57.6 / 53.3**, and the page's own
     caption ("between 52.5 m and 57.6 m") was correct. This survived an
     explicit narration-correction pass that was supposed to read off the
     plotted series — so **read the rendered numbers, don't summarise from
     memory of the design**.
- **No build notes in funder-facing copy.** The integrity dashboard's
  methodology footnote shipped *"Every colour on this page is an inline style
  so that no compiled-CSS purge can silently blank a bar."* That is a note to
  ourselves about a rendering workaround, in a block a funder reads. Keep the
  practice; delete the sentence.
- **`provenance` must match a real spine `id`**, and every `demo`-role scene
  needs a `feature` with both `description` and `verify` — the actionability
  eval cold-derives a build plan from narration and checks it against
  `features[]`.
- **First-scene-only `url`** per surface (see Step 3).
- **This skill authors + validates only.** Rendering, judging, and video are the
  DDD loop's job, invoked by `agents/demo.md` after this skill returns.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-09-10 | **Step 3 refuses to copy a PINNED `render_reset.command` into `setup.command` (ace#2351).** The verbatim copy is the right contract — the handoff is the record — but it also means a command written as `/Users/<name>/.claude/plugins/cache/ace/ace/<version>/scripts/…` reaches canopy's per-render `subprocess.run(shell=True)` as a snapshot of one machine: the cache keeps old versions, so the path resolves to STALE code after every `/ace:update`, and another account cannot use it at all. On `spark-facilitator/20260909-2242` the copied string pinned 0.13.1413 (pre-ace#2325) and only a hand rewrite kept every render from failing `run-not-found`. Now: halt on `/plugins/cache/ace/ace/` or `/Users|/home/<name>/` and send the author back to `demo-data-setup` step 4b's self-resolving form; `demo-data-setup-qa` check 18 fails the same pin as `render_reset_command_pinned`. | ACE team |
| 2026-09-08 | **The spec's `setup` block is `rerun: per_render` and must RESET the interactive run, not just re-emit `realized.json` (ace#2297).** Step 3 said `rerun: once`, which skips the setup command whenever the outputs file exists — i.e. from the second render on. But recording MUTATES the world: the coaching task the payoff scene creates persists on the labs run, so the next take finds the button gone and its `must_succeed` click aborts. On `spark-facilitator/20260908-2215` iterations 0-2 passed only because a human had reset labs run 5508 by hand. The command now prefixes `source.render_reset.command` (`demo-data-setup` step 4b); both halves are enforced by `demo-data-setup-qa` check 18. | ACE team |
| 2026-09-06 | **Narrow the detection vocabulary: `marker` / `markers` are OUT (ace#1893).** They were the only NOUN forms in it, and a noun names a thing on the screen rather than an act the platform performs — so on `hh-poverty-targeting/20260901-1932` the payoff scene, a pure DECISION beat (*"A collection window ends in a disposition stored per worker"*), was flagged as an insufficient-cardinality detection demo on nothing but the word `marker`, used twice for a "recorded on this run" badge. The author renamed the noun to `badge` to get past the flag, which is exactly the cost the module warns about (*"inventing a demonstration costs the author's trust in every flag after it"*). Measured over all 10 unified specs in Drive (4 opps, 10 runs, 59 scenes): 26 scenes match the detection vocabulary, **24 carry a verb form**, and only 2 match on `marker` alone — the same scene in two revisions of one narrative. **Spec-level recall is unchanged, 8 specs flagged before and after**, because every spec with a noun-only scene also has a verb-form one. The two narrower repairs the issue proposed were measured and rejected: requiring a corroborating second vocabulary word is bit-identical to deletion (24/26), and exempting `features[].verify` is strictly worse (23/26) — it does not clear the false positive, whose other hit is in `show`. The ace#1841 widening to `show` / `concept_claim` / `features[]` STAYS: ablating it took the same spec from 6 findings to 0. | ACE team |
| 2026-08-29 | Add a FOURTH demonstration verb — **detection / flagging**, on the `rows` axis with its own higher floor of **24** (`DETECTION_MIN_ROWS`, two screenfuls of the 12-row anchor the filter floor already uses): a filter claims narrowing is meaningful, a detection claims unaided scanning is not viable, and the second is false the moment the cohort fits in one look. `checkSceneCardinality` also now reads a scene's `show`, `concept_claim` and `features[]` alongside its title and action targets — measured on the failing spec, the detection vocabulary appears 20+ times and in not one title, so the verb alone would have matched nothing. The finding names the axis with room, because that is the action. `hh-poverty-targeting/20260828-0702` authored a detection demo over a seven-worker cohort; the gate returned ok with zero findings and the concept judge said post-render that a manager could find the outlier by eye, ending the loop `stopped_not_converged` at concept 2.0 after four iterations. ace#1841. | ACE team |
| 2026-08-26 | Add the dataset's cardinality as an INPUT (`source.record_counts` + `source.data_shape`) and a pre-authoring shape check (Step 2b) with a per-verb minimum — `rows` 12 for filter/search/sort, `periods` 4 for a trend, `groups` 3 for a comparison — enforced by `checkSceneCardinality` in `lib/ddd-scene-actions.ts` at Step 3b. Flags rather than rejects (the rule reads the data's shape but not the dashboard's rendering, so it cannot be certain which population a surface enumerates — ace#1238), but every flag must be resolved. `bednet-check-2-visit/20260825-1310` authored a filter demonstration over a five-worker cohort; every existing gate reported green and the concept judge caught it four render iterations later, ending the loop `stopped_not_converged` at concept 3.0. ace#1670. | ACE team |
