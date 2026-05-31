---
name: app-multimedia-coverage
description: >
  Attach display-only images to Connect app questions where they
  meaningfully help FLWs. Manual gate; not part of /ace:run.
disable-model-invocation: true
---

# App Multimedia Coverage

Generate and attach display-only images to Connect app questions
where they meaningfully help frontline workers. Closes the loop that
Nova doesn't today: schema for media on a field, asset generation,
form-XML reference, CCZ bundling, and a release. Surgical post-Nova
patch — invoke `commcare_patch_xform` to inject the jr:// reference,
then `commcare_make_build` + `commcare_release_build` to ship.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 3 | `3-commcare/pdd-to-learn-app_summary.md` and `pdd-to-deliver-app_summary.md` | source `nova_app_id`s |
| Operator (manual invocation) | per-opp confirmation gate | required — this skill is NOT part of `/ace:run`; invoke via `/ace:step app-multimedia-coverage <opp>` |

## Products

- `3-commcare/app-multimedia-coverage_summary.md` — per-field judge decisions, images attached, build/release IDs

## Removal criteria

Delete this skill (and the supporting helpers + atom) once Nova ships
first-class field-level display media — tracked at
`voidcraft-labs/nova-plugin#8`. See § Removal criteria below for the
exact removal checklist.

## Why this skill exists

CommCare apps render images on questions via standard `<image>` itext
references and CCZ-bundled assets at `commcare/image/...`.
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
`lib/multimedia-xform-patch.ts`, `lib/content-generator-client.ts`,
`scripts/run-content-generator.ts`, and `scripts/run-xform-patch.ts`
when ALL of:

1. Nova ships a field-level `media: { image_url, alt_text, image_directives }`
   schema (see `voidcraft-labs/nova-plugin#8`) and round-trips it
   through `compile_app`.
2. Nova's `compile_app` bundles linked media into the produced CCZ at
   `commcare/image/...` and writes the matching `<image>`
   itext entries into form XML.
3. A clean `/ace:run` against the smoke fixture
   `ACE-Test-005-KMC-multimedia` produces images-attached apps
   without this skill firing.
4. Each affected opp's `run_state.yaml` has empty
   `phase_2_backlog.app-multimedia-coverage`.

When that's true: drop the skill directory, remove the atom backend +
tool registration, drop the `lib/multimedia-*` helpers + their unit
tests, drop the `scripts/run-content-generator.ts` and
`scripts/run-xform-patch.ts` wrappers + their tests, drop the
`commcare_upload_multimedia` integration test, and remove the smoke
fixture if it served only this skill. The
`phase_2_backlog.app-multimedia-coverage` entry in each affected opp's
`run_state.yaml` is the load-bearing TODO; if it goes stale, the skill
will drift out of the codebase silently while the Nova schema is still
missing.

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
   `3-commcare/app-deploy_summary.md` frontmatter. Read `pdd.md` for
   the intervention description used in step 2.

