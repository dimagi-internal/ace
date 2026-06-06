---
name: partnership-deck-build
description: >
  Fill the connect-pitch-partnership deck spec from prospect research + picked
  angle, render to Google Slides via the 14-stencil machinery. Use in the
  produce phase after partnership-video-build.
disable-model-invocation: true
---

# Partnership Deck Build

Builds a `connect-pitch-partnership` Google Slides pitch deck for a prospect organization, mirroring the arc of the picked video angle. Fills the `spec.template.yaml` skeleton following `generate.prompt.md`, validates the spec parses via `parseTrainingSpec`, renders to Slides using the 14-stencil ACE template machinery, and saves the Slides URL into `package.yaml`. Combines the generate + render steps that are split across `training-deck-generate` and `training-deck-render` — justified because the pitch deck has a fixed ~10–12 slide shape with no per-opp screenshot manifest dependency (unlike the training deck's dynamic per-app screenshot capture).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 profile | `ACE/partnerships/<slug>/prospect.yaml` | Prospect name, slug, logo ref, region, sector |
| `partnership-research` | `ACE/partnerships/<slug>/research/deep-research.md` | Cited problem/impact stats for their-world + business-case slides |
| `partnership-research` | `ACE/partnerships/<slug>/research/connect-fit.md` | Connect capability claims for thesis + how-connect-works slides |
| `partnership-angles` | `ACE/partnerships/<slug>/runs/<run-id>/angles.yaml` | Chosen angle arc; deck must mirror the video arc |
| `run_state.yaml` | `phases.angles.products.selected_angle` | Active angle id |
| `partnership-microdemo` | `ACE/partnerships/<slug>/runs/<run-id>/micro-demo/provenance.yaml` | Micro-demo screenshot alias(es) for the proof module |
| Plugin repo | `templates/training-deck/connect-pitch-partnership/` | Template bundle: `template.yaml`, `spec.template.yaml`, `generate.prompt.md` |
| Env | `ACE_PARTNERSHIP_DECK_TEMPLATE_ID` (falls back to `ACE_TRAINING_DECK_TEMPLATE_ID`) | 14-stencil Slides template |
| Previous step | `ACE/partnerships/<slug>/runs/<run-id>/package.yaml` (if exists) | Existing package entries to preserve during deck URL merge |

## Products

- `ACE/partnerships/<slug>/runs/<run-id>/deck_spec.yaml` — filled `TrainingDeckSpec` YAML (machine-parsed; via `drive_create_file`)
- `ACE/partnerships/<slug>/runs/<run-id>/package.yaml` — updated with `deck.slides_url`, `deck.presentation_id`, `deck.slide_count` (merged into existing package.yaml if present; via `drive_create_file`)
- Google Slides deck in the run's folder (in Drive)
- `ACE/partnerships/<slug>/runs/<run-id>/run_state.yaml` — Phase Write-Back: `phases.deck-build.*`

## Process

1. **Resolve inputs and check preconditions.**

   Read `ACE/partnerships/<slug>/runs/<run-id>/run_state.yaml` via `drive_read_file`. Check `phases.microdemo.verdict` — if `fail` or `incomplete`, halt with: "partnership-deck-build requires a passing partnership-microdemo run. Check `phases.microdemo.verdict` in run_state.yaml."

   Check `phases.angles.products.selected_angle` for the active angle id. If absent, halt with: "phases.angles.products.selected_angle not set — run partnership-angles with a picked angle before deck build."

   Check env: `TEMPLATE_ID = ACE_PARTNERSHIP_DECK_TEMPLATE_ID || ACE_TRAINING_DECK_TEMPLATE_ID`. If neither is set, halt with: "Neither ACE_PARTNERSHIP_DECK_TEMPLATE_ID nor ACE_TRAINING_DECK_TEMPLATE_ID is set — set one and retry."

2. **Read the template bundle from the plugin repo.**

   Read three files from `templates/training-deck/connect-pitch-partnership/` via local Read (repo checkout):
   - `template.yaml` — template metadata (id, archetype, expected slide count)
   - `spec.template.yaml` — spec skeleton with `{{PLACEHOLDER}}` tokens
   - `generate.prompt.md` — filling instructions (arc rules, grounding rules, layout selection, token reference)

3. **Read the run artifacts from Drive.**

   Read via `drive_read_file`:
   - `ACE/partnerships/<slug>/prospect.yaml` → extract `name`, `slug`, `logo_asset` (or null), `region`, `sector`.
   - `ACE/partnerships/<slug>/runs/<run-id>/angles.yaml` → extract the angle entry matching `selected_angle`; capture its `logline`, beats arc (`hook`, `cycle`, `handoff`, `scene`, `problem`, `product`, `impact`), and `primary_capability`.
   - `ACE/partnerships/<slug>/research/deep-research.md` → extract the two strongest cited problem and impact statistics (each must have a source citation — prefix any unsourced value with `[TBD] `).
   - `ACE/partnerships/<slug>/research/connect-fit.md` → extract the top fit signals and recommended Connect entry archetype.
   - `ACE/partnerships/<slug>/runs/<run-id>/micro-demo/provenance.yaml` → extract `clips[]` entries; build an opp manifest map `{ alias -> drive:<file_id> }` for each clip that is `is_demo_clip: true`. If no demo clips are flagged, build an empty manifest and note it — the proof module will fall back to `content` layout.

4. **Build the `deck_spec.yaml` following `generate.prompt.md`.**

   Fill every `{{TOKEN}}` in `spec.template.yaml` using the artifacts from steps 2–3. Follow the module-by-module instructions and arc coherence rules in `generate.prompt.md` exactly:

   - **Identity tokens:** `PROSPECT_SLUG`, `PROSPECT_NAME` (≤28 chars for cover stencil), `PROGRAM_NAME`, `GENERATED_AT`, `RESEARCH_DOC_ID` (set to the Drive fileId of `deep-research.md` — the provenance anchor), `RUN_ID`, `LANGUAGE`, `DATE`, `DURATION` (12).
   - **Manifest tokens:** `COMMON_MANIFEST` = `{}` (no common screenshot pool for prospect pitches); `OPP_MANIFEST` = the opp manifest map built in step 3 (or `{}` if empty).
   - **Module content:** fill per the arc of the chosen angle — `their-world` in the angle's framing, `thesis-divider` naming the angle's core tension, `thesis-content` mirroring the angle's capability lean, `proof` module using the first demo-clip `@alias` if the manifest is non-empty (else layout `content`), `business-case` using only cited stats from the research doc.

   **Grounding enforcement (non-negotiable — prospect-facing deck):**
   - Every cited stat must trace to `deep-research.md` or `connect-fit.md`. Invented or unsourced stats must be prefixed `[TBD] `.
   - Only Dimagi/Connect/CommCare brand names. Do not invent partner org names, program histories, or geography.
   - Only use `@alias` keys that exist in the opp manifest. If a proof screenshot is unavailable, switch the micro-demo slide to `content` layout and note it in the slide's `notes:` field.
   - No `[TBD]` in any slide `title` or `body` field — if a value cannot be grounded, rephrase in prose without the figure rather than leaving a placeholder. (Exception: stats slides where the number is explicitly missing from the research — acceptable to use `[TBD] <what's missing>` there and surface a WARN in the inline QA verdict.)

   Validate the fully-filled YAML parses via the `parseTrainingSpec` rules (mentally check):
   - `archetype: partnership-pitch` present.
   - `voice.audience: prospect` present.
   - `source.pdd_doc_id` set to the actual fileId (not a placeholder).
   - All `{{...}}` tokens replaced.
   - Every slide has a non-empty `title` and `notes` (50–150 words, second person, addressed to the presenter).
   - Total slide count in 10–12 range.

5. **Write `deck_spec.yaml` to Drive via `drive_create_file`.**

   Parent folder = the run folder (`ACE/partnerships/<slug>/runs/<run-id>/`). File name: `deck_spec.yaml`. Use `drive_create_file` (NOT `drive_create_doc_from_markdown` — that creates a Google Doc which mangles YAML on read-back). Capture the returned `file_id` and `web_view_link`.

6. **Inline spec validation.**

   Parse the written YAML back mentally (or re-read it via `drive_read_file`) and confirm:
   - No `{{` tokens remain in any string field.
   - All `@alias` image refs in the spec exist in the opp manifest (or the slide has been switched to `content` layout).
   - `archetype: partnership-pitch`, `voice.audience: prospect`, `source.pdd_doc_id` set.
   - Slide count is 10–12.

   If any check fails, fix the spec, overwrite `deck_spec.yaml` via `drive_create_file`, and re-validate. Halt if still failing after one fix attempt — surface the failed checks.

7. **Pre-flight: share all image assets.**

   For each `drive:<fileId>` value in the opp manifest, call `drive_set_anyone_with_link` to ensure the Slides `createImage` import will succeed. (Slides image import requires publicly accessible URLs — this is the same pre-flight used by `training-deck-render`.)

8. **Copy the Slides template.**

   Call `slides_copy_template` with:
   - `templatePresentationId`: `ACE_PARTNERSHIP_DECK_TEMPLATE_ID` if set, else `ACE_TRAINING_DECK_TEMPLATE_ID`
   - `title`: `"<prospect name> — Connect Partnership Pitch"`
   - `parentFolderId`: the run folder ID

   Capture the returned `presentationId` and `webViewLink`.

9. **Discover stencil objectIds.**

   Call `slides_get` on the copied presentation. Walk the slides array and match each slide's `objectId` against the `STENCILS` constant values (`ace_stencil_cover`, `ace_stencil_section`, `ace_stencil_content_v2`, etc. — all 14 keys from `lib/training-deck-spec.ts`). Build a `stencils: Record<StencilKey, string>` map.

   Verify all 14 stencils are present. Halt if any are missing — the copied template is corrupt or the wrong template ID was used.

10. **Build Slides requests.**

    Call `buildSlidesRequestsV2(spec, { stencils, manifest })` from `lib/training-deck-spec.ts`:
    - `spec` = the parsed `TrainingDeckSpec` from step 6
    - `stencils` = the objectId map from step 9
    - `manifest` = the `ResolvedManifest` from `resolveManifest({ opp: opp_manifest_map })` (common = `{}` for prospect pitches)

    This emits the full sequence: one `duplicateObject` + layout-specific `replaceAllText` + `createImage` requests per slide, then `updateSlidesPosition` reorders, then `deleteObject` removes all 14 stencils.

11. **Execute the batch update.**

    Call `slides_batch_update` with all requests from step 10 — single call. Capture success/failure.

12. **Merge `deck.slides_url` into `package.yaml`.**

    Read the existing `package.yaml` from the run folder via `drive_read_file` (if it exists). Merge in the deck block:

    ```yaml
    deck:
      presentation_id: <presentationId>
      slides_url: <webViewLink>
      slide_count: <total slides in spec>
      rendered_at: <ISO timestamp>
    ```

    Write the merged YAML back via `drive_create_file` (find-or-update by name `package.yaml` in the run folder). Preserve all existing keys (especially `video.*` from `partnership-video-build`).

13. **Inline QA (binary — run before writing the phase write-back).**

    Verify all of the following. Record which pass and which fail — the write-back is ALWAYS written regardless of outcome:

    - **`spec_parses`**: `deck_spec.yaml` written with no `{{` tokens and `archetype: partnership-pitch`.
    - **`deck_rendered`**: `slides_batch_update` returned success; `presentationId` captured.
    - **`url_captured`**: `package.yaml` contains non-null `deck.slides_url`.
    - **`no_tbd_in_titles`**: no `[TBD]` token in any slide `title` field across all modules (prospect-facing surface).
    - **`slide_count_in_range`**: total slide count is 10–12.
    - **`arc_mirrored`**: the chosen angle id matches `selected_angle` from `run_state.yaml` and the `their-world` / `thesis-divider` slides reflect that angle's framing (not another angle's arc).

