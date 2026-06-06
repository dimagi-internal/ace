---
name: partnership-video-build
description: >
  Fill the ace-web partnership-pitch video template, POST the spec, trigger
  render, and poll until done. Writes video_spec.yaml + package.yaml.
disable-model-invocation: true
---

# Partnership Video Build

Fill the ace-web `partnership-pitch` video template with the run's produce-phase artifacts — prospect identity, all three narration variants, the picked angle, micro-demo proof clips, and research stat cards — then POST the spec to ace-web, trigger a render, poll until the render completes, and save the output URLs. This is the core produce-phase skill: it converts grounded narrative + proof clips into a rendered partnership pitch video.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 profile | `ACE/partnerships/<slug>/prospect.yaml` | Prospect name, logo ref, region, sector, program URL, slug |
| `partnership-angles` | `ACE/partnerships/<slug>/runs/<run-id>/angles.yaml` | All three grounded narration variants; `selected_angle` from `run_state.yaml.phases.angles.products.selected_angle` |
| `partnership-microdemo` | `ACE/partnerships/<slug>/runs/<run-id>/micro-demo/provenance.yaml` | Clip entries with `is_demo_clip`, `file_id`, `caption` |
| `partnership-research` | `ACE/partnerships/<slug>/research/deep-research.md` | Problem/impact stat cards with citations |
| `run_state.yaml` | `phases.angles.products.selected_angle` | Which angle is active |
| Env | `ACE_WEB_PAT_TOKEN`, `ACE_WEB_BASE`, `WORKSPACE_SLUG` (default `dimagi-team`) | ace-web auth + base URL + workspace |

## Products

- `ACE/partnerships/<slug>/runs/<run-id>/video_spec.yaml` — the filled ace-web spec as-POSTed (machine-parsed YAML; via `drive_create_file`)
- `ACE/partnerships/<slug>/runs/<run-id>/package.yaml` — final output URLs: ace-web program URL, render media URL (via `drive_create_file`)
- `ACE/partnerships/<slug>/runs/<run-id>/run_state.yaml` — Phase Write-Back: `phases.video-build.*`

## Process

1. **Resolve inputs and check preconditions.**

   Read `ACE/partnerships/<slug>/runs/<run-id>/run_state.yaml` via `drive_read_file`. Check `phases.microdemo.verdict` — if `fail` or `incomplete`, halt with: "partnership-video-build requires a passing partnership-microdemo run. Check `phases.microdemo.verdict` in run_state.yaml."

   Read and capture:
   - `phases.angles.products.selected_angle` — the active angle id.
   - `ACE_WEB_PAT_TOKEN` env var. If unset, halt with: "ACE_WEB_PAT_TOKEN not set; run `/ace:ace-web-pat-mint` and retry."
   - `BASE_URL="${ACE_WEB_BASE:-https://labs.connect.dimagi.com/ace}"` (strip trailing slash).
   - `WORKSPACE_SLUG="${WORKSPACE_SLUG:-dimagi-team}"`.

