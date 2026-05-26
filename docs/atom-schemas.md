# ACE MCP Atom Schemas

Auto-generated catalog of every registered atom across the five MCP servers. **Do not hand-edit.** Regenerate with:

```bash
npx tsx scripts/dump-atom-schemas.ts
```

Purpose: single source of truth skill authors can grep against. PR review surfaces atom-schema diffs as diffs to this file. See PR-P for full rationale.

For the deterministic atom-rename / remove drift check, see `test/skill-atom-references.test.ts` (PR-K).

## ace-gdrive

Source: `mcp/google-drive-server.ts` — 40 atoms

### `sheets_list_tabs`

List all sheet tabs in a Google Spreadsheet

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spreadsheetId` | `z.string` | **required** | The spreadsheet ID from the URL |

### `sheets_read`

Read a range of cells from a Google Spreadsheet. Returns rows as arrays.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spreadsheetId` | `z.string` | **required** | The spreadsheet ID |
| `range` | `z.string` | **required** | A1 notation range, e.g. "Sheet1!A1:D10" or just "Sheet1" |

### `sheets_write`

Write values to a range in a Google Spreadsheet

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spreadsheetId` | `z.string` | **required** | The spreadsheet ID |
| `range` | `z.string` | **required** | A1 notation range, e.g. "Sheet1!A1:D10" |
| `values` | `z.array` | **required** | _—_ |

### `sheets_append`

Append rows to the end of a sheet

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spreadsheetId` | `z.string` | **required** | The spreadsheet ID |
| `range` | `z.string` | **required** | Sheet name or range to append after, e.g. "Sheet1" |
| `values` | `z.array` | **required** | _—_ |

### `sheets_info`

Get metadata about a Google Spreadsheet (title, locale, sheets)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spreadsheetId` | `z.string` | **required** | The spreadsheet ID |

### `sheets_batch_read`

Read multiple ranges from a spreadsheet in one call

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spreadsheetId` | `z.string` | **required** | The spreadsheet ID |
| `ranges` | `z.array` | **required** | _—_ |

### `sheets_create_tab`

Create a new tab (sheet) in a Google Spreadsheet

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spreadsheetId` | `z.string` | **required** | The spreadsheet ID |
| `title` | `z.string` | **required** | Name for the new tab |

### `drive_list_folder`

List files in a Google Drive folder

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `folderId` | `z.string` | **required** | The Google Drive folder ID |

### `drive_read_file`

Read the text content of a file in Google Drive. Works with Google Docs (exported as plain text), text/* files (markdown, plain text, etc.), and JSON/YAML/XML/CSV variants. Refuses non-text mimetypes (PDF, docx/xlsx/pptx, images, audio, zip) with a typed `unsupported_binary_mimetype` error pointing at `drive_download_binary` — pre-#106-finding-4 the read returned raw binary as a JSON-corrupted str…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fileId` | `z.string` | **required** | The Google Drive file ID |

### `read_personal_drive_doc`

Read a Google Drive document via personal OAuth (gog CLI) — fallback for files shared with the human user account but not the ACE service account. Requires gog to be installed and authorized for Drive on $ACE_GMAIL_ACCOUNT/$ACE_GMAIL_CLIENT. If the user has not yet granted Drive scope, re-run: `gog login $ACE_GMAIL_ACCOUNT --client $ACE_GMAIL_CLIENT --services gmail,drive`. Use only when drive_rea…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file_id` | `z.string` | **required** | The Google Drive file ID |
| `format` | `z.enum` | optional | _—_ |

### `drive_update_file`

Update the text content of an existing Google Doc in Drive. Use for updating PDDs, summaries, and other docs as ACE skills produce new content. Pass `ifMatchRevisionId` (from a prior `drive_read_file`) to opt into optimistic-concurrency CAS — the write is rejected with a typed `revision_conflict` error if another writer changed the file in between, so the caller can re-read and retry without overw…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fileId` | `z.string` | **required** | The Google Drive file ID |
| `content` | `z.string` | **required** | The new text content to write |
| `ifMatchRevisionId` | `z.string` | optional | Optional. The revisionVersion returned by the prior drive_read_file. If supplied and the file\'s current revisionVersion no longer matches, the update is rejected with a revision_conflict error instea… |

### `update_yaml_file`

Patch a YAML-content Google Doc in one MCP call: the server reads the current content + revisionVersion, parses it as YAML (treating empty/missing as `{}`), merges `patch` into the existing YAML, serializes back to YAML, and writes with optimistic-concurrency. On a `revision_conflict` (a concurrent writer landed between read and write) the call retries once with the freshly-observed revision. Two …

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fileId` | `z.string` | **required** | The Google Drive file ID of the YAML doc |
| `patch` | `z.record` | **required** | _—_ |
| `merge` | `z.enum` | optional | _—_ |

### `drive_create_file`

Create a new Google Doc in Drive with the given name and content, inside the given parent folder. By default, find-or-update: if a same-name file already exists under the parent (non-trashed), its content is replaced with `content` and its id is returned — no duplicate is created. Pass `findOrCreate:false` to force a new sibling. Body is uploaded as `text/plain; charset=utf-8` so non-ASCII text (e…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `z.string` | **required** | Name for the new file |
| `content` | `z.string` | **required** | Text content for the file |
| `parentFolderId` | `z.string` | **required** | _—_ |
| `findOrCreate` | `z.boolean` | optional | _—_ |

### `drive_create_doc_from_markdown`

Create a new Google Doc by uploading markdown content and letting Drive natively convert it to a styled Google Doc. Drive interprets `# `/`## `/`### ` as Heading 1/2/3 (so the Docs outline sidebar works), `**bold**` and `*italic*` as native runs, `[text](url)` as hyperlinks, `-`/`*` lists as native bullets, fenced ``` blocks as monospace, and pipe tables as native tables. Use this instead of `driv…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `z.string` | **required** | Name for the new Google Doc |
| `markdown` | `z.string` | **required** | _—_ |
| `parentFolderId` | `z.string` | **required** | _—_ |
| `findOrCreate` | `z.boolean` | optional | _—_ |

### `drive_copy_file`

