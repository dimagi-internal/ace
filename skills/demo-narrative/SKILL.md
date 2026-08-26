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
   - `setup: { command: <regenerate-realized.json command>, outputs: "realized.json", rerun: once }`.
     The `command` must (re)produce `realized.json` for the render session. For
     denovo Plan A this re-invokes `demo-data-setup` in ensure mode; **confirm
     idempotency live in the joint test** (if `demo-data-setup` regenerates
     rather than reuses, either add an ensure mode or set the command to emit the
     already-written `realized.json`).
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

3b. **Check every scene's ACTIONS before validating (ace#1379, #1380, #1660).**
   Run `checkSceneActions` from `lib/ddd-scene-actions.ts` over `scenes[]`.
   Three ways a scene reports `ok: true` while demonstrating nothing — all
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

   If a scene genuinely needs different framing, the only levers canopy accepts
   are `scroll` (whose `value` takes `top` / `bottom` / a pixel offset) and a
   per-scene `viewport`.

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
