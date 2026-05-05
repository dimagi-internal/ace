---
name: app-multimedia-coverage
description: >
  Post-Phase-2 enhancement that attaches display-only images to Connect
  Learn / Deliver app questions where they meaningfully help frontline
  workers. LLM-judges every visible field against the criterion *"would
  the FLW use this image themselves OR show it to a client?"*, generates
  the chosen images via Dimagi's Content Generator API, patches each
  affected form's XML to add `<image>` itext entries, uploads the
  binaries to CCHQ via `commcare_upload_multimedia`, and re-builds +
  re-releases the apps so Connect can ingest the enriched CCZ. Manual
  gate; not part of `/ace:run`. Sibling of `commcare-form-patch` and
  `app-connect-coverage`. Delete this skill (and the supporting helpers
  + atom) once Nova ships first-class field-level display media — see
  § Removal criteria.
---

# App Multimedia Coverage

Generate and attach display-only images to Connect app questions
where they meaningfully help frontline workers. Closes the loop that
Nova doesn't today: schema for media on a field, asset generation,
form-XML reference, CCZ bundling, and a release. Mirrors the
end-to-end pattern of `commcare-form-patch` — surgical post-Nova
patch, then build + release + verify.

## Why this skill exists

CommCare apps render images on questions via standard `<image>` itext
references and CCZ-bundled assets at `commcare/multimedia/image/...`.
Nova has no schema for it: its `image`/`audio`/`video` field kinds are
*input capture* (FLW takes a photo), not *display-only* media on a
question label. There is no field-level `media` property and
`compile_app` does not bundle assets into the CCZ. Connect's runtime,
meanwhile, expects standard CommCare image conventions — without
bundled assets and matching form-XML references there is nothing for
CommCare to render.

Dimagi recently shipped a Content Generator (Cloud Run service,
Gemini-3-Flash-backed) that takes an Application Context, a Form Text
string, and optional Image Directives and produces a relevant PNG.
Hit rate isn't yet high enough to bake into HQ directly, but it is
high enough to be useful as the asset source for this skill. So: we
have a generator, we have CommCare's well-trodden display-image
surface, but no glue. This skill is the glue.

## Removal criteria

Delete `skills/app-multimedia-coverage/`, the
`commcare_upload_multimedia` atom, `lib/multimedia-judge.ts`,
`lib/multimedia-prompt-hash.ts`, `lib/multimedia-manifest.ts`,
`lib/multimedia-xform-patch.ts`, and `lib/content-generator-client.ts`
when ALL of:

1. Nova ships a field-level `media: { image_url, alt_text, image_directives }`
   schema (see `voidcraft-labs/nova-plugin#8`) and round-trips it
   through `compile_app`.
2. Nova's `compile_app` bundles linked media into the produced CCZ at
   `commcare/multimedia/image/...` and writes the matching `<image>`
   itext entries into form XML.
3. A clean `/ace:run` against the smoke fixture
   `CRISPR-Test-005-KMC-multimedia` produces images-attached apps
   without this skill firing.
4. Each affected opp's `run_state.yaml` has empty
   `phase_2_backlog.app-multimedia-coverage`.

When that's true: drop the skill directory, remove the atom backend +
tool registration, drop the `lib/multimedia-*` helpers + their unit
tests, drop the `commcare_upload_multimedia` integration test, and
remove the smoke fixture if it served only this skill. The `phase_2_backlog.app-multimedia-coverage` entry in each
affected opp's `run_state.yaml` is the load-bearing TODO; if it goes
stale, the skill will drift out of the codebase silently while the
Nova schema is still missing.

## Process

Inputs:
- `<opp-name>` — positional, required. Resolves the opp's Drive folder
  (`ACE/<opp-name>/`).
- `--app=learn|deliver|both` — default `both`.
- `--max-images=N` — default `100` (runaway guard before generation).
- `--dry-run` — investigate without generating, patching, or
  releasing.
