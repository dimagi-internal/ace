---
name: partnership-microdemo
description: >
  Source the micro-demo proof clip(s) for the picked partnership angle —
  reuse existing Connect/ace-web media where it matches, else build a
  lightweight tailored mock — with provenance.
disable-model-invocation: true
---

# Partnership Micro-Demo

Source one or more short (~20-30s) proof clips that credibly show the picked angle's `product` beat in action for a specific prospect. The skill is adaptive: it checks the ace-web media library for a reusable clip first, and falls back to a lightweight tailored mock only when no suitable clip exists. Provenance is recorded per clip so the eval and the downstream video-build skill know exactly what they're working with. This is the first produce-phase skill — it runs after the operator picks an angle and before the video spec is filled.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| `partnership-angles` | `ACE/partnerships/<slug>/runs/<run-id>/angles.yaml` | Selected angle's `product` beat intent and `primary_capability` |
| Phase 1 profile | `ACE/partnerships/<slug>/prospect.yaml` | Program type, sector, target geography — drives media-library query |
| Operator selection | `run_state.yaml.phases.angles.products.selected_angle` | Which angle was picked (set by the orchestrator at the gate) |
| Env | `ACE_WEB_PAT_TOKEN`, `ACE_WEB_BASE`, `WORKSPACE_SLUG` (default `dimagi-team`) | ace-web media library auth + base URL + workspace |

## Products

- `ACE/partnerships/<slug>/runs/<run-id>/micro-demo/provenance.yaml` — machine-parsed clip manifest: one entry per clip with `source`, `origin`, `caption`, `is_demo_clip`
- `ACE/partnerships/<slug>/runs/<run-id>/micro-demo/<clip-file>` — the sourced or mocked clip file(s) uploaded to Drive
- `ACE/partnerships/<slug>/runs/<run-id>/run_state.yaml` — Phase Write-Back: `phases.microdemo.*`

## Process

1. **Read the selected angle's product beat intent and prospect context.**

   Read from Drive via `drive_read_file`:
   - `ACE/partnerships/<slug>/runs/<run-id>/angles.yaml` → find the angle matching `selected_angle` → extract its `beats.product` intent and `primary_capability`.
   - `ACE/partnerships/<slug>/prospect.yaml` → extract `sector`, `target_geography`, `name`.

   Read `run_state.yaml` via `drive_read_file` and confirm `phases.angles.verdict` is `pass` (or `warn`). If `fail` or `incomplete`, halt with: "partnership-microdemo requires a passing partnership-angles run. Check `phases.angles.verdict` in run_state.yaml."

   Derive the **clip specification** from the `product` beat intent: what screen, what flow, what capability does the beat need to show? This is the search query and the mock brief.

