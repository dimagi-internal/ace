# ACE MCP Atom Schemas

Auto-generated catalog of every registered atom across the five MCP servers. **Do not hand-edit.** Regenerate with:

```bash
npx tsx scripts/dump-atom-schemas.ts
```

Purpose: single source of truth skill authors can grep against. PR review surfaces atom-schema diffs as diffs to this file. See PR-P for full rationale.

For the deterministic atom-rename / remove drift check, see `test/skill-atom-references.test.ts` (PR-K).

## ace-gdrive

Source: `mcp/google-drive-server.ts` — 45 atoms

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

### `drive_list_comments`

List the comment threads a reviewer left on a Drive file (Docs, Sheets, Slides). ACE publishes the PDD as a Google Doc SO THAT reviewers can comment on it and grants `commenter` for exactly that — this is the atom that reads what they wrote, so a comment no longer depends on a human noticing it and retyping it into `inputs/`. Returns `{file_id, total, comments: [{id, author, created_time, modified_time, resolved, content, quoted_text, anchor, replies: [{author, created_time, content}]}]}`. **`quoted_text` is the point.** Drive returns the document text the comment is anchored to (`quotedFileContent`), so a caller can bind a comment to the SECTION it sits on rather than guessing from prose. That is what makes it possible to detect a comment contradicting the text it is attached to — the failure mode a hand transcription cannot see, because transcription throws the anchor away. `resolved: true` marks a thread someone closed in the Drive UI. They are returned by default (`includeResolved`, default true) because a resolved thread is still evidence of what was asked — do not confuse resolved with honoured. Deleted comments are never returned; Drive drops them. Runs as the service account, which owns the artifacts ACE generates. Verified against a live Shared Drive file: create → list → delete round-trips, and the SA reads comments on its own PDD and Work Order. Note the SA and `ace@dimagi-ai.com` have DIFFERENT grants — `gog drive comments` (the ace@ path) 403s on SA-created files, so use this atom for anything ACE produced.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fileId` | `z.string` | **required** | The Google Drive file ID to read comments from. |
| `includeResolved` | `z.boolean` | optional | Include threads marked resolved in the Drive UI. Default true — a resolved thread still records what the reviewer asked for, and "resolved" means someone closed the thread, NOT that the build honoured it. |
| `maxResults` | `z.number` | optional | Max comment threads to return (default 100, the Drive page maximum). |

### `drive_reply_to_comment`

Post a reply on a Drive comment thread, optionally resolving or reopening it. The write half of `drive_list_comments`, and the step that closes the review loop: a reviewer who commented in place should learn where their comment LANDED without having to ask. `action: 'resolve'` marks the thread resolved (verified live: Drive returns the reply with `action: resolve` and the comment then reads `resolved: true`). `action: 'reopen'` undoes it. Omit `action` to reply without changing thread state. **Resolve ONLY after the comment has been written into durable opp-level state** — a feedback record under `ACE/<opp>/feedback/`, an `open-questions.md` row, or a decision. Each run writes a NEW PDD document, so a comment lives on a doc no later run produces: resolving a thread whose substance was not carried forward destroys the only remaining copy. Say in the reply exactly where it landed, so the thread is an audit trail pointing at the durable record rather than the record itself. Runs as the service account — correct for artifacts ACE generated.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fileId` | `z.string` | **required** | The Google Drive file ID the comment is on. |
| `commentId` | `z.string` | **required** | The comment thread id, from `drive_list_comments`. |
| `content` | `z.string` | **required** | The reply body. Name WHERE the comment landed (the durable record, question row, or decision id) — not just that it was handled. |
| `action` | `z.enum` | optional | Optional. 'resolve' closes the thread, 'reopen' undoes that. Omit to reply without changing state. Only resolve once the substance is in durable opp-level state. |

### `drive_read_file`

