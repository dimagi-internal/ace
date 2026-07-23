---
name: narrative-iteration-review
description: >
  Orchestrate one iteration of a Connect DDD narrative on domain-expert feedback — the THIN,
  ACE-specific layer over canopy's DDD framework. Pull the verbatim current narration from canopy,
  draft the proposed next version from the expert's feedback, derive the connect-labs build
  implications, and route the proposed version into canopy's DDD review surface. Versioning, the
  review surface, and the narration-edit round-trip are canopy's job — do NOT reimplement them.
  Use when iterating a Connect DDD narrative on expert feedback (e.g. RF Surveys / Sophie).
---

# Narrative iteration review (ACE-thin over canopy DDD)

**DRY boundary — read first.** The canopy DDD framework already owns:

- **Versioned narratives** — a canopy `ReviewRequest` carrying a `narrative_slug` *is* a narrative
  version (`version` monotonic per slug); the lineage + every version's `story` live in canopy
  (`apps/reviews`, `apps/runs`).
- **The review surface + narration-edit round-trip** — `POST /reviews/` opens a review; `POST
  /reviews/<id>/submit/` ingests a human's **narration edits** + decisions; `/review/<id>` hosts it.
- **The narrative-agreement gate** — canopy's `ddd-narrative-review` posts a narrative version for
  approve / redraft.

So this skill is deliberately THIN. **ACE brings only what is ACE-specific:** (1) drafting the
proposed next-version narration from a domain expert's feedback, and (2) the **connect-labs build
implications** the narration changes imply. Everything else is delegated to canopy. **Never build a
parallel review surface** (e.g. minting Google Docs + parsing suggestion-mode edits) as the durable
path — that is the DRY violation this skill exists to avoid.

## Procedure

1. **Pull the verbatim current narration from canopy** (the source of truth — NOT the
   `docs/walkthroughs/<slug>.yaml` scene-spec, which drifts; NOT reconstructed audio):
   ```
   GET https://labs.connect.dimagi.com/canopy/api/ddd/narratives/<slug>/
   Authorization: Bearer <canopy PAT>      # ~/.claude/canopy/workbench-token
   ```
   → `current_version.version` (N) and `current_version.story`, plus `versions[]` (the lineage).
2. **Draft the proposed next version (N+1) — ACE-specific.** Rewrite the narration to fold in the
   expert's points and honor any locked decisions (e.g. keep an agreed term, a chosen design steer).
   Beats are **not 1:1**: feedback may add/merge/reorder beats. It is a **new version in the lineage**
   (vN → vN+1), never a "fork".
3. **Derive the connect-labs build implications — ACE-specific.** List the real product changes the
   new narration implies (labels, UI, data). This is ACE/labs domain and stays here.
4. **Route into canopy's DDD review surface — delegate.** Open the narrative-agreement (`concept_change`)
   review carrying the proposed version, via the canopy `ddd-narrative-review` skill or directly:
   ```
   POST /canopy/api/reviews/    (PAT)   body: { request_json: { run_id, gate: "concept_change",
                                                 narrative_slug, <current + proposed narration> },
                                               visibility: "private" | "link" }
   ```
   canopy assigns vN+1 and returns `/review/<id>/`. It owns the review surface + the internal-reviewer
   narration-edit round-trip.
5. **Read submitted edits from canopy** — the review's `response_json` (via `GET /reviews/<id>/`),
   fold them into the proposed version, iterate. Do not parse a side-channel document.

## Producing the video = fire the FULL `canopy:ddd` loop (it BUILDS the product)

Once a new version is agreed, **making its video is the full `canopy:ddd` loop, not a render of the
existing screens.** DDD is *demo-DRIVEN development*: the agreed narration drives you to **build the
product changes it implies** (new UI, data, flows), validate them live, and only THEN record. The
build phase is the whole point — the "D" in DDD.

- **Unbuilt product is the loop's work, NOT a blocker.** If the new narration references affordances
  that don't exist yet, that is the DDD build backlog to work through — fire the loop and build them.
  Do **not** treat "product not built" as a terminal blocker, render over the old screens (that ships
  claim-reality incoherence the dual-judge will fail), or bail with "blocked."
- **Fire `canopy:ddd` — do NOT hand-assemble a `narrative-iteration-review` → `ddd-ace-render`
  pipeline.** That bespoke path is only the *render tail* and has **no build phase**, so it silently
  amputates the product iteration. `ddd-ace-render` alone is correct ONLY when the narration implies
  zero product change (pure re-record over already-built screens).
- **Gates when the story is already signed off:** `concept_change` is pre-approved (resolve
  in-session; never block on a canopy-web UI poll — DDD HITL gates hang any non-interactive run);
  `external_release` stays OFF until an act-tier operator approves.
- **Build cleanly:** work in a fresh git worktree off `origin/main` (the shared checkout drifts +
  goes dirty across parallel runs), **validate the affordances live before recording** (ACE's
  close-the-loop-to-source-of-truth discipline), and ship the product changes as a **PR** — never
  deploy live-uncommitted.

(Origin: Jon, 2026-07-23, RF Surveys — three narratives were run through a bespoke author-version +
render pipeline; the one narrative that needed new product read as "blocked" instead of "in
development," because the pipeline had no build phase. "The whole point of doing the DDD loop is that
you iterate on the product to improve it." Sharpens jjackson/ace#909.)

## Known canopy gaps (tracked — do NOT work around them in ACE)

`canopy-web#290` tracks the two DDD-framework improvements that make this fully DRY:

1. **Domain-expert before/after presentation** — a plain-language vN→vN+1 review view a non-engineer
   can scan/comment on (today's DDD review screens are too complicated for a subject-matter reviewer).
2. **External (non-dimagi) reviewer edit path** — `submit_review` requires a dimagi login, so an
   external expert (e.g. `@dimagi-associate.com`) can read a link-visibility review but can't submit
   edits. canopy should provide a tokenized external-edit path, or a canopy-generated review doc it
   ingests.

**Interim external-expert bridge (temporary, explicitly labelled):** until `canopy-web#290` lands, an
external expert's language review may be collected in a one-off shared doc. Treat it as a disposable
bridge for that round only — it is NOT this skill's durable mechanism, and the fix belongs in canopy,
not here. When the bridge is used, say so and link the issue.

## Gotchas

- **canopy `story` is the source of truth** for the current narration — the scene-spec and stale
  render specs drift from the shipped video.
- **Iterations, not forks.** New version in the same lineage; canopy assigns the number.
- **Submit is dimagi-gated.** External reviewers can't submit to canopy today (see `canopy-web#290`).
- **Don't rebuild canopy in ACE.** Versioning, review hosting, and edit ingestion are canopy's. If you
  reach for Google Docs + `docs_get` suggestion parsing as the mechanism, stop — that's the anti-pattern.