2. **REUSE FIRST — query the ace-web media library.**

   Call the ace-web media library endpoint via Bash/curl:

   ```bash
   curl -sS \
     -H "Authorization: Bearer $ACE_WEB_PAT_TOKEN" \
     "$ACE_WEB_BASE/api/w/$WORKSPACE_SLUG/videos/library/video"
   ```

   (`$ACE_WEB_BASE` defaults to `https://labs.connect.dimagi.com/ace`; `$WORKSPACE_SLUG` defaults to `dimagi-team`.)

   Scan the returned entries for a clip that matches the clip specification: same program type (Learn/Deliver/Verify/Pay), same capability shown, similar sector. A clip is a **good match** when:
   - Its `capability_tags` or `description` overlaps the `primary_capability` of the picked angle.
   - The sector shown is the same as (or close to) the prospect's sector.
   - The clip is ≤ 45s (longer clips cannot fit a 20-30s product beat).

   If a good match exists: record its `ref` (the library's canonical identifier), mark `source: reuse`, and proceed to step 4.

   If no good match exists, or the library returns an error, proceed to step 3.

3. **MOCK (lightweight, ~20-30s) — build a tailored proof clip.**

   Choose the mock method based on what the `product` beat requires:

   **Option A — Nova app stub + canopy walkthrough (preferred when the beat requires a Connect workflow):**

   Dispatch `/nova:autobuild` (a level-0 Agent dispatch from the orchestrator) with a minimal brief derived from the clip specification: a single-module CommCare app with the one form or case list the beat needs to show. Keep the build to the minimum that makes the product beat credible — not a full ACE build. Capture the `nova_app_id`.

   Then dispatch `canopy:walkthrough` (also a level-0 Agent dispatch) to film a short walkthrough of the stub. Record only the product beat's flow. The output is a short clip file (MP4 or webm) + a screenshot.

   **Option B — Connect-styled clickable mock filmed headless via gstack browse (preferred when the beat shows a simple Connect-mobile screen):**

   Navigate to a live Connect demo environment (or a Connect home screen) via gstack `browse`. Take a screenshot or record the relevant screen. The gstack `browse` tool is the capture mechanism — not an MCP atom. Keep it to one or two screens.

   In both cases: keep the clip to 20-30s. Credibility matters more than polish — the clip only needs to make the product beat visually plausible, not tell the full story.

4. **Upload the clip file(s) to Drive and write `provenance.yaml`.**

   Ensure the `micro-demo/` subfolder exists in the run folder via `drive_create_folder` with `findOrCreate: true` (parent = the `runs/<run-id>/` folder).

   Upload each clip via `drive_upload_binary` (use `localFilePath` for video files to avoid ferrying large bytes through context). Record the returned Drive `file_id`.

   Write `provenance.yaml` via `drive_create_file` (NOT `drive_create_doc_from_markdown` — this is a machine-parsed YAML file that must land as plain text, not a Google Doc). The structure:

   ```yaml
   prospect_slug: <slug>
   run_id: <run-id>
   angle_id: <selected_angle>
   generated_at: <ISO timestamp>
   clips:
     - clip_id: clip-001
       source: reuse | mock
       origin: >        # library ref (reuse) OR mock method (nova-stub+walkthrough / gstack-browse-screen)
         <library ref or mock description>
       file_id: <file_id>
       caption: >       # one sentence describing what the clip shows (used as product beat caption)
         <caption>
       is_demo_clip: true
       mock_method: nova-stub+walkthrough | gstack-browse-screen | null   # null when source: reuse
   ```

5. **Inline QA (binary — run before writing the phase write-back).**

   Verify all of the following. Record which checks pass and which fail — the write-back is ALWAYS written regardless of outcome:

   - **`at_least_one_clip`**: at least one clip entry exists in `provenance.yaml`.
   - **`provenance_file_exists`**: `provenance.yaml` was written and a `file_id` was returned.
   - **`source_recorded`**: every clip entry has `source: reuse` or `source: mock`.
   - **`is_demo_clip_set`**: every clip entry has `is_demo_clip: true`.
   - **`clip_file_ids_present`**: every clip entry has a non-null file_id field value.

6. **Write the Phase Write-Back to `run_state.yaml`** (always — both pass and fail paths).

   Write `phases.microdemo.*` to `ACE/partnerships/<slug>/runs/<run-id>/run_state.yaml` via `update_yaml_file` with `merge: 'deep'` (a partial nested patch of `phases.<phase>` requires `deep` — `two-level` silently drops sibling keys; see CLAUDE.md § Gotchas):

   **QA pass path** (`verdict: pass`):
   ```yaml
   phases:
     microdemo:
       status: done
       verdict: pass
       completed_at: <ISO timestamp>
       summary_artifact: micro-demo/provenance.yaml
       steps:
         angle_read: done
         library_queried: done
         clip_sourced: done
         provenance_written: done
         inline_qa: done
         write_back: done
       products:
         provenance_file_id: <file_id>
         clip_count: <count>
         sourcing_strategy: reuse | mock   # which path was taken
   ```

   **QA fail path** (`verdict: fail`): write the write-back first, then halt with the failed check names surfaced.
   ```yaml
   phases:
     microdemo:
       status: incomplete
       verdict: fail
       completed_at: <ISO timestamp>
       summary_artifact: micro-demo/provenance.yaml
       steps:
         angle_read: done
         library_queried: done
         clip_sourced: done
         provenance_written: done
         inline_qa: fail
         write_back: done
       products:
         provenance_file_id: <file_id or null>
         clip_count: <count or 0>
         sourcing_strategy: reuse | mock | null
       qa_failures:
         - <failed-check-id>
   ```

   After writing the write-back on the fail path, halt with an actionable operator error naming the failed checks.

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_create_folder`, `drive_create_file`, `drive_upload_binary`, `update_yaml_file`
- ace-web media library: `GET /api/w/<workspace>/videos/library/video` via Bash/curl with `ACE_WEB_PAT_TOKEN` (not an MCP atom — direct HTTP)
- Level-0 Agent dispatches (from the orchestrator, not this skill's own MCP calls): `/nova:autobuild` (Nova stub build), `canopy:walkthrough` (walkthrough + clip recording) — these are skills/commands dispatched by the level-0 orchestrator when this skill recommends Option A mocking.
- gstack `browse`: headless browser capture for Option B mocking — a tool, not an MCP atom.

Note: The ace-web media library is an HTTP API (`GET /api/w/<workspace>/videos/library/video`) reached via curl/Bash with `ACE_WEB_PAT_TOKEN`. It is not an MCP atom.

## Mode Behavior

- **Auto:** Run all steps, query the library, source or mock as needed, write `provenance.yaml` and the phase write-back, stop. No interactive prompt — the clip strategy is fully decided by the library-match logic.
- **Review:** Same as Auto. The produce-phase gate is at the orchestrator level (the operator reviews the full package before publish), not inside this skill.

## Dry-Run Behavior

When `--dry-run` is active:
- Read inputs normally (read-only operations are safe in dry-run).
- Query the ace-web media library normally (read-only).
- Skip Nova stub build and canopy walkthrough dispatch (external side effects).
- Write `provenance.yaml` to Drive as normal (human-facing artifact; safe to write in dry-run) but set each clip's `file_id: null` and `source: dry-run`.
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-06-06 | Initial version. Produce-phase proof-clip sourcing skill: reuse-first from ace-web library, lightweight mock fallback (Nova stub + canopy walkthrough or gstack browse). Inline QA, merge: deep write-back. | ACE team |
