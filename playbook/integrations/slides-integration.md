# Slides integration

How ACE produces Google Slides decks — Slides API atoms, the
training-deck skills (`training-deck-generate` → `training-deck-render`),
the template lifecycle, and the durable-knowledge gotcha record. The
partnership pitch deck (`partnership-deck-build`) uses the same atoms.

## Overview

`training-deck-generate` writes a structured deck spec
(`training-deck-spec.yaml`, parsed by `parseTrainingSpec` in
`lib/training-deck-spec.ts`) from the PDD, app summaries and screenshots;
`training-deck-render` copies the stencil template and fills it into a
Google Slides deck the LLO admin can edit and present. Neither needs a
run beyond its inputs — re-rendering a live program's deck after an app
change is the same two calls.

The Slides path uses three atoms in `mcp/google-drive-server.ts`,
mirrored after the `docs_*` family. The build path is template-based:
operator (or the bootstrap script) creates a Slides template once;
each per-opp deck is `drive.files.copy(template) → batchUpdate fill`.

## Running the MCP server

The Slides atoms ship in the same `ace-gdrive` MCP server as the
Drive/Docs/Sheets atoms. The `https://www.googleapis.com/auth/presentations`
scope is in the `SCOPES` list. No separate startup; once `ace-gdrive`
is wired in `.claude-plugin/plugin.json`, the Slides atoms are
available.

## Capability map

### Three Slides atoms

| Atom | Backend | Purpose |
|---|---|---|
| `slides_get` | Slides API | Read full structured presentation JSON. Use to discover stencil objectIds + speakerNotes shape IDs. |
| `slides_batch_update` | Slides API | Execute raw batchUpdate requests (createSlide, replaceAllText, createImage, duplicateObject, deleteObject, etc.). |
| `slides_copy_template` | Drive API | Copy a Slides template into a Shared-Drive folder. Mirrors `docs_copy_template`. Returns presentationId + webViewLink. |

### One bootstrap script

| Script | Purpose |
|---|---|
| `scripts/bootstrap-training-deck-template.ts` | One-time per environment. Creates the ACE training-deck template with two stencil slides (`ace_stencil_title`, `ace_stencil_content`) and `{{TITLE}}` / `{{SUBTITLE}}` / `{{BODY}}` placeholder tokens. Idempotent — re-running with an existing template prints the existing ID. |

### Pure-helper modules

`lib/training-deck-spec.ts` (no I/O, unit-tested) parses and lints the
spec (`parseTrainingSpec`, `lintDeckFormatting`, `bodyFit`);
`lib/training-deck-frames.ts` picks screenshot frames;
`lib/training-deck-stencil-geometry.ts` holds stencil geometry. The
batchUpdate request stream is built by `buildSlidesRequestsV2`.
- `buildSpeakerNotesRequests(notes, idMap)` — second-phase batch for
  speaker notes

### Two end-to-end smokes

| Script | Proves |
|---|---|
| `scripts/test-deck-build-smoke.ts` | Synthetic content: 5-slide deck with bullets, paragraphs, speaker notes (no images). |
| `scripts/test-screenshot-to-slides-e2e.ts` | Real device output: AVD → Maestro → PNG → Drive → Slides deck with the embedded image. **The actual end-to-end demo.** |

## Template lifecycle

The template is the source of all branding (fonts, colors, logo,
slide-master typography). Iterate it as a Google Slides edit, NOT a
code change. Two stencils, both with well-known objectIds:

- `ace_stencil_title` — title slide with `{{TITLE}}` and `{{SUBTITLE}}`
  placeholder text boxes.
- `ace_stencil_content` — content slide with `{{TITLE}}` (top) and
  `{{BODY}}` (mid) text boxes. Images get layered into the lower
  body area at runtime via `createImage`.

Both stencil objectIds + the three placeholder tokens are
load-bearing. They're declared as constants in
`lib/training-deck-spec.ts`:

```typescript
export const STENCIL_TITLE_OBJECT_ID = 'ace_stencil_title';
export const STENCIL_CONTENT_OBJECT_ID = 'ace_stencil_content';
export const PLACEHOLDER_TITLE = '{{TITLE}}';
export const PLACEHOLDER_SUBTITLE = '{{SUBTITLE}}';
export const PLACEHOLDER_BODY = '{{BODY}}';
```