Copy an existing Google Drive file server-side into a parent folder, optionally with a new name. Wraps Drive\'s native files.copy(), so a Google Doc copy stays a Google Doc, a markdown copy stays markdown, etc. — preserves mimeType and content without ferrying bytes through the model. Use this instead of drive_read_file + drive_create_file whenever the goal is "copy file X to folder Y" — it saves …

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sourceFileId` | `z.string` | **required** | The Drive file ID to copy from |
| `parentFolderId` | `z.string` | **required** | _—_ |
| `name` | `z.string` | optional | _—_ |

### `drive_upload_binary`

Upload a binary file (PNG, JPG, PDF, audio, video, etc.) to Google Drive inside the given parent folder. Accepts content via base64 string (contentBase64) OR a local file path (localFilePath) — use localFilePath for large files like videos to avoid passing megabytes through the context window. The MCP uses Drive\'s media-upload path with the supplied mime type, so the file lands as its native type…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `z.string` | **required** | _—_ |
| `contentBase64` | `z.string` | optional | File content, base64-encoded. Provide either this OR localFilePath, not both. |
| `localFilePath` | `z.string` | optional | Absolute path to a local file to upload. Reads directly from disk — avoids passing large binaries through the context window. Provide either this OR contentBase64, not both. |
| `mimeType` | `z.string` | **required** | _—_ |
| `parentFolderId` | `z.string` | **required** | _—_ |
| `shareAnyoneWithLink` | `z.boolean` | optional | _—_ |

### `drive_download_binary`

Download a binary or non-Google-Doc file from Google Drive and return its bytes base64-encoded. The companion atom to `drive_upload_binary`. Use for PDFs, docx/xlsx/pptx, images, audio, zip (CCZ), etc. — any mimeType that `drive_read_file` rejects with `unsupported_binary_mimetype`. Returns `{ id, name, mimeType, size, content_base64 }`. Caller is responsible for decoding (e.g. `Buffer.from(conten…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fileId` | `z.string` | **required** | The Google Drive file ID. Resolves Drive shortcuts transparently. |

### `drive_set_anyone_with_link`

Grant `role: reader, type: anyone` (anyone-with-link) on an existing Drive file. Required for any PNG that downstream Slides `createImage` will fetch — Slides\' image-import service does NOT carry the SA\'s auth, so an SA-only file renders as a blank image in the deck. `drive_upload_binary` accepts a `shareAnyoneWithLink` flag that does this inline at upload time; use this atom when the file alrea…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fileId` | `z.string` | **required** | _—_ |

### `drive_create_folder`

Create a new folder in Google Drive, inside the given parent folder. By default, find-or-create: if a same-named folder already exists under the parent, that folder is returned instead of creating a duplicate (closes the duplicate-`verdicts/` class of bug from parallel skill writes). Pass findOrCreate:false to force a new sibling. The parent MUST be a folder on a Shared Drive — when the parent is …

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `z.string` | **required** | Name for the new folder |
| `parentFolderId` | `z.string` | **required** | _—_ |
| `findOrCreate` | `z.boolean` | optional | _—_ |

### `drive_create_shortcut`

Create a Google Drive shortcut (mimeType application/vnd.google-apps.shortcut) under `parentFolderId` pointing at `targetId`. The orchestrator uses this to refresh `<opp>/current/` shortcuts after each phase completes — e.g. `<opp>/current/connect-opp-summary.md → runs/<latest>/4-connect/connect-opp-setup.md`. With findOrReplace=true, any prior file/shortcut with the same `name` under the parent i…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `z.string` | **required** | _—_ |
| `parentFolderId` | `z.string` | **required** | _—_ |
| `targetId` | `z.string` | **required** | _—_ |
| `findOrReplace` | `z.boolean` | optional | When true, delete any prior same-name file/shortcut under `parentFolderId` before creating. Default: false. Use true to make `current/` pointers idempotent. |

### `drive_move_file`

Move an existing file into a different folder in Google Drive

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fileId` | `z.string` | **required** | The file ID to move |
| `newParentFolderId` | `z.string` | **required** | The destination folder ID |

### `drive_rename_file`

Rename an existing file or folder in Google Drive. Only the display name changes — file ID, parents, content, and web link stay the same. Useful for in-place file renames (e.g. state.yaml → run_state.yaml during the 0.11.4 migration).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fileId` | `z.string` | **required** | The file or folder ID to rename |
| `newName` | `z.string` | **required** | _—_ |

### `drive_trash_file`

Move a file or folder to the Google Drive bin. Recoverable for 30 days via the Drive UI; after that, Drive permanently deletes it. Use this for cleanup paths where you want the operation reversible — e.g. removing the stub `state.yaml` files left after the 0.11.4 → run_state.yaml migration. Sets `trashed: true` via files.update; does NOT call files.delete (which is irreversible).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fileId` | `z.string` | **required** | The file or folder ID to trash |

### `drive_transfer_ownership`

Transfer ownership of a file or folder to another Google account

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fileId` | `z.string` | **required** | The file or folder ID |
| `email` | `z.string` | **required** | Email address of the new owner |

### `drive_diagnose`

Test Drive API access - checks scopes, lists recent files the SA can see, and tests a specific file ID

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `testFileId` | `z.string` | optional | Optional file ID to test direct access |

### `docs_get`

Read the full structured JSON of a Google Doc — paragraphs, tables, smart chips, inline objects, and all element indices. Use this to inspect document structure before making edits via docs_batch_update.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `documentId` | `z.string` | **required** | The Google Doc ID from the URL |
| `tabId` | `z.string` | optional | _—_ |

### `docs_batch_update`

Execute raw Google Docs API batchUpdate requests. Supports all 40 request types: insertText, replaceAllText, deleteContentRange, insertTable, updateTextStyle, etc. See https://developers.google.com/docs/api/reference/rest/v1/documents/request for the full request schema.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `documentId` | `z.string` | **required** | The Google Doc ID |
| `requests` | `z.array` | **required** | _—_ |

### `docs_copy_template`

Copy a Google Doc template and optionally replace placeholder text. Smart chips (person chips, dates, building blocks) survive the copy. Use placeholders like {{NAME}} in the template, then pass replacements to fill them in. Useful for ACE training materials, PDD templates, and onboarding email templates.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `templateDocId` | `z.string` | **required** | The template Google Doc ID to copy |
| `title` | `z.string` | **required** | Title for the new document |
| `replacements` | `z.record` | **required** | _—_ |
| `parentFolderId` | `z.string` | optional | _—_ |

### `docs_finalize_bullets`

Finalize an ACE-template-rendered Google Doc by applying real Google Docs bullet styling to paragraphs enclosed in `<<<BULLETS_<NAME>_START>>>` / `<<<BULLETS_<NAME>_END>>>` anchor pairs, then deleting the two anchor paragraphs. Call AFTER `docs_copy_template` when the template wraps variable-length bulleted regions in anchor pairs (so the skill\'s cell-level token replacement can emit `\ `-separat…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `documentId` | `z.string` | **required** | The Google Doc ID |

### `slides_get`

Read the full structured JSON of a Google Slides presentation — slides, page elements (text boxes, images, shapes), speakerNotes, masters, layouts, and all element object IDs. Use this to inspect deck structure before making edits via slides_batch_update.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `presentationId` | `z.string` | **required** | The Google Slides presentation ID from the URL |

### `slides_batch_update`

Execute raw Google Slides API batchUpdate requests. Supports all request types: createSlide, insertText, createImage, updatePageElementTransform, updateSpeakerNotesProperties, etc. See https://developers.google.com/slides/api/reference/rest/v1/presentations/request for the full schema. For ACE training decks, the typical sequence is: createSlide (with layout) → createShape/createImage → insertText…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `presentationId` | `z.string` | **required** | The Google Slides presentation ID |
| `requests` | `z.array` | **required** | _—_ |

### `slides_copy_template`

Copy a Google Slides template deck into a Shared-Drive folder. Mirrors `docs_copy_template`. ACE training-deck workflow: the template contains stencil slides with placeholder text like {{TITLE}} / {{BODY}} that subsequent slides_batch_update calls fill in. Returns the new presentationId and webViewLink. Optional `replacements` runs a single deck-wide replaceAllText pass for any quick global substi…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `templatePresentationId` | `z.string` | **required** | The template Google Slides presentation ID to copy |
| `title` | `z.string` | **required** | Title for the new presentation |
| `parentFolderId` | `z.string` | **required** | Destination Shared-Drive folder ID. REQUIRED — Service Accounts cannot write to My Drive. |
| `replacements` | `z.record` | **required** | _—_ |

### `resolve_opp_path`

Resolve an ACE opportunity's Drive folder paths in one call. Given an opp slug (and an optional ACE root folder ID — defaults to $ACE_DRIVE_ROOT_FOLDER_ID), returns `{slug, ace_root_id, opp_root_id, inputs_id, runs_id}`. Replaces the 3-call drive_list_folder dance at run-init: list ACE root → find opp by name → list opp root → find inputs/ + runs/. `runs_id` is null on first-run opps where the run…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `slug` | `z.string` | **required** | _—_ |

### `resolve_current_run_id`

Return the most-recent run-id for opp `<slug>` plus its run-folder ID. Lists `<opp>/runs/` and picks the lexicographically-largest folder name (run-ids are `YYYYMMDD-HHMM`, so lex order matches chronological order). Returns `{slug, run_id, run_folder_id}` — both `run_id` and `run_folder_id` are `null` when the opp has no runs yet. Replaces the dead `opp.yaml.last_run_id` read pattern (the orchestr…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `slug` | `z.string` | **required** | _—_ |

### `generate_inputs_manifest`

Generate a structured inputs manifest for an ACE opportunity's `inputs/` Drive folder. Lists every file in the folder, resolves shortcut targetIds (so a shortcut to a PDD doc surfaces the real target), and assigns each file a kebab-cased `input_key` (e.g. \"sample-pdd.docx\" → \"sample-pdd\") that downstream skills can key off. Returns `{folder_id, generated_at, files: [{file_id, name, mime_type, …

_no parameters_

### `get_google_form_definition`

Read a Google Forms form definition via the Forms API (forms.googleapis.com/v1/forms/{formId}). Returns `{form_id, title, description?, items: [{item_id, title, description?, kind, required, options?}, ...]}` where `kind` is one of `radio | checkbox | dropdown | choice | short_answer | paragraph | scale | date | time | file_upload | grid | unknown`. Replaces the workaround of reading the linked Re…

_no parameters_

### `validate_run_state`

Validate a run_state.yaml file's shape against the Phase Write-Back Contract. Reads the YAML from Drive (one call, with the same transient-error retry handleReadFile uses), parses it, and returns `{valid, errors, warnings}` where each issue carries `{path, message, severity, expected?, actual?}`. Use to confirm a phase actually wrote its block correctly — particularly after an `Agent(<phase>)` dis…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fileId` | `z.string` | **required** | The Google Drive fileId of run_state.yaml. |

### `classify_phase_writeback`

Single-line answer to 'did `<phaseName>` write its run_state.yaml block correctly?' Reads run_state.yaml from Drive, parses it, and returns `{status: 'ok' | 'missing' | 'in_progress' | 'error' | 'malformed', phase: <name>}`. The orchestrator's silent-dispatch retry should treat 'missing', 'in_progress', and 'malformed' as retry triggers (agent claimed success but didn't write properly); 'error' is…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fileId` | `z.string` | **required** | The Google Drive fileId of run_state.yaml. |

### `verify_phase_artifacts`

Verify every artifact the manifest declares required for `phase` is present in the run folder's per-phase subfolder. Returns `{phase, ok, missing, present_count, expected_count}` where each `missing` entry carries `{path, producedBy, description}` — `producedBy` tells the orchestrator which skill to re-dispatch to heal. Pair with `classify_phase_writeback` in the boundary fence's parallel block: w…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `runFolderId` | `z.string` | **required** | _—_ |

### `render_run_readme`

Render the run-folder README markdown for `runId` with optional per-phase status overrides (keys: idea-to-design | scenarios-and-acceptance | commcare-setup | connect-setup | ocs-setup | qa-and-training | synthetic-data-and-workflows | solicitation-management | execution-management | closeout; values: pending | in-progress | done | skipped). Returns `{markdown}`. The orchestrator writes this direc…

_no parameters_

## ace-connect

Source: `mcp/connect-server.ts` — 46 atoms

### `connect_list_programs`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `name` | `z.string` | optional | _—_ |

### `connect_get_program`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `program_id` | `z.string` | **required** | _—_ |

### `connect_create_program`

PM-side org slug (must be a program-manager org).

_no parameters_

### `connect_update_program`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `program_id` | `z.string` | **required** | _—_ |
| `name` | `z.string` | optional | _—_ |
| `description` | `z.string` | optional | _—_ |
| `start_date` | `z.string` | optional | _—_ |
| `end_date` | `z.string` | optional | _—_ |

### `connect_list_delivery_types`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |

### `connect_list_opportunities`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `program_id` | `z.string` | optional | _—_ |
| `name` | `z.string` | optional | _—_ |

### `connect_get_opportunity`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `opportunity_id` | `z.string` | **required** | _—_ |

### `connect_create_opportunity`

PM-side org running the program.

_no parameters_

### `connect_update_opportunity`

Max 50 chars — DB-enforced (see connect_create_opportunity for the full bisect note).

_no parameters_

### `connect_set_verification_flags`

Set per-opportunity verification toggles via the `/opportunity/<id>/verification_flags_config/` HTML form (not yet on the public REST API; routes through Playwright). Supports the top-level booleans (`duplicate` / `gps` / `catchment_areas`), the numeric `gps_radius_meters` field (renamed from the historic `location: boolean` typo), submission-window times, and the per-deliver-unit attachment / dur…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `opportunity_id` | `z.string` | **required** | _—_ |

### `connect_list_deliver_units`

List deliver units for an opportunity. Each entry has `id` (per-opp display index 1/2/3…), `name`, `slug`, plus `server_id` — the server-side primary key suitable for `connect_create_payment_unit.required_deliver_units` / `optional_deliver_units`. `server_id` is populated by reading the create-payment-unit form\'s checkbox values; absent only on the rare degraded path where that secondary fetch fa…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `opportunity_id` | `z.string` | **required** | _—_ |

### `connect_create_payment_units`

Atomic batch — server validates DU assignments across the whole list

_no parameters_

### `connect_create_payment_unit`

Required for managed opportunities.

_no parameters_

### `connect_list_payment_units`

List payment units on an opportunity. **HTML-scraped read-back has known unreliable fields:** `amount` returns undefined (the table doesn\'t render it); `max_total` and `max_daily` are mislabeled / swapped on some pages (verified live on `malaria-itn-fgd/20260514-2352` Phase 4); `required_deliver_units` returns `[]` regardless of actual config. **Use `createPaymentUnit`\'s response object for roun…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `opportunity_id` | `z.string` | **required** | _—_ |

### `connect_activate_opportunity`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `opportunity_id` | `z.string` | **required** | _—_ |

### `connect_send_llo_invite`

PM-side org running the program.

_no parameters_

### `connect_accept_program_application`

ProgramApplication UUID returned by `connect_send_llo_invite`.

_no parameters_

### `connect_list_invites`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `program_id` | `z.string` | **required** | _—_ |

### `connect_send_flw_invite`

Opportunity must be active and not ended.

_no parameters_

### `connect_delete_unaccepted_flw_invites`

Hard-delete unaccepted FLW invites by integer id. Invites with `status=accepted` are silently skipped server-side (those represent real workers and cannot be deleted via this endpoint). Associated `OpportunityAccess` rows cascade-delete. Used by `/ace:sweep connect` to clean up orphan invites tied to deactivated opportunities. Routes through Playwright to the `@csrf_exempt` `/opportunity/<opp_id>/…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `opportunity_id` | `z.string` | **required** | _—_ |
| `user_invite_ids` | `z.array` | **required** | _—_ |

### `connect_list_invoices`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `opportunity_id` | `z.string` | **required** | _—_ |

### `connect_get_invoice`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `invoice_id` | `z.string` | **required** | _—_ |

### `commcare_list_apps`

List CommCare HQ applications in a domain. Hits the REST API at GET /a/<domain>/api/v0.4/application/ (domain-scoped — the unscoped /api/v0.4/application/?domain= form returns 404 from Django routing) using the existing PlaywrightSession cookie jar (allow_session_auth=True on CCHQ\'s TaskPie resource — no separate API key needed). Returns id, name, and doc_type per app. Soft-deleted apps (doc_type…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `z.string` | **required** | _—_ |

### `commcare_delete_app`

Soft-delete a CommCare HQ application. POST /a/<domain>/apps/delete_app/<app_id>/ via the web view (no REST equivalent — the view soft-deletes by mutating doc_type to `<original>-Deleted` and creates a DeleteApplicationRecord for restore). Restore is possible via HQ admin UI\'s "deleted applications" list. Routes through the existing PlaywrightSession (session cookies + CSRF from cookie jar; API k…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `z.string` | **required** | _—_ |
| `app_id` | `z.string` | **required** | _—_ |

### `commcare_create_domain`

Create a new CommCare HQ project space (domain). POST /register/domain/ via the DomainRegistrationForm CSRF-protected web view (no REST equivalent — corehq/apps/registration/views.py:RegisterDomainView). For an existing (non-new) user — which ACE\'s ace@dimagi-ai.com always is — success is a 302 to /a/<slug>/dashboard/; the returned `domain` is the slug HQ derived from `hr_name`. `hr_name` is capp…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `hr_name` | `z.string` | **required** | _—_ |
| `org` | `z.string` | optional | _—_ |

### `commcare_get_lookup_table`

Fetch a CommCare HQ lookup table by tag (name). GET /a/<domain>/api/v0.5/lookup_table/ via Tastypie (session auth OK). Lists all tables in the domain and returns the one whose `tag` matches; returns `{table: null}` if not found. Use this to verify a lookup table exists before appending rows (see also commcare_lookup_table_append_rows, planned).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `z.string` | **required** | _—_ |
| `tag` | `z.string` | **required** | _—_ |

### `commcare_create_lookup_table`

Create a new CommCare HQ lookup table. POST /a/<domain>/api/v0.5/lookup_table/ via Tastypie. Body: {tag, is_global, fields: [{field_name, properties}], item_attributes}. Returns the new table\'s UUID hex id. Rejects with 400 if a table with the same tag already exists in the domain.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `z.string` | **required** | _—_ |
| `tag` | `z.string` | **required** | _—_ |
| `fields` | `z.array` | **required** | _—_ |
| `properties` | `z.array` | **required** | _—_ |
| `is_global` | `z.boolean` | optional | _—_ |
| `item_attributes` | `z.array` | **required** | _—_ |

### `commcare_list_user_fields`

Read the current custom-user-data field definition for a CommCare HQ domain. GET /a/<domain>/users/user_data/ and parse the <div data-name="custom_fields"> initial_page_data div (HQ\'s standard Django→JS bootstrap). Returns the list of fields (slug, label, is_required, choices, regex) + the list of profiles. Requires can_edit_commcare_users permission; 302s to settings/users/ surface as a typed er…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `z.string` | **required** | _—_ |

### `commcare_set_user_fields`

Write the full custom-user-data field definition for a domain (DESTRUCTIVE — replaces existing). POST CustomDataFieldsForm to /a/<domain>/users/user_data/ with `data_fields` JSON-encoded. Direct form POST bypasses the React/Knockout UI (verified against apps/custom_data_fields/edit_model.py:491). Callers SHOULD list_user_fields first, merge their additions, then call this. The atom doesn\'t do the…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `z.string` | **required** | _—_ |
| `fields` | `z.array` | **required** | _—_ |
| `label` | `z.string` | optional | _—_ |
| `is_required` | `z.boolean` | optional | _—_ |
| `choices` | `z.array` | **required** | _—_ |
| `regex` | `z.string` | optional | _—_ |
| `regex_msg` | `z.string` | optional | _—_ |
| `required_for` | `z.array` | **required** | _—_ |
| `upstream_id` | `z.string` | optional | _—_ |
| `profiles` | `z.array` | **required** | _—_ |
| `purge_existing` | `z.boolean` | optional | If true, purge user_data on existing users for removed fields. Default false. |

### `commcare_list_ucr_expressions`

List named UCR expressions / filters on a CommCare HQ domain. POST /a/<domain>/data/ucr_expressions/ with action=paginate via CRUDPaginatedView. Returns id, name, expression_type ("named_expression" | "named_filter"), description, parsed definition JSON. Auth: session (BaseProjectDataView).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `z.string` | **required** | _—_ |
| `limit` | `z.number` | **required** | _—_ |

### `commcare_create_ucr_expression`

Create a named UCR expression or filter on a domain. POST the UCRExpressionForm to /a/<domain>/data/ucr_expressions/ via action=create. Required fields: name, expression_type ("named_expression" | "named_filter"), definition (JSON spec). The Connect Interviews bootstrap creates 4: "Register User OCS" + "Trigger OCS Bot" (named_filter), "Session Completion API" + "24 hr Expiry API" (named_expressio…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `z.string` | **required** | _—_ |
| `name` | `z.string` | **required** | _—_ |
| `expression_type` | `z.enum` | **required** | _—_ |
| `definition` | `z.record` | **required** | _—_ |
| `description` | `z.string` | optional | _—_ |

### `commcare_list_inbound_apis`

List Inbound API configurations on a CommCare HQ domain. POST /a/<domain>/motech/inbound/ with action=paginate. Returns each API\'s id, name, description, api_url, edit_url. Pro Edition / DATA_FORWARDING required.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `z.string` | **required** | _—_ |
| `limit` | `z.number` | **required** | _—_ |

### `commcare_create_inbound_api`

Create an Inbound API configuration. POST the ConfigurableAPICreateForm to /a/<domain>/motech/inbound/ via CRUDPaginatedViewMixin\'s action=create. Requires filter_expression_id (UCR FK) and optionally transform_expression_id — these UCR expressions must exist on the domain first (typically pushed via linked_domain in the Connect Interviews flow). Returns new id and name. The Connect Interviews "S…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `z.string` | **required** | _—_ |
| `name` | `z.string` | **required** | _—_ |
| `description` | `z.string` | optional | _—_ |
| `filter_expression_id` | `z.number` | **required** | _—_ |
| `transform_expression_id` | `z.number` | **required** | _—_ |
| `backend` | `z.enum` | optional | _—_ |

### `commcare_create_repeater`

Create a Data-Forwarding Repeater on a CommCare HQ domain. POST the GenericRepeaterForm (or BaseExpressionRepeaterForm for *ExpressionRepeater types) to /a/<domain>/motech/forwarding/new/<repeater_type>/. Plain FormRepeater forwards every submission; FormExpressionRepeater applies a UCR filter (configured_filter) and emits a UCR-derived payload (configured_expression) — the Connect Interviews "OCS…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `z.string` | **required** | _—_ |
| `repeater_type` | `z.enum` | **required** | _—_ |
| `connection_settings_id` | `z.number` | **required** | _—_ |
| `name` | `z.string` | optional | _—_ |
| `request_method` | `z.enum` | optional | _—_ |
| `format` | `z.string` | optional | _—_ |
| `configured_filter` | `z.record` | **required** | _—_ |
| `configured_expression` | `z.record` | **required** | _—_ |
| `url_template` | `z.string` | optional | _—_ |

### `commcare_list_connections`

List Connection settings (motech outbound connections) on a CommCare HQ domain. POST /a/<domain>/motech/conn/ with action=paginate via the CRUDPaginatedView. Returns each connection\'s id, name, url, notify_addresses, used_by. Gated by privileges.DATA_FORWARDING (Pro Edition) — 404s without it. Used by verifier to confirm "Connect Interviews" and "OCS Interviews Bot" connections exist.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `z.string` | **required** | _—_ |
| `limit` | `z.number` | **required** | _—_ |

### `commcare_create_connection`

Create a Connection (motech outbound connection settings). POST the ConnectionSettingsForm to /a/<domain>/motech/conn/add/ (form-encoded, CSRF-protected). Success redirects to the list view — atom re-lists by name to recover the new id. Auth types per corehq/motech/auth.py: none, basic, digest, bearer, oauth1, oauth2_pwd, oauth2_client, api_key. Pro Edition required (DATA_FORWARDING privilege).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `z.string` | **required** | _—_ |
| `name` | `z.string` | **required** | _—_ |
| `url` | `z.string` | **required** | _—_ |
| `auth_type` | `z.enum` | optional | _—_ |
| `username` | `z.string` | optional | _—_ |
| `plaintext_password` | `z.string` | optional | _—_ |
| `client_id` | `z.string` | optional | _—_ |
| `plaintext_client_secret` | `z.string` | optional | _—_ |
| `token_url` | `z.string` | optional | _—_ |
| `notify_addresses_str` | `z.string` | optional | Comma-separated emails for failure notifications. |
| `skip_cert_verify` | `z.boolean` | optional | _—_ |
| `plaintext_custom_headers` | `z.string` | optional | JSON string of custom headers (e.g. \'{"Authorization": "Token xyz"}\ |

### `commcare_get_case`

Fetch a single CommCare HQ case by case_id. GET /a/<domain>/api/v0.5/case/<id>/?format=json via Tastypie (API-key auth — CaseResource sets RequirePermissionAuthentication(edit_data) without allow_session_auth). Returns the case\'s dynamic property bag (commcare-user case has session_completion / last_bot_interaction_date / interaction_validation written by OCS-to-HQ custom action). 404 surfaces as…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `z.string` | **required** | _—_ |
| `case_id` | `z.string` | **required** | _—_ |

### `commcare_list_users`

List mobile workers (CommCareUser) in a CommCare HQ domain. GET /a/<domain>/api/v0.5/user/ via Tastypie (API key auth). Supports standard Tastypie pagination (limit/offset) and group filter. Returns each user\'s id, username, basic profile, and the full user_data dict (including custom fields like cohort_id). Used by verifier to confirm cohort_id is set on the right FLWs.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `z.string` | **required** | _—_ |
| `limit` | `z.number` | **required** | _—_ |
| `offset` | `z.number` | **required** | _—_ |
| `group` | `z.string` | optional | _—_ |

### `commcare_get_user`

Fetch a single CommCare HQ mobile worker by id. GET /a/<domain>/api/v0.5/user/<user_id>/. Returns the full record including user_data.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `z.string` | **required** | _—_ |
| `user_id` | `z.string` | **required** | _—_ |

### `commcare_update_user_field`

Set a single custom-user-data field on a mobile worker. Implemented as GET → mutate user_data → PUT (v0_5 CommCareUserResource exposes PUT but not PATCH, so we PUT the merged user_data). Pass value=null to clear the field. Used by per-FLW cohort_id assignment after Learn completion.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `z.string` | **required** | _—_ |
| `user_id` | `z.string` | **required** | _—_ |
| `field_slug` | `z.string` | **required** | _—_ |
| `value` | `z.union` | **required** | _—_ |

### `commcare_get_lookup_table_rows`

Get rows of a CommCare HQ lookup table. GET /a/<domain>/api/v0.5/lookup_table_item/ via Tastypie (API key auth). Tastypie returns ALL rows in the domain (no querystring filter); this atom client-side filters by data_type_id resolved from the supplied tag or UUID. Returns each row\'s fields as a flat map (column → first field_value).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `z.string` | **required** | _—_ |
| `table_id_or_tag` | `z.string` | **required** | _—_ |

### `commcare_lookup_table_append_rows`

Append rows to a CommCare HQ lookup table. POST /a/<domain>/api/v0.5/lookup_table_item/ once per row (Tastypie doesn\'t support list POST for this resource). Each row is a flat field_name→string-value map; HQ wraps it into its field_list shape internally. Used by the cohort-create skill to populate interview_schedule rows for a new cohort.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `z.string` | **required** | _—_ |
| `table_id_or_tag` | `z.string` | **required** | _—_ |
| `rows` | `z.array` | **required** | _—_ |
| `item_attributes` | `z.record` | **required** | _—_ |

### `commcare_link_domains`

Set up a linked-project-spaces relationship: upstream (master) → downstream. Required before linked-app push / linked content sync. POST /a/<upstream>/linked_domain/service/ via the jQuery-RMI protocol (corehq/util/jqueryrmi.py + corehq/apps/linked_domain/views.py:DomainLinkRMIView.create_domain_link). Caller must have access in both domains. Pro Edition is required for the LITE_RELEASE_MANAGEMENT…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `upstream_domain` | `z.string` | **required** | _—_ |
| `downstream_domain` | `z.string` | **required** | _—_ |

### `commcare_make_build`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `z.string` | **required** | _—_ |
| `app_id` | `z.string` | **required** | _—_ |
| `comment` | `z.string` | optional | _—_ |

### `commcare_release_build`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `z.string` | **required** | _—_ |
| `app_id` | `z.string` | **required** | _—_ |
| `build_id` | `z.string` | **required** | _—_ |

### `commcare_download_ccz`

If true, request the full CCZ with multimedia binaries inlined under commcare/multimedia/...; default false returns the lite manifest-only response.

_no parameters_

## ace-ocs

Source: `mcp/ocs-server.ts` — 32 atoms

### `ocs_clone_chatbot`

Clone an OCS chatbot from a template. Returns the new experiment_id, public_id, and pipeline_id.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `template_id` | `z.number` | **required** | _—_ |
| `new_name` | `z.string` | **required** | _—_ |

### `ocs_create_chatbot`

Create a brand-new OCS chatbot from scratch (not by cloning). POST /a/<team>/chatbots/new/ via the CSRF-protected ChatbotForm (apps/chatbots/views.py:CreateChatbot, apps/chatbots/forms.py:ChatbotForm — fields: name + optional description). On success, OCS auto-creates a default Pipeline with the team\'s first LLM provider and 302-redirects to /edit/. Returns { experiment_id, pipeline_id }. Does NO…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `z.string` | **required** | _—_ |
| `description` | `z.string` | optional | _—_ |

### `ocs_link_action_to_node`

Link a Custom Action operation to a pipeline node. GET/POST /a/<team>/pipelines/data/<pipeline_id>/ — appends "<custom_action_id>:<operation_id>" to the target node\'s data.params.custom_actions array. String format verified against apps/custom_actions/form_utils.py:make_model_id. Idempotent: skips if the model_id is already present. Typically the target node is an LLMResponseWithPrompt.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pipeline_id` | `z.number` | **required** | _—_ |
| `node_id` | `z.string` | **required** | _—_ |
| `custom_action_id` | `z.number` | **required** | _—_ |
| `operation_id` | `z.string` | **required** | _—_ |

### `ocs_add_custom_action`

Create an OCS Custom Action (an OpenAPI-driven external tool the LLM can call). POST /a/<team>/actions/new/ via the CSRF-protected CustomActionForm (apps/custom_actions/forms.py + views.py:CreateCustomAction). The api_schema field takes an OpenAPI 3.x schema as a JSON or YAML string — operationIds within the schema become the action\'s allowed_operations. Returns action_id, found by scraping /a/<t…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `z.string` | **required** | _—_ |
| `server_url` | `z.string` | **required** | _—_ |
| `api_schema` | `z.string` | **required** | OpenAPI 3.x schema as JSON or YAML string. operationIds become the action\'s allowed_operations. |
| `description` | `z.string` | optional | _—_ |
| `prompt` | `z.string` | optional | Additional instructions to the LLM about how to use this action. |
| `healthcheck_path` | `z.string` | optional | Optional health endpoint path; auto-detected from schema if omitted. |

### `ocs_add_chatbot_event`

Attach a timeout-trigger event to a chatbot. POST /a/<team>/chatbots/<experiment_id>/events/timeout/new/ via the combined _create_event_view (apps/events/views.py) which takes THREE forms in one POST: TimeoutTriggerForm (delay seconds, total_num_triggers, trigger_from_first_message), EventActionForm (action_type), and a per-action-type params form. Returns {ok: true} — the view does NOT expose the…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `experiment_id` | `z.number` | **required** | _—_ |
| `delay_seconds` | `z.number` | **required** | _—_ |
| `total_num_triggers` | `z.number` | **required** | _—_ |
| `trigger_from_first_message` | `z.boolean` | optional | _—_ |
| `action_type` | `z.enum` | **required** | _—_ |
| `action_params` | `z.record` | **required** | _—_ |

### `ocs_add_pipeline_node`

Add a node to a chatbot\'s pipeline graph. GET-mutate-POST the pipeline JSON at /a/<team>/pipelines/data/<pipeline_id>/ — same shape as the existing LLM-patch atoms. Supports splice-into-existing-edge: pass `disconnect_edge: {source:A, target:B}` + `connect_from: A` + `connect_to: B` to turn A→B into A→new→B (the typical pattern for inserting Router or Python nodes between Start and the default LL…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pipeline_id` | `z.number` | **required** | _—_ |
| `node_type` | `z.string` | **required** | OCS data.type value — e.g. "DynamicRouterNode", "PythonNode", "LLMResponseWithPrompt", "StartNode", "EndNode". |
| `node_id` | `z.string` | optional | Explicit node id; auto-generated if omitted. |
| `position` | `z.object` | **required** | _—_ |
| `y` | `z.number` | **required** | _—_ |
| `params` | `z.record` | **required** | _—_ |
| `connect_from` | `z.string` | optional | Existing node id; if set, creates edge connect_from→new_node. |
| `connect_to` | `z.string` | optional | Existing node id; if set, creates edge new_node→connect_to. |
| `disconnect_edge` | `z.object` | **required** | _—_ |
| `target` | `z.string` | **required** | _—_ |

### `ocs_set_chatbot_system_prompt`

Update the LLMResponseWithPrompt node's prompt field for this chatbot. NOTE: when also changing collection_index_ids in the same operator-visible step, prefer ocs_set_chatbot_pipeline — it does both updates in a single transactional save and avoids the cross-field validation chicken-and-egg (e.g. setting a prompt with `{collection_index_summaries}` when no collections are attached, or vice versa).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `experiment_id` | `z.number` | **required** | _—_ |
| `prompt` | `z.string` | **required** | _—_ |

### `ocs_set_chatbot_pipeline`

Transactional update of the LLMResponseWithPrompt node's params: prompt + collections + tools + source material in one save. Any field omitted is preserved from the existing pipeline. OCS cross-field rule (verified 2026-04-28): the FINAL prompt must contain `{collection_index_summaries}` iff FINAL collection_index_ids.length >= 2. Pre-flight raises a typed error in either violation direction. Use …

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `experiment_id` | `z.number` | **required** | _—_ |
| `prompt` | `z.string` | optional | _—_ |
| `collection_index_ids` | `z.array` | **required** | _—_ |
| `max_results` | `z.number` | optional | _—_ |
| `generate_citations` | `z.boolean` | optional | _—_ |
| `source_material_id` | `z.number` | optional | _—_ |
| `tools` | `z.array` | **required** | _—_ |
| `custom_actions` | `z.array` | **required** | _—_ |
| `built_in_tools` | `z.array` | **required** | _—_ |
| `mcp_tools` | `z.array` | **required** | _—_ |

### `ocs_create_collection`

Create a new Collection (RAG knowledge base) in OCS. For indexed collections (is_index=true), llm_provider and embedding_model are required — defaults from OCS_LLM_PROVIDER_ID and OCS_EMBEDDING_MODEL_ID env vars.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `z.string` | **required** | _—_ |
| `summary` | `z.string` | **required** | _—_ |
| `is_index` | `z.boolean` | **required** | _—_ |
| `is_remote_index` | `z.boolean` | **required** | _—_ |
| `llm_provider` | `z.number` | optional | LLM provider ID. Defaults to OCS_LLM_PROVIDER_ID env var. |
| `embedding_model` | `z.number` | optional | Embedding model ID. Defaults to OCS_EMBEDDING_MODEL_ID env var. |

### `ocs_upload_collection_files`

Upload files to an existing Collection. Each file MUST supply EXACTLY ONE source: `file_path` (local filesystem path — MCP reads + base64-encodes server-side, preferred for any payload >1KB) OR `content` (caller-supplied base64 — legacy inline mode, only sensible for tiny strings). Mixing both, or supplying neither, fails fast. The file_path mode exists because emitting megabytes of base64 in the …

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `collection_id` | `z.number` | **required** | _—_ |
| `files` | `z.array` | **required** | _—_ |
| `content` | `z.string` | optional | _—_ |
| `file_path` | `z.string` | optional | _—_ |
| `mime_type` | `z.string` | **required** | _—_ |
| `chunk_size` | `z.number` | optional | Chunk size in tokens. Default 800. |
| `chunk_overlap` | `z.number` | optional | Chunk overlap in tokens. Must be < chunk_size. Default 400. |

### `ocs_wait_for_collection_indexing`

Poll until the specified files in a Collection have been indexed (chunked + embedded). Pass the file_ids returned by ocs_upload_collection_files.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `collection_id` | `z.number` | **required** | _—_ |
| `file_ids` | `z.array` | **required** | _—_ |
| `timeout_sec` | `z.number` | optional | _—_ |

### `ocs_attach_knowledge`

Attach one or more Collections to a chatbot's retriever node. OCS cross-field rule (verified 2026-04-28 via live probe): the prompt MUST contain `{collection_index_summaries}` if and only if `collection_index_ids.length >= 2`. Single or zero collections must NOT include the variable; multiple collections MUST include it. The MCP pre-flights both directions and fails fast with a typed PipelineValid…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `experiment_id` | `z.number` | **required** | _—_ |
| `collection_index_ids` | `z.array` | **required** | _—_ |
| `max_results` | `z.number` | optional | _—_ |
| `generate_citations` | `z.boolean` | optional | _—_ |

### `ocs_set_chatbot_tools`

Configure the chatbot's tools, custom actions, built-in tools, and MCP tools.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `experiment_id` | `z.number` | **required** | _—_ |
| `tools` | `z.array` | **required** | _—_ |
| `custom_actions` | `z.array` | **required** | _—_ |
| `built_in_tools` | `z.array` | **required** | _—_ |
| `mcp_tools` | `z.array` | **required** | _—_ |

### `ocs_set_source_material`

Point a chatbot's legacy SourceMaterial FK at a specific row. Use null to clear.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `experiment_id` | `z.number` | **required** | _—_ |
| `source_material_id` | `z.number` | optional | _—_ |

### `ocs_publish_chatbot_version`

Publish a new default version of a chatbot.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `experiment_id` | `z.number` | **required** | _—_ |
| `description` | `z.string` | **required** | _—_ |

### `ocs_get_chatbot_embed_info`

Fetch the public_id and embed_key needed to render the OCS widget.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `experiment_id` | `z.number` | **required** | _—_ |

### `ocs_delete_chatbot`

Delete a chatbot (user-visible effect: the chatbot disappears from listings; mechanism is OCS setting is_archived=True server-side). SAFE PER-OPP: each ACE clone has its own Experiment row, so deleting one clone does not affect the golden template or other opps. CRITICAL — callers MUST exclude OCS_GOLDEN_TEMPLATE_ID from the set of ids passed to this atom; the atom itself has no concept of "templa…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `experiment_id` | `z.number` | **required** | _—_ |

### `ocs_get_chatbot_pipeline_id`

Resolve an experiment_id (integer chatbot id) to its working-version pipeline_id (integer). The OCS REST `/api/experiments/<id>/` response omits pipeline_id by design; this atom scrapes it from the pipeline-builder HTML (`SiteJS.pipeline.renderPipeline("#pipelineBuilder", "<team>", <pipeline_id>)`) via Playwright and caches the result per experiment_id. Used by /ace:sweep ocs to pair each orphan c…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `experiment_id` | `z.number` | **required** | _—_ |

### `ocs_delete_pipeline`

Delete a pipeline (sets is_archived=True server-side). SAFE PER-OPP: when ACE clones a chatbot, Pipeline.create_new_version(is_copy=True) deep-clones the Pipeline row + its nodes — each clone has its own pipeline. Deleting the pipeline does NOT cascade-delete its referenced Collections — those need separate ocs_delete_collection calls. Routes through Playwright to /a/<team>/pipelines/<pk>/delete/ …

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pipeline_id` | `z.number` | **required** | _—_ |

### `ocs_delete_collection`

Delete a collection (calls Collection.archive() server-side — sets is_archived=True AND triggers delete_document_source_task to async-purge underlying File rows + object-storage blobs + FileChunkEmbedding vectors; the user-visible effect is full deletion). SAFE PER-OPP for collections created fresh by Phase 5 (those are not shared). CRITICAL — callers MUST exclude OCS_GOLDEN_TEMPLATE_COLLECTION_ID…

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `collection_id` | `z.number` | **required** | _—_ |

### `ocs_list_chatbots`

List chatbots on the OCS team. Each entry includes both `id` (UUID public_id, used by ocs_get_chatbot/ocs_send_test_message) AND `experiment_id` (integer, used by every authoring atom: ocs_set_chatbot_system_prompt, ocs_attach_knowledge, ocs_publish_chatbot_version, etc.). Use this to find an existing bot by name and reconfigure it idempotently — no need to clone if it already exists.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cursor` | `z.string` | optional | _—_ |
| `page_size` | `z.number` | optional | _—_ |

### `ocs_get_chatbot`

Retrieve a single chatbot by its public UUID (from ocs_list_chatbots). Returns both `id` (UUID) and `experiment_id` (integer) — the latter is required by every authoring atom.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `public_id` | `z.string` | **required** | _—_ |

### `ocs_list_sessions`

List sessions, optionally filtered by experiment, tags, or since-date.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `experiment_id` | `z.string` | optional | _—_ |
| `since` | `z.string` | optional | _—_ |
| `tags` | `z.string` | optional | _—_ |
| `versions` | `z.string` | optional | _—_ |
| `cursor` | `z.string` | optional | _—_ |
| `page_size` | `z.number` | optional | _—_ |

### `ocs_get_session`

Retrieve a session with its full message history.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `session_id` | `z.string` | **required** | _—_ |

### `ocs_end_session`

Mark a session as ended.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `session_id` | `z.string` | **required** | _—_ |

### `ocs_add_session_tags`

Add tags to a session.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `session_id` | `z.string` | **required** | _—_ |
| `tags` | `z.array` | **required** | _—_ |

### `ocs_remove_session_tags`

Remove tags from a session.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `session_id` | `z.string` | **required** | _—_ |
| `tags` | `z.array` | **required** | _—_ |

### `ocs_update_session_state`

Patch the arbitrary state blob on a session.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `session_id` | `z.string` | **required** | _—_ |
| `state` | `z.record` | **required** | _—_ |

### `ocs_send_test_message`

Send a test message to a chatbot via the anonymous widget chat API. Requires the public_id and embed_key from ocs_get_chatbot_embed_info.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `public_id` | `z.string` | **required** | UUID public_id of the chatbot |
| `embed_key` | `z.string` | **required** | _—_ |
| `message` | `z.string` | **required** | The message to send |

### `ocs_trigger_bot_message`

Trigger the bot to send a message to a participant on a given channel.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `experiment_id` | `z.string` | **required** | _—_ |
| `identifier` | `z.string` | **required** | _—_ |
| `platform` | `z.string` | **required** | _—_ |
| `prompt_text` | `z.string` | **required** | _—_ |
| `session_data` | `z.record` | **required** | _—_ |
| `participant_data` | `z.record` | **required** | _—_ |

### `ocs_update_participant_data`

Create or update participant data across one or more experiments.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `identifier` | `z.string` | **required** | _—_ |
| `platform` | `z.string` | **required** | _—_ |
| `data` | `z.array` | **required** | _—_ |
| `data` | `z.record` | **required** | _—_ |
| `schedules` | `z.array` | **required** | _—_ |

### `ocs_download_file`

Download a file from OCS by file ID.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file_id` | `z.number` | **required** | _—_ |

## ace-mobile

Source: `mcp/mobile-server.ts` — 14 atoms

### `mobile_ensure_avd_running`

ACE_Pixel_API_34

_no parameters_

### `mobile_stop_avd`

text

_no parameters_

### `mobile_list_avds`

text

_no parameters_

### `mobile_install_apk`

text

_no parameters_

### `mobile_uninstall_apk`

text

_no parameters_

### `mobile_register_test_user`

ACE_Pixel_API_34

_no parameters_

### `mobile_capture_ui_dump`

text

_no parameters_

### `mobile_probe_maestro_driver`

AVD name (e.g. ACE_Pixel_API_34). Must already be booted — this atom does not boot.

_no parameters_

### `mobile_resolve_selectors`

Maestro YAML body containing `${SELECTOR:logical-name}` placeholders to resolve.

_no parameters_

### `mobile_save_snapshot`

text

_no parameters_

### `mobile_load_snapshot`

text

_no parameters_

### `mobile_diagnose`

text

_no parameters_

### `mobile_restart_runner`

Block until the runner re-sets the ready marker (default true). False is fire-and-forget — returns a partial Diagnostics snapshot immediately.

_no parameters_

### `mobile_patch_launch_script`

Full new body of /usr/local/bin/ace-emulator-launch. Must start with '#!/bin/bash'. Server enforces a 64KB cap.

_no parameters_

## ace-decisions

Source: `mcp/decisions-server.ts` — 1 atoms

### `decisions_append_rows`

Append validated load-bearing default rows to a run\'s decisions.yaml. The MCP transport enforces `lib/decisions-schema.ts` v3 on every row, so malformed writes (wrong field names, missing required fields, non-ordinal phase tags) are rejected at the call boundary — they never reach Drive. The tool seeds a fresh v3-compliant log header when decisions.yaml doesn\'t exist yet, and is idempotent: rows…

_no parameters_

## connect-labs (proxy)

Source: `mcp/connect-labs-server.ts` — 0 atoms