2. **Fetch the template bundle from ace-web.**

   ```bash
   curl -fsS \
     -H "Authorization: Bearer $ACE_WEB_PAT_TOKEN" \
     "$BASE_URL/api/w/$WORKSPACE_SLUG/videos/templates/partnership-pitch"
   ```

   On non-200: halt with the status code and body — the `partnership-pitch` template (merged via ace-web PR #610) must be deployed before this skill can run. Surface the exact curl error for the operator.

   From the response, extract:
   - `skeleton_yaml` — the spec skeleton with `{{placeholder}}` tokens.
   - `prompt_md` — the generation instructions; follow these instructions exactly when filling placeholders (they specify word budgets, output format, and grounding rules).

3. **Read the run artifacts.**

   Read from Drive via `drive_read_file`:
   - `ACE/partnerships/<slug>/prospect.yaml` → extract `name`, `slug`, `logo_asset` (or `null`), `region`, `sector`, `program_url` (or site URL).
   - `ACE/partnerships/<slug>/runs/<run-id>/angles.yaml` → extract all three angle entries; for each angle, extract `angle_id`, `logline`, `beats` (the seven beat texts: `hook`, `cycle`, `handoff`, `scene`, `problem`, `product`, `impact`).
   - `ACE/partnerships/<slug>/runs/<run-id>/micro-demo/provenance.yaml` → extract `clips[]` (each with `is_demo_clip`, `caption`, `file_id`).
   - `ACE/partnerships/<slug>/research/deep-research.md` → extract the two strongest cited problem/impact statistics. Each stat must have a citation (author/source name + year or URL). **If a stat lacks a citation, use `[TBD] <missing citation>` rather than including an uncited figure.**

4. **Fill the skeleton following the template's `prompt_md`.**

   Follow the generation instructions in `prompt_md` exactly, using the artifacts gathered in step 3 as inputs. Key filling rules:

   - **Identity block:** `slug` = prospect slug; `name`, `region`, `sector`, `program_url` from `prospect.yaml`; `status` from deep-research headline (cited); `tagline` from research or `[TBD] tagline`.
   - **Prospect block:** `name`, `logo_asset`, `region`, `sector` from `prospect.yaml`. If `logo_asset` is null, omit `prospect.logo_asset` or use `[TBD] logo ref`.
   - **Narration variants:** embed ALL THREE angles. For each angle, map its seven grounded beat texts to the skeleton's `by_beat` keys (`hook`, `cycle`, `handoff`, `scene`, `problem`, `product`, `impact`). Respect per-beat word budgets from `prompt_md` (±2 words; going long causes mid-word synthesis cuts). Set `active_angle` to `selected_angle`.
   - **Problem block:** `big` = the cited problem stat from research (e.g. "60%"); `caption` = one sentence describing the problem; `source` = citation string. **Never invent a number** — cite directly from deep-research or mark `[TBD]`.
   - **Impact block:** two impact stats from deep-research, each with `big` + `caption`. Both must be cited; uncited stats get `[TBD] ` prefix.
   - **Product beats:** populate from `micro-demo/provenance.yaml`. For each clip: `asset` = Drive `file_id`, `caption` = clip `caption`, `is_demo_clip: true`. If no clips exist, write one placeholder beat with `asset: "[TBD] clip file_id"`.
   - **Scene lower third:** `"<region> · <prospect name>"` or just `"<region>"` if no prospect name.
   - **`[TBD]` discipline (non-negotiable):** any value that cannot be grounded from the available artifacts MUST be written as `[TBD] <what is missing>`. Never invent a stat, name, or fact. After filling, scan the completed spec and count `[TBD]` tokens — if any remain (permitted for unresolvable gaps), report them in the write-back and QA checks. **The skill must NOT proceed past inline QA if a `[TBD]` appears in a narration beat** — narration is the prospect-facing surface; unresolved narration text is a hard block.

5. **Validate the filled spec before POST.**

   Confirm:
   - No `{{` placeholder tokens remain (all were replaced by values or `[TBD]`).
   - No `[TBD]` in any `by_beat` narration string across all three variants (these are the prospect-facing text; any unresolved narration beats must be resolved before POSTing).
   - The `active_angle` value matches one of the three `angle_id` values in `variants`.

   If either of the first two checks fails, halt and report: "Spec validation failed before POST — [list issues]. Resolve these gaps in the source artifacts and re-run."

6. **POST the program to ace-web.**

   ```bash
   curl -fsS -X POST \
     -H "Authorization: Bearer $ACE_WEB_PAT_TOKEN" \
     -H "Content-Type: application/json" \
     "$BASE_URL/api/w/$WORKSPACE_SLUG/videos/programs" \
     -d "$(jq -nc --arg slug "$PROGRAM_SLUG" --arg spec "$SPEC_YAML" \
             '{slug: $slug, spec_yaml: $spec}')"
   ```

   Expect 2xx. Capture the response's `run_id` (typically `"run-001"`), `program_slug`, and `spec_path`.

   On 409 (slug already exists): halt with: "Video program `<slug>` already exists in workspace `<ws>`. Either pick a different slug or delete the existing program in the ace-web UI before re-running."

   On 400: surface the `detail` field from the response — the server rejected the spec structure; revisit the placeholder fill in step 4.

7. **Trigger the render.**

   ```bash
   curl -fsS -X POST \
     -H "Authorization: Bearer $ACE_WEB_PAT_TOKEN" \
     -H "Content-Type: application/json" \
     "$BASE_URL/api/w/$WORKSPACE_SLUG/videos/programs/$PROGRAM_SLUG/runs/$RUN_ID/build" \
     -d '{"mode": "render"}'
   ```

   Expect 2xx (`ok: true`). If the response body has `triggered: false`, log a WARN — the server did not queue the render — and continue to step 8 (the status poll will catch `appears_failed`).

8. **Poll render status until complete.**

   Poll up to 30 times with a 10-second interval (5 minutes total — the typical render is 60–90s):

   ```bash
   curl -fsS \
     -H "Authorization: Bearer $ACE_WEB_PAT_TOKEN" \
     "$BASE_URL/api/w/$WORKSPACE_SLUG/videos/programs/$PROGRAM_SLUG/runs/$RUN_ID/render-status"
   ```

   On each poll: if `busy: false`, the render is done — proceed. If `appears_failed: true` (present in any poll response), stop polling and record `render_failed: true`.

   After 30 polls without `busy: false`, record `render_failed: true` (timeout).

9. **Construct the output URLs.**

   - Editable program URL: `$BASE_URL/w/$WORKSPACE_SLUG/videos/$PROGRAM_SLUG`
   - Render media base: `$BASE_URL/api/w/$WORKSPACE_SLUG/videos/programs/$PROGRAM_SLUG/runs/$RUN_ID/media/`
   - The primary output file is conventionally `output.mp4` (or whatever the server returns as the canonical render output — check `render-status` for a `output_files` field if present; fall back to `output.mp4`).

10. **Save `video_spec.yaml` and `package.yaml` to Drive.**

    Both are machine-parsed YAML files. Use `drive_create_file` with `mimeType: "text/plain"` (NOT `drive_create_doc_from_markdown` — these are not Google Docs). Parent folder = the run folder (`runs/<run-id>/`).

    `video_spec.yaml` — the filled spec as-POSTed:
    ```yaml
    prospect_slug: <slug>
    run_id: <run-id>
    generated_at: <ISO timestamp>
    program_slug: <program_slug>
    ace_web_run_id: <run_id from POST response>
    spec_yaml: |
      <the full filled spec, verbatim>
    ```

    `package.yaml` — final delivery URLs:
    ```yaml
    prospect_slug: <slug>
    run_id: <run-id>
    generated_at: <ISO timestamp>
    video:
      program_url: <editable ace-web URL>
      media_url: <render media URL>
      run_id: <ace_web_run_id>
      render_status: completed | failed | timeout
      appears_failed: <true|false>
    ```

11. **Inline QA (binary — run before writing the phase write-back).**

    Verify all of the following. Record which checks pass and which fail — the write-back is ALWAYS written regardless of outcome:

    - **`spec_posted`**: POST to ace-web returned 2xx.
    - **`render_completed`**: `busy: false` received before timeout AND `appears_failed` is not true.
    - **`package_has_urls`**: `package.yaml` contains non-null `video.program_url` and `video.media_url`.
    - **`no_tbd_in_narration`**: no `[TBD]` tokens appear in any `by_beat` narration string in the posted spec (this re-checks the pre-POST guard; if a `[TBD]` slipped through the step 5 check, catch it here).
    - **`active_angle_valid`**: `active_angle` in the posted spec matches `selected_angle` from `run_state.yaml`.

12. **Write the Phase Write-Back to `run_state.yaml`** (always — both pass and fail paths).

    Write `phases.video-build.*` to `ACE/partnerships/<slug>/runs/<run-id>/run_state.yaml` via `update_yaml_file` with `merge: 'deep'` (a partial nested patch of `phases.<phase>` requires `deep` — `two-level` silently drops sibling keys; see CLAUDE.md § Gotchas):

    **QA pass path** (`verdict: pass`):
    ```yaml
    phases:
      video-build:
        status: done
        verdict: pass
        completed_at: <ISO timestamp>
        summary_artifact: video_spec.yaml
        steps:
          preconditions_checked: done
          template_fetched: done
          artifacts_read: done
          spec_filled: done
          spec_validated: done
          spec_posted: done
          render_triggered: done
          render_polled: done
          artifacts_saved: done
          inline_qa: done
          write_back: done
        products:
          program_slug: <program_slug>
          ace_web_run_id: <run_id>
          program_url: <editable ace-web URL>
          media_url: <render media URL>
          video_spec_file_id: <Drive file_id>
          package_file_id: <Drive file_id>
          tbd_count: <number of [TBD] tokens in the posted spec outside narration>
          render_failed: false
    ```

    **QA fail path** (`verdict: fail`): write the write-back first, then halt with the failed check names surfaced.
    ```yaml
    phases:
      video-build:
        status: incomplete
        verdict: fail
        completed_at: <ISO timestamp>
        summary_artifact: video_spec.yaml
        steps:
          preconditions_checked: done
          template_fetched: done
          artifacts_read: done
          spec_filled: done
          spec_validated: done
          spec_posted: <done|fail>
          render_triggered: <done|fail>
          render_polled: <done|fail>
          artifacts_saved: done
          inline_qa: fail
          write_back: done
        products:
          program_slug: <program_slug or null>
          ace_web_run_id: <run_id or null>
          program_url: <URL or null>
          media_url: <URL or null>
          video_spec_file_id: <file_id or null>
          package_file_id: <file_id or null>
          tbd_count: <count>
          render_failed: <true|false>
        qa_failures:
          - <failed-check-id>
    ```

    After writing the write-back on the fail path, halt with an actionable operator error naming the failed checks.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `ACE_WEB_PAT_TOKEN` | (required) | Per-human Bearer token; mint via `/ace:ace-web-pat-mint` |
| `ACE_WEB_BASE` | `https://labs.connect.dimagi.com/ace` | ace-web base URL (strip trailing slash) |
| `WORKSPACE_SLUG` | `dimagi-team` | ace-web workspace slug |

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_create_file`, `update_yaml_file`
- ace-web video API: all HTTP calls via Bash/curl with `ACE_WEB_PAT_TOKEN` — NOT MCP atoms. Endpoints used:
  - `GET /api/w/<ws>/videos/templates/partnership-pitch` — fetch template bundle
  - `POST /api/w/<ws>/videos/programs` — create program with filled spec
  - `POST /api/w/<ws>/videos/programs/<slug>/runs/<run_id>/build` — trigger render
  - `GET /api/w/<ws>/videos/programs/<slug>/runs/<run_id>/render-status` — poll status

Note: `drive_create_folder` is NOT called here — `video_spec.yaml` and `package.yaml` live at the run folder root (not in a subfolder), so no subfolder creation is needed. Both files use `drive_create_file` with the run folder as `parentFolderId`.

## Mode Behavior

- **Auto:** Run all steps, fill spec, POST, render, poll, save artifacts, write phase write-back, stop. No interactive prompt.
- **Review:** Same as Auto. The produce-phase operator review gate is at the orchestrator level (operator reviews the video before publish), not inside this skill.

## Dry-Run Behavior

When `--dry-run` is active:
- Read inputs normally (read-only operations are safe in dry-run).
- Fetch the template bundle normally (read-only HTTP GET).
- Fill the skeleton normally (in-memory LLM work).
- Skip the `POST /videos/programs` call, the `POST .../build` call, and the render poll.
- Write `video_spec.yaml` to Drive with `ace_web_run_id: dry-run` and the filled spec (so the operator can review it before committing to render).
- Write `package.yaml` with `render_status: dry-run`, `program_url: null`, `media_url: null`.
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-06-06 | Initial version. Produce-phase video-spec fill → POST → render → poll. Inline QA: spec_posted, render_completed, package_has_urls, no_tbd_in_narration, active_angle_valid. Hard block on [TBD] in narration pre-POST. merge: deep write-back. Phase folder: 8-video-build/. | ACE team |