Read the text content of a file in Google Drive. Works with Google Docs (exported as plain text), text/* files (markdown, plain text, etc.), and JSON/YAML/XML/CSV variants. Refuses non-text mimetypes (PDF, docx/xlsx/pptx, images, audio, zip) with a typed `unsupported_binary_mimetype` error pointing at `drive_download_binary` — pre-#106-finding-4 the read returned raw binary as a JSON-corrupted string and silently fed garbage into callers. Returns revisionVersion so callers can pair the read with an optimistic-concurrency `ifMatchRevisionId` on `drive_update_file` (read-modify-write without lost updates). Transient 5xx responses are retried internally (3 attempts, 1s/2s/4s backoff). Three delivery modes — pick by how much of the document you actually need in context: - Default (no extra args): returns the whole document inline. Refused with a typed `oversized_document` error above 40,000 characters, since a larger result blows the tool-result token budget. - `writeToPath` (preferred for large or whole-document reads): writes the full text to that absolute local path and returns `{path, name, mimeType, total_length, revisionVersion}` with NO content — costs zero context regardless of file size. Then grep or read that file, ideally inside a subagent so the content never enters your context at all. Use this whenever you need the whole document, and especially when you only need a fact out of it. - `offset`/`limit` (in characters): returns one slice inline plus `{total_length, offset, returned_length, has_more}`. Walk with `offset += returned_length` until `has_more` is false. Note that paging a large document to completion still spends its full size in context — `writeToPath` is cheaper for that; paging is for a bounded peek, e.g. identifying a doc or reading one section. `writeToPath` cannot be combined with `offset`/`limit` — it always writes the complete document. `exportAs` (Google Docs only, default `text/plain`) picks the export format. Pass `text/markdown` ONLY to read a human-facing PROSE doc back as markdown — a doc written via `drive_create_doc_from_markdown` round-trips to clean markdown (headings, bold, links, tables), so this is the right way to re-read a partner-edited PDD or training guide and feed the edits back into a run. NEVER pass it for a MACHINE-PARSED doc: ACE stores `run_state.yaml`, `opp.yaml`, `decisions.yaml` and every `*_verdict.yaml` as Google Docs, and Drive's markdown exporter escapes markdown-significant characters (`---` becomes `\---`, `run_id` becomes `run\_id`), which breaks `update_yaml_file`, `validate_run_state` and every YAML parser downstream. Keep the default for anything you intend to parse. Ignored for non-Docs files (text/*, JSON, YAML), whose stored bytes are returned verbatim either way.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fileId` | `z.string` | **required** | The Google Drive file ID |
| `writeToPath` | `z.string` | optional | Optional. Absolute local path to write the full document text to. When set, no content is returned inline (costs zero context regardless of file size) — the response is a {path, total_length} handle you then read or grep locally. Preferred for large files and for whole-document reads. Missing parent directories are created. Mutually exclusive with offset/limit. |
| `offset` | `z.number` | optional | Optional. Zero-based CHARACTER index of the first character to return (default 0). Use with limit to page a large document; advance by the returned `returned_length`. An offset past the end returns empty content with has_more=false rather than erroring. |
| `limit` | `z.number` | optional | Optional. Max CHARACTERS to return inline (default: to the end of the document). Must be 40,000 or less — a larger slice is refused with oversized_document, so limit cannot be used to bypass the inline budget. |
| `exportAs` | `z.enum` | optional | Optional. Export format for NATIVE GOOGLE DOCS. Default text/plain. Use text/markdown only for human-facing prose docs you want back as markdown; it ESCAPES markdown-significant characters, so it corrupts YAML/JSON docs (run_state.yaml, decisions.yaml, verdict files) — keep the default for anything that will be parsed. Ignored for non-Docs files. |

### `read_personal_drive_doc`

Read a Google Drive document via personal OAuth (gog CLI) — fallback for files shared with the human user account but not the ACE service account. The gog identity is resolved from config/agent.json (`email` + `gog_client`, the SHARED fleet client — normally `canopy`), falling back to $ACE_GMAIL_ACCOUNT/$ACE_GMAIL_CLIENT. If the account has not yet granted Drive scope, re-run: `gog login <email> --client <gog_client> --services gmail,drive`. Use only when drive_read_file fails with a permission error.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file_id` | `z.string` | **required** | The Google Drive file ID |
| `format` | `z.enum` | optional | Export format for Google Docs/Sheets (default: txt for Docs, csv for Sheets) |

### `drive_update_file`

Update the text content of an existing Google Doc in Drive. Use for updating PDDs, summaries, and other docs as ACE skills produce new content. Content comes from exactly ONE of `content` (inline, small updates only — refused above 40,000 chars with a typed `oversized_inline_content` error) or `localFilePath` (preferred for anything large: the server reads the bytes off disk, so a read-modify-write via `drive_read_file writeToPath` → local edit → this call costs ~zero context regardless of file size, and the fileId — and every shared URL — is preserved, unlike `drive_upload_binary`, which mints a new file). Pass `ifMatchRevisionId` (from a prior `drive_read_file`) to opt into optimistic-concurrency CAS — the write is rejected with a typed `revision_conflict` error if another writer changed the file in between, so the caller can re-read and retry without overwriting concurrent edits. Required pattern for any read-modify-write on a shared file (e.g., opp.yaml updates from concurrent /ace:run invocations).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fileId` | `z.string` | **required** | The Google Drive file ID |
| `content` | `z.string` | optional | The new text content, inline. Small updates only (max 40,000 chars). Provide either this OR localFilePath, not both. |
| `localFilePath` | `z.string` | optional | Absolute path to a local file whose utf-8 content becomes the new file content. Reads directly from disk — avoids passing the whole document through the context window. Provide either this OR content, not both. Mirrors drive_upload_binary's param of the same name. |
| `ifMatchRevisionId` | `z.string` | optional | Optional. The revisionVersion returned by the prior drive_read_file. If supplied and the file's current revisionVersion no longer matches, the update is rejected with a revision_conflict error instead of overwriting the change. |

### `update_yaml_file`

Patch a YAML-content Google Doc in one MCP call: the server reads the current content + revisionVersion, parses it as YAML (treating empty/missing as `{}`), merges `patch` into the existing YAML, serializes back to YAML, and writes with optimistic-concurrency. On a `revision_conflict` (a concurrent writer landed between read and write) the call retries once with the freshly-observed revision. Three merge modes — pick one based on what you're patching. **In ALL THREE, an array value is REPLACED wholesale, never merged or appended (ace#1467)** — build the whole list and write it once: - `shallow` (default): `patch[k]` *replaces* `base[k]` for every top-level key `k`. Predictable, matches the historical behavior. Use for whole-subtree updates (e.g., `connect: { opportunity_id: 2, status: "active" }` to fully overwrite the `connect:` block). - `two-level`: for top-level keys whose value is a plain object on BOTH sides, the merge recurses one level — child keys from `patch[k]` are merged into `base[k]` (with `patch` winning on conflicts), preserving sibling child keys. For non-object values (strings, numbers, arrays) and for keys present on only one side, the behavior is identical to `shallow`. Use for incremental run_state.yaml writes where each phase agent owns one entry under `phases:` / `gates:` and must not clobber sibling entries written by other phases. - `deep`: recurses at EVERY depth for object-valued keys, so a partial nested patch preserves siblings at all levels. This is the right default for incremental run_state.yaml writes. Note the array rule above: `deep` does not deep-merge lists. Use this tool for run_state.yaml / opp.yaml updates instead of pairing drive_read_file + drive_update_file by hand: it saves one round-trip per state transition AND keeps the full file content out of the model context (the model only sends the diff). For arbitrary text files use drive_update_file instead.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fileId` | `z.string` | **required** | The Google Drive file ID of the YAML doc |
| `patch` | `z.record` | **required** | _—_ |
| `merge` | `z.enum` | optional | Merge strategy. Defaults to `shallow` (top-level replace) for back-compat. `two-level` merges ONE level deep (top-level-key children preserved, grandchildren replaced wholesale) — use it ONLY when you resend a phase's COMPLETE child block. `deep` recursively merges OBJECT keys at every depth (preserves sibling keys at all levels) — use it when patching a nested path like `phases.<phase>.steps.<step>` or `phases.<phase>.products.<block>` without resending the whole phase block. **ARRAYS ARE REPLACED WHOLESALE UNDER EVERY MODE, `deep` INCLUDED** — recursion only happens when the value is a plain object on both sides, so an array-valued key (e.g. `phases.<phase>.residuals`) is ASSIGNED, not merged or appended. To change one element of a list, read the list, build the full intended array, and write that array once (ace#1467). Prefer `deep` for incremental run_state.yaml writes: it eliminates the lost-update footgun where a partial `two-level` phase-child patch silently dropped the rest of the block (jjackson/ace#572). |
| `validateAs` | `z.object` | **required** | _—_ |
| `phase` | `z.string` | **required** | The phase whose products block this patch writes (e.g. "connect-setup", "qa-and-training"). |

### `drive_create_file`

Create a new Google Doc in Drive with the given name and content, inside the given parent folder. By default, find-or-update: if a same-name file already exists under the parent (non-trashed), its content is replaced with `content` and its id is returned — no duplicate is created. Pass `findOrCreate:false` to force a new sibling. Body is uploaded as `text/plain; charset=utf-8` so non-ASCII text (em-dashes, accents, smart quotes) round-trips correctly. The parent MUST be a folder on a Shared Drive — Service Accounts have zero My-Drive quota, so files created in My Drive fail with a misleading "user storage quota exceeded" error. Used by ACE skills (idea-to-pdd, pdd-to-learn-app, etc.) to write artifacts to opportunity folders.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `z.string` | **required** | Name for the new file |
| `content` | `z.string` | **required** | Text content for the file |
| `parentFolderId` | `z.string` | **required** | Required. Parent folder ID — MUST be a folder on a Shared Drive (the MCP verifies this before writing). |
| `findOrCreate` | `z.boolean` | optional | When true (default), reuse an existing same-name file under the parent and overwrite its content; otherwise always create a new sibling. Default: true. Set to false only when you specifically want a separate sibling each call. |

### `drive_create_doc_from_markdown`

Create a new Google Doc by uploading markdown content and letting Drive natively convert it to a styled Google Doc. Drive interprets `# `/`## `/`### ` as Heading 1/2/3 (so the Docs outline sidebar works), `**bold**` and `*italic*` as native runs, `[text](url)` as hyperlinks, `-`/`*` lists as native bullets, fenced ``` blocks as monospace, and pipe tables as native tables. Use this instead of `drive_create_file` whenever you want a rendered gdoc — `drive_create_file` uploads as `text/plain` and the markdown markers remain literal characters. Same find-or-create semantics: by default reuses any same-name file under the parent (default true). The parent MUST live on a Shared Drive — same Service Account quota constraint as `drive_create_file`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `z.string` | **required** | Name for the new Google Doc |
| `markdown` | `z.string` | **required** | Markdown body. Drive converts: # → H1, ## → H2, ### → H3, **bold**, *italic*, [text](url), -/* lists, ```code```, \| tables \|. Smart quotes / em-dashes / accents round-trip cleanly via UTF-8. |
| `parentFolderId` | `z.string` | **required** | Required. Parent folder ID — MUST be a folder on a Shared Drive. |
| `findOrCreate` | `z.boolean` | optional | When true (default), reuse an existing same-name file under the parent and overwrite its content; otherwise always create a new sibling. Default: true. |

### `drive_copy_file`

Copy an existing Google Drive file server-side into a parent folder, optionally with a new name. Wraps Drive's native files.copy(), so a Google Doc copy stays a Google Doc, a markdown copy stays markdown, etc. — preserves mimeType and content without ferrying bytes through the model. Use this instead of drive_read_file + drive_create_file whenever the goal is "copy file X to folder Y" — it saves a full content round-trip (~6KB+ per PDD-sized doc and ~minutes of model serialization latency). The destination parent MUST live on a Shared Drive — same Service Account quota constraint as drive_create_file.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sourceFileId` | `z.string` | **required** | The Drive file ID to copy from |
| `parentFolderId` | `z.string` | **required** | Required. Destination folder ID — MUST be a folder on a Shared Drive (the MCP verifies this before writing). |
| `name` | `z.string` | optional | Optional name for the copy (defaults to the source file's name). |

### `drive_upload_binary`

Upload a binary file (PNG, JPG, PDF, audio, video, etc.) to Google Drive inside the given parent folder. Accepts content via base64 string (contentBase64) OR a local file path (localFilePath) — use localFilePath for large files like videos to avoid passing megabytes through the context window. The MCP uses Drive's media-upload path with the supplied mime type, so the file lands as its native type (NOT auto-converted to a Google Doc — that's what `drive_create_file` is for). Pass `shareAnyoneWithLink: true` to atomically grant `role: reader` to `type: anyone` on the new file. By default, find-or-create: a same-name non-folder sibling under the parent has its BYTES REPLACED and keeps its id, so a corrected re-upload does not leave two files the name-matching `verify_phase_artifacts` fence would both count as present (dimagi-internal/ace#1324); pass `findOrCreate:false` to force a new sibling. The parent MUST be a folder on a Shared Drive.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `z.string` | **required** | Name for the new file (include the extension — e.g., "screen-01.png", not "screen-01") |
| `contentBase64` | `z.string` | optional | File content, base64-encoded. Provide either this OR localFilePath, not both. |
| `localFilePath` | `z.string` | optional | Absolute path to a local file to upload. Reads directly from disk — avoids passing large binaries through the context window. Provide either this OR contentBase64, not both. |
| `mimeType` | `z.string` | **required** | MIME type of the binary content. Common ACE values: "image/png", "image/jpeg", "application/pdf", "audio/mpeg", "video/mp4", "application/zip" (CCZ). |
| `parentFolderId` | `z.string` | **required** | Required. Parent folder ID — MUST be a folder on a Shared Drive (the MCP verifies this before writing). |
| `shareAnyoneWithLink` | `z.boolean` | optional | When true, after a successful upload set sharing to `role: reader, type: anyone` (anyone-with-link). Required for any PNG that downstream Slides `createImage` will fetch — Slides' image-import service does not carry the SA's auth. Default: false. |
| `findOrCreate` | `z.boolean` | optional | When true (default), reuse an existing same-name non-folder file under the parent and REPLACE its bytes — the id and every already-shared URL survive. Otherwise always create a new sibling. Default: true. Set false only when you specifically want a separate sibling each call (e.g. timestamped captures that share a base name). |

### `drive_download_binary`

Download a binary or non-Google-Doc file from Google Drive. The companion atom to `drive_upload_binary`. Use for PDFs, docx/xlsx/pptx, images, audio, zip (CCZ), etc. — any mimeType that `drive_read_file` rejects with `unsupported_binary_mimetype`. Transient 5xx responses retried internally (3 attempts, 1s/2s/4s backoff). Tracking: jjackson/ace#106 finding 4. Two delivery modes: - `writeToPath` (STRONGLY preferred): writes the bytes to that absolute local path and returns `{id, name, mimeType, size, path}` with NO base64 — costs zero context regardless of file size. This is the mode to pair with anything that takes a local path: `ocs_upload_collection_files`' `file_path`, `commcare_validate_ccz`' `ccz_path`, or your own PDF/DOCX extractor. Mirrors `commcare_download_ccz`' `write_to_path`. - Default (no `writeToPath`): returns `content_base64`, which costs ~1.33x the file size in context and is refused above 40,000 base64 characters (~30 KB of file) with a typed `oversized_binary` error. Only use this for genuinely tiny files, or when you cannot write to disk. Caller decodes (`Buffer.from(content_base64, "base64")`, `base64.b64decode`). Server-side text extraction is intentionally NOT done here so this stays a pure transport atom — skills that need text from a PDF/DOCX should `writeToPath` and run their own extractor over the file.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fileId` | `z.string` | **required** | The Google Drive file ID. Resolves Drive shortcuts transparently. |
| `writeToPath` | `z.string` | optional | Optional but strongly preferred. Absolute local path to write the bytes to. Returns a {path, size} handle instead of content_base64, so a large download costs zero context. Missing parent directories are created. This is what makes the documented "download to a tmp path, then pass it as file_path" recipe expressible. |

### `drive_set_anyone_with_link`

Grant an anyone-with-link permission (`type: anyone`) on an existing Drive file. Three roles, three uses: **`reader`** (default) for any PNG that downstream Slides `createImage` will fetch — Slides' image-import service does NOT carry the SA's auth, so an SA-only file renders as a blank image in the deck; **`commenter`** for a document someone is meant to read and react to — a Drive reader physically cannot comment (`skills/feedback-ledger`'s `channel: gdoc-comments` assumes they can); **`writer`** for a document a partner is meant to CO-CREATE — ACE opportunities are co-created, so feedback also arrives as revisions, and a commenter cannot edit. Verified working on the ACE Shared Drive 2026-08-14 (the tenant does not cap link sharing at commenter). ⚠ `writer` here means ANYONE with the URL can edit or delete the file — when you know who the collaborators are, prefer `drive_share_with_person` (`type: user`), which is the precise primitive for edit access. `drive_upload_binary` accepts a `shareAnyoneWithLink` flag that does the reader grant inline at upload time; use this atom when the file already exists, was uploaded without the flag, or needs a higher role. Idempotent per role: Drive ignores a duplicate `type: anyone` grant at the same role.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fileId` | `z.string` | **required** | The Drive file ID to share. Must be a file the SA can access. |
| `role` | `z.enum` | optional | Permission role for the anyone-with-link grant. Default 'reader' (view only). 'commenter' when the recipient should be able to leave comments — a reader cannot. 'writer' when they should be able to EDIT (co-creation); note this grants edit/delete to anyone the URL is forwarded to — prefer drive_share_with_person when the collaborators are known. |

### `drive_share_with_person`

Share a Drive file with a NAMED person (`type: user`) at `role: writer` (default), `commenter`, or `reader`. This is the primitive for **co-creation**: ACE opportunities are co-created with partners, so a partner engaging with a run's artifacts should be able to EDIT them — and you know who your participants are, whereas anyone-with-link `writer` lets anyone the URL is forwarded to edit or delete the doc. Prefer this over `drive_set_anyone_with_link` whenever the collaborators are known by email. ⚠ **This atom does NOT email anyone by default.** Drive's permissions API normally sends the grantee a notification email; `sendNotificationEmail` is forced to `false` unless you explicitly pass `true`, because ACE's outbound email is gated through `bin/ace-email` and a Drive-sent notification would route around that gate. Send the person the link yourself through the normal email path. Verified against the ACE Shared Drive 2026-08-14: a `writer` grant with the notification off returns a `type: user` permission id and reads back in `permissions.list`. If Drive rejects a grant (unknown account, drive-level sharing policy), the atom returns Drive's own error rather than guessing — call it and read the result.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fileId` | `z.string` | **required** | The Drive file ID to share. Must be a file the SA can access. |
| `email` | `z.string` | **required** | The grantee's email address (Google account). Internal or external — external partner collaborators are the whole point of this atom. |
| `role` | `z.enum` | optional | Permission role. Default 'writer' — the co-creation grant, which lets the person edit the document. Use 'commenter' for read-and-react, 'reader' for view-only. |
| `sendNotificationEmail` | `z.boolean` | optional | Whether Drive should email the grantee that the file was shared. **Defaults to false.** ACE never silently emails an external party as a side effect of a permission change — outbound email goes through bin/ace-email, which is hook-gated. Pass true ONLY when a human has explicitly approved a Drive-sent notification. |

### `drive_create_folder`

Create a new folder in Google Drive, inside the given parent folder. By default, find-or-create: if a same-named folder already exists under the parent, that folder is returned instead of creating a duplicate (closes the duplicate-`verdicts/` class of bug from parallel skill writes). Pass findOrCreate:false to force a new sibling. The parent MUST be a folder on a Shared Drive — when the parent is in My Drive (or unset), the new folder lands in the SA's My Drive root and every subsequent file write into it fails with a "user storage quota exceeded" error. ACE uses this to set up the per-opportunity folder structure (ACE/<opp-name>/).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `z.string` | **required** | Name for the new folder |
| `parentFolderId` | `z.string` | **required** | Required. Parent folder ID — MUST be a folder on a Shared Drive (the MCP verifies this before writing). |
| `findOrCreate` | `z.boolean` | optional | When true (default), reuse an existing same-named folder under the parent if one exists; otherwise always create. Default: true. Set to false only when you specifically want a separate sibling. |

### `drive_create_shortcut`

Create a Google Drive shortcut (mimeType application/vnd.google-apps.shortcut) under `parentFolderId` pointing at `targetId`. The orchestrator uses this to refresh `<opp>/current/` shortcuts after each phase completes — e.g. `<opp>/current/connect-opp-summary.md → runs/<latest>/4-connect/connect-opp-setup.md`. With findOrReplace=true, any prior file/shortcut with the same `name` under the parent is deleted before the new shortcut is created (semantics: "swap the pointer atomically"). Default findOrReplace=false because Drive permits multiple same-named entries; only set it to true when you intend the shortcut to be a single canonical pointer. The parent MUST live on a Shared Drive — same Service Account quota constraint as drive_create_file / drive_create_folder.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `z.string` | **required** | Display name for the shortcut (include the extension to mirror the target — e.g., "connect-opp-summary.md"). |
| `parentFolderId` | `z.string` | **required** | Required. Parent folder ID — MUST be a folder on a Shared Drive (the MCP verifies this before writing). |
| `targetId` | `z.string` | **required** | The file or folder ID the shortcut should point at. |
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
| `newName` | `z.string` | **required** | The new file/folder name |

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
| `tabId` | `z.string` | optional | Specific tab ID (omit for first tab) |

### `docs_batch_update`

Execute raw Google Docs API batchUpdate requests. Supports all 40 request types: insertText, replaceAllText, deleteContentRange, insertTable, updateTextStyle, etc. See https://developers.google.com/docs/api/reference/rest/v1/documents/request for the full request schema.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `documentId` | `z.string` | **required** | The Google Doc ID |
| `requests` | `z.array` | **required** | _—_ |

### `render_decisions_log`

Render a run's decisions.yaml into its decisions.gdoc at one stable URL — read + render + clear + batchUpdate done entirely server-side. Pass the run-folder file ID; the atom reads decisions.yaml from it, renders the prose log via lib/decisions-renderer, and find-or-updates decisions.gdoc in the same folder (idempotent). Use this instead of hand-relaying renderDecisionsLog output through docs_batch_update.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `runFolderFileId` | `z.string` | **required** | Drive file ID of the run folder (ACE/<opp>/runs/<run-id>/) containing decisions.yaml |

### `docs_copy_template`

Copy a Google Doc template and optionally replace placeholder text. Smart chips (person chips, dates, building blocks) survive the copy. Use placeholders like {{NAME}} in the template, then pass replacements to fill them in. Useful for ACE training materials, PDD templates, and onboarding email templates.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `templateDocId` | `z.string` | **required** | The template Google Doc ID to copy |
| `title` | `z.string` | **required** | Title for the new document |
| `replacements` | `z.record` | **required** | _—_ |
| `parentFolderId` | `z.string` | optional | Destination folder ID (omit to create in same location as template) |

### `docs_finalize_bullets`

Finalize an ACE-template-rendered Google Doc by applying real Google Docs bullet styling to paragraphs enclosed in `<<<BULLETS_<NAME>_START>>>` / `<<<BULLETS_<NAME>_END>>>` anchor pairs, then deleting the two anchor paragraphs. Call AFTER `docs_copy_template` when the template wraps variable-length bulleted regions in anchor pairs (so the skill's cell-level token replacement can emit `\ `-separated bullet items without per-bullet token slots). Idempotent — re-runs are no-ops once all anchors have been processed. Returns the count of anchor pairs processed.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `documentId` | `z.string` | **required** | The Google Doc ID |

### `slides_get`

Read the full structured JSON of a Google Slides presentation — slides, page elements (text boxes, images, shapes), speakerNotes, masters, layouts, and all element object IDs. Use this to inspect deck structure before making edits via slides_batch_update.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `presentationId` | `z.string` | **required** | The Google Slides presentation ID from the URL |

### `slides_batch_update`

Execute raw Google Slides API batchUpdate requests. Supports all request types: createSlide, insertText, createImage, updatePageElementTransform, updateSpeakerNotesProperties, etc. See https://developers.google.com/slides/api/reference/rest/v1/presentations/request for the full schema. For ACE training decks, the typical sequence is: createSlide (with layout) → createShape/createImage → insertText → optionally updateTextStyle.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `presentationId` | `z.string` | **required** | The Google Slides presentation ID |
| `requests` | `z.array` | **required** | _—_ |

### `slides_copy_template`

Copy a Google Slides template deck into a Shared-Drive folder. Mirrors `docs_copy_template`. ACE training-deck workflow: the template contains stencil slides with placeholder text like {{TITLE}} / {{BODY}} that subsequent slides_batch_update calls fill in. Returns the new presentationId and webViewLink. Optional `replacements` runs a single deck-wide replaceAllText pass for any quick global substitutions; per-slide-scoped replacements happen via slides_batch_update.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `templatePresentationId` | `z.string` | **required** | The template Google Slides presentation ID to copy |
| `title` | `z.string` | **required** | Title for the new presentation |
| `parentFolderId` | `z.string` | **required** | Destination Shared-Drive folder ID. REQUIRED — Service Accounts cannot write to My Drive. |
| `replacements` | `z.record` | **required** | _—_ |

### `resolve_opp_path`

Resolve an ACE opportunity's Drive folder paths in one call. Given an opp slug (and an optional ACE root folder ID — defaults to $ACE_DRIVE_ROOT_FOLDER_ID), returns `{slug, ace_root_id, opp_root_id, inputs_id, runs_id}`. Replaces the 3-call drive_list_folder dance at run-init: list ACE root → find opp by name → list opp root → find inputs/ + runs/. `runs_id` is null on first-run opps where the runs/ subfolder doesn't exist yet (callers create it). Errors loudly on missing opp or ambiguous slug (multiple folders with the same name).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `slug` | `z.string` | **required** | The opportunity slug (folder name under ACE root). |
| `aceRootFolderId` | `z.string` | optional | Override $ACE_DRIVE_ROOT_FOLDER_ID for tests / multi-tenant. |

### `resolve_current_run_id`

Return the most-recent run-id for opp `<slug>` plus its run-folder ID. Lists `<opp>/runs/` and picks the lexicographically-largest folder name (run-ids are `YYYYMMDD-HHMM`, so lex order matches chronological order). Returns `{slug, run_id, run_folder_id}` — both `run_id` and `run_folder_id` are `null` when the opp has no runs yet. Replaces the dead `opp.yaml.last_run_id` read pattern (the orchestrator stopped writing that field; see `lib/artifact-manifest.ts`). Used by Phase 7 synthetic skills when invoked standalone via `/ace:step` to discover which run folder to operate on; inside `/ace:run`, the phase agent already knows the current run-id and shouldn't need this call.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `slug` | `z.string` | **required** | The opportunity slug (folder name under ACE root). |
| `aceRootFolderId` | `z.string` | optional | Override $ACE_DRIVE_ROOT_FOLDER_ID for tests / multi-tenant. |

### `generate_inputs_manifest`

Generate a structured inputs manifest for an ACE opportunity's `inputs/` Drive folder. Lists every file in the folder, resolves shortcut targetIds (so a shortcut to a PDD doc surfaces the real target), and assigns each file a kebab-cased `input_key` (e.g. "sample-pdd.docx" → "sample-pdd") that downstream skills can key off. Returns `{folder_id, generated_at, files: [{file_id, name, mime_type, input_key, resolved_target_id?, resolved_target_mime_type?, modified_time?, web_view_link?}, ...]}`. Replaces the hand-assembled inputs-manifest.yaml step that ran at every /ace:run start. Snapshot semantics: returns the folder state at the moment of the call — same freshness as the prior manual process.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `folderId` | `z.string` | **required** | The Google Drive folder ID of the opp's inputs/ folder. |

### `get_google_form_definition`

Read a Google Forms form definition via the Forms API (forms.googleapis.com/v1/forms/{formId}). Returns `{form_id, title, description?, items: [{item_id, title, description?, kind, required, options?}, ...]}` where `kind` is one of `radio | checkbox | dropdown | choice | short_answer | paragraph | scale | date | time | file_upload | grid | unknown`. Replaces the workaround of reading the linked Responses sheet — that approach is lossy (no option text, no required flag, no question kind) and only works after the form has at least one response. Use whenever a file in inputs/ has MIME `application/vnd.google-apps.form` — `drive_read_file` does NOT support Forms.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `formId` | `z.string` | **required** | The Google Forms form ID (from the form URL or generate_inputs_manifest output). |

### `validate_run_state`

Validate a run_state.yaml file's shape against the Phase Write-Back Contract. Reads the YAML from Drive (one call, with the same transient-error retry handleReadFile uses), parses it, and returns `{valid, errors, warnings}` where each issue carries `{path, message, severity, expected?, actual?}`. Use to confirm a phase actually wrote its block correctly — particularly after an `Agent(<phase>)` dispatch returns. Empty/null YAML (legal at run-init before any phase writes) returns `valid: true`. Implementation: `lib/run-state-validator.ts::validateRunState`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fileId` | `z.string` | **required** | The Google Drive fileId of run_state.yaml. |

### `classify_phase_writeback`

Single-line answer to 'did `<phaseName>` write its run_state.yaml block correctly?' Reads run_state.yaml from Drive, parses it, and returns `{status: 'ok' | 'missing' | 'in_progress' | 'error' | 'malformed', phase: <name>}`. The orchestrator's silent-dispatch retry should treat 'missing', 'in_progress', and 'malformed' as retry triggers (agent claimed success but didn't write properly); 'error' is a real phase failure that halts. Cheaper than `validate_run_state` for the common case of 'I just need to know if this phase shipped' — returns one classification, not a full issue list. Implementation: `lib/run-state-validator.ts::classifyPhaseWriteBack`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fileId` | `z.string` | **required** | The Google Drive fileId of run_state.yaml. |
| `phaseName` | `z.string` | **required** | The phase whose write-back block to classify (e.g. "idea-to-design", "commcare-setup"). |

### `verify_phase_products`

Boundary-fence check that a phase's `phases.<phase>.products` block matches the typed-handoff contract the ace-web summary page reads (`lib/phase-products-schema.ts`). Reads run_state.yaml from Drive, parses it, and returns `{phase, status, ok, mode, issues}`. `mode` is `complete` when the phase is `done`/`complete` (validates shape AND that every required handoff key is present — e.g. `connect.opportunity.url`, `qa-and-training`'s `training.docs.onboarding_email`), `fragment` when the phase is still in-flight (shape-only, so incremental writes pass), or `skipped` when the phase has no products contract. `ok:false` on a `done` phase means a handoff the summary renders is missing or malformed — the orchestrator should treat it like a `verify_phase_artifacts` miss (heal the producing skill / re-dispatch) before advancing. This is the run_state-level companion to `verify_phase_artifacts` (which checks Drive files); run BOTH in the phase boundary fence. Implementation: `lib/phase-products-schema.ts::classifyPhaseProducts`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fileId` | `z.string` | **required** | The Google Drive fileId of run_state.yaml. |
| `phase` | `z.string` | **required** | The phase whose products block to verify (e.g. "connect-setup", "qa-and-training"). |

### `verify_phase_artifacts`

Verify every artifact the manifest declares required for `phase` is present in the run folder's per-phase subfolder. Returns `{phase, ok, missing, present_count, expected_count, optional_present_count, summary}` where each `missing` entry carries `{path, producedBy, description}` — `producedBy` tells the orchestrator which skill to re-dispatch to heal. Narrate from `summary` (a ready-made one-liner like "all 4 required artifacts found (+3 optional)"); do NOT pair `present_count`/`expected_count` into a fraction — present counts every file in the folder, expected counts only the required set, so the ratio routinely exceeds 1. Pair with `classify_phase_writeback` in the boundary fence's parallel block: writeback checks `run_state.yaml`, this checks Drive contents. Walks the phase subfolder two levels deep so `recipes/`, `screenshots/`, etc. children are seen. **Side effect (deliberate): it also refreshes `<run-folder>/README.md`** from the run's own `run_state.yaml` phase statuses and reports `readme_refreshed` — the README index is derived state, and making its refresh a remembered extra call is what left a finished 8-phase run with 96 rows of `pending`. Best-effort: a failed refresh sets `readme_refreshed:false` + `readme_note` and never changes `ok`. Implementation: `lib/phase-closeout.ts::verifyPhaseArtifacts` + `lib/run-readme.ts::phaseStatusFromRunState`. Manifest: `lib/artifact-manifest.ts`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `runFolderId` | `z.string` | **required** | The Google Drive folder ID of the run (e.g. <opp>/runs/<run-id>/). |
| `phase` | `z.enum` | **required** | The phase whose declared required artifacts to verify (e.g. "design", "commcare", "synthetic-data-and-workflows"). |
| `mode` | `z.string` | optional | Optional override of the phase run MODE. Normally omit it: the atom reads `phases.<phase>.mode` out of the run folder's run_state.yaml itself, so a supported mode relaxes the fence without the caller having to remember. Recognized values live in `lib/artifact-manifest.ts::PHASE_MODES` (today: `app-QA-only`); an unrecognized string is ignored and the full required set applies, so a typo cannot skip the fence. |

### `render_run_readme`

Render the run-folder README index and, when `runFolderFileId` is supplied, WRITE it to `<run-folder>/README.md` server-side (find-or-update). Pass `runFolderFileId` — that is the intended call at RUN-INIT (orchestrator step 7b): one call renders and persists the index, and nothing has to be relayed back through `drive_create_file`. Returns `{markdown, written, fileId?}`; omitting `runFolderFileId` renders only (`written: false`) and is kept for callers that genuinely want the markdown without persisting it. Optional per-phase status overrides (keys: idea-to-design | scenarios-and-acceptance | commcare-setup | connect-setup | ocs-setup | qa-and-training | synthetic-data-and-workflows | solicitation-management | execution-management | closeout; values: pending | in-progress | done | partial | blocked | error | skipped); unspecified phases default to `pending`. You do NOT need to call this at phase boundaries: `verify_phase_artifacts` refreshes the README itself from `run_state.yaml` on every fence call. Implementation: `lib/run-readme.ts::generateRunReadme`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `runId` | `z.string` | **required** | The run-id folder name, e.g. "20260526-1334". |
| `phaseStatus` | `z.record` | **required** | _—_ |
| `runFolderFileId` | `z.string` | optional | Drive folder ID of the run (ACE/<opp>/runs/<run-id>/). When supplied, the rendered index is WRITTEN to README.md in that folder (find-or-update) and `written: true` is returned. Supply it at run-init; omit it only when you want the markdown without persisting it. |

## ace-connect

Source: `mcp/connect-server.ts` — 61 atoms

### `connect_list_programs`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `name` | `z.string` | optional | Case-insensitive SUBSTRING filter on program name — a prefix of the full name matches. Name-filtered rows are hydrated to full program shape via a per-row get. Unfiltered rows carry null, never a typed zero, for delivery_type/budget/currency/country/start_date/end_date because the list page does not render them; hydrate via connect_get_program. |

### `connect_get_program`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `program_id` | `z.string` | **required** | _—_ |

### `connect_create_program`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | PM-side org slug (must be a program-manager org). |
| `name` | `z.string` | **required** | _—_ |
| `description` | `z.string` | **required** | _—_ |
| `delivery_type` | `z.union` | **required** | _—_ |
| `budget` | `z.coerce.number` | **required** | _—_ |
| `currency` | `z.string` | **required** | ISO 4217 code (e.g. "USD"). |
| `country` | `z.string` | **required** | Human country name as Connect renders it (e.g. "United States of America"). |
| `start_date` | `z.string` | **required** | _—_ |
| `end_date` | `z.string` | **required** | _—_ |

### `connect_update_program`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `program_id` | `z.string` | **required** | _—_ |
| `name` | `z.string` | optional | _—_ |
| `description` | `z.string` | optional | _—_ |
| `budget` | `z.coerce.number` | optional | _—_ |
| `start_date` | `z.string` | optional | _—_ |
| `end_date` | `z.string` | optional | _—_ |

### `connect_list_delivery_types`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |

### `connect_list_opportunities`

List opportunities in an organization. `hydrate: true` fetches each row through `connect_get_opportunity` so `active` and `is_test` are REAL rather than absent — the list view returns only {id, name, short_description, description, organization_slug}. `program_id` is NOT a filter here and is refused loudly by the backend (ace#1022): the list endpoint has no program scope, and silently ignoring it would return the whole org while the caller believed it was scoped to one program. Filter client-side instead.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `program_id` | `z.string` | optional | REFUSED by the backend — the list endpoint has no program scope (ace#1022). Present only so the refusal explains itself; filter client-side. |
| `name` | `z.string` | optional | _—_ |
| `hydrate` | `z.boolean` | optional | Fetch each row through getOpportunity so `active`, `is_test`, `total_budget` and `program_name` are real. REQUIRED by connect-program-setup Step 4a and connect-opp-setup Step 4; unreachable before ace#1448. |

### `connect_get_opportunity`

Read one opportunity from the edit form (authoritative for name/description/currency/country/end_date/active/is_test) merged with the dashboard (learn_app/deliver_app wiring, plus `total_budget`, `start_date` and `program_name`, which no form carries — ace#1550). A field the pages do not render comes back undefined: UNDEFINED MEANS UNKNOWN, NEVER ZERO. `program_id` is never populated by a read — `program_name` is the only program key any read surface carries, so scope a per-program sum by name and treat a non-unique name as unknown. Degrades to the dashboard alone on a 403/404 from the edit form (viewer tier, ace#1461).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `opportunity_id` | `z.string` | **required** | _—_ |

### `connect_create_opportunity`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | PM-side org running the program. |
| `program_id` | `z.string` | **required** | Program UUID — required (managed opportunity). |
| `name` | `z.string` | **required** | _—_ |
| `short_description` | `z.string` | **required** | _—_ |
| `description` | `z.string` | **required** | _—_ |
| `target_organization_slug` | `z.string` | optional | _—_ |
| `start_date` | `z.string` | **required** | Must fit inside the program window. |
| `end_date` | `z.string` | **required** | _—_ |
| `total_budget` | `z.coerce.number` | **required** | Must fit inside `program.budget − Σ(other managed opps)`. |
| `is_test` | `z.boolean` | optional | Defaults true server-side. |
| `auto_activate` | `z.boolean` | optional | _—_ |
| `description` | `z.string` | **required** | Required — Connect form marks it *. |
| `passing_score` | `z.coerce.number` | **required** | _—_ |
| `learn_app` | `HqAppZ` | **required** | Shared schema `HqAppZ` — see its definition in the server source for the full shape. |
| `deliver_app` | `HqAppZ` | **required** | cc_app_id MUST differ from learn_app.cc_app_id. |

### `connect_update_opportunity`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `opportunity_id` | `z.string` | **required** | _—_ |
| `name` | `z.string` | optional | _—_ |
| `short_description` | `z.string` | optional | Max 50 chars — DB-enforced (see connect_create_opportunity for the full bisect note). |
| `description` | `z.string` | optional | _—_ |
| `end_date` | `z.string` | optional | _—_ |
| `is_test` | `z.boolean` | optional | _—_ |

### `connect_set_learn_passing_score`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | PM-side org slug that owns the program (e.g. ai-demo-space). |
| `program_id` | `z.string` | **required** | Program UUID. Required because the form carrying passing_score is the PROGRAM-SCOPED init-edit form (/a/<org>/program/<program_id>/opportunity/<opp_id>/init/edit/), not the opportunity edit form connect_update_opportunity posts. |
| `opportunity_id` | `z.string` | **required** | Opportunity UUID whose Learn app gate is being changed. Note the score lives on the CommCareApp row, which is keyed (cc_app_id, cc_domain, organization, hq_server) and NOT by opportunity — so every opportunity in this org wired to the same HQ Learn app shares it. The returned previous_passing_score shows what was displaced. |
| `passing_score` | `z.coerce.number` | **required** | Learn-app passing score, 0-100 (Connect renders the input with min=0 max=100). This is the ONLY gate on Deliver unlock: Connect sets passed = score >= passing_score for every submitted form block carrying user_score. |

### `connect_get_learn_passing_score`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | PM-side org slug that owns the program (e.g. ai-demo-space). |
| `program_id` | `z.string` | **required** | Program UUID. Required because the score is rendered ONLY on the PROGRAM-SCOPED init-edit form (/a/<org>/program/<program_id>/opportunity/<opp_id>/init/edit/). connect_get_opportunity reads the opportunity edit form plus the detail page, and the field appears on neither — which is why it does not return it. |
| `opportunity_id` | `z.string` | **required** | Opportunity UUID whose Learn gate to read. Note the score lives on the CommCareApp row, keyed (cc_app_id, cc_domain, organization, hq_server) and NOT by opportunity, so this value is shared by every opportunity in the org wired to the same HQ Learn app. |

### `connect_set_verification_flags`

Set per-opportunity verification config via the `/opportunity/<id>/verification_flags_config/` HTML form (not on the public REST API; routes through Playwright). Re-posts every existing formset row verbatim, so changes are additive. WHAT ACTUALLY WORKS TODAY (live-verified 2026-07-28, dimagi-internal/ace#1013): only `form_field_rules`, `form_submission_start` / `form_submission_end`, and the per-deliver-unit `duration` are backed by fields that still exist on the form. `duplicate`, `gps`, `catchment_areas`, `gps_radius_meters` and `deliver_unit_checks[].check_attachments` are now REFUSED when truthy — the atom fetches the form, finds no such input, and throws a typed `unsupported_verification_flag` error BEFORE posting, because Django drops unrecognized keys and the old behaviour returned `ok: true` for a control that was never set. The support test reads the fetched page, not a hardcoded list, so it relaxes by itself if Connect restores a field. `form_field_rules` is the only surface on which a PDD Evidence-Model Layer A predicate can be enforced server-side; it is additive and idempotent, and its `name` is capped at 25 chars (a longer name silently fails the WHOLE formset). Durations are `deliver_unit_checks[].duration_minutes` (MINUTES, per the form label); the legacy `duration_seconds` spelling is rejected rather than reinterpreted. The response carries `form_field_rules_saved` — the count Connect actually persisted — which is the only evidence the write landed.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `opportunity_id` | `z.string` | **required** | _—_ |
| `flags` | `VerificationFlagsZ` | **required** | Shared schema `VerificationFlagsZ` — see its definition in the server source for the full shape. |

### `connect_list_deliver_units`

List deliver units for an opportunity. Each entry has `id` (per-opp display index 1/2/3…), `name`, `slug`, plus `server_id` — the server-side primary key suitable for `connect_create_payment_unit.required_deliver_units` / `optional_deliver_units`. `server_id` is populated by reading the create-payment-unit form's checkbox values; absent only on the rare degraded path where that secondary fetch fails. Pass `server_id` (not `id`) to `connect_create_payment_unit`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `opportunity_id` | `z.string` | **required** | _—_ |

### `connect_create_payment_units`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `opportunity_id` | `z.string` | **required** | _—_ |
| `total_budget` | `z.coerce.number` | optional | _—_ |
| `payment_units` | `z.array` | **required** | _—_ |

### `connect_create_payment_unit`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `opportunity_id` | `z.string` | **required** | _—_ |
| `total_budget` | `z.coerce.number` | optional | _—_ |
| `name` | `z.string` | **required** | _—_ |
| `description` | `z.string` | optional | _—_ |
| `amount` | `z.coerce.number` | **required** | _—_ |
| `org_amount` | `z.coerce.number` | optional | Required for managed opportunities. |
| `max_total` | `z.coerce.number` | **required** | _—_ |
| `max_daily` | `z.coerce.number` | **required** | _—_ |
| `start_date` | `z.string` | optional | _—_ |
| `end_date` | `z.string` | optional | _—_ |
| `required_deliver_units` | `z.array` | **required** | _—_ |
| `optional_deliver_units` | `z.array` | **required** | _—_ |

### `connect_list_payment_units`

List payment units on an opportunity. **HTML-scraped read-back has known unreliable fields:** `amount` returns undefined (the table doesn't render it); `max_total` and `max_daily` are mislabeled / swapped on some pages (verified live on `malaria-itn-fgd/20260514-2352` Phase 4); `required_deliver_units` returns `[]` regardless of actual config. **Use `createPaymentUnit`'s response object for round-trip verification** of those fields rather than this list endpoint. `id`, `payment_unit_uuid`, `name`, and `description` ARE reliable. Issue tracking: jjackson/ace#106 finding 5 + turmeric-20260503-0835. When upstream ships a real GET /api/payment_units/ endpoint, all fields become reliable in one routing change.

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

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | PM-side org running the program. |
| `program_id` | `z.string` | **required** | Program UUID — invite is program-level. |
| `organization` | `z.string` | **required** | LLO org slug to invite. |

### `connect_accept_program_application`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `program_id` | `z.string` | **required** | _—_ |
| `application_id` | `z.string` | **required** | ProgramApplication UUID returned by `connect_send_llo_invite`. |

### `connect_list_invites`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `program_id` | `z.string` | **required** | _—_ |

### `connect_send_flw_invite`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `opportunity_id` | `z.string` | **required** | Opportunity must be active and not ended. |
| `phone_numbers` | `z.array` | **required** | _—_ |

### `connect_list_flw_invites`

Read an opportunity's workers table and report, per phone, whether Connect actually has an FLW invite for that worker — the read-back that turns a "queued" send response into evidence (dimagi-internal/ace#824 / #855). WHY: `connect_send_flw_invite` returns `{status:"queued", invited_count:N}` even when Connect ends up with no invite for the phone, and Phase 6 then burns a full AVD session hunting a tile that cannot exist. GATE ON ROW EXISTENCE (`match !== null`), NOT on `claimed`. `claimed` reports whether the worker has already ACCEPTED/CLAIMED the opportunity (it has moved to "In Progress" on device); `status: "pending"` with `name: null` is the NORMAL state for a fresh invite, because acceptance happens on-device when `connect-claim-opp` claims the tile. Requiring `claimed` would fail every legitimate fresh run. Each row returns `{phone, name, connect_user_id, claimed, status, invited_date, completed_learn}`; `status` is `accepted` | `pending` | `unknown` read off the row status icon. Pass `phone` to get a `match` field resolved by digits-only comparison (accepts `${VAR}` env tokens such as `${ACE_E2E_PHONE}`). Read-only. Routes through Playwright to the htmx workers fragment (sends HX-Request; without it Connect returns the shell with zero rows); no REST equivalent. Throws WorkersTableSchemaError if Connect reshapes the table rather than returning wrong answers.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `opportunity_id` | `z.string` | **required** | Opportunity UUID. |
| `phone` | `z.string` | optional | Optional phone to resolve into a `match` field. Accepts `+<digits>` or a `${VAR}` env token (e.g. ${ACE_E2E_PHONE}). |

### `connect_delete_unaccepted_flw_invites`

Hard-delete unaccepted FLW invites by integer id. Invites with `status=accepted` are silently skipped server-side (those represent real workers and cannot be deleted via this endpoint). Associated `OpportunityAccess` rows cascade-delete. Used by `/ace:sweep connect` to clean up orphan invites tied to deactivated opportunities. Routes through Playwright to the `@csrf_exempt` `/opportunity/<opp_id>/delete_invites/` HTML view; no REST equivalent. `opportunity_id` is the opportunity UUID slug; `user_invite_ids` are the integer ids returned by `connect_list_invites`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | _—_ |
| `opportunity_id` | `z.string` | **required** | Opportunity UUID slug (same shape used by connect_list_invites). |
| `user_invite_ids` | `z.array` | **required** | _—_ |

### `connect_add_org_member`

Invite a human user to a Connect workspace (organization) by email. POSTs the HTML membership form at `/a/<org_slug>/organization/member` (no REST equivalent), reading the member table BEFORE and AFTER so the outcome is observed rather than assumed. Returns `status: "invited"` (absent before, present after — this call added them) or `status: "already-member"`, plus `role` READ BACK from the table (the role Connect actually stored) alongside the `requested_role`. IMPORTANT: Connect's `MembershipForm.clean_email` EXCLUDES users already in the org, so for an existing member the form never validates — the POST is a silent no-op returning the same 302 as success, and the requested role is NOT applied. That case returns `role_unchanged: {requested, actual, note}`; there is no add-member path that updates an existing membership's role (do it in the Connect UI). Requirements enforced by Connect, not bypassable: (1) the authenticated ACE session user (ace@dimagi-ai.com) MUST be an admin of `organization_slug`, or the POST 403s; (2) the invitee MUST already have a Connect account (signed in once) — if they were not a member before and are still absent after, that is the cause, raised as a typed validation error. A newly added user gets an accept-invite email and shows in the member list. `role` defaults to `member`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `organization_slug` | `z.string` | **required** | Workspace (organization) slug, e.g. "ai-demo-space". |
| `email` | `z.string` | **required** | Email of an EXISTING Connect user to add (they must have signed in to Connect at least once). |
| `role` | `z.enum` | optional | Membership role to request for a NEW member. Default "member". Ignored by Connect if the person is already a member — see `role_unchanged` in the result. |

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

### `connect_get_learn_progress`

Read each accepted worker's AUTHORITATIVE Learn progression from Connect's WorkerLearnView (GET /a/<domain>/opportunity/<opportunity_id>/workers/learn/, htmx fragment; session-cookie authed, read-only). This is the "close the loop to the source of truth" check for Phase 6: Deliver unlocks ONLY when Learn reaches 100% of modules (Connect's OpportunityAccess.learn_progress == 100 / completed_learn_date set), NOT when the assessment passes. A partial walk (e.g. 4/5 modules → 80%) returns `learn_complete: false` even though the on-device assessment screen may already read "Passed", so assert `learn_complete` / `modules_completed_pct >= 100` — never the assessment status — to confirm the Deliver gate will open. Returns `{ domain, opportunity_id, workers: [{ name, modules_completed_pct, learn_complete, completed_learning_date, assessment_status }] }`. `domain` is the Connect org slug in the /a/<domain>/ path; `opportunity_id` is the opportunity UUID. Columns are resolved by header label (the table has a leading Status column the per-worker API omits), so a live template reshape fails loud rather than shifting fields.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `z.string` | **required** | Connect org / project-space slug in the /a/DOMAIN/ URL path, e.g. ai-demo-space. |
| `opportunity_id` | `z.string` | **required** | Opportunity UUID. |

### `connect_get_deliver_progress`

Read each accepted worker's AUTHORITATIVE DELIVERY progression from Connect's WorkerDeliverView (GET /a/<domain>/opportunity/<opportunity_id>/workers/deliver/, htmx fragment; session-cookie authed, read-only). The Deliver counterpart to connect_get_learn_progress, and the server-side read dimagi-internal/ace#1066 is about: Phase 6's Deliver smoke can return pass while the visit sits UNSENT in the device's local outbox, because the device is not authoritative about whether a delivery reached Connect. Assert `delivered >= 1` for "the visit reached Connect"; assert `approved >= 1` for the stronger "one payment unit registers" criterion app-test-cases.yaml actually declares (a delivery can be submitted and then REJECTED by verification, so delivered alone does not prove payability). Returns `{ domain, opportunity_id, workers: [{ name, payment_unit, delivered, approved, rejected, progress_completed, progress_total, last_active }] }` — one row per worker+payment-unit. `domain` is the Connect org slug in the /a/<domain>/ path; `opportunity_id` is the opportunity UUID. Columns are resolved by header label, so a live template reshape throws WorkerDeliverTableSchemaError rather than returning shifted fields.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `z.string` | **required** | Connect org / project-space slug in the /a/DOMAIN/ URL path, e.g. ai-demo-space. |
| `opportunity_id` | `z.string` | **required** | Opportunity UUID. |

### `commcare_list_apps`

List CommCare HQ applications in a domain. Hits the REST API at GET /a/<domain>/api/v0.4/application/ (domain-scoped — the unscoped /api/v0.4/application/?domain= form returns 404 from Django routing) using the existing PlaywrightSession cookie jar (allow_session_auth=True on CCHQ's TaskPie resource — no separate API key needed). Returns id, name, and doc_type per app. Soft-deleted apps (doc_type ending in `-Deleted`) are filtered server-side; the field is preserved for callers that cross-check against `commcare_delete_app`. Used by `/ace:sweep hq` to enumerate the universe of apps in the ACE-owned domain.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |

### `commcare_delete_app`

Soft-delete a CommCare HQ application. POST /a/<domain>/apps/delete_app/<app_id>/ via the web view (no REST equivalent — the view soft-deletes by mutating doc_type to `<original>-Deleted` and creates a DeleteApplicationRecord for restore). Restore is possible via HQ admin UI's "deleted applications" list. Routes through the existing PlaywrightSession (session cookies + CSRF from cookie jar; API key auth is insufficient because this is a CSRF-protected Django web view). Used by `/ace:sweep hq` to clean up orphan apps in the ACE-owned domain. GUARDED: refuses any `domain` other than ACE_HQ_DOMAIN unless `allow_foreign_domain` is passed with that exact domain name.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `app_id` | `z.string` | **required** | _—_ |
| `allow_foreign_domain` | `z.string` | optional | Escape hatch for deleting outside ACE_HQ_DOMAIN. Must equal `domain` EXACTLY — a bare `true` is not accepted, so the override has to name what it is overriding. Bounds accidental blast radius (a stale or typo'd domain, a sweep bug); it is a rail, not an approval gate. |

### `commcare_create_domain`

Create a new CommCare HQ project space (domain). POST /register/domain/ via the DomainRegistrationForm CSRF-protected web view (no REST equivalent — corehq/apps/registration/views.py:RegisterDomainView). For an existing (non-new) user — which ACE's ace@dimagi-ai.com always is — success is a 302 to /a/<slug>/dashboard/; the returned `domain` is the slug HQ derived from `hr_name`. `hr_name` is capped at 25 chars (HQ's DomainRegistrationForm.max_name_length); pass an already-slug-shaped value (lowercase, hyphens) for predictable slug derivation. Daily-creation rate-limit and `RESTRICT_DOMAIN_CREATION` errors are surfaced explicitly.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `hr_name` | `z.string` | **required** | Human-readable project name; HQ derives the URL slug from this. Max 25 chars. Pass a slug-shaped value (lowercase + hyphens) for predictable results. |
| `org` | `z.string` | optional | Optional organization id (hidden form field; usually empty). |

### `commcare_get_lookup_table`

Fetch a CommCare HQ lookup table by tag (name). GET /a/<domain>/api/v0.5/lookup_table/ via Tastypie (session auth OK). Lists all tables in the domain and returns the one whose `tag` matches; returns `{table: null}` if not found. Use this to verify a lookup table exists before appending rows (see also commcare_lookup_table_append_rows, planned).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `tag` | `z.string` | **required** | Lookup table name as the team uses it (e.g. "interview_schedule"). |

### `commcare_create_lookup_table`

Create a new CommCare HQ lookup table. POST /a/<domain>/api/v0.5/lookup_table/ via Tastypie. Body: {tag, is_global, fields: [{field_name, properties}], item_attributes}. Returns the new table's UUID hex id. Rejects with 400 if a table with the same tag already exists in the domain.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `tag` | `z.string` | **required** | Name for the new table (e.g. "interview_schedule"). |
| `fields` | `z.array` | **required** | _—_ |
| `properties` | `z.array` | **required** | _—_ |
| `is_global` | `z.boolean` | optional | If true, table is shared across the domain (default false). |
| `item_attributes` | `z.array` | **required** | _—_ |

### `commcare_list_user_fields`

Read the current custom-user-data field definition for a CommCare HQ domain. GET /a/<domain>/users/user_data/ and parse the <div data-name="custom_fields"> initial_page_data div (HQ's standard Django→JS bootstrap). Returns the list of fields (slug, label, is_required, choices, regex) + the list of profiles. Requires can_edit_commcare_users permission; 302s to settings/users/ surface as a typed error.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |

### `commcare_set_user_fields`

Write the full custom-user-data field definition for a domain (DESTRUCTIVE — replaces existing). POST CustomDataFieldsForm to /a/<domain>/users/user_data/ with `data_fields` JSON-encoded. Direct form POST bypasses the React/Knockout UI (verified against apps/custom_data_fields/edit_model.py:491). Callers SHOULD list_user_fields first, merge their additions, then call this. The atom doesn't do the merge — destructive semantics keep the contract clean.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
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
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `limit` | `z.number` | optional | _—_ |

### `commcare_create_ucr_expression`

Create a named UCR expression or filter on a domain. POST the UCRExpressionForm to /a/<domain>/data/ucr_expressions/ via action=create. Required fields: name, expression_type ("named_expression" | "named_filter"), definition (JSON spec). The Connect Interviews bootstrap creates 4: "Register User OCS" + "Trigger OCS Bot" (named_filter), "Session Completion API" + "24 hr Expiry API" (named_expression). Duplicate name in domain raises IntegrityError surfaced as explicit error.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `name` | `z.string` | **required** | _—_ |
| `expression_type` | `z.enum` | **required** | _—_ |
| `definition` | `z.record` | **required** | _—_ |
| `description` | `z.string` | optional | _—_ |

### `commcare_linked_app_copy`

Pull a linked copy of an app from an upstream domain into a downstream domain. POSTs CopyApplicationForm to /a/<upstream_domain>/apps/copy_app/ (view: copy_app in corehq.apps.app_manager.views.apps). Closes the long-standing Connect Interviews atom gap — reverse-engineered from CommCare HQ source since app-copying is NOT handled by the generic linked_domain content-sync RMI (MODEL_APP is deliberately absent from that dispatch table). Returns the new app's id and name (recovered via a re-list-by-name after the redirect, not by parsing the Location header). linked defaults to true (a live linked app eligible for future pulls, not a disconnected one-off copy) — this is what the Connect Interviews per-cohort flow always wants. NOT YET LIVE-VALIDATED — probe against a disposable domain pair before relying on it in a real run.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `upstream_domain` | `z.string` | **required** | Domain the source app currently lives in (the linked-domain upstream/master). |
| `upstream_app_id` | `z.string` | **required** | The source app's id, to be copied (from commcare_list_apps on the upstream domain). |
| `downstream_domain` | `z.string` | **required** | Domain to copy the app into (the linked-domain downstream). |
| `name` | `z.string` | **required** | Name for the new copy — should include the cohort id per the Connect Interviews naming convention. |
| `linked` | `z.boolean` | optional | Whether the copy stays connected to upstream as a live linked app eligible for future pulls, vs. a disconnected one-off copy. Default true. |
| `build_id` | `z.string` | optional | Specific build/version of the source app to copy. Omit for the latest saved version. |

### `commcare_list_inbound_apis`

List Inbound API configurations on a CommCare HQ domain. POST /a/<domain>/motech/inbound/ with action=paginate. Returns each API's id, name, description, api_url, edit_url. Pro Edition / DATA_FORWARDING required.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `limit` | `z.number` | optional | _—_ |

### `commcare_create_inbound_api`

Create an Inbound API configuration. POST the ConfigurableAPICreateForm to /a/<domain>/motech/inbound/ via CRUDPaginatedViewMixin's action=create. Requires filter_expression_id (UCR FK) and optionally transform_expression_id — these UCR expressions must exist on the domain first (typically pushed via linked_domain in the Connect Interviews flow). Returns new id and name. The Connect Interviews "Session Completion API" + "24 hr Expiry API" are created via this atom in the per-domain bootstrap.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `name` | `z.string` | **required** | _—_ |
| `description` | `z.string` | optional | _—_ |
| `filter_expression_id` | `z.number` | **required** | _—_ |
| `transform_expression_id` | `z.number` | optional | _—_ |
| `backend` | `z.enum` | optional | _—_ |

### `commcare_create_repeater`

Create a Data-Forwarding Repeater on a CommCare HQ domain. POST the GenericRepeaterForm (or BaseExpressionRepeaterForm for *ExpressionRepeater types) to /a/<domain>/motech/forwarding/new/<repeater_type>/. Plain FormRepeater forwards every submission; FormExpressionRepeater applies a UCR filter (configured_filter) and emits a UCR-derived payload (configured_expression) — the Connect Interviews "OCS User Registration" and "Trigger Bot" repeaters use this variant. Pro Edition required (DATA_FORWARDING privilege).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `repeater_type` | `z.enum` | **required** | _—_ |
| `connection_settings_id` | `z.number` | **required** | FK to a Connection (from commcare_list_connections). |
| `name` | `z.string` | optional | _—_ |
| `request_method` | `z.enum` | optional | _—_ |
| `format` | `z.string` | optional | Payload format slug (e.g. "form_json", "form_xml"). |
| `configured_filter` | `z.record` | **required** | _—_ |
| `configured_expression` | `z.record` | **required** | _—_ |
| `url_template` | `z.string` | optional | _—_ |

### `commcare_list_connections`

List Connection settings (motech outbound connections) on a CommCare HQ domain. POST /a/<domain>/motech/conn/ with action=paginate via the CRUDPaginatedView. Returns each connection's id, name, url, notify_addresses, used_by. Gated by privileges.DATA_FORWARDING (Pro Edition) — 404s without it. Used by verifier to confirm "Connect Interviews" and "OCS Interviews Bot" connections exist.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `limit` | `z.number` | optional | _—_ |

### `commcare_create_connection`

Create a Connection (motech outbound connection settings). POST the ConnectionSettingsForm to /a/<domain>/motech/conn/add/ (form-encoded, CSRF-protected). Success redirects to the list view — atom re-lists by name to recover the new id. Auth types per corehq/motech/auth.py: none, basic, digest, bearer, oauth1, oauth2_pwd, oauth2_client, api_key. Pro Edition required (DATA_FORWARDING privilege).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `name` | `z.string` | **required** | _—_ |
| `url` | `z.string` | **required** | Base URL of the target system (e.g. "https://connect.dimagi.com/"). |
| `auth_type` | `z.enum` | optional | _—_ |
| `username` | `z.string` | optional | _—_ |
| `plaintext_password` | `z.string` | optional | _—_ |
| `client_id` | `z.string` | optional | _—_ |
| `plaintext_client_secret` | `z.string` | optional | _—_ |
| `token_url` | `z.string` | optional | _—_ |
| `notify_addresses_str` | `z.string` | optional | Comma-separated emails for failure notifications. |
| `skip_cert_verify` | `z.boolean` | optional | _—_ |
| `plaintext_custom_headers` | `z.string` | optional | JSON string of custom headers (e.g. '{"Authorization": "Token xyz"}'). |

### `commcare_get_case`

Fetch a single CommCare HQ case by case_id. GET /a/<domain>/api/v0.5/case/<id>/?format=json via Tastypie (API-key auth — CaseResource sets RequirePermissionAuthentication(edit_data) without allow_session_auth). Returns the case's dynamic property bag (commcare-user case has session_completion / last_bot_interaction_date / interaction_validation written by OCS-to-HQ custom action). 404 surfaces as an explicit error.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `case_id` | `z.string` | **required** | _—_ |

### `commcare_list_users`

List mobile workers (CommCareUser) in a CommCare HQ domain. GET /a/<domain>/api/v0.5/user/ via Tastypie (API key auth). Supports standard Tastypie pagination (limit/offset) and group filter. Returns each user's id, username, basic profile, and the full user_data dict (including custom fields like cohort_id). Used by verifier to confirm cohort_id is set on the right FLWs.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `limit` | `z.number` | optional | _—_ |
| `offset` | `z.number` | optional | _—_ |
| `group` | `z.string` | optional | _—_ |

### `commcare_invite_web_user`

Invite a WEB user (a Dimagi teammate / reviewer, not a mobile worker) to a CommCare HQ domain, or bring an existing member up to the right role. POSTs the live InviteWebUserView form at /a/<domain>/settings/users/web/invite/ and proves the result by read-back. IDEMPOTENT: an email that is already a member or already invited returns already-member / invite-pending rather than erroring. IMPORTANT — role, not membership: the default role is "App Editor" because HQ stock "Read Only" lacks view_apps, so a Read Only member gets a bare 403 on every app link ACE shares while the releases page still renders (looks like it mostly works). An existing member on a DIFFERENT role is reconciled through the edit page, re-posting the whole live form so per-project custom-data fields are not dropped. Role labels are resolved against the live select and an unknown label fails loud with the available list. Backs skills/share-run-access.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | HQ project space, e.g. connect-ace-prod |
| `email` | `z.string` | **required** | Email address of the person to invite. |
| `role` | `z.string` | optional | Role LABEL as HQ renders it. Defaults to "App Editor" — do not set "Read Only" for reviewers who need app links (ace#905). |

### `commcare_get_user`

Fetch a single CommCare HQ mobile worker by id. GET /a/<domain>/api/v0.5/user/<user_id>/. Returns the full record including user_data.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `user_id` | `z.string` | **required** | _—_ |

### `commcare_update_user_field`

Set a single custom-user-data field on a mobile worker. Implemented as GET → mutate user_data → PUT (v0_5 CommCareUserResource exposes PUT but not PATCH, so we PUT the merged user_data). Pass value=null to clear the field. Used by per-FLW cohort_id assignment after Learn completion.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `user_id` | `z.string` | **required** | _—_ |
| `field_slug` | `z.string` | **required** | User-data field slug (e.g. "cohort_id"). |
| `value` | `z.union` | **required** | _—_ |

### `commcare_get_lookup_table_rows`

Get rows of a CommCare HQ lookup table. GET /a/<domain>/api/v0.5/lookup_table_item/ via Tastypie (API key auth). Tastypie returns ALL rows in the domain (no querystring filter); this atom client-side filters by data_type_id resolved from the supplied tag or UUID. Returns each row's fields as a flat map (column → first field_value).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `table_id_or_tag` | `z.string` | **required** | Either a 32-hex table UUID or the human-readable tag (e.g. "interview_schedule"). |

### `commcare_lookup_table_append_rows`

Append rows to a CommCare HQ lookup table. POST /a/<domain>/api/v0.5/lookup_table_item/ once per row (Tastypie doesn't support list POST for this resource). Each row is a flat field_name→string-value map; HQ wraps it into its field_list shape internally. Used by the cohort-create skill to populate interview_schedule rows for a new cohort.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `table_id_or_tag` | `z.string` | **required** | _—_ |
| `rows` | `z.array` | **required** | _—_ |
| `item_attributes` | `z.record` | **required** | _—_ |

### `commcare_link_domains`

Set up a linked-project-spaces relationship: upstream (master) → downstream. Required before linked-app push / linked content sync. POST /a/<upstream>/linked_domain/service/ via the jQuery-RMI protocol (corehq/util/jqueryrmi.py + corehq/apps/linked_domain/views.py:DomainLinkRMIView.create_domain_link). Caller must have access in both domains. Pro Edition is required for the LITE_RELEASE_MANAGEMENT privilege that backs linked spaces — without it, the call may succeed structurally but content-push operations downstream will fail.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `upstream_domain` | `z.string` | **required** | Master domain slug (must have access). |
| `downstream_domain` | `z.string` | **required** | Downstream domain slug to attach (must also have access). |

### `commcare_make_build`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `app_id` | `z.string` | **required** | _—_ |
| `comment` | `z.string` | optional | _—_ |

### `commcare_release_build`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `app_id` | `z.string` | **required** | _—_ |
| `build_id` | `z.string` | **required** | _—_ |

### `commcare_download_ccz`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `app_id` | `z.string` | **required** | _—_ |
| `build_id` | `z.string` | optional | _—_ |
| `include_multimedia` | `z.boolean` | optional | If true, request the full CCZ with multimedia binaries inlined under commcare/multimedia/...; default false returns the lite manifest-only response. |
| `write_to_path` | `z.string` | optional | If set, write the CCZ bytes to this local path and return `ccz_written_to` INSTEAD of `ccz_base64` — keeps the (multi-MB) base64 blob out of the model context. The `connect_markers` + `projected_connect_state` projection is still returned. Mirrors `commcare_validate_ccz`'s `ccz_path` so the download → install-sim chain (`app-release-qa`) never round-trips base64: `download_ccz(write_to_path=X)` then `validate_ccz(ccz_path=X)`. The 25 MB base64 cap does not apply when set. |

### `commcare_validate_ccz`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `ccz_path` | `z.string` | optional | Local filesystem path to the CCZ. Preferred — avoids round-tripping ~10KB of base64 through the model context. Exactly one of `ccz_path` or `ccz_base64` must be supplied. |
| `ccz_base64` | `z.string` | optional | Base64-encoded CCZ bytes. Use when chaining directly from `commcare_download_ccz` without writing to disk. Exactly one of `ccz_path` or `ccz_base64` must be supplied. |
| `mode` | `z.enum` | optional | `validate` (default; fast, parser-class only) vs `play` (slow, catches runtime-binding defects like the bednet `entity_id` class). Use `play` as the authoritative Phase 3 install-time gate. |
| `entry_path` | `z.array` | **required** | _—_ |
| `timeout_ms` | `z.number` | optional | Spawn timeout. validate default 60000ms; play default 30000ms. |

### `commcare_patch_xform`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `app_id` | `z.string` | **required** | _—_ |
| `form_unique_id` | `z.string` | **required** | _—_ |
| `new_xform_xml` | `z.string` | optional | Inline XForm XML (mutually exclusive with new_xform_xml_path). |
| `new_xform_xml_path` | `z.string` | optional | Local path to the XForm XML file (mutually exclusive with new_xform_xml). Use this for large patched XML that blows past tool-call arg-size limits. |
| `sha1` | `z.string` | optional | Optional concurrency token; CCHQ rejects with XformConflictError on mismatch. |

### `commcare_upload_multimedia`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `app_id` | `z.string` | **required** | _—_ |
| `media_path` | `z.string` | **required** | _—_ |
| `file_bytes_base64` | `z.string` | optional | Asset bytes, base64-encoded (mutually exclusive with file_bytes_path). |
| `file_bytes_path` | `z.string` | optional | Local path to the binary payload (mutually exclusive with file_bytes_base64). Use this for typical-sized PNGs that blow past tool-call arg-size limits. |
| `content_type` | `z.string` | **required** | _—_ |

### `commcare_get_form_source`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `app_id` | `z.string` | **required** | _—_ |
| `form_unique_id` | `z.string` | **required** | _—_ |

### `commcare_set_menu_display`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `app_id` | `z.string` | **required** | _—_ |
| `module_unique_id` | `z.string` | **required** | _—_ |
| `display_style` | `z.enum` | optional | Menu display style; defaults to "grid". |

### `commcare_set_app_menu_display`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server` | `z.string` | optional | CommCare HQ cluster to target — e.g. "us" or "eu". Omit to use the default server ACE_HQ_DEFAULT_SERVER. All configured clusters are live at once. |
| `domain` | `z.string` | **required** | _—_ |
| `app_id` | `z.string` | **required** | _—_ |
| `use_grid_menus` | `z.boolean` | optional | App-root "Modules Menu Display": true = grid, false = list. Defaults to true. |
| `grid_form_menus` | `z.enum` | optional | _—_ |

### `connect_preflight_learn_app_user`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `hq_domain` | `z.string` | **required** | _—_ |
| `connect_username` | `z.string` | optional | _—_ |
| `api_key` | `z.string` | **required** | _—_ |
| `hq_username` | `z.string` | **required** | CCHQ username the API key belongs to. Typically `${ACE_HQ_USERNAME}`. |
| `base_url` | `z.string` | optional | Override CCHQ base URL. Defaults to https://www.commcarehq.org. |

## ace-ocs

Source: `mcp/ocs-server.ts` — 35 atoms

### `ocs_clone_chatbot`

Clone an OCS chatbot from a template. Returns the new experiment_id, public_id, and pipeline_id.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `template_id` | `z.number` | **required** | _—_ |
| `new_name` | `z.string` | **required** | _—_ |

### `ocs_create_chatbot`

Create a brand-new OCS chatbot from scratch (not by cloning). POST /a/<team>/chatbots/new/ via the CSRF-protected ChatbotForm (apps/chatbots/views.py:CreateChatbot, apps/chatbots/forms.py:ChatbotForm — fields: name + optional description). On success, OCS auto-creates a default Pipeline with the team's first LLM provider and 302-redirects to /edit/. Returns { experiment_id, pipeline_id }. Does NOT create channels — caller follows up with createEmbeddedWidgetChannel if needed. Used by the ACE Interviews stub bot template build where the bot is the *clone source*, so channels are added on clones, not the source.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `z.string` | **required** | _—_ |
| `description` | `z.string` | optional | _—_ |

### `ocs_link_action_to_node`

Link a Custom Action operation to a pipeline node. GET/POST /a/<team>/pipelines/data/<pipeline_id>/ — appends "<custom_action_id>:<operation_id>" to the target node's data.params.custom_actions array. String format verified against apps/custom_actions/form_utils.py:make_model_id. Idempotent: skips if the model_id is already present. Typically the target node is an LLMResponseWithPrompt.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pipeline_id` | `z.number` | **required** | _—_ |
| `node_id` | `z.string` | **required** | _—_ |
| `custom_action_id` | `z.number` | **required** | From `ocs_add_custom_action`. |
| `operation_id` | `z.string` | **required** | The operationId within the custom action's api_schema (e.g. "postSessionCompletion"). |

### `ocs_add_custom_action`

Create an OCS Custom Action (an OpenAPI-driven external tool the LLM can call). POST /a/<team>/actions/new/ via the CSRF-protected CustomActionForm (apps/custom_actions/forms.py + views.py:CreateCustomAction). The api_schema field takes an OpenAPI 3.x schema as a JSON or YAML string — operationIds within the schema become the action's allowed_operations. Returns action_id, found by scraping /a/<team>/actions/ for the row whose name matches (the create view 302s to the team-manage page without including the new id in the Location). For Connect Interviews this is how the bot posts session_completion or 24hr-expiry back to HQ's Inbound API.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `z.string` | **required** | _—_ |
| `server_url` | `z.string` | **required** | Base URL of the target API (e.g. https://www.commcarehq.org). |
| `api_schema` | `z.string` | **required** | OpenAPI 3.x schema as JSON or YAML string. operationIds become the action's allowed_operations. |
| `description` | `z.string` | optional | _—_ |
| `prompt` | `z.string` | optional | Additional instructions to the LLM about how to use this action. |
| `healthcheck_path` | `z.string` | optional | Optional health endpoint path; auto-detected from schema if omitted. |

### `ocs_add_chatbot_event`

Attach a timeout-trigger event to a chatbot. POST /a/<team>/chatbots/<experiment_id>/events/timeout/new/ via the combined _create_event_view (apps/events/views.py) which takes THREE forms in one POST: TimeoutTriggerForm (delay seconds, total_num_triggers, trigger_from_first_message), EventActionForm (action_type), and a per-action-type params form. Returns {ok: true} — the view does NOT expose the new trigger ID in the response (caller must re-list events if they need it). NOTE: OCS events CANNOT directly fire custom actions; action_type must be one of {log, send_message_to_bot, end_conversation, schedule_trigger, pipeline_start}. The Connect Interviews "24hr fires custom action" pattern requires action_type=pipeline_start pointing at a secondary pipeline that contains the custom action.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `experiment_id` | `z.number` | **required** | _—_ |
| `delay_seconds` | `z.number` | **required** | Wait time before triggering, in seconds. 86400 = 24 hours. |
| `total_num_triggers` | `z.number` | optional | Number of times to fire (default 1). |
| `trigger_from_first_message` | `z.boolean` | optional | Trigger relative to the first message vs. last interaction (default false = last). |
| `action_type` | `z.enum` | **required** | _—_ |
| `action_params` | `z.record` | **required** | _—_ |

### `ocs_add_pipeline_node`

Add a node to a chatbot's pipeline graph. GET-mutate-POST the pipeline JSON at /a/<team>/pipelines/data/<pipeline_id>/ — same shape as the existing LLM-patch atoms. Supports splice-into-existing-edge: pass `disconnect_edge: {source:A, target:B}` + `connect_from: A` + `connect_to: B` to turn A→B into A→new→B (the typical pattern for inserting Router or Python nodes between Start and the default LLM). `node_id` is auto-generated as `<node_type>-<5hex>` (matching OCS UI convention) if omitted. Returns the chosen `node_id`. Server-side validation errors surface as PipelineValidationError.

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

Transactional update of the LLMResponseWithPrompt node's params: prompt + collections + tools + source material in one save. Any field omitted is preserved from the existing pipeline. OCS cross-field rule (verified 2026-04-28): the FINAL prompt must contain `{collection_index_summaries}` iff FINAL collection_index_ids.length >= 2. Pre-flight raises a typed error in either violation direction. Use this when changing both prompt and collections together; use the focused atoms when only changing one.

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

Upload files to an existing Collection. Each file MUST supply EXACTLY ONE source: `file_path` (local filesystem path — MCP reads + base64-encodes server-side, preferred for any payload >1KB) OR `content` (caller-supplied base64 — legacy inline mode, only sensible for tiny strings). Mixing both, or supplying neither, fails fast. The file_path mode exists because emitting megabytes of base64 in the tool_use input wedges model generation (stream-idle timeout) — class-level preventer for the 2026-05-19 Phase 5 wedge (`docs/learnings/2026-05-19-ocs-upload-b64-context-wedge.md`). For files that live on Drive, `drive_download_binary` to a tmp path first, then pass that as `file_path` — keeps the b64 entirely out of agent context. Files will be chunked and embedded asynchronously. chunk_size and chunk_overlap are optional (default 800/400, matching the upstream NM Bot collection).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `collection_id` | `z.number` | **required** | _—_ |
| `files` | `z.array` | **required** | _—_ |
| `content` | `z.string` | optional | Base64-encoded file content. Legacy inline mode — use file_path for anything > ~1KB to avoid stalling model generation on large b64 tool_use inputs. |
| `file_path` | `z.string` | optional | Local filesystem path. MCP reads the bytes + base64-encodes server-side, so the agent never holds the b64 in context. Pass an absolute path; relative paths resolve against the MCP subprocess CWD which is rarely predictable. Preferred for any payload > 1KB. |
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

Attach one or more Collections to a chatbot's retriever node. OCS cross-field rule (verified 2026-04-28 via live probe): the prompt MUST contain `{collection_index_summaries}` if and only if `collection_index_ids.length >= 2`. Single or zero collections must NOT include the variable; multiple collections MUST include it. The MCP pre-flights both directions and fails fast with a typed PipelineValidationError if the bot's current prompt + your new collections list would violate it. Fix by either adjusting the prompt (via ocs_set_chatbot_system_prompt) or attaching a different number of collections. For atomic prompt+collections changes, prefer ocs_set_chatbot_pipeline.

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

Delete a chatbot (user-visible effect: the chatbot disappears from listings; mechanism is OCS setting is_archived=True server-side). SAFE PER-OPP: each ACE clone has its own Experiment row, so deleting one clone does not affect the golden template or other opps. CRITICAL — callers MUST exclude OCS_GOLDEN_TEMPLATE_ID from the set of ids passed to this atom; the atom itself has no concept of "template" and will delete any experiment_id given. The /ace:sweep ocs flow enforces this exclusion. Routes through Playwright to /a/<team>/chatbots/<pk>/delete/ (POST, returns 302 HTMX HX-Redirect). No REST equivalent.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `experiment_id` | `z.number` | **required** | _—_ |

### `ocs_get_chatbot_pipeline_id`

Resolve an experiment_id (integer chatbot id) to its working-version pipeline_id (integer). The OCS REST `/api/experiments/<id>/` response omits pipeline_id by design; this atom scrapes it from the pipeline-builder HTML (`SiteJS.pipeline.renderPipeline("#pipelineBuilder", "<team>", <pipeline_id>)`) via Playwright and caches the result per experiment_id. Used by /ace:sweep ocs to pair each orphan chatbot with its per-opp Pipeline row before deletion — without this, deleting an orphan chatbot leaves its Pipeline as a zombie row on the team (is_archived=False, no parent chatbot in the live listing). Returns `{ pipeline_id: number }`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `experiment_id` | `z.number` | **required** | _—_ |

### `ocs_delete_pipeline`

Delete a pipeline (sets is_archived=True server-side). SAFE PER-OPP: when ACE clones a chatbot, Pipeline.create_new_version(is_copy=True) deep-clones the Pipeline row + its nodes — each clone has its own pipeline. Deleting the pipeline does NOT cascade-delete its referenced Collections — those need separate ocs_delete_collection calls. Routes through Playwright to /a/<team>/pipelines/<pk>/delete/ (HTTP DELETE method on Django View.delete(); returns 200 empty body).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pipeline_id` | `z.number` | **required** | _—_ |

### `ocs_delete_collection`

Delete a collection (calls Collection.archive() server-side — sets is_archived=True AND triggers delete_document_source_task to async-purge underlying File rows + object-storage blobs + FileChunkEmbedding vectors; the user-visible effect is full deletion). SAFE PER-OPP for collections created fresh by Phase 5 (those are not shared). CRITICAL — callers MUST exclude OCS_GOLDEN_TEMPLATE_COLLECTION_ID (the collection referenced by every cloned pipeline; typically id 350) from the set of ids passed to this atom. Deleting the template collection would break every clone's RAG retrieval. The /ace:sweep ocs flow enforces this exclusion. Routes through Playwright to /a/<team>/documents/collection/<pk>/delete/ (HTTP DELETE method on Django View.delete(); returns 200 empty body; async cleanup task fires after).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `collection_id` | `z.number` | **required** | _—_ |

### `ocs_list_chatbots`

List chatbots on the OCS team. Each entry includes both `id` (UUID public_id, used by ocs_get_chatbot/ocs_send_test_message) AND `experiment_id` (integer, used by every authoring atom: ocs_set_chatbot_system_prompt, ocs_attach_knowledge, ocs_publish_chatbot_version, etc.). Use this to find an existing bot by name and reconfigure it idempotently — no need to clone if it already exists. Optional `team_slug` targets a non-default team — when supplied the server resolves the matching `OCS_API_TOKEN_<SLUG>` env token; `experiment_id` enrichment via Playwright is skipped for non-default teams (the Playwright session is bound to the default team only).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cursor` | `z.string` | optional | _—_ |
| `page_size` | `z.number` | optional | _—_ |
| `team_slug` | `z.string` | optional | Optional team slug to read from (e.g. "Vaccine_Coach"). Omit to use OCS_TEAM_SLUG. |

### `ocs_get_chatbot`

Retrieve a single chatbot by its public UUID (from ocs_list_chatbots). Returns both `id` (UUID) and `experiment_id` (integer) — the latter is required by every authoring atom.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `public_id` | `z.string` | **required** | _—_ |

### `ocs_inspect_chatbot`

Return the chatbot's FULL denormalized config in one read-only call via OCS v2 `/api/v2/chatbots/{id}/inspect/?version=`: settings, channels, the pipeline graph + per-node inlined resources (LLM, source material, custom actions, indexed/media collections, assistant, voice), AND experiment-level `events.static_triggers` + `events.timeout_triggers` (the latter exposes the 24-hr inactivity heartbeat that node-resource walks miss). Use this for any structural verification — Connect Interviews `/ace:interview-opp-verify` reads it for router-node keywords, the 24-hr `TimeoutTrigger`, the "Session Completion" custom action, and attached collections. The OpenAPI schema at /api/schema/ (ChatbotInspect) is the field contract — grep there before paraphrasing fields. Read-only: works with a `read_only=true` `UserAPIKey`. `version` is optional: omit for the working/draft version, pass an int for a specific published version, or `"default"` for the live default-published version. Optional `team_slug` targets a non-default team — when supplied the server resolves the matching `OCS_API_TOKEN_<SLUG>` env token; missing-team errors include the exact env-var name to add.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `public_id` | `z.string` | **required** | UUID public_id of the chatbot (from ocs_list_chatbots → id) |
| `version` | `z.union` | **required** | _—_ |
| `team_slug` | `z.string` | optional | Optional team slug to inspect (e.g. "Vaccine_Coach"). Omit to use OCS_TEAM_SLUG. |

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

Retrieve a session with its full message history AND the session `state` blob (added by OCS PR #3634, deployed 2026-06-15). The `state` field surfaces session-scoped memory the bot is holding for the participant (e.g. cohort_id, last_interview, next_interview) — useful for verifying mid-conversation state during the Connect Interviews E2E walkthrough. Read-only.

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
| `embed_key` | `z.string` | **required** | Embed key (widget_token) from ocs_get_chatbot_embed_info |
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

Download a file from OCS by file ID. Two delivery modes: - `writeToPath` (STRONGLY preferred): writes the bytes to that absolute local path and returns `{filename, mime_type, size, path}` with NO base64 — costs zero context regardless of file size. Pair it with `ocs_upload_collection_files`' `file_path` to move a file inside OCS without the bytes ever entering model context. Mirrors `drive_download_binary`' and `commcare_download_ccz`' write-to-path modes. - Default (no `writeToPath`): returns `content_base64` at ~1.33x the file size in context, refused above 40,000 base64 characters (~30 KB of file) with a typed `oversized_binary` error. Only for genuinely tiny files. Tracking: dimagi-internal/ace#1182.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file_id` | `z.number` | **required** | _—_ |
| `writeToPath` | `z.string` | optional | Optional but strongly preferred. Absolute local path to write the bytes to. Returns a {path, size} handle instead of content_base64, so a large download costs zero context. Missing parent directories are created. |

### `ocs_get_me`

Cheap "is my OCS API key live + which team is it scoped to" probe via OCS v2 `/api/v2/me/` (PR #3648). Returns `{ username, email, email_verified?, team: { name, slug }, ... }` for the user the configured API key belongs to. Pair with /ace:doctor and call this BEFORE attempting `ocs_inspect_chatbot` on a new machine — if `team.slug` doesn't match the team that owns the chatbot you're trying to inspect, the inspect call will 403 / 404. Read-only. Optional `team_slug` picks a non-default registered token.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `team_slug` | `z.string` | optional | Optional team slug to probe (e.g. "Vaccine_Coach"). Omit to use OCS_TEAM_SLUG. |

### `ocs_add_team_member`

Add a person to the OCS team so a linked chatbot page actually opens for them (dimagi-internal/ace#906). Invites via the team invite form, OR — because membership is not access — additively reconciles an EXISTING accepted member's groups through the membership page (never removes groups; MembershipForm REPLACES the m2m set so the POST is always the union). Default group is "Chatbot Admin" (the least-privilege group carrying experiments.view_experiment — the permission the linked `/a/<team>/chatbots/<id>/` page needs; a member on the wrong group 403s there). Terminal statuses: invited | already-member | groups-reconciled | invite-pending. A pending invite with the WRONG groups fails loud unless replace_invite is set (then it is cancelled, the cancel is verified, and a fresh invite is sent). Every mutation is proven against a fresh page read — a 2xx POST is never treated as proof. Requires a live OCS Playwright session with Team Admin rights.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | `z.string` | **required** | Email address to invite / reconcile. |
| `group_labels` | `z.array` | **required** | _—_ |
| `replace_invite` | `z.boolean` | optional | Cancel a pending invite whose groups differ from the requested set, then re-invite. |

## ace-mobile

Source: `mcp/mobile-server.ts` — 18 atoms

### `mobile_ensure_avd_running`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `avdName` | `z.string` | optional | _—_ |

### `mobile_stop_avd`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `avdName` | `z.string` | **required** | _—_ |

### `mobile_list_avds`

_no parameters_

### `mobile_install_apk`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `avdName` | `z.string` | **required** | _—_ |
| `apkPath` | `z.string` | **required** | _—_ |

### `mobile_uninstall_apk`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `avdName` | `z.string` | **required** | _—_ |
| `packageId` | `z.string` | **required** | _—_ |

### `mobile_register_test_user`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `avdName` | `z.string` | optional | _—_ |
| `phone` | `z.string` | optional | _—_ |
| `phoneLocal` | `z.string` | optional | _—_ |
| `countryCode` | `z.string` | optional | _—_ |
| `pin` | `z.string` | optional | _—_ |
| `backupCode` | `z.string` | optional | _—_ |
| `name` | `z.string` | optional | _—_ |

### `mobile_run_recipe`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `recipePath` | `z.string` | **required** | _—_ |
| `envVars` | `z.record` | **required** | _—_ |
| `screenshotDir` | `z.string` | **required** | _—_ |
| `avdName` | `z.string` | optional | _—_ |
| `captureAllBoundaries` | `z.boolean` | optional | Tier 2 of the mapping ladder. EXPENSIVE — opens an extra ui-dump window at every top-level `runFlow` boundary, not just at `takeScreenshot` (one extra `maestro test` invocation per window; measured 3→10 and 1→9 on the two calibration recipes). Default false. Only turn this on for a targeted re-walk after an atlas-report.yaml reports `classification: unmapped-surface`. |

### `mobile_capture_ui_dump`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `avdName` | `z.string` | **required** | _—_ |

### `mobile_probe_maestro_driver`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `avdName` | `z.string` | **required** | AVD name (e.g. ACE_Pixel_API_34). Must already be booted — this atom does not boot. |
| `timeoutMs` | `z.number` | optional | Probe timeout in ms (default 8000). On a healthy AVD `maestro hierarchy` returns ~2s; raise only if you suspect a slow first-time install of the driver app. |

### `mobile_validate_recipe`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `yaml` | `z.string` | **required** | Maestro YAML body to validate. Standard ACE-recipe shape: appId frontmatter + `---` separator + step list. Validates step-key allowlist (${[...ALLOWED_STEP_KEYS].join(', ')}) and structural integrity (`---` separator present, appId in frontmatter, every step is a single-key object). Use this AFTER an ACE skill (running as a Claude Code session) writes Maestro YAML inline using its own LLM context — the mobile MCP does not bundle an LLM client, so YAML generation is the calling agent's responsibility, not this server's. |

### `mobile_resolve_selectors`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `yaml` | `z.string` | **required** | Maestro YAML body containing `${SELECTOR:logical-name}` placeholders to resolve. |
| `apkVersion` | `z.string` | optional | Connect APK version. Maps to mcp/mobile/selectors/connect-<apkVersion>.yaml. Defaults to 2.63.2 (live drift-checked 2026-07-25); bump when re-baselining against a new APK. Pin PUBLISHED releases only — 2.63.3 is a GitHub draft with no assets. |

### `mobile_save_snapshot`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `avdName` | `z.string` | **required** | _—_ |
| `snapshotName` | `z.string` | **required** | _—_ |

### `mobile_load_snapshot`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `avdName` | `z.string` | **required** | _—_ |
| `snapshotName` | `z.string` | **required** | _—_ |

### `mobile_set_location`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `avdName` | `z.string` | optional | _—_ |
| `longitude` | `z.number` | **required** | Longitude (X). NOTE: longitude is the FIRST coordinate (emulator `geo fix` console convention) — pass it before latitude to avoid the classic transposition footgun. |
| `latitude` | `z.number` | **required** | Latitude (Y). |
| `altitude` | `z.number` | optional | Altitude in metres (default 480). |
| `satellites` | `z.number` | optional | Number of satellites in the simulated fix (default 12). >= 4 yields a usable fix; more improves the reported accuracy shown in a CommCare geopoint accuracy readout. |

### `mobile_list_session_videos`

_no parameters_

### `mobile_clear_session_videos`

_no parameters_

### `mobile_diagnose`

_no parameters_

### `mobile_restart_runner`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `waitForReady` | `z.boolean` | optional | Block until the runner re-sets the ready marker (default true). False is fire-and-forget — returns a partial Diagnostics snapshot immediately. |

## ace-decisions

Source: `mcp/decisions-server.ts` — 1 atoms

### `decisions_append_rows`

Append validated load-bearing default rows to a run's decisions.yaml. The MCP transport enforces `lib/decisions-schema.ts` v4 on every row, so malformed writes (wrong field names, missing required fields, non-ordinal phase tags) are rejected at the call boundary — they never reach Drive. The tool seeds a fresh v4-compliant log header when decisions.yaml doesn't exist yet (and keeps appending to pre-existing v3 logs), and is idempotent: rows whose `id` is already present in the log are silently skipped (returned in `skipped`), so a re-run of the same skill is safe. Reviewer decision-overrides bind automatically (ace#933): if the opp has `inputs/decision-overrides.yaml` (saved by ace-web's Phases tab → Decisions panel), any appended row whose `id` matches a saved override is written with `override` + `status: overridden` + `override_reasoning` from that file, with the override value appended to the row's `options` if missing. Emitting skills need no changes and should keep sending rows as `status: ai-default` — the binding happens here. Matched ids are reported in `overridesApplied`; override ids the run never raises are ignored. Field shape mirrors `DecisionRowSchema` from `lib/decisions-schema.ts`: - `id`: kebab-case (e.g. `archetype-selection`, `wo-period-of-performance`) - `phase`: `<N>-<kebab-name>` (e.g. `1-design`, `4-connect`) — ordinal-prefixed, matches the artifact-manifest folder convention - `skill`: emitter slug (e.g. `idea-to-pdd`, `pdd-to-work-order`) - `question`: the load-bearing question this row records - `ai-default`: the AI's picked value as a string (exact-match member of `options`) - `options`: array of short scannable labels for what was considered - `source`: citation only (where the info came from) - `evidence_basis` (REQUIRED, v4): how grounded the default is — `stated` (directly in a source), `inferred` (extrapolated beyond any source), or `conflicting` (resolves disagreeing sources). This forces Phase-1 to declare, per decision, whether it sourced, extrapolated, or resolved a contested fork — instead of silently presenting an inferred default as fact. - `conflict_signals` (REQUIRED iff `evidence_basis: conflicting`; >= 2 entries): the competing source readings you resolved, one per entry, each ideally citing where it came from. Omit for `stated`/`inferred`. - `status`: `ai-default` (always for new rows; the renderer + sync skills flip to `overridden` after human edits) - `reasoning` (optional): AI's rationale (for `conflicting`, state WHY this resolution won) - `override` (optional; only with `status: overridden`) - `override_reasoning` (optional; only with `status: overridden`) Returns `{fileId, added, skipped[], total, created, modifiedTime, revisionVersion}`, plus `headerRepairs[]` when an inherited header needed repair — a SEEDED run copies the parent run's header verbatim, so its `generated_at` can arrive in a non-ISO spelling and its `run_id` can name the seed run. Both are repaired in place (the run folder is the authority on run_id) instead of rejecting the write: before ace#1029 either one rejected EVERY append for the whole run, and since this atom is the only sanctioned writer, the run silently lost its entire decisions trail. An `opportunity` mismatch is still a hard error — that one is data loss.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `runFolderId` | `z.string` | **required** | Drive file ID of the run folder (e.g. resolved via resolve_opp_path → runs/<run-id>). decisions.yaml lives at the root of this folder. |
| `opportunity` | `z.string` | **required** | Opportunity slug (e.g. `bednet-spot-check`). Must match an existing log's `opportunity` if one is already in place. |
| `run_id` | `z.string` | **required** | Run id (e.g. `20260525-2013`). Must match an existing log's `run_id` if one is already in place. |
| `rows` | `z.array` | **required** | Array of validated decision rows to append. Each row's `ai-default` (and `override` if set) MUST be one of the strings in its `options` array, exact-match — put rationale in `reasoning`, never in `ai-default`. Duplicate ids within the batch are rejected; ids already present in the existing log are silently skipped (idempotent re-run). |