2. **Derive Application Context.** Look for
   `3-commcare/app-multimedia-coverage_app-context.md`. If present,
   use as-is — the operator override always wins. Otherwise synthesize
   from the PDD's `intervention.description`, a one-line target-FLW
   statement, and the standard Dimagi guidance ("People should be
   dressed modestly. All of the users and participants should be
   representative of the context."). Write the synthesized version
   back to that path so the operator can edit and re-run.

3. **Judge each visible field.** Walk every form's fields; skip kinds
   `hidden` and `calculate`; skip kinds with no displayed label. The
   canonical way to obtain the field inventory is
   `npx tsx scripts/run-form-walk.ts <hq_domain> <app_id> [--build-id <hex>] --out <path>`
   — it downloads the released CCZ, walks the form XML, and overlays
   each form's `form_unique_id` from CCHQ's draft-app API (because the
   suite.xml-derived uid is a build-only variant that
   `commcare_patch_xform` rejects — see issue #108). Output's
   `form_unique_id_source` field reads `draft_api` when overlay
   succeeded, `suite_xml` when the env lacks `ACE_HQ_USERNAME` /
   `ACE_HQ_API_KEY` and the script fell back. **Halt step 7 if
   `form_unique_id_source: 'suite_xml'`** — patches against those uids
   will fail; re-run with API creds or pass the draft uid explicitly.

   Each output row carries `field_id`, `kind`
   (`label|text|int|single_select|multi_select|date|datetime|trigger|unknown`),
   `label`, and `options[]` (for selects). Edge-case body shapes
   surface as `kind: unknown` — treat unknowns conservatively
   (default: skip). For each remaining field, decide using the
   operator-LLM's own reasoning
   — read the field id / kind / label / hint / select-option labels
   plus ±2 surrounding fields for context, hold the Application
   Context (step 2) constant for every field in the opp so directives
   stay tonally consistent, then apply the criterion below:

   > **Criterion (verbatim):** *Would the FLW use this image themselves
   > to do their job (e.g. step-by-step demonstration, labeled diagram
   > of an anatomy or device) OR show it to a client to communicate
   > something (e.g. visual choice card, "what does X look like"
   > reference)? If either, return `generate: true`.*

   Skip if the question is purely numeric (weight, age), date/time, or
   a yes/no without ambiguity. Skip if the question's text alone is
   unambiguous and concrete.

   Output one row per visible field in the candidates YAML (step 4)
   with shape:

   ```yaml
   - form_unique_id: <hex>
     module: <int>
     form: <int>
     field_id: <id>
     kind: label | text | int | single_select | multi_select | image | ...
     field_text: "<label>"
     judge:
       generate: true | false
       use_case: flw_self_use | flw_shows_client | both | null
       why: "<≤200-char rationale>"
       directive: "<≤500-char Image Directive draft, or null when generate=false>"
     operator_override: null
   ```

   The Image Directive should be specific about subject, action,
   environment, lighting, and any modesty/representation cues from the
   Application Context — it is passed verbatim to the generator in
   step 6.

   (Note: `lib/multimedia-judge.ts::judgeField` ships a tested rubric
   implementation if a non-LLM caller wants to drive the judge
   programmatically. Skills do the judging in-LLM directly because
   it's cheaper than spawning a separate Anthropic call and the
   criterion is short enough to inline.)

4. **Write candidates YAML** to
   `3-commcare/app-multimedia-coverage_candidates-<app>.yaml`. One row
   per visible field with the judge output (`generate`, `use_case`,
   `why`, `directive`) and an `operator_override: null` slot. **If the
   file already exists**, load it as-is — operator hand-edits to
   `judge.generate` or `judge.directive` are respected. Re-run the
   judge with `--rejudge` to refresh.

5. **Cost preview.** Print
   `Will generate {N} images for <app>; ~30-60s each ≈ M minutes.`
   (live-measured wall-clock 2026-05-05: 23–53s per image, avg ~42s,
   so use the upper bound when computing M — e.g. N=8 images ≈ 8
   minutes, N=20 ≈ 20 minutes). If `N > --max-images`, halt before
   any generation so a runaway opp can't burn the full budget
   unannounced. Operator raises the cap or trims the candidates YAML.

6. **Generate images.** For each `generate: true` candidate:
   - Compute `prompt_hash` as SHA-256 over the trimmed
     `(app_context, field_text, directive)` joined by single spaces.
     One-liner — strip leading/trailing whitespace per field, treat
     null/missing directive as the empty string, then:

     ```bash
     prompt_hash=$(printf '%s %s %s' "$app_context_trimmed" "$field_text_trimmed" "$directive_trimmed" \
       | shasum -a 256 | cut -d' ' -f1)
     ```

     (`lib/multimedia-prompt-hash.ts::promptHash` is the canonical
     implementation; it normalizes via `s.trim()` then joins with `' '`.
     The Bash one-liner above matches that contract.)
   - Cache check: if a PNG exists at
     `3-commcare/app-multimedia-coverage_generated/<app>/<form_unique_id>/<field_id>__<prompt_hash>.png`,
     skip.
   - Cache miss: write a per-field input JSON file like:

     ```json
     {
       "applicationContext": "<step 2 paragraph>",
       "formText": "<field label, hint, options joined>",
       "imageDirectives": "<judge.directive from step 3>",
       "upscale": false
     }
     ```

     Then call:

     ```bash
     npx tsx scripts/run-content-generator.ts <input.json> <output.png>
     ```

     The wrapper reads `CONTENT_GENERATOR_URL` and
     `CONTENT_GENERATOR_API_KEY` from the env, POSTs to the gateway,
     decodes the base64 PNG, writes it to `<output.png>`, and prints a
     JSON line to stdout: `{ image_path, prompt_used, elapsed_ms, bytes }`.
     Live wall-clock is ~68s for low-res (`upscale: false`); longer
     with `upscale: true`. The wrapper exits non-zero on any
     Content-Generator failure (auth, validation, 5xx) — surface the
     stderr message and halt the skill on a hard failure (one retry on
     5xx is built into the underlying client).
   - Append a row to
     `3-commcare/app-multimedia-coverage_manifest.yaml` matching the
     schema in `lib/multimedia-manifest.ts` (Zod-validated; YAML keys:
     `app`, `form_unique_id`, `field_id`, `prompt_hash`, `file_path`,
     `ccz_filename`, `cchq_multimedia_id` (null until step 8),
     `cchq_file_hash_md5` (null until step 8), `generated_at`).
     Top-level fields: `app_context_hash` (SHA-256 of the Application
     Context paragraph) and `images: [...]`.
   - Default execution: serial. Bounded parallelism is a follow-up if
     wall-clock pain shows up.

7. **Patch form XML.** For each form with ≥1 image:
   - `commcare_download_ccz` to fetch the released form XML; save it
     to a temp path like `/tmp/ace-mm-<form_unique_id>.xml`.
   - Build a bindings JSON file listing every field on this form that
     got an image:

     ```json
     [
       { "fieldId": "kmc_position_demo", "cczFilename": "kmc_position_demo.png" },
       { "fieldId": "kmc_warning_signs", "cczFilename": "kmc_warning_signs.png" }
     ]
     ```

   - Run the patcher:

     ```bash
     npx tsx scripts/run-xform-patch.ts /tmp/ace-mm-<form_unique_id>.xml /tmp/bindings-<form_unique_id>.json [--replace-existing] -o /tmp/patched-<form_unique_id>.xml
     ```

     Patched XML lands at the `-o` path; a JSON summary
     `{ patched, applied, skipped, notFound }` is written to stderr.
     Pass `--replace-existing` when re-running the skill on a form
     that already has an attached image with a different filename —
     without it, CCHQ's build validator rejects with `duplicate
     definition for text ID '<field>-label' and form 'image'`. `notFound`
     listing any field id means the form-XML walk in step 3 disagreed
     with the live released form — halt and re-discover.
   - `commcare_patch_xform` to POST the patched XML. **Pass the
     patched file via `new_xform_xml_path` (preferred for any real
     form — typical patched XML is 12K+ chars and blows past tool-call
     arg-size limits when passed inline).** The atom reads the file
     and forwards its contents to the backend. The legacy
     `new_xform_xml` inline arg is still accepted for tiny patches
     and unit-test convenience; pass exactly one.
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
   `jr://file/commcare/<media_type>/<filename>`. **Pass the binary
   via `file_bytes_path` (preferred for any real PNG — a typical
   1.2 MB image becomes ~1.6 MB base64 and blows past tool-call
   arg-size limits when inlined as `file_bytes_base64`).** The atom
   reads the file as raw bytes and forwards a Buffer to the backend
   for the multipart POST. The legacy `file_bytes_base64` inline arg
   is still accepted for tiny test assets and unit-test convenience;
   pass exactly one. Record the returned `multimedia_id` (CCHQ couch
   `_id`) and `file_hash_md5` (CCHQ's md5 of the bytes; CCHQ dedupes
   on this) into the manifest. CCHQ does not return sha1 despite
   earlier draft notes — md5 is the source of truth.

9. **Build + release.** `commcare_make_build` followed by
   `commcare_release_build` per app. Capture the new `build_id` and
   `version`. Connect reads released builds only — without this step
   the patches and uploads stay on the draft and FLW devices never
   see them.

10. **Verify the release.** `commcare_download_ccz` against the new
    build, decode, and assert per manifest image that:
    - The PNG is present at `commcare/image/<filename>`
      inside the CCZ.
    - The patched form XML still references its expected
      `jr://file/commcare/image/<filename>` URI.
    Halt on mismatch with a per-form before/after diff dump. If the
    file is missing despite a successful upload, the most likely
    cause is that step 7 didn't land before step 9 — see the
    orphan-pruning callout in Failure modes.

11. **Write the report** to
    `3-commcare/app-multimedia-coverage_report-<YYYY-MM-DD>.md`.
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
| `judge.error` for ≥1 field | Operator-LLM output for the field couldn't be coerced into the documented row shape (e.g. invalid `use_case`, missing `why`) | Skip that field, log `judge.error` to candidates YAML, continue. Skill exits `partial` if any field errored. |
| Content Generator 5xx | Service hiccup | One retry with a fixed delay (built into the client called by `scripts/run-content-generator.ts`), then halt the skill. |
| `ContentGeneratorAuthError` | Bad / missing API key | `scripts/run-content-generator.ts` exits with the wrapped auth error to stderr. Halt immediately and point operator at `/ace:doctor` (verifies `CONTENT_GENERATOR_URL` + `CONTENT_GENERATOR_API_KEY` env-drift). |
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
    `<image>` itext entries. Two payload modes: `new_xform_xml`
    (inline string) or `new_xform_xml_path` (filesystem path —
    preferred for real forms; sidesteps tool-call arg-size limits).
    Pass exactly one.
  - `commcare_upload_multimedia` — POST the PNG bytes to
    `/a/<domain>/apps/<app_id>/multimedia/uploaded/<media_type>/`.
    Returns `{ multimedia_id, file_hash_md5 }`. Two payload modes:
    `file_bytes_base64` (inline) or `file_bytes_path` (filesystem
    path — preferred for any real PNG; sidesteps the ~1.6 MB base64
    inline-arg limit). Pass exactly one.
  - `commcare_make_build` — POST `/apps/save/<app_id>/`, returns the
    new build id.
  - `commcare_release_build` — POST
    `/apps/view/<app_id>/releases/release/<build_id>/`, sets
    `is_released: true`.
- **Nova (read-only, when MCP available):**
  `get_app`,
  `get_form`,
  `get_field` — for field metadata when the
  blueprint is reachable.
- **CLI wrappers (skill-runtime, called via Bash):**
  - `scripts/run-content-generator.ts` — wraps
    `lib/content-generator-client.ts::ContentGeneratorClient.generateImage`.
    Reads request JSON from a file, writes the decoded PNG to the
    target path, prints `{ image_path, prompt_used, elapsed_ms, bytes }`
    to stdout. Reads `CONTENT_GENERATOR_URL` and
    `CONTENT_GENERATOR_API_KEY` from the env. 180s timeout, single
    5xx retry, hard-fail on auth errors.
  - `scripts/run-xform-patch.ts` — wraps
    `lib/multimedia-xform-patch.ts::addImageItext`. Reads form XML
    + bindings JSON, writes patched XML to stdout (or `-o <path>`),
    writes `{ patched, applied, skipped, notFound }` JSON to stderr.
    Pass `--replace-existing` when re-running on a form that already
    has an attached image with a different filename.
- **Lib helpers (rubric reference, in-process for non-LLM callers):**
  - `lib/multimedia-judge.ts::judgeField` — Zod-typed Anthropic SDK
    rubric implementation. Skills do per-field judging in-LLM
    directly (cheaper than spawning a separate Anthropic call and the
    criterion is short enough to inline); this lib is the tested
    reference if a non-LLM caller (e.g. a CI batch tool) wants the
    same judge programmatically.
  - `lib/multimedia-prompt-hash.ts::promptHash` — content-addressed
    cache key. Skills compute the same hash inline via `shasum -a 256`
    over the trimmed-and-space-joined fields; this lib is the
    canonical normalization implementation for non-Bash callers.
  - `lib/multimedia-manifest.ts` — Zod schema for the
    generated-image manifest. Skills write the YAML directly per the
    documented shape; this lib is the validator + parser for non-LLM
    callers.

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-05 | Initial version. Manual gate, sibling of `commcare-form-patch` and `app-connect-coverage`. Closes the display-only image gap left by Nova until `voidcraft-labs/nova-plugin#8` ships field-level media. Backed by the new `commcare_upload_multimedia` atom and the `lib/multimedia-*` helper family. Pipeline order (patch-form-XML BEFORE upload BEFORE build) is load-bearing because CCHQ's `clean_paths()` prunes orphan multimedia from the build's multimedia map — verified live during the implementation probe. Removal criteria documented. | ACE team |
| 2026-05-05 | Made the skill operator-runnable. Added `scripts/run-content-generator.ts` and `scripts/run-xform-patch.ts` CLI wrappers for the two helpers that need shell-callable surfaces (image generation, form-XML patching). Per-field judge step now uses operator-LLM reasoning directly with the verbatim criterion (cheaper than a separate Anthropic call). Prompt hashing uses inline `shasum -a 256`; manifest written directly per the `lib/multimedia-manifest.ts` schema. Lib code unchanged — `lib/multimedia-*.ts` remain as tested rubric implementations for non-LLM callers. | ACE team |
