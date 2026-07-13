---
name: training-deck-render
description: >
  Render a training deck spec.yaml into a Google Slides deck via the
  14-stencil ACE template. Produces a presentable Slides URL.
disable-model-invocation: true
---

# Training Deck Render

Reads `training-deck-spec.yaml` from Drive, validates it, resolves the
manifest, copies the template, and executes the Slides batchUpdate
pipeline. Single-pass (no speaker notes).

## When to run

Phase 6 (`qa-and-training`), after `training-deck-generate`. The last
training material step before Phase 7.

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| Phase 6 (`training-deck-generate`) | `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-deck-spec.yaml` | The spec to render |

## Inputs (env)

- `ACE_TRAINING_DECK_TEMPLATE_ID` — the 14-stencil Slides template.

## Process

1. **Read** `training-deck-spec.yaml` from the run's
   `6-qa-and-training/` folder.

2. **Parse and validate** via `parseTrainingSpec(yamlStr)` — halt on
   validation error.

3. **Resolve manifest** via `resolveManifest(spec.manifest)`.

4. **Check image aliases.** Verify all image aliases used in
   `walkthrough` / `mobile_flow` / `web_screen` / `mobile_zoom` /
   `two_column` slides are resolvable against the manifest. HALT if
   any are unresolvable — do not render a partial deck.

5. **Verify env.** Confirm `ACE_TRAINING_DECK_TEMPLATE_ID` is set.
   HALT if missing with a clear error.

6. **Copy template.** Call `slides_copy_template` with:
   - `templatePresentationId`: `ACE_TRAINING_DECK_TEMPLATE_ID`
   - `title`: `"<opp-name> — Training Deck"`
   - `parentFolderId`: the run's `6-qa-and-training/` folder ID

7. **Discover stencil objectIds.** Call `slides_get` on the copied
   deck. Verify all 14 stencils are present (match against the
   `STENCILS` constant). HALT if any missing.

8. **Build requests.** Call
   `buildSlidesRequestsV2(spec, { stencils, manifest })`.

9. **Execute.** Call `slides_batch_update` — single call with all
   requests.

10. **Write deck handoff** to `run_state.yaml`:

    ```yaml
    phases:
      qa-and-training:
        products:
          training:
            deck:
              file_id: <presentationId>
              title: "<opp-name> — Training Deck"
              web_view_link: <url>
              slide_count: <N>
              rendered_at: <ISO timestamp>
    ```

    Multi-writer block (sibling slots are the five training doc
    skills' `docs.<key>` entries) — apply via read-modify-write
    following the canonical pattern in
    `skills/synthetic-data-generate/SKILL.md § Step 6` so sibling
    sub-keys are preserved. See `agents/qa-and-training.md § Products`
    for the full slot table.

11. **Print deck URL** for operator.

## Pre-flight checks

Before rendering:
- All Drive fileIds in manifest must be shared `anyone-with-link`. Use
  `drive_set_anyone_with_link` on each. (Slides image import won't
  work without this.)
- Template must exist and be accessible by the SA.

## Self-eval

Three criteria:

1. **Slide count**: Rendered deck slide count matches total slides in
   spec. FAIL if mismatch.
2. **Image resolution**: All images in the spec resolved successfully
   (no `createImage` errors). FAIL if any failed.
3. **API success**: `slides_batch_update` completed without error.
   FAIL if error.

Verdict to
`ACE/<opp>/runs/<run-id>/6-qa-and-training/training-deck-render_verdict.yaml`
in the standard shape (see `lib/verdict-schema.ts`).

### Post-render sweep: leftover decorative ellipse (pre-fix template)

The CURRENTLY-MINTED template still contains a 6×6pt decorative ELLIPSE
on the `walkthrough` stencil (and `mobile_zoom` — same Dimagi source
page), cloned from the source slide and missed by the original
bootstrap strips. Fresh renders from that template inherit it as a
stray blue dot on every walkthrough-derived slide until the template is
re-minted via the (now-fixed) `scripts/bootstrap-training-deck-template.ts`.
Until then, after rendering: `slides_get` the deck, filter pageElements
with `isDecorativeLeftover` (`lib/training-deck-stencil-geometry.ts` —
ELLIPSE rendered ≤ 12pt in both dimensions), and issue one
`slides_batch_update` of `deleteObject` requests for the matches. The
in-place re-render script (below) already runs this sweep automatically
when it rebuilds stencils, so re-rendered decks self-clean.

## Output

- Google Slides deck in the run's `6-qa-and-training/` folder
- `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-deck-render_verdict.yaml`
  per standard verdict shape
- Handoff written to `run_state.yaml`

## Same-link re-render

For a deck that has already been shared at a stable URL and needs
regeneration (e.g. new screenshots after a capture unblock), do NOT
copy the template again — that mints a new presentationId and breaks
the shared link. Use the in-place re-render script instead
(dimagi-internal/ace#864):

```bash
npx tsx scripts/rerender-training-deck-in-place.ts \
  --deck <presentationId> \
  --spec <new-spec.yaml> \
  --old-spec <spec.yaml that produced the CURRENT slides> \
  [--key <gws-sa-key.json>]
```

- `--old-spec` is required: it must be the spec that rendered the
  deck's CURRENT slides — stored in the run's `6-qa-and-training/`
  folder as the deck-spec doc. The script derives each live slide's
  layout from it and HALTS if the live slide count differs (the deck
  was hand-edited; reconcile first).
- Safety property: the old slides are deleted ONLY after the new
  render batch succeeds — a failed render leaves the shared deck
  intact.
- Stencil text-box geometry comes from
  `lib/training-deck-stencil-geometry.ts` (single source, shared with
  the bootstrap script), so re-rendered stencils match the template.

## Error handling

- If `ACE_TRAINING_DECK_TEMPLATE_ID` not set: emit verdict `skipped`
  with reason. Don't FAIL.
- If spec validation fails: emit verdict `failed` with Zod error
  details.
- If `slides_batch_update` fails: emit verdict `failed` with API
  error.

## MCP Tools Used

- `ace-gdrive`:
  - `drive_read_file` (read the spec YAML)
  - `drive_set_anyone_with_link` (pre-flight image sharing)
  - `slides_copy_template` (copy the template into the opp folder)
  - `slides_get` (discover stencil objectIds)
  - `slides_batch_update` (render all slides in one call)

## Mode Behavior

- **Auto:** Run end-to-end, write the deck, update state, return URL.
- **Review:** Pause after step 8 (requests built). Show request
  count + slide count, let operator inspect before executing. Resume
  on approval.
- **Dry-run:** Steps 1-8 only, skip the copy/batchUpdate calls. Write
  a verdict with `dry_run: true` and a count of slides that would be
  created.

## Products

- The Google Slides deck itself (in Drive)
- `run_state.yaml.phases.qa-and-training.products.training.deck` —
  `{file_id, title, web_view_link, slide_count, rendered_at}` typed
  handoff (multi-writer block; sibling `docs.*` slots written by the
  five training doc skills)
- `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-deck-render_verdict.yaml`
  — standard verdict shape (see `lib/verdict-schema.ts`); `passed:`
  true if parse + batchUpdate succeeded

## Change Log

- v1: Initial skill. Replaces `training-deck-build`. Reads
  `training-deck-spec.yaml` (from `training-deck-generate`) instead
  of `training-deck-outline.md`. Single-pass render via
  `buildSlidesRequestsV2` against 14-stencil template. No speaker
  notes pass.
