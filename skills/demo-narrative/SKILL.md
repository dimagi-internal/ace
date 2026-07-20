---
name: demo-narrative
description: >
  Author a funder-tuned canopy DDD narrative (WhyBrief + UnifiedSpec) on top of
  a demo-data-setup realized map, with scenes that render the live labs
  dashboard (par_url). Validated by canopy's own scripts.ddd.validate — the
  authoritative gate. Hands off to the DDD loop.
disable-model-invocation: true
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
| `demo-data-setup` | `<demo-run>/7-synthetic/realized.json` | `par_url` + drill vars the scenes render |
| `demo-data-setup` | `run_state…products.synthetic.source` | provider, labs opp id, deliver units |
| Discovery | canopy checkout path | `uv run python -m scripts.ddd.validate` (default `/Users/jjackson/emdash-projects/canopy`; see `docs/superpowers/plans/2026-07-20-plan-a-task1-findings.md`) |

## Products

- `<demo-run>/7-synthetic/why_brief.yaml` — the `WhyBrief`
- `<demo-run>/7-synthetic/<demo-slug>.yaml` — the `UnifiedSpec`
- `run_state.yaml…products.synthetic.narrative` — `{ why_brief_ref, unified_spec_ref, validated: true }`
- `run_state.yaml…steps.demo-narrative.status: done`

## Process

1. **Read the schema, not this doc.** Open canopy `scripts/narrative/models.py`
   (or the JSON Schemas) for the exact `WhyBrief`, `UnifiedSpec`, `Scene`,
   `Feature`, `Persona`, `SetupBlock` fields + required/optional split. Mirror
   the working reference at `~/emdash/repositories/connect-labs/docs/walkthroughs/
   program-admin-report.yaml` (a labs-dashboard walkthrough with a `setup` block
   and `url: ${par_url}` scenes) — it is the closest template.

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
     color, intro, org`.
   - `why_brief` — embed / reference the Step 2 brief.
   - `setup: { command: <regenerate-realized.json command>, outputs: "realized.json", rerun: once }`.
     The `command` must (re)produce `realized.json` for the render session. For
     denovo Plan A this re-invokes `demo-data-setup` in ensure mode; **confirm
     idempotency live in the joint test** (if `demo-data-setup` regenerates
     rather than reuses, either add an ensure mode or set the command to emit the
     already-written `realized.json`).
   - `scenes[]` — each scene: `persona` (must exist in `personas`), `title`,
     `show`, `concept_claim` (≥5 words, falsifiable, NO banned marketing
     phrases), `provenance` (= a spine `id`), `role: demo`, ≥1 `feature` with
     non-empty `description` AND `verify`, `actions[]` (from the 17-verb
     vocabulary), and `url: ${par_url}` (or a drill var). **Only the first scene
     on a given surface carries `url`** — consecutive same-`url` scenes reload
     the page (`hal:synthetic-walkthrough` anti-pattern); follow-on scenes on the
     same surface omit `url` and just act/capture.

4. **Validate — the gate.** From the canopy checkout:
   ```
   cd <canopy> && uv run python -m scripts.ddd.validate why_brief   <demo-run>/7-synthetic/why_brief.yaml
   cd <canopy> && uv run python -m scripts.ddd.validate unified_spec <demo-run>/7-synthetic/<demo-slug>.yaml
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