If you change any of these in the template, you MUST update
`lib/training-deck-spec.ts` to match. Otherwise `replaceAllText`
silently no-ops and the deck comes out with raw placeholder tokens
visible.

The template ID is in `ACE_TRAINING_DECK_TEMPLATE_ID`, a value stored in
ACE's Canopy vault on canopy-web (Settings → Credentials). Every
environment runs the bootstrap script once and stores its own template
ID in its vault.

## Gotchas (the durable-knowledge section)

These are the things that bit live and now have either code-level
preventers or doc-level guards.

### `slides.presentations.create` returns PERMISSION_DENIED for Service Accounts

The Slides API's `presentations.create` always writes to My Drive
root and has no `parents` field. Service Accounts can't write to My
Drive — not just zero-quota, *no create permission*. Returns
`PERMISSION_DENIED` (HTTP 403).

**The route that works:** `drive.files.create({ mimeType:
'application/vnd.google-apps.presentation', parents:
[sharedDriveFolder] })`. The deck lands directly in the Shared Drive
in one call. Then `slides.presentations.get` to discover the
auto-generated initial slide objectId before the stencil-setup
batchUpdate.

Used by `bootstrap-training-deck-template.ts` and
`test-deck-build-smoke.ts`. The MCP atom `slides_copy_template` doesn't
hit this path because it uses `drive.files.copy`, which inherits
parents from the call args. Live-verified 2026-05-02 via
`scripts/probe-slides-create-via-drive.ts`.

### `createImage` requires anyone-with-link sharing

**The biggest gotcha in this integration.** Slides' `createImage`
fetches the image URL via Google's image-import service, NOT via the
caller's auth. Even though the Service Account owns the file, Slides
itself needs HTTPS read access. Without it, `createImage` returns
"image cannot be reached" silently and the slide ends up blank — no
error in the batchUpdate response, no signal in `slides.get`, just
an empty slide where the image should be.

**The fix is at upload time:**

```typescript
await drive.files.create({ requestBody: { name, parents }, media: {...} });
await drive.permissions.create({
  fileId,
  requestBody: { role: 'reader', type: 'anyone' },
  supportsAllDrives: true,
});
```

`app-screenshot-capture` sets this permission for every uploaded PNG.
`training-deck-render` should verify the permission before building the
request stream and either fix it inline or fail loudly.

Live-verified 2026-05-02 via `scripts/test-screenshot-to-slides-e2e.ts`.
The verification step counts embedded images in the resulting deck —
catches the silent failure mode that previous synthetic smokes missed.

### `slides_create_presentation` does not exist as an MCP atom

Earlier drafts shipped a `slides_create_presentation` atom that called
`slides.presentations.create` directly. It was replaced with
`slides_copy_template` (Drive API copy) once the SA permission gotcha
above surfaced. `bootstrap-training-deck-template.ts` does its own
`drive.files.create` inline.

If you find yourself wanting "create a brand-new empty deck from MCP",
the answer is: copy the template instead. There is no per-opp
use case for an empty deck in the ACE pipeline today.

### `notesPage.notesProperties.speakerNotesObjectId` is assigned lazily

When you `createSlide` (or `duplicateObject` of a stencil), Slides
doesn't return the speakerNotesObjectId of the new slide in the
batchUpdate response. You must `slides.presentations.get` afterward
to discover it. That's why `buildSlidesRequests` returns
`{ mainRequests, speakerNotes }` separately, and the orchestrating
skill dispatches two batches:

1. Main batch (replaceAllText + duplicateObject + createImage +
   deleteObject)
2. Discover speakerNotesObjectId per slide via `slides.get`
3. Speaker-notes batch (insertText against the discovered IDs)

`buildSpeakerNotesRequests` formalizes phase 3.

### Stencil objectIds are preserved across `drive.files.copy`

This is a documented Slides API guarantee — `objectId`s are preserved
on copy "if there are no collisions, otherwise new IDs are assigned."
Since each per-opp deck is a fresh copy into an empty target context,
collisions don't happen. That's why the build code can hard-reference
`ace_stencil_title` / `ace_stencil_content` after copy without
re-discovering them.

The `training-deck-render` skill should still verify both stencils
exist via `slides.get` after copy (defensive — catches operator
edits that broke the template). If either is missing, fail with a
hint to re-run the bootstrap script.

### `drive.files.delete` returns 404 even on existing Shared Drive files

