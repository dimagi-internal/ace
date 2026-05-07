---
name: training-deck-build
description: >
  Render training-deck-outline.md into a Google Slides deck using the
  ACE template. Produces a presentable Slides URL.
disable-model-invocation: true
---

# Training Deck Build

Turn the markdown `training-deck-outline.md` (produced by the
`training-deck-outline` skill) into a real Google Slides deck the LLO
can present or use as a recording source. The skill does NOT generate a
video — that's a separate skill, planned but not implemented.

## When to run

After `training-deck-outline` has written its artifact for the
opportunity. Typically the last step of Phase 5 (`qa-and-training`),
before LLO onboarding in Phase 8.

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| Phase 5 (`training-deck-outline`) | `ACE/<opp>/runs/<run-id>/5-qa-and-training/training-deck-outline.md` | parsed via `parseDeckOutline` |
| Phase 5 (`app-screenshot-capture`) | `ACE/<opp>/runs/<run-id>/5-qa-and-training/app-screenshot-capture_manifest.yaml` | screenshot fileId resolution for `drive:` image refs by alias |
| Common assets | `ACE/_common/connect-screenshots/<v>/manifest.yaml` | same, for cross-opp screenshots |

## Inputs (env)

- `ACE_TRAINING_DECK_TEMPLATE_ID` — Slides template the skill copies.
  Created once via `scripts/bootstrap-training-deck-template.ts`.
- `ACE_DRIVE_ROOT_FOLDER_ID` — root for `ACE/<opp>/` paths.

If `ACE_TRAINING_DECK_TEMPLATE_ID` is empty, fail with a clear pointer
to the bootstrap script and the README. The skill does NOT auto-create
the template — that's a one-time operator action so the template stays
under human control.

## Process

1. **Read** `5-qa-and-training/training-deck-outline.md` from Drive.
   If missing, fail with a hint to run the `training-deck-outline`
   skill first.

