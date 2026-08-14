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
- **`provenance` must match a real spine `id`**, and every `demo`-role scene
  needs a `feature` with both `description` and `verify` — the actionability
  eval cold-derives a build plan from narration and checks it against
  `features[]`.
- **First-scene-only `url`** per surface (see Step 3).
- **This skill authors + validates only.** Rendering, judging, and video are the
  DDD loop's job, invoked by `agents/demo.md` after this skill returns.