Service Accounts can `list` and `read` files on the Shared Drive but
get a 404 from `delete` — not "no permission", "no such file."
Confirmed via `scripts/cleanup-smoke-decks.ts`: the same files visible
in `drive.files.list` return "File not found" on `delete`.

**The workaround:** `drive.files.update({ fileId, requestBody:
{ trashed: true } })` — moves to trash, which has different perm
semantics and works. `cleanup-smoke-decks.ts` falls back to this path
on any 404 / 403 from `delete`.

### `mainRequests` order matters

The build code emits requests in this order:

1. `replaceAllText` `{{TITLE}}` on title stencil
2. `replaceAllText` `{{SUBTITLE}}` on title stencil
3. For each parsed slide: `duplicateObject(content_stencil)` →
   `replaceAllText({{TITLE}}, ...)` →
   `replaceAllText({{BODY}}, ...)` →
   `createImage(...)` (if any image blocks)
4. `deleteObject(content_stencil)` — last, after all duplicates exist

If you re-order any of these, two failure modes appear:

- `deleteObject` before `duplicateObject` → all subsequent duplicates
  fail (no source object).
- `replaceAllText` *unscoped* (no `pageObjectIds`) before per-slide
  `duplicateObject` → the stencil's tokens get replaced first, then
  every duplicate inherits the resolved text — every slide in the
  deck shows the title of slide N (whichever ran first).

`buildSlidesRequests` always uses `pageObjectIds: [duplicateId]` to
scope per-slide replacements. Don't bypass that.

## Invocation chain (Phase 6 of a build)

Inside `/ace:run` the deck is produced in Phase 6. Outside a run, start
at step 3 with the inputs in hand.

1. `app-test-cases` — produces walkthrough recipes
2. `app-screenshot-capture` — runs recipes against AVD, uploads PNGs
   to Drive **with anyone-with-link permission**
3. Five text-artifact skills in parallel:
   - `training-llo-guide`
   - `training-flw-guide`
   - `training-quick-reference`
   - `training-faq`
   - `training-deck-generate`
4. `training-deck-render` — sequential after `training-deck-generate`.
   Skipped if `ACE_TRAINING_DECK_TEMPLATE_ID` is unset.
5. `training-onboarding-email` — last, links to all other docs by URL.

`training-deck-render` is non-blocking (Phase 7 doesn't depend on the
Slides deck — `onboarding-email-body.md` is the load-bearing Phase 7
input).

## Pre-flight checklist for a fresh environment

Before the first Phase 6 in a new GCP project / ACE instance:

- [ ] **Slides API enabled** on the GCP project. First call to
      `slides.presentations.get` returns the enable URL if not. One-click
      browser fix; propagates in ~1 minute.
- [ ] **`ACE_TRAINING_DECK_TEMPLATE_ID` set.** Run
      `npx tsx scripts/bootstrap-training-deck-template.ts`, store the
      ID as `ACE_TRAINING_DECK_TEMPLATE_ID` in ACE's Canopy vault,
      then `/ace:setup --force-env` and restart Claude Code. `bin/ace-doctor` reports PASS or WARN.
- [ ] **Service Account scopes include `presentations`.** Verified by
      `mcp/google-drive-server.ts` `SCOPES` constant.
- [ ] **Run the smoke** to verify all atoms work end-to-end:
      `npx tsx scripts/test-deck-build-smoke.ts`. Should produce a
      5-slide deck in `ACE_DRIVE_ROOT_FOLDER_ID` named
      `Smoke <timestamp>`. Trash via `scripts/cleanup-smoke-decks.ts`.
- [ ] **Run the screenshot smoke** to verify the full chain on real
      device output: `npx tsx scripts/test-screenshot-to-slides-e2e.ts`.
      Requires AVD booted with CommCare 2.62.0 installed
      (mobile-bootstrap done).

## Sibling docs

- `playbook/integrations/mobile-integration.md` — AVD + Maestro
- `playbook/integrations/ocs-integration.md` — OCS chatbot
- `playbook/integrations/connect-api.md` — Connect platform
- `playbook/integrations/nova-integration.md` — CommCare app builder

## Change log

- v1 (0.10.91): Initial. Captures the four critical Slides gotchas
  (SA can't create directly, createImage needs anyone-with-link,
  speakerNotes lazy, delete returns 404), the template lifecycle, the
  pre-flight checklist, and the Phase 6 invocation chain. Drawn from
  the 0.10.78–0.10.90 build cycle.
