# General Video-Spec Generator — Design Spec

**Date:** 2026-06-09
**Status:** Approved (autonomous), implementing
**Spans:** ACE plugin (`skills/video-spec-generate`, `skills/video-spec-eval`) + ace-web (template shape) + connect-videos (templates)

---

## 1. Problem

Each video template ships a `generate.prompt.md` (525–1,905 words). Comparing
them: **~70% is identical boilerplate** — the grounding rule is the same
sentence, the per-beat word-budget tables are the *same numbers*, the brand
voice / clip-picking / output-format sections repeat verbatim. The generator
(`video-from-program-page`) and the eval (`video-spec-eval`) both load that
prose prompt as their load-bearing context, and the generator is hardcoded to
one template id.

The genuinely template-specific signal is small and already (or nearly)
structured:
- **Which beats exist** → the skeleton (`spec.template.yaml`).
- **Word budgets** → derivable from beat seconds (`programs/_defaults.yaml`).
- **The narrative thesis** ("what this video is *for*") → the template metadata
  (description / intended_audience / when_to_use) — now editable structured
  fields.
- **Special structure** → only partnership-pitch's 3 narrative angles, which are
  already `narration.variants[]` in its skeleton.

## 2. The shift

Replace per-template prose prompts with **one general generator skill that
ingests the template's structured data + a short intent**, deriving the rest.

### The template's new contract (what the general skill reads)
1. **meta** — name, country_focus default, status, intended_audience,
   when_to_use, and a **new `intent`** field: 1–3 sentences naming what the
   video must accomplish and its narrative thesis (the irreducible per-template
   framing, lifted from each prompt's "what makes it good" section).
2. **skeleton** (`spec.template.yaml`) — structure + `{{placeholders}}`. The
   skill reads which beats/sections/placeholders are present (incl. whether
   `problem`/`impact` stat beats exist → whether numbers are in play, and
   whether `narration.variants[]` exists → multi-angle).
3. **example** (`example.spec.yaml`) — a reference of *good* filled output
   (few-shot exemplar).
4. **derived word budgets** — computed from beat seconds (~2.5 words/sec),
   not hand-authored per template.

`generate.prompt.md` becomes **optional**: dropped as the primary mechanism;
if present it is an advanced per-template override appended after the universal
body. (Kept in the repo as historical reference; new templates need none.)

## 3. `skills/video-spec-generate` (the general generator)

Generalizes `video-from-program-page`. Inputs: `template_id`, a `source`
(program-page URL, brief text, or prospect research), `workspace_slug`,
`program_slug`, optional `gdrive_folder_id`. Universal skill body owns the
shared ~70%:
- **Grounding rule** — never invent stats/claims; the no-numbers clause is
  conditional on whether the skeleton carries `problem`/`impact` beats.
- **Brand voice** — Connect documentary register + the banned-word list.
- **Per-beat word budgets** — derived from beat seconds (a single table the
  skill computes, not per-template).
- **Clip-picking** from the media library (`GET …/library/video`).
- **Placeholder fill → substitute into skeleton → validate no `{{` remains →
  POST `/programs`** + provenance.
- **Multi-angle**: if the skeleton has `narration.variants[]`, generate one
  `by_beat` per angle (angle theses come from the template's intent / a
  structured `angles` block); else a single `by_beat`.

The per-template signal it consumes (not authored in the skill): **intent +
meta + skeleton + example**. So one skill serves every template; adding a
template needs no new prompt — just meta+intent+skeleton+example.

`video-from-program-page` becomes a thin wrapper (source = a Connect program
URL, template defaulting to `60s-campaign-overview`).

## 4. ace-web framework changes

- **`TemplateMeta`** (+ `schemas`, `_parse_meta`, cache): add `intent: str`.
  Bundle + list endpoints return it. Backward compatible (default "").
- **Template editor**: an **Intent** field in `TemplateMetaPanel` (short
  textarea); the **Generate prompt** panel becomes "Advanced — optional
  override" (collapsed) since the general skill no longer needs it.
- **Seed**: each template's `template.yaml` gains an `intent:` key; existing
  Drive `_templates` get it via the reflow/parse path (empty until re-seeded or
  edited). Bump the template cache key (v3).

## 5. `video-spec-eval` — prompt-independent

Replace step "load `generate.prompt.md` for voice + budget anchors" with:
- Voice anchors live **in the eval rubric itself** (the universal Connect
  register — already largely there in dimension 1).
- Word budgets **derived from beat seconds** (same formula as the generator).
- Per-template fitness anchor = the template's **intent** + the **example** as
  the "what good looks like" reference.
- Keep the 6 dimensions + inflation guard. Honor the **out-of-chain fitness**
  principle (`_eval-template.md`): the intent is a thin same-chain anchor, so
  Source Fidelity (graded against the *real source page*, an out-of-chain
  anchor) stays the highest-signal dimension and must not be inflated.

## 6. The 10-run eval-and-improve loop

1. **Fixed harness:** generate a spec from a chosen template + a fixed real
   source (e.g. `60s-campaign-overview` from a live Connect program page, or
   `connectify-program` from a fixed brief) — **10 independent generations**.
2. **Eval each** with `video-spec-eval` (6 dims → overall + verdict).
3. **Aggregate:** mean/spread per dimension; the recurring lowest dimensions
   and concrete weaknesses across the 10.
4. **Improve** the generator universal body + the eval rubric to address the
   top-2 recurring weaknesses (e.g. tighten a budget, sharpen a voice anchor,
   add a few-shot cue). Re-run for ≥1 more round; compare aggregate scores.
5. **Document** the runs, the deltas, and the final skill changes.

Wins recorded by mean overall score across the 10 and by the weakest-dimension
floor (story is "raise the floor," not "raise the average").

## 7. Out of scope / deferred
- Server-side CLI generation endpoint (`POST /from-source`) — the skill stays
  agent-run for now.
- Fully structuring partnership-pitch's narrative library into its own
  versioned files (the angles stay in the skeleton + intent for v1).
- Removing the historical `generate.prompt.md` files from the repo (kept as
  reference; just no longer required).