- `--rejudge` — re-run the LLM judge even when a candidates YAML
  already exists; default off (operator hand-edits win).

This skill targets ONE app per loop iteration but runs across both
apps in a single invocation when `--app=both`. Order matters because
of CCHQ's orphan-pruning behavior — see the WHY callout in step 7.

1. **Read deployment summary.** Pull `hq_domain`, `learn_app_id`,
   `deliver_app_id`, and the latest released `build_id` per app from
   `2-commcare/app-deploy_summary.md` frontmatter. Read `pdd.md` for
   the intervention description used in step 2.

2. **Derive Application Context.** Look for
   `2-commcare/app-multimedia-coverage_app-context.md`. If present,
   use as-is — the operator override always wins. Otherwise synthesize
   from the PDD's `intervention.description`, a one-line target-FLW
   statement, and the standard Dimagi guidance ("People should be
   dressed modestly. All of the users and participants should be
   representative of the context."). Write the synthesized version
   back to that path so the operator can edit and re-run.

3. **LLM-judge each visible field** via
   `lib/multimedia-judge.ts::judgeField`. Walk every form's fields;
   skip kinds `hidden` and `calculate`; skip kinds with no displayed
   label. Per-field input includes the field id / kind / label / hint
   / select-option labels plus ±2 surrounding fields for context. The
   Application Context block is identical for every field in the opp,
   so it goes in a `cache_control: { type: "ephemeral" }` block —
   prompt cache hits on every per-field call after the first.
   Decision criterion (verbatim): *would the FLW use this image
   themselves to do their job OR show it to a client to communicate
   something? If either, return `generate: true`.*

4. **Write candidates YAML** to
   `2-commcare/app-multimedia-coverage_candidates-<app>.yaml`. One row
   per visible field with the judge output (`generate`, `use_case`,
   `why`, `directive`) and an `operator_override: null` slot. **If the
   file already exists**, load it as-is — operator hand-edits to
   `judge.generate` or `judge.directive` are respected. Re-run the
   judge with `--rejudge` to refresh.

5. **Cost preview.** Print
   `Will generate {N} images for <app>; ~30s each ≈ M minutes.`. If
   `N > --max-images`, halt before any generation so a runaway opp
   can't burn 30 minutes unannounced. Operator raises the cap or
   trims the candidates YAML.

6. **Generate images.** For each `generate: true` candidate:
   - Compute `prompt_hash` via
     `lib/multimedia-prompt-hash.ts::promptHash` over
     `(app_context, field_text, directive)`.
   - Cache check: if a PNG exists at
     `2-commcare/app-multimedia-coverage_generated/<app>/<form_unique_id>/<field_id>__<prompt_hash>.png`,
     skip.
   - Cache miss: call
     `lib/content-generator-client.ts::generateImage` (180s timeout,
     single 5xx retry with a fixed delay, hard-fail on auth errors;
     live wall-clock ~68s for low-res, longer with `upscale: true`),
     save the PNG to the path above, update
     `app-multimedia-coverage_manifest.yaml` via
     `lib/multimedia-manifest.ts`.
   - Default execution: serial. Bounded parallelism is a follow-up
     if wall-clock pain shows up.

7. **Patch form XML.** For each form with ≥1 image:
   - `commcare_download_ccz` to fetch the released form XML.
   - `lib/multimedia-xform-patch.ts::addImageItext` to add a
     `<value form="image">jr://file/commcare/image/<filename></value>`
     under `itext/translation/text[@id="<field_id>-label"]`. The
     existing label binding stays unchanged — CommCare renders the
     image alongside the existing text.
   - `commcare_patch_xform` to POST the patched XML.
   - Re-fetch via `commcare_download_ccz` to confirm the patch stuck
     (per-mutation re-fetch gate, same shape as
     `app-connect-coverage`). On `XformConflictError`, halt the form
     and surface the live sha1 so the operator can decide whether to
     re-fetch + retry.

   **WHY this happens before the upload.** CCHQ's
   `Application.multimedia_map_for_build` runs `clean_paths()` on
   every build, which prunes any uploaded multimedia binary that no
   form references. The form-XML reference written here is what
   causes CCHQ to retain the asset in the build's multimedia map.
   Reverse steps 7 and 8 and the upload still succeeds (CCHQ dedupes
   on md5 so a re-run is a no-op), but skipping the patch entirely
   means the asset lands in CouchDB and never reaches FLW devices —
   silent failure mode, verified live during T2.

8. **Upload multimedia to CCHQ** via `commcare_upload_multimedia`,
   one call per generated image. Path is
   `jr://file/commcare/<media_type>/<filename>`. (The MCP atom expects
   `file_bytes_base64` — the skill base64-encodes the PNG bytes before
   invoking it; the backend decodes back to a Buffer for the multipart
   POST.) Record the returned `multimedia_id` (CCHQ couch `_id`) and
   `file_hash_md5` (CCHQ's md5 of the bytes; CCHQ dedupes on this)
   into the manifest. CCHQ does not return sha1 despite earlier draft
   notes — md5 is the source of truth.

9. **Build + release.** `commcare_make_build` followed by
   `commcare_release_build` per app. Capture the new `build_id` and
   `version`. Connect reads released builds only — without this step
   the patches and uploads stay on the draft and FLW devices never
   see them.

10. **Verify the release.** `commcare_download_ccz` against the new
    build, decode, and assert per manifest image that:
    - The PNG is present at `commcare/multimedia/image/<filename>`
      inside the CCZ.
    - The patched form XML still references its expected
      `jr://file/commcare/image/<filename>` URI.
    Halt on mismatch with a per-form before/after diff dump. If the
    file is missing despite a successful upload, the most likely
    cause is that step 7 didn't land before step 9 — see the
    orphan-pruning callout in Failure modes.

11. **Write the report** to
    `2-commcare/app-multimedia-coverage_report-<YYYY-MM-DD>.md`.
    Frontmatter:

    ```yaml
    ---
    app: learn
    app_id: <32-char hex>
    app_context_hash: <sha256>
    prior_build_id: <hex>
    new_build_id: <hex>
    images_total_candidates: <N>
    images_judge_yes: <N>
    images_generated: <N>
    images_cache_hits: <N>
    images_skipped_max: <N>
    forms_patched: <N>
    verified_in_release: true | false
    status: clean | blocked | partial
    ran_at: <ISO timestamp>
    ---
    ```

    Body: per-form table — form name, field id, judge decision +
    rationale, image filename, before/after.

12. **Update `run_state.yaml`** with status + per-app counts under
    `phases.manual.app-multimedia-coverage`. Bump `last_actor` /
    `last_actor_at`. Track removal-criteria reminder in
    `phase_2_backlog.app-multimedia-coverage` if not already present.

## Mode behavior

- **Auto** (default): walk → judge → generate → patch → upload →
  build → release → verify → report. No human gate.
- **Review**: same flow, but pause after step 4 (candidates YAML
  written) and after step 7 (form-XML diff staged) for operator
  approval. Resume on confirmation.
- **Dry-run** (`--dry-run`): execute steps 1–4 + the cost preview
  only. No generator calls, no patches, no builds, no uploads,
  no release. Outputs the candidates YAML so the operator can
  inspect the judge's choices without burning generator quota.
  Writes the would-do summary to
  `comms-log/dry-run-app-multimedia-coverage-<app>-<YYYY-MM-DD>.md`.
  State tracks as `dry-run-success`.

## Failure modes

| Mode | Cause | Behavior |
|---|---|---|
| `judge.error` for ≥1 field | LLM output failed Zod validation in `lib/multimedia-judge.ts` | Skip that field, log `judge.error` to candidates YAML, continue. Skill exits `partial` if any field errored. |
| Content Generator 5xx | Service hiccup | One retry with a fixed delay, then halt the skill. |
| `ContentGeneratorAuthError` | Bad / missing API key | Halt immediately and point operator at `/ace:doctor` (verifies `CONTENT_GENERATOR_URL` + `CONTENT_GENERATOR_API_KEY` env-drift). |
| `XformConflictError` in step 7 | CCHQ's live form sha1 disagrees with the caller-supplied sha1 (concurrent edit) | Halt the form, surface live sha1, operator re-fetches and retries. Non-retryable in the same form-state. |
| `commcare_upload_multimedia` HTTP 500 | CCHQ rejected the binary (size, content-type mismatch, malformed multipart) | Halt the skill, surface the response body slice. |
| Verify step (10) finds missing file | Most likely cause: step 7 didn't land before step 9, so CCHQ's `clean_paths()` pruned the orphan binary out of the build's multimedia map on `make_build`. Less likely: the upload itself was rejected silently or the form-XML patch was reverted. | Halt with per-form before/after diff. Status `blocked`. Operator re-runs step 7 against the released form, then step 9 + step 10 again. |
| `--max-images` exceeded | Runaway opp generated more candidates than the runaway guard allows | Halt before any generation. Operator raises the cap with `--max-images=N` or trims the candidates YAML. |
| Nova MCP unavailable | Step 1 fallback path | Use released-CCZ XML walk for field discovery. Loses `kind` granularity for select fields; judge degrades to label-only heuristics for those. |

## MCP tools used

- **Google Drive:** `drive_read_file`, `drive_create_file`,
  `drive_update_file`, `drive_create_folder`, `drive_list_folder`
- **ace-connect (CCHQ atoms):**
  - `commcare_download_ccz` — fetch + inflate the released CCZ to
    discover form unique_ids, walk current form XML, and verify the
    post-release multimedia map.
  - `commcare_patch_xform` — POST the patched XForm XML adding the
    `<image>` itext entries.
  - `commcare_upload_multimedia` (new in this release) — POST the
    PNG bytes to
    `/a/<domain>/apps/<app_id>/multimedia/uploaded/<media_type>/`.
    Returns `{ multimedia_id, file_hash_md5 }`.
  - `commcare_make_build` — POST `/apps/save/<app_id>/`, returns the
    new build id.
  - `commcare_release_build` — POST
    `/apps/view/<app_id>/releases/release/<build_id>/`, sets
    `is_released: true`.
- **Nova (read-only, when MCP available):**
  `mcp__plugin_nova_nova__get_app`,
  `mcp__plugin_nova_nova__get_form`,
  `mcp__plugin_nova_nova__get_field` — for field metadata when the
  blueprint is reachable.
- **Lib helpers (in-process, not MCP):**
  - `lib/multimedia-judge.ts::judgeField` — Anthropic SDK
    (Sonnet 4.6) per-field judgment with prompt-cached
    Application Context.
  - `lib/multimedia-prompt-hash.ts::promptHash` —
    content-addressed cache key.
  - `lib/multimedia-manifest.ts` — Zod schema + YAML I/O for the
    generated-image manifest.
  - `lib/multimedia-xform-patch.ts::addImageItext` — pure XForm
    patcher adding the `<image>` itext value.
  - `lib/content-generator-client.ts::generateImage` — typed
    wrapper over Dimagi's Content Generator API.

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-05 | Initial version. Manual gate, sibling of `commcare-form-patch` and `app-connect-coverage`. Closes the display-only image gap left by Nova until `voidcraft-labs/nova-plugin#8` ships field-level media. Backed by the new `commcare_upload_multimedia` atom and the `lib/multimedia-*` helper family. Pipeline order (patch-form-XML BEFORE upload BEFORE build) is load-bearing because CCHQ's `clean_paths()` prunes orphan multimedia from the build's multimedia map — verified live during the implementation probe. Removal criteria documented. | ACE team |