14. **Write the Phase Write-Back to `run_state.yaml`** (always — both pass and fail paths).

    Write `phases.deck-build.*` to `ACE/partnerships/<slug>/runs/<run-id>/run_state.yaml` via `update_yaml_file` with `merge: 'deep'` (a partial nested patch of `phases.<phase>` requires `deep` — `two-level` silently drops sibling keys; see CLAUDE.md § Gotchas):

    **QA pass path** (`verdict: pass`):
    ```yaml
    phases:
      deck-build:
        status: done
        verdict: pass
        completed_at: <ISO timestamp>
        summary_artifact: deck_spec.yaml
        steps:
          preconditions_checked: done
          template_bundle_read: done
          artifacts_read: done
          spec_built: done
          spec_written: done
          spec_validated: done
          image_assets_shared: done
          template_copied: done
          stencils_discovered: done
          requests_built: done
          batch_update_executed: done
          package_merged: done
          inline_qa: done
          write_back: done
        products:
          deck_spec_file_id: <file_id>
          deck_spec_url: <web_view_link>
          presentation_id: <presentationId>
          slides_url: <webViewLink>
          slide_count: <N>
          tbd_count: <count of [TBD] tokens in spec outside slide titles>
          angle_id: <selected_angle>
    ```

    **QA fail path** (`verdict: fail`): write the write-back first, then halt with the failed check names surfaced.
    ```yaml
    phases:
      deck-build:
        status: incomplete
        verdict: fail
        completed_at: <ISO timestamp>
        summary_artifact: deck_spec.yaml
        steps:
          preconditions_checked: done
          template_bundle_read: done
          artifacts_read: done
          spec_built: done
          spec_written: <done|fail>
          spec_validated: <done|fail>
          image_assets_shared: <done|fail>
          template_copied: <done|fail>
          stencils_discovered: <done|fail>
          requests_built: <done|fail>
          batch_update_executed: <done|fail>
          package_merged: <done|fail>
          inline_qa: fail
          write_back: done
        products:
          deck_spec_file_id: <file_id or null>
          deck_spec_url: <url or null>
          presentation_id: <presentationId or null>
          slides_url: <url or null>
          slide_count: <N or null>
          tbd_count: <count>
          angle_id: <selected_angle>
        qa_failures:
          - <failed-check-name>
    ```

    After writing the write-back on the fail path, halt with an actionable operator error naming the failed checks.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `ACE_PARTNERSHIP_DECK_TEMPLATE_ID` | (optional) | Dedicated pitch-deck Slides template; falls back to training template |