2. **Parse** the outline via `parseDeckOutline` in `lib/training-deck-spec.ts`.
   The parser is strict — a malformed outline (missing `# Title`, a
   section that doesn't start with `## Slide:`) throws with a clear
   message. Do not silently skip malformed sections.

3. **Resolve image refs.** For each `BodyBlock` of kind `image`:
   - `drive:<fileId>` refs are passed through unchanged. The
     `createImage` request will use
     `https://drive.google.com/uc?export=view&id=<fileId>`.
   - `https://...` URLs are passed through unchanged.
   - `screenshot:<alias>` refs (planned, not yet implemented in the
     parser) would resolve via the screenshot manifest — emit a clean
     "unknown ref scheme" error if encountered.

   **CRITICAL:** every Drive fileId used by `createImage` MUST be
   shared `anyone-with-link` (role: reader). Slides' `createImage`
   fetches the URL via Google's image-import service, NOT via the
   caller's auth — even though the SA owns the file, Slides itself
   needs HTTPS read access. Without this permission, `createImage`
   returns "image cannot be reached" and the slide ends up with no
   image. `app-screenshot-capture` should set this permission at
   upload time; this skill must verify it before building the request
   stream and warn loudly (or set the permission inline) if any
   referenced fileId is SA-only. Verified live 2026-05-02 via
   `scripts/test-screenshot-to-slides-e2e.ts`.

4. **Copy the template.** Call `slides_copy_template` with:
   - `templatePresentationId`: from `ACE_TRAINING_DECK_TEMPLATE_ID`
   - `title`: `<opp> — Training Deck`
   - `parentFolderId`: the opp's `5-qa-and-training/` folder
   Capture the new `presentationId` and `webViewLink`.

5. **Discover stencil objectIds.** Call `slides_get` on the new
   presentation. Slides preserves objectIds across `drive.files.copy`,
   so `ace_stencil_title` and `ace_stencil_content` should be present.
   Verify both — if either is missing, fail with a hint to re-run the
   bootstrap script (someone edited the template and broke the
   stencils). Capture each slide's `notesPage.notesProperties.speakerNotesObjectId`
   for the speaker-notes pass.

6. **Build the main batch.** Call `buildSlidesRequests(spec, { stencils })`.
   Apply the returned `mainRequests` via a single `slides_batch_update` call.

7. **Re-fetch** the presentation via `slides_get`. The duplicateObject
   requests in the main batch produced new slides whose
   speakerNotesObjectIds we now need to discover. Build a map
   `{ slideObjectId → speakerNotesObjectId }` from the response.

8. **Apply speaker notes** via `buildSpeakerNotesRequests` + a second
   `slides_batch_update`.

9. **Write a state-trail entry** to `run_state.yaml` under the opp:
   ```yaml
   training_deck:
     presentation_id: <new id>
     web_view_link: <url>
     template_id: <ACE_TRAINING_DECK_TEMPLATE_ID>
     built_at: <ISO timestamp>
   ```

10. **Print the deck URL** to the operator. The LLO admin opens it,
    optionally tweaks branding/wording, and uses Slides' native
    Present + Record (or just shares the URL with the LLO directly).

## MCP Tools Used

- `ace-gdrive`:
  - `drive_read_file` (read the deck-outline markdown)
  - `slides_copy_template` (copy the template into the opp folder)
  - `slides_get` (discover stencil + notes object IDs)
  - `slides_batch_update` (the main fill-in batch and the speaker-notes batch)
  - `drive_create_file` (write `run_state.yaml` updates if needed)

## Mode Behavior

- **Auto:** Run end-to-end, write the deck, update state, return URL.
- **Review:** Pause after step 6 (main batch applied). Show the URL,
  let the operator inspect the deck visually before applying speaker
  notes. Resume on approval.
- **Dry-run:** Parse + buildSlidesRequests, but skip the
  copy/batchUpdate calls. Write a verdict with `dry_run: true` and a
  count of slides that would be created. Useful for CI checks.

## Outputs

- The Google Slides deck itself (in Drive)
- `ACE/<opp>/run_state.yaml` updated with `training_deck:` block
- `ACE/<opp>/runs/<run-id>/5-qa-and-training/training-deck-build_verdict.yaml` — standard verdict shape
  (see `lib/verdict-schema.ts`); `summary.deck_url` set; `passed:` true if
  parse + both batchUpdates succeeded

## Failure modes (and their prevention)

- **Slides API not enabled on the GCP project** → bootstrap script
  fails fast with the enable-URL Google returns. Fix once per project.
- **Template lacks stencil objectIds** → step 5 fails with a clear
  re-bootstrap hint.
- **Template was edited to remove `{{TITLE}}` / `{{BODY}}` tokens** →
  the replaceAllText requests in step 6 silently no-op for that token.
  Detect by counting non-zero `replyCount` in the batchUpdate response;
  fail if any of the expected tokens didn't replace anywhere.
- **Drive image at `drive:<id>` is not readable by the SA** → the
  `createImage` request fails with a clear permission error. The skill
  surfaces this as a per-image failure, doesn't bail the whole deck.

## Iteration: improving the template over time

The template lives in Slides; iterate it there. Things you can change
freely:
- Theme colors, fonts, slide background
- Logo placement, footer text, page numbers
- Position/size of the title and body text boxes
- Speaker-notes formatting

Things you must NOT change without coordinating a code update:
- Stencil objectIds (`ace_stencil_title`, `ace_stencil_content`)
- Placeholder tokens (`{{TITLE}}`, `{{SUBTITLE}}`, `{{BODY}}`)
- The presence of exactly two stencil slides (no more, no fewer in v1)

If you add a new stencil (e.g., `ace_stencil_image_full`), update
`STENCIL_*_OBJECT_ID` constants in `lib/training-deck-spec.ts` and
extend `buildSlidesRequests` to emit a request matching the new
stencil's role.

## Change Log

- v1 (0.10.71): Initial skill. Two stencils (title, content). Image
  refs via `drive:<fileId>` or HTTPS URL. Speaker notes via two-pass
  batchUpdate.