| `ACE_TRAINING_DECK_TEMPLATE_ID` | (required if above unset) | The 14-stencil Slides template used by training-deck-render |

## MCP Tools Used

- `ace-gdrive`:
  - `drive_read_file` (read prospect.yaml, angles.yaml, deep-research.md, connect-fit.md, micro-demo/provenance.yaml, run_state.yaml, package.yaml)
  - `drive_create_file` (write deck_spec.yaml and package.yaml — NOT `drive_create_doc_from_markdown`)
  - `drive_set_anyone_with_link` (pre-flight: share each demo-clip image asset before Slides import)
  - `slides_copy_template` (copy the 14-stencil template into the run folder)
  - `slides_get` (discover the 14 stencil objectIds post-copy)
  - `slides_batch_update` (render all slides in one call)
  - `update_yaml_file` (phase write-back to run_state.yaml with `merge: 'deep'`)

## Mode Behavior

- **Auto:** Run all steps, build spec, render deck, save artifacts, write phase write-back, stop.
- **Review:** Pause after step 6 (spec validated) — show the spec's module summary (module ids + slide counts) and the inline QA result. Resume on operator approval before executing the Slides render.

## Dry-Run Behavior

When `--dry-run` is active:
- Read inputs normally (read-only operations are safe in dry-run).
- Build the spec in memory normally (steps 1–6).
- Write `deck_spec.yaml` to Drive normally (human-facing artifact; safe to write in dry-run).
- Skip `drive_set_anyone_with_link`, `slides_copy_template`, `slides_batch_update` (external render side effects).
- Write `package.yaml` with `deck.slides_url: null`, `deck.presentation_id: dry-run`, `deck.render_status: dry-run`.
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-06-06 | Initial version. Builds + renders connect-pitch-partnership deck spec. Mirrors training-deck-generate + training-deck-render render atom sequence. Inline QA: spec_parses, deck_rendered, url_captured, no_tbd_in_titles, slide_count_in_range, arc_mirrored. merge: deep write-back. Phase write-back: phases.deck-build.*. | ACE team |
