/**
 * Google Drive MCP Server for ACE
 *
 * Exposes Google Drive and Sheets tools over stdio using the Model Context
 * Protocol. Uses a service account JSON key for auth.
 *
 * Adapted from chrome-sales/mcp/google-drive-server.ts
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import { resolvePluginDataDir, logPluginDataDirDiag } from '../lib/plugin-data-dir.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY_KEY_PATH = path.join(PROJECT_ROOT, '.gws-sa-key.json');

// One-line stderr diag so MCP log shows exactly what CLAUDE_PLUGIN_DATA /
// CLAUDE_PLUGIN_ROOT the subprocess received and which tier resolveKeyPath
// will use. See anthropics/claude-code#9427 for the underlying env-block
// substitution bug this works around.
logPluginDataDirDiag('ace-gdrive', import.meta.url);

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/presentations',
];

// ============================================================================
// Auth
// ============================================================================

/**
 * Resolve the Google service-account key path.
 *
 * Priority:
 *   1. $GOOGLE_APPLICATION_CREDENTIALS — Google's standard env var. Operators
 *      who set it explicitly keep working.
 *   2. <plugin-data-dir>/gws-sa-key.json via `resolvePluginDataDir`, which
 *      tries `$CLAUDE_PLUGIN_DATA` first, then self-derives the data dir
 *      from this module's path at runtime. The derivation is the real
 *      workaround for https://github.com/anthropics/claude-code/issues/9427:
 *      in our testing (Claude Code 2.1.116, 2026-04-21), Claude Code does
 *      NOT expand `${CLAUDE_PLUGIN_DATA}` inside env blocks for plugin MCP
 *      configs — neither in `.mcp.json` nor in inline `plugin.json`
 *      `mcpServers` — even though the docs imply it should. By deriving the
 *      data dir from `import.meta.url` we sidestep the broken env path
 *      entirely.
 *   3. <plugin-root>/.gws-sa-key.json — legacy fallback for pre-migration
 *      local-dev checkouts.
 */
function resolveKeyPath(): string {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }
  // Tier 2: the plugin-data-dir helper tries $CLAUDE_PLUGIN_DATA first, then
  // self-derives from the server's module path as a fallback. Handles both
  // the "env var was passed" and "env var wasn't passed (9427)" cases.
  const dataDir = resolvePluginDataDir(import.meta.url);
  if (dataDir) {
    const dataKey = path.join(dataDir, 'gws-sa-key.json');
    if (fs.existsSync(dataKey)) {
      return dataKey;
    }
  }
  if (fs.existsSync(LEGACY_KEY_PATH)) {
    return LEGACY_KEY_PATH;
  }
  throw new Error(
    `No Google service-account key found. Set GOOGLE_APPLICATION_CREDENTIALS, ` +
      `place the key at $CLAUDE_PLUGIN_DATA/gws-sa-key.json, ` +
      `or place it at ${LEGACY_KEY_PATH}. Run /ace:setup for help.`,
  );
}

function getAuth() {
  return new google.auth.GoogleAuth({
    keyFile: resolveKeyPath(),
    scopes: SCOPES,
  });
}

// Auth init is tolerant of missing credentials so the module is importable in
// tests that mock the Drive client entirely (no real Google calls). Production
// MCP server runs always have a valid SA key — `/ace:doctor` flags missing keys
// before any tool call, and the underlying `googleapis` calls would surface a
// clear auth error if the key were missing at runtime.
let auth: ReturnType<typeof getAuth> | undefined;
try {
  auth = getAuth();
} catch {
  // Leave undefined; downstream `drive`/`sheets`/etc. clients will be unusable
  // until a real key is in place. Tests inject mocked Drive clients directly
  // into the exported handlers (e.g. handleCreateFolder) and never touch the
  // module-level `drive`.
}
const sheets = google.sheets({ version: 'v4', auth });
const drive = google.drive({ version: 'v3', auth });
const docs = google.docs({ version: 'v1', auth });
const slides = google.slides({ version: 'v1', auth });

// ============================================================================
// Helper
// ============================================================================

function result(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function error(msg: string) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${msg}` }],
  };
}

/**
 * Pre-flight: verify the parent folder lives on a Shared Drive.
 *
 * Service Accounts have zero My-Drive storage quota. A `files.create` with a
 * My-Drive parent (or no parent) silently lands in the SA's My-Drive root,
 * and every subsequent file write into that folder fails with the misleading
 * error "The user's Drive storage quota has been exceeded." Catching this at
 * the create-call boundary turns a class of silent corruption into a typed,
 * actionable failure.
 *
 * On a Shared Drive, every file/folder has a non-empty `driveId` (the Shared
 * Drive's ID). On My Drive, `driveId` is absent. That single field is the
 * canonical signal — no scope checks, no quota probes, no second API call
 * beyond the one `files.get`.
 */
async function assertParentOnSharedDrive(
  parentFolderId: string,
  driveClient: typeof drive = drive,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const meta = await driveClient.files.get({
      fileId: parentFolderId,
      fields: 'id, name, driveId, mimeType',
      supportsAllDrives: true,
    });
    if (meta.data.mimeType !== 'application/vnd.google-apps.folder') {
      return { ok: false, message: `Parent ${parentFolderId} is not a folder (mimeType: ${meta.data.mimeType}).` };
    }
    if (!meta.data.driveId) {
      return {
        ok: false,
        message:
          `Parent folder "${meta.data.name}" (${parentFolderId}) is in My Drive, not on a Shared Drive. ` +
          `Service Accounts have zero My-Drive quota; any file create here would fail with "user storage quota exceeded". ` +
          `Move the folder onto a Shared Drive (or set ACE_DRIVE_ROOT_FOLDER_ID to a folder that already lives on one) and re-run.`,
      };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, message: `Could not resolve parent folder ${parentFolderId}: ${e.message}` };
  }
}

// ============================================================================
// MCP Server
// ============================================================================

const server = new McpServer({
  name: 'ace-gdrive',
  version: '0.2.0',
});

// 1. List sheets (tabs) in a spreadsheet
server.tool(
  'sheets_list_tabs',
  'List all sheet tabs in a Google Spreadsheet',
  { spreadsheetId: z.string().describe('The spreadsheet ID from the URL') },
  async ({ spreadsheetId }) => {
    try {
      const resp = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
      const tabs = resp.data.sheets?.map(s => ({
        sheetId: s.properties?.sheetId,
        title: s.properties?.title,
        rowCount: s.properties?.gridProperties?.rowCount,
        columnCount: s.properties?.gridProperties?.columnCount,
      }));
      return result(tabs);
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 2. Read a range
server.tool(
  'sheets_read',
  'Read a range of cells from a Google Spreadsheet. Returns rows as arrays.',
  {
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    range: z.string().describe('A1 notation range, e.g. "Sheet1!A1:D10" or just "Sheet1"'),
  },
  async ({ spreadsheetId, range }) => {
    try {
      const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
      return result({ range: resp.data.range, values: resp.data.values });
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 3. Write a range
server.tool(
  'sheets_write',
  'Write values to a range in a Google Spreadsheet',
  {
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    range: z.string().describe('A1 notation range, e.g. "Sheet1!A1:D10"'),
    values: z.array(z.array(z.string())).describe('2D array of values to write'),
  },
  async ({ spreadsheetId, range, values }) => {
    try {
      const resp = await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values },
      });
      return result({ updatedRange: resp.data.updatedRange, updatedCells: resp.data.updatedCells });
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 4. Append rows
server.tool(
  'sheets_append',
  'Append rows to the end of a sheet',
  {
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    range: z.string().describe('Sheet name or range to append after, e.g. "Sheet1"'),
    values: z.array(z.array(z.string())).describe('2D array of rows to append'),
  },
  async ({ spreadsheetId, range, values }) => {
    try {
      const resp = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values },
      });
      return result({ updatedRange: resp.data.updates?.updatedRange, updatedRows: resp.data.updates?.updatedRows });
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 5. Get spreadsheet metadata
server.tool(
  'sheets_info',
  'Get metadata about a Google Spreadsheet (title, locale, sheets)',
  { spreadsheetId: z.string().describe('The spreadsheet ID') },
  async ({ spreadsheetId }) => {
    try {
      const resp = await sheets.spreadsheets.get({ spreadsheetId });
      return result({
        title: resp.data.properties?.title,
        locale: resp.data.properties?.locale,
        sheets: resp.data.sheets?.map(s => ({
          title: s.properties?.title,
          sheetId: s.properties?.sheetId,
          rowCount: s.properties?.gridProperties?.rowCount,
          columnCount: s.properties?.gridProperties?.columnCount,
        })),
      });
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 6. Batch read multiple ranges
server.tool(
  'sheets_batch_read',
  'Read multiple ranges from a spreadsheet in one call',
  {
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    ranges: z.array(z.string()).describe('Array of A1 notation ranges'),
  },
  async ({ spreadsheetId, ranges }) => {
    try {
      const resp = await sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges });
      const results = resp.data.valueRanges?.map(vr => ({
        range: vr.range,
        values: vr.values,
      }));
      return result(results);
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 7. Create a new tab
server.tool(
  'sheets_create_tab',
  'Create a new tab (sheet) in a Google Spreadsheet',
  {
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    title: z.string().describe('Name for the new tab'),
  },
  async ({ spreadsheetId, title }) => {
    try {
      const resp = await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title } } }],
        },
      });
      const props = resp.data.replies?.[0]?.addSheet?.properties;
      return result({ sheetId: props?.sheetId, title: props?.title });
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 8. List files in a Drive folder
server.tool(
  'drive_list_folder',
  'List files in a Google Drive folder',
  {
    folderId: z.string().describe('The Google Drive folder ID'),
  },
  async ({ folderId }) => {
    try {
      const safeFolderId = folderId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const resp = await drive.files.list({
        q: `'${safeFolderId}' in parents and trashed = false`,
        fields: 'files(id, name, mimeType, modifiedTime, webViewLink, shortcutDetails)',
        orderBy: 'name',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      return result(resp.data.files);
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 9. Read a Drive file
server.tool(
  'drive_read_file',
  'Read the text content of a file in Google Drive. Works with Google Docs (exported as plain text), text/* files (markdown, plain text, etc.), and JSON/YAML/XML/CSV variants. Refuses non-text mimetypes (PDF, docx/xlsx/pptx, images, audio, zip) with a typed `unsupported_binary_mimetype` error pointing at `drive_download_binary` — pre-#106-finding-4 the read returned raw binary as a JSON-corrupted string and silently fed garbage into callers. Returns revisionVersion so callers can pair the read with an optimistic-concurrency `ifMatchRevisionId` on `drive_update_file` (read-modify-write without lost updates). Transient 5xx responses are retried internally (3 attempts, 1s/2s/4s backoff).',
  {
    fileId: z.string().describe('The Google Drive file ID'),
  },
  async ({ fileId }) => {
    try {
      const r = await handleReadFile({ fileId }, drive);
      return result(r);
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 9b. Read a Drive file via personal OAuth (gog CLI fallback)
server.tool(
  'read_personal_drive_doc',
  'Read a Google Drive document via personal OAuth (gog CLI) — fallback for files shared with the human user account but not the ACE service account. Requires gog to be installed and authorized for Drive on $ACE_GMAIL_ACCOUNT/$ACE_GMAIL_CLIENT. If the user has not yet granted Drive scope, re-run: `gog login $ACE_GMAIL_ACCOUNT --client $ACE_GMAIL_CLIENT --services gmail,drive`. Use only when drive_read_file fails with a permission error.',
  {
    file_id: z.string().describe('The Google Drive file ID'),
    format: z.enum(['txt', 'md', 'csv']).optional().describe('Export format for Google Docs/Sheets (default: txt for Docs, csv for Sheets)'),
  },
  async ({ file_id, format }) => {
    const account = process.env.ACE_GMAIL_ACCOUNT;
    const client = process.env.ACE_GMAIL_CLIENT;
    if (!account || !client) {
      return error('ACE_GMAIL_ACCOUNT and ACE_GMAIL_CLIENT must be set in .env (these select the gog OAuth identity).');
    }
    const fmt = format ?? 'txt';
    const tmpFile = path.join(os.tmpdir(), `ace-personal-drive-${process.pid}-${Date.now()}.${fmt}`);
    try {
      const args = [
        'drive', 'download', file_id,
        '--account', account,
        '--client', client,
        '--format', fmt,
        '--out', tmpFile,
        '--no-input',
      ];
      const proc = spawnSync('gog', args, { encoding: 'utf8' });
      if (proc.error) {
        return error(`gog binary not found or not executable: ${proc.error.message}. Install with: brew install steipete/tap/gogcli`);
      }
      // gog can return exit 0 even on 404; check stderr and that the file
      // was actually written.
      const stderr = (proc.stderr || '').trim();
      if (proc.status !== 0 || !fs.existsSync(tmpFile) || fs.statSync(tmpFile).size === 0) {
        const reauth = `gog login ${account} --client ${client} --services gmail,drive`;
        return error(
          `gog drive download failed: ${stderr || 'no output written'}. ` +
          `If the error mentions scope/permission/insufficient, re-auth gog with Drive scope: ${reauth}`,
        );
      }
      const content = fs.readFileSync(tmpFile, 'utf8');
      return result({ file_id, format: fmt, content });
    } catch (e: any) {
      return error(e.message);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  },
);

// 10. Update a Drive file's content
server.tool(
  'drive_update_file',
  'Update the text content of an existing Google Doc in Drive. Use for updating PDDs, summaries, and other docs as ACE skills produce new content. Pass `ifMatchRevisionId` (from a prior `drive_read_file`) to opt into optimistic-concurrency CAS — the write is rejected with a typed `revision_conflict` error if another writer changed the file in between, so the caller can re-read and retry without overwriting concurrent edits. Required pattern for any read-modify-write on a shared file (e.g., opp.yaml updates from concurrent /ace:run invocations).',
  {
    fileId: z.string().describe('The Google Drive file ID'),
    content: z.string().describe('The new text content to write'),
    ifMatchRevisionId: z.string().optional().describe('Optional. The revisionVersion returned by the prior drive_read_file. If supplied and the file\'s current revisionVersion no longer matches, the update is rejected with a revision_conflict error instead of overwriting the change.'),
  },
  async ({ fileId, content: newContent, ifMatchRevisionId }) => {
    try {
      // Optimistic concurrency: re-read the file's `version` and compare. Drive's
      // files.update has no native If-Match equivalent, so we do the check
      // server-side here. This narrows but does not eliminate the race; for
      // ACE's concurrent /ace:run scenario the window is one Drive round-trip,
      // small enough that the retry-once strategy in the orchestrator is
      // sufficient.
      if (ifMatchRevisionId) {
        const meta = await withTransientRetry(() =>
          drive.files.get({ fileId, fields: 'version', supportsAllDrives: true }),
        );
        const current = (meta.data as any).version as string | undefined;
        if (current && current !== ifMatchRevisionId) {
          return error(
            `revision_conflict: file ${fileId} revisionVersion is ${current}, expected ${ifMatchRevisionId}. ` +
              `Re-read and retry.`,
          );
        }
      }
      const resp = await withTransientRetry(() => drive.files.update({
        fileId,
        media: { mimeType: 'text/plain', body: newContent },
        fields: 'id, name, modifiedTime, version',
        supportsAllDrives: true,
      }));
      return result({
        id: resp.data.id,
        name: resp.data.name,
        modifiedTime: resp.data.modifiedTime,
        revisionVersion: (resp.data as any).version,
      });
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 10a. Patch a YAML file server-side (read+merge+CAS-write in one call)
server.tool(
  'update_yaml_file',
  'Patch a YAML-content Google Doc in one MCP call: the server reads the current content + revisionVersion, parses it as YAML (treating empty/missing as `{}`), shallow-merges `patch` into the top-level keys (replace, NOT deep-merge — predictable), serializes back to YAML, and writes with optimistic-concurrency. On a `revision_conflict` (a concurrent writer landed between read and write) the call retries once with the freshly-observed revision. Use this for run_state.yaml / opp.yaml updates instead of pairing drive_read_file + drive_update_file by hand: it saves one round-trip per state transition AND keeps the full file content out of the model context (the model only sends the diff). For arbitrary text files use drive_update_file instead.',
  {
    fileId: z.string().describe('The Google Drive file ID of the YAML doc'),
    patch: z.record(z.unknown()).describe('Object whose top-level keys are merged into the existing YAML (replace, not deep-merge). Use a nested object only when you intend to fully replace that subtree.'),
  },
  async ({ fileId, patch }) => {
    try {
      const r = await handleUpdateYamlFile({ fileId, patch }, drive);
      return result(r);
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 11. Create a file in Google Drive
server.tool(
  'drive_create_file',
  'Create a new Google Doc in Drive with the given name and content, inside the given parent folder. By default, find-or-update: if a same-name file already exists under the parent (non-trashed), its content is replaced with `content` and its id is returned — no duplicate is created. Pass `findOrCreate:false` to force a new sibling. Body is uploaded as `text/plain; charset=utf-8` so non-ASCII text (em-dashes, accents, smart quotes) round-trips correctly. The parent MUST be a folder on a Shared Drive — Service Accounts have zero My-Drive quota, so files created in My Drive fail with a misleading "user storage quota exceeded" error. Used by ACE skills (idea-to-pdd, pdd-to-learn-app, etc.) to write artifacts to opportunity folders.',
  {
    name: z.string().describe('Name for the new file'),
    content: z.string().describe('Text content for the file'),
    parentFolderId: z.string().min(1).describe('Required. Parent folder ID — MUST be a folder on a Shared Drive (the MCP verifies this before writing).'),
    findOrCreate: z.boolean().optional().describe('When true (default), reuse an existing same-name file under the parent and overwrite its content; otherwise always create a new sibling. Default: true. Set to false only when you specifically want a separate sibling each call.'),
  },
  async ({ name: fileName, content: fileContent, parentFolderId, findOrCreate }) => {
    try {
      const r = await handleCreateFile({ name: fileName, content: fileContent, parentFolderId, findOrCreate }, drive);
      return result(r);
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 11a. Copy an existing Drive file server-side
server.tool(
  'drive_copy_file',
  'Copy an existing Google Drive file server-side into a parent folder, optionally with a new name. Wraps Drive\'s native files.copy(), so a Google Doc copy stays a Google Doc, a markdown copy stays markdown, etc. — preserves mimeType and content without ferrying bytes through the model. Use this instead of drive_read_file + drive_create_file whenever the goal is "copy file X to folder Y" — it saves a full content round-trip (~6KB+ per PDD-sized doc and ~minutes of model serialization latency). The destination parent MUST live on a Shared Drive — same Service Account quota constraint as drive_create_file.',
  {
    sourceFileId: z.string().describe('The Drive file ID to copy from'),
    parentFolderId: z.string().min(1).describe('Required. Destination folder ID — MUST be a folder on a Shared Drive (the MCP verifies this before writing).'),
    name: z.string().optional().describe('Optional name for the copy (defaults to the source file\'s name).'),
  },
  async ({ sourceFileId, parentFolderId, name: copyName }) => {
    try {
      const guard = await assertParentOnSharedDrive(parentFolderId);
      if (!guard.ok) return error(guard.message);
      const requestBody: Record<string, unknown> = { parents: [parentFolderId] };
      if (copyName) requestBody.name = copyName;
      const resp = await drive.files.copy({
        fileId: sourceFileId,
        requestBody,
        fields: 'id, name, mimeType, webViewLink',
        supportsAllDrives: true,
      });
      return result({
        id: resp.data.id,
        name: resp.data.name,
        mimeType: resp.data.mimeType,
        webViewLink: resp.data.webViewLink,
      });
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 11b. Upload a binary file (PNG, PDF, audio, etc.) to Google Drive
server.tool(
  'drive_upload_binary',
  'Upload a binary file (PNG, JPG, PDF, audio, video, etc.) to Google Drive inside the given parent folder. Content is base64-encoded; the MCP decodes it and uses Drive\'s media-upload path with the supplied mime type, so the file lands as its native type (NOT auto-converted to a Google Doc — that\'s what `drive_create_file` is for). Used by ACE skills that need to upload screenshots (Phase 5 `app-screenshot-capture`), CCZs, training-material attachments, audio session recordings, etc. Pass `shareAnyoneWithLink: true` to atomically grant `role: reader` to `type: anyone` on the new file — required for downstream Slides `createImage` ingest (Slides\' image-import service does NOT carry the SA\'s auth, so an SA-only PNG renders as an empty image in the deck). The parent MUST be a folder on a Shared Drive — same Service Account quota constraint as `drive_create_file` / `drive_create_folder`.',
  {
    name: z.string().describe('Name for the new file (include the extension — e.g., "screen-01.png", not "screen-01")'),
    contentBase64: z.string().describe('File content, base64-encoded. For PNGs from `cat foo.png | base64`, just paste the result. The MCP decodes before upload.'),
    mimeType: z.string().describe('MIME type of the binary content. Common ACE values: "image/png", "image/jpeg", "application/pdf", "audio/mpeg", "application/zip" (CCZ).'),
    parentFolderId: z.string().min(1).describe('Required. Parent folder ID — MUST be a folder on a Shared Drive (the MCP verifies this before writing).'),
    shareAnyoneWithLink: z.boolean().optional().describe('When true, after a successful upload set sharing to `role: reader, type: anyone` (anyone-with-link). Required for any PNG that downstream Slides `createImage` will fetch — Slides\' image-import service does not carry the SA\'s auth. Default: false.'),
  },
  async ({ name: fileName, contentBase64, mimeType, parentFolderId, shareAnyoneWithLink }) => {
    try {
      const guard = await assertParentOnSharedDrive(parentFolderId);
      if (!guard.ok) return error(guard.message);
      const buf = Buffer.from(contentBase64, 'base64');
      if (buf.length === 0) {
        return error('contentBase64 decoded to 0 bytes — verify the input is valid base64.');
      }
      const created = await drive.files.create({
        requestBody: {
          name: fileName,
          mimeType,
          parents: [parentFolderId],
        },
        media: {
          mimeType,
          body: Readable.from(buf),
        },
        fields: 'id, name, webViewLink, mimeType, size',
        supportsAllDrives: true,
      });
      let sharing: 'anyone-with-link' | 'sa-only' = 'sa-only';
      if (shareAnyoneWithLink && created.data.id) {
        await drive.permissions.create({
          fileId: created.data.id,
          supportsAllDrives: true,
          requestBody: { role: 'reader', type: 'anyone' },
        });
        sharing = 'anyone-with-link';
      }
      return result({
        id: created.data.id,
        name: created.data.name,
        mimeType: created.data.mimeType,
        size: created.data.size,
        webViewLink: created.data.webViewLink,
        sharing,
      });
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 11c. Download a binary file (PDF, DOCX, XLSX, image, etc.) from Drive
server.tool(
  'drive_download_binary',
  'Download a binary or non-Google-Doc file from Google Drive and return its bytes base64-encoded. The companion atom to `drive_upload_binary`. Use for PDFs, docx/xlsx/pptx, images, audio, zip (CCZ), etc. — any mimeType that `drive_read_file` rejects with `unsupported_binary_mimetype`. Returns `{ id, name, mimeType, size, content_base64 }`. Caller is responsible for decoding (e.g. `Buffer.from(content_base64, "base64")` in JS or `base64.b64decode` in Python). Skills that need extracted text from PDF/DOCX/XLSX should pair this with their own extractor — server-side text extraction is intentionally NOT done here so this stays a pure transport atom. Transient 5xx responses retried internally (3 attempts, 1s/2s/4s backoff). Tracking: jjackson/ace#106 finding 4.',
  {
    fileId: z.string().describe('The Google Drive file ID. Resolves Drive shortcuts transparently.'),
  },
  async ({ fileId }) => {
    try {
      const r = await handleDownloadBinary({ fileId }, drive);
      return result(r);
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 11d. Set anyone-with-link sharing on an existing Drive file
server.tool(
  'drive_set_anyone_with_link',
  'Grant `role: reader, type: anyone` (anyone-with-link) on an existing Drive file. Required for any PNG that downstream Slides `createImage` will fetch — Slides\' image-import service does NOT carry the SA\'s auth, so an SA-only file renders as a blank image in the deck. `drive_upload_binary` accepts a `shareAnyoneWithLink` flag that does this inline at upload time; use this atom when the file already exists or was uploaded without the flag. Idempotent: Drive ignores duplicate `type: anyone` permission grants.',
  {
    fileId: z.string().min(1).describe('The Drive file ID to share. Must be a file the SA can access.'),
  },
  async ({ fileId }) => {
    try {
      const resp = await drive.permissions.create({
        fileId,
        supportsAllDrives: true,
        requestBody: { role: 'reader', type: 'anyone' },
      });
      return result({ fileId, permissionId: resp.data.id, sharing: 'anyone-with-link' });
    } catch (e: any) {
      return error(e.message);
    }
  },
);

/**
 * Classify an error thrown by the googleapis client as a transient 5xx that
 * should be retried, vs a permanent error (4xx, auth, malformed args) that
 * should not. We accept either a numeric `code` (modern client) or a string
 * message that names the failure mode (older client / network errors).
 */
function isTransientDriveError(e: any): boolean {
  const code = typeof e?.code === 'number' ? e.code : Number(e?.code);
  if (Number.isFinite(code) && code >= 500 && code < 600) return true;
  const msg = String(e?.message || '').toLowerCase();
  if (/internal error|backend error|service unavailable|gateway|timeout|econnreset|etimedout/.test(msg)) {
    return true;
  }
  return false;
}

/**
 * Run `op` with up to N attempts on transient 5xx errors. Backoff schedule
 * is 1s, 2s, 4s; a `sleep` injection lets tests skip the actual wait. The
 * final failure rethrows so the caller still surfaces it.
 */
async function withTransientRetry<T>(
  op: () => Promise<T>,
  opts: { maxAttempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let lastErr: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await op();
    } catch (e: any) {
      lastErr = e;
      if (!isTransientDriveError(e)) throw e;
      if (attempt < maxAttempts) {
        const backoffMs = 1000 * Math.pow(2, attempt - 1);
        await sleep(backoffMs);
      }
    }
  }
  throw lastErr;
}

/**
 * Read-file handler, exported for unit testing with a mocked Drive client.
 *
 * Each underlying Drive API call is wrapped in `withTransientRetry` so that a
 * single 503 / 500 / "Backend Error" doesn't force the caller to handle a
 * retry by hand. 4xx responses (404, 403, etc.) are not retried — those
 * indicate caller bugs, not transient infrastructure flakes.
 */
export async function handleReadFile(
  args: { fileId: string },
  driveClient: typeof drive = drive,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ name: string | undefined; mimeType: string; content: string; revisionVersion: string | undefined }> {
  const { fileId } = args;
  const retry = <T>(op: () => Promise<T>) => withTransientRetry(op, opts);

  // Drive API exposes the monotonic revision counter as `version` (a string in
  // the wire format). It IS populated for Docs Editors files (which is most of
  // ACE's writes) — unlike `headRevisionId`, which is binary-files-only. We
  // surface it as `revisionVersion` to make its role obvious to callers.
  const meta = await retry(() =>
    driveClient.files.get({ fileId, fields: 'mimeType, name, shortcutDetails, version', supportsAllDrives: true }),
  );
  let resolvedId = fileId;
  let mimeType = (meta.data as any).mimeType || '';
  let revisionVersion = (meta.data as any).version as string | undefined;

  // If the file is a Drive shortcut, resolve to the target file. Shortcuts
  // have their own mimeType and store the target's ID/mimeType in
  // shortcutDetails; the shortcut's version is not the target's version.
  if (mimeType === 'application/vnd.google-apps.shortcut') {
    const targetId = (meta.data as any).shortcutDetails?.targetId;
    const targetMimeType = (meta.data as any).shortcutDetails?.targetMimeType;
    if (!targetId) throw new Error('Shortcut has no target file ID');
    resolvedId = targetId;
    mimeType = targetMimeType || '';
    const targetMeta = await retry(() =>
      driveClient.files.get({ fileId: resolvedId, fields: 'version', supportsAllDrives: true }),
    );
    revisionVersion = (targetMeta.data as any).version as string | undefined;
  }

  let content: string;
  if (mimeType === 'application/vnd.google-apps.document') {
    const resp = await retry(() =>
      driveClient.files.export({ fileId: resolvedId, mimeType: 'text/plain' }, { responseType: 'text' }),
    );
    content = resp.data as string;
  } else if (isTextMimeType(mimeType)) {
    const resp = await retry(() =>
      driveClient.files.get({ fileId: resolvedId, alt: 'media', supportsAllDrives: true }, { responseType: 'text' }),
    );
    content = resp.data as string;
  } else {
    // Non-Google-Doc, non-text mimetype (PDF, docx, xlsx, image, audio,
    // zip, etc.). The pre-#106-finding-4 code path returned the raw bytes
    // as a JSON-corrupted "string", which (a) blew past the inline-content
    // token budget on big PDFs, (b) survived JSON encoding by mangling
    // multi-byte sequences, and (c) silently fed garbage into callers.
    // Refuse loudly with a typed error pointing at the right tool — same
    // class of fix as the OCS `{collection_index_summaries}` invariant
    // (boundary-rejecting silent-failure modes). Tracking: jjackson/ace#106
    // finding 4.
    throw new Error(
      `unsupported_binary_mimetype: drive_read_file cannot return raw binary content (mimeType=${mimeType}). ` +
        `Use drive_download_binary for binary file types (PDF, docx, xlsx, images, audio, zip). ` +
        `For Google Sheets / Slides, drive_read_file does not currently support text export — ` +
        `download via drive_download_binary or open the file in Drive directly.`,
    );
  }

  return { name: (meta.data as any).name, mimeType, content, revisionVersion };
}

/**
 * Download-binary handler, exported for unit testing with a mocked Drive
 * client. Returns `{ id, name, mimeType, size, content_base64 }`. Resolves
 * Drive shortcuts transparently to the same target the read path follows.
 * Each underlying Drive API call is wrapped in `withTransientRetry`.
 */
export async function handleDownloadBinary(
  args: { fileId: string },
  driveClient: typeof drive = drive,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ id: string; name: string; mimeType: string; size: number; content_base64: string }> {
  const { fileId } = args;
  const retry = <T>(op: () => Promise<T>) => withTransientRetry(op, opts);

  const meta = await retry(() =>
    driveClient.files.get({
      fileId,
      fields: 'id, name, mimeType, size, shortcutDetails',
      supportsAllDrives: true,
    }),
  );
  let resolvedId = (meta.data as any).id || fileId;
  let mimeType = (meta.data as any).mimeType || '';
  let name = (meta.data as any).name || '';

  if (mimeType === 'application/vnd.google-apps.shortcut') {
    const targetId = (meta.data as any).shortcutDetails?.targetId;
    if (!targetId) throw new Error('Shortcut has no target file ID');
    const targetMeta = await retry(() =>
      driveClient.files.get({
        fileId: targetId,
        fields: 'id, name, mimeType, size',
        supportsAllDrives: true,
      }),
    );
    resolvedId = targetId;
    mimeType = (targetMeta.data as any).mimeType || '';
    name = (targetMeta.data as any).name || name;
  }

  if (mimeType.startsWith('application/vnd.google-apps.')) {
    throw new Error(
      `cannot_download_native_google_doc: file ${resolvedId} is a native Google Doc/Sheet/Slides ` +
        `(mimeType=${mimeType}). Native Docs editors files have no binary representation. ` +
        `Use drive_read_file to text-export Docs, or open the file in Drive to download a converted format.`,
    );
  }

  const resp = await retry(() =>
    driveClient.files.get(
      { fileId: resolvedId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' },
    ),
  );
  const buf = Buffer.from(resp.data as ArrayBuffer);
  return {
    id: resolvedId,
    name,
    mimeType,
    size: buf.length,
    content_base64: buf.toString('base64'),
  };
}

/**
 * Mimetypes that drive_read_file safely returns inline as text. Anything
 * else either round-trips as a Google Doc export (text/plain) or, if it's
 * a true binary, surfaces as `unsupported_binary_mimetype`.
 *
 * The list intentionally errs on the side of "safe to return" — omitting
 * a mimetype means a fail-closed error rather than silently corrupting
 * the read.
 */
function isTextMimeType(mimeType: string): boolean {
  if (!mimeType) return false;
  if (mimeType.startsWith('text/')) return true;
  // Common JSON / YAML / CSV variants that masquerade as application/* but
  // are textual on the wire.
  return [
    'application/json',
    'application/yaml',
    'application/x-yaml',
    'application/xml',
    'application/csv',
  ].includes(mimeType);
}

/**
 * Patch-yaml-file handler, exported for unit testing with a mocked Drive client.
 *
 * Reads `fileId` (Google Doc, plain text export), parses as YAML (empty
 * file = `{}`), shallow-merges `patch` into the top level (top-level keys are
 * replaced outright, not deep-merged), serializes, writes with
 * `ifMatchRevisionId = revisionVersion-just-read`. On `revision_conflict` we
 * retry once with the freshly-observed revision (covers the common case of a
 * concurrent writer landing between our read and our write); a second
 * conflict surfaces to the caller.
 */
export async function handleUpdateYamlFile(
  args: { fileId: string; patch: Record<string, unknown> },
  driveClient: typeof drive = drive,
): Promise<{ id: string; name: string; modifiedTime: string; revisionVersion: string | undefined }> {
  const { fileId, patch } = args;
  const maxAttempts = 2;
  let lastErr: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const current = await handleReadFile({ fileId }, driveClient);
    const parsed = current.content && current.content.trim() ? YAML.parse(current.content) : {};
    const base: Record<string, unknown> = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    const merged: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(patch)) merged[k] = v;
    const newContent = YAML.stringify(merged);

    try {
      const resp = await withTransientRetry(() => driveClient.files.update({
        fileId,
        media: { mimeType: 'text/plain', body: newContent },
        fields: 'id, name, modifiedTime, version',
        supportsAllDrives: true,
      } as any));
      return {
        id: (resp.data as any).id,
        name: (resp.data as any).name,
        modifiedTime: (resp.data as any).modifiedTime,
        revisionVersion: (resp.data as any).version,
      };
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || '');
      if (!/revision_conflict/i.test(msg)) throw e;
      // fall through to next attempt: re-read, re-merge, re-write
    }
  }
  throw lastErr;
}

/**
 * Create-folder handler, exported for unit testing with a mocked Drive client.
 *
 * Default behavior is find-or-create: if a folder with the same `name` already
 * exists under `parentFolderId` (non-trashed), return that one instead of
 * creating a duplicate. This closes a class of silent bug where parallel skill
 * writes each created a fresh same-named folder under a run root (observed:
 * two `verdicts/` folders under `leep-paint-collection/runs/20260503-2128/`).
 *
 * Pass `findOrCreate: false` to opt out — only do this when you specifically
 * need a separate sibling.
 */
export async function handleCreateFolder(
  args: { name: string; parentFolderId: string; findOrCreate?: boolean },
  driveClient: typeof drive = drive,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ id: string; name: string; webViewLink?: string }> {
  const { name, parentFolderId, findOrCreate = true } = args;
  const retry = <T>(op: () => Promise<T>) => withTransientRetry(op, opts);
  const guard = await assertParentOnSharedDrive(parentFolderId, driveClient);
  if (!guard.ok) throw new Error(guard.message);
  if (findOrCreate) {
    const escaped = name.replace(/'/g, "\\'");
    const list = await retry(() => driveClient.files.list({
      q: `mimeType='application/vnd.google-apps.folder' and name='${escaped}' and '${parentFolderId}' in parents and trashed=false`,
      fields: 'files(id, name, webViewLink)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    }));
    const existing = list.data.files?.[0];
    if (existing?.id) {
      return { id: existing.id, name: existing.name!, webViewLink: existing.webViewLink ?? undefined };
    }
  }
  const resp = await retry(() => driveClient.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  }));
  return { id: resp.data.id!, name: resp.data.name!, webViewLink: resp.data.webViewLink ?? undefined };
}

/**
 * Create-file handler, exported for unit testing with a mocked Drive client.
 *
 * Uploads `content` as a Google Doc body via Drive's two-step
 * (create-then-import) flow. Body is sent with explicit
 * `text/plain; charset=utf-8` so non-ASCII text (em-dashes, accented
 * characters, smart quotes, etc.) round-trips correctly — without the
 * charset hint Drive's import path mis-decodes the bytes and the upload
 * fails with `Internal Error` (observed during ACE Phase 6 Stage 1
 * synthetic-data-generate smoke on 2026-05-06).
 *
 * Default behavior is find-or-update: if a same-name file exists under
 * `parentFolderId` (non-trashed), the existing file's content is replaced
 * with `content` and its id is returned — no duplicate is created. This
 * matches `handleCreateFolder`'s find-or-create semantics and closes the
 * duplicate-Drive-file class of bug from transient 5xx retries (the call
 * actually succeeded server-side but the model retried, creating a
 * second copy). Pass `findOrCreate: false` to opt out.
 */
export async function handleCreateFile(
  args: { name: string; content: string; parentFolderId: string; findOrCreate?: boolean },
  driveClient: typeof drive = drive,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ id: string; name: string; webViewLink?: string; reused?: boolean }> {
  const { name, content, parentFolderId, findOrCreate = true } = args;
  const retry = <T>(op: () => Promise<T>) => withTransientRetry(op, opts);
  const guard = await assertParentOnSharedDrive(parentFolderId, driveClient);
  if (!guard.ok) throw new Error(guard.message);

  // Body upload — explicit charset closes the non-ASCII Internal Error
  // class. `text/plain; charset=utf-8` makes Drive's Doc-import path
  // decode the body as UTF-8 instead of falling through to a default
  // that mis-handles multi-byte sequences.
  const bodyMedia = { mimeType: 'text/plain; charset=utf-8', body: content };

  if (findOrCreate) {
    const escaped = name.replace(/'/g, "\\'");
    const list = await retry(() => driveClient.files.list({
      q: `name='${escaped}' and '${parentFolderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`,
      fields: 'files(id, name, webViewLink)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    }));
    const existing = list.data.files?.[0];
    if (existing?.id) {
      // Update content of existing file and return its id — no new file
      // gets created.
      await retry(() => driveClient.files.update({
        fileId: existing.id!,
        media: bodyMedia,
        fields: 'id',
        supportsAllDrives: true,
      }));
      return {
        id: existing.id,
        name: existing.name!,
        webViewLink: existing.webViewLink ?? undefined,
        reused: true,
      };
    }
  }

  const created = await retry(() => driveClient.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.document',
      parents: [parentFolderId],
    },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  }));
  const fileId = created.data.id!;

  await retry(() => driveClient.files.update({
    fileId,
    media: bodyMedia,
    fields: 'id',
    supportsAllDrives: true,
  }));

  return {
    id: fileId,
    name: created.data.name!,
    webViewLink: created.data.webViewLink ?? undefined,
    reused: false,
  };
}

/**
 * Create-shortcut handler, exported for unit testing with a mocked Drive client.
 *
 * Creates a Google Drive shortcut (mimeType `application/vnd.google-apps.shortcut`)
 * pointing at `targetId`, parented under `parentFolderId`. With `findOrReplace=true`,
 * any prior same-name file/shortcut under the parent is deleted first — semantically
 * "replace the old pointer with a new one." Used by the orchestrator (Task 28 of
 * the run-folder-readability plan) to refresh `<opp>/current/` shortcuts after
 * each phase completes.
 */
export async function handleCreateShortcut(
  args: { name: string; parentFolderId: string; targetId: string; findOrReplace?: boolean },
  driveClient: typeof drive = drive,
): Promise<{ id: string; name: string; webViewLink?: string }> {
  const { name, parentFolderId, targetId, findOrReplace = false } = args;
  const guard = await assertParentOnSharedDrive(parentFolderId, driveClient);
  if (!guard.ok) throw new Error(guard.message);
  if (findOrReplace) {
    const escaped = name.replace(/'/g, "\\'");
    const list = await driveClient.files.list({
      q: `name='${escaped}' and '${parentFolderId}' in parents and trashed=false`,
      fields: 'files(id)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const existing of list.data.files ?? []) {
      await driveClient.files.delete({ fileId: existing.id!, supportsAllDrives: true });
    }
  }
  const created = await driveClient.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.shortcut',
      parents: [parentFolderId],
      shortcutDetails: { targetId },
    },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });
  return {
    id: created.data.id!,
    name: created.data.name!,
    webViewLink: created.data.webViewLink ?? undefined,
  };
}

// 12. Create a folder in Google Drive
server.tool(
  'drive_create_folder',
  'Create a new folder in Google Drive, inside the given parent folder. By default, find-or-create: if a same-named folder already exists under the parent, that folder is returned instead of creating a duplicate (closes the duplicate-`verdicts/` class of bug from parallel skill writes). Pass findOrCreate:false to force a new sibling. The parent MUST be a folder on a Shared Drive — when the parent is in My Drive (or unset), the new folder lands in the SA\'s My Drive root and every subsequent file write into it fails with a "user storage quota exceeded" error. ACE uses this to set up the per-opportunity folder structure (ACE/<opp-name>/).',
  {
    name: z.string().describe('Name for the new folder'),
    parentFolderId: z.string().min(1).describe('Required. Parent folder ID — MUST be a folder on a Shared Drive (the MCP verifies this before writing).'),
    findOrCreate: z.boolean().optional().describe('When true (default), reuse an existing same-named folder under the parent if one exists; otherwise always create. Default: true. Set to false only when you specifically want a separate sibling.'),
  },
  async ({ name: folderName, parentFolderId, findOrCreate }) => {
    try {
      const r = await handleCreateFolder({ name: folderName, parentFolderId, findOrCreate }, drive);
      return result(r);
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 12b. Create a Drive shortcut pointing at an existing file/folder
server.tool(
  'drive_create_shortcut',
  'Create a Google Drive shortcut (mimeType application/vnd.google-apps.shortcut) under `parentFolderId` pointing at `targetId`. The orchestrator uses this to refresh `<opp>/current/` shortcuts after each phase completes — e.g. `<opp>/current/connect-opp-summary.md → runs/<latest>/3-connect/connect-opp-setup.md`. With findOrReplace=true, any prior file/shortcut with the same `name` under the parent is deleted before the new shortcut is created (semantics: "swap the pointer atomically"). Default findOrReplace=false because Drive permits multiple same-named entries; only set it to true when you intend the shortcut to be a single canonical pointer. The parent MUST live on a Shared Drive — same Service Account quota constraint as drive_create_file / drive_create_folder.',
  {
    name: z.string().min(1).describe('Display name for the shortcut (include the extension to mirror the target — e.g., "connect-opp-summary.md").'),
    parentFolderId: z.string().min(1).describe('Required. Parent folder ID — MUST be a folder on a Shared Drive (the MCP verifies this before writing).'),
    targetId: z.string().min(1).describe('The file or folder ID the shortcut should point at.'),
    findOrReplace: z.boolean().optional().describe('When true, delete any prior same-name file/shortcut under `parentFolderId` before creating. Default: false. Use true to make `current/` pointers idempotent.'),
  },
  async ({ name: shortcutName, parentFolderId, targetId, findOrReplace }) => {
    try {
      const r = await handleCreateShortcut({ name: shortcutName, parentFolderId, targetId, findOrReplace }, drive);
      return result(r);
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 13. Move a file into a different folder
server.tool(
  'drive_move_file',
  'Move an existing file into a different folder in Google Drive',
  {
    fileId: z.string().describe('The file ID to move'),
    newParentFolderId: z.string().describe('The destination folder ID'),
  },
  async ({ fileId, newParentFolderId }) => {
    try {
      const file = await drive.files.get({ fileId, fields: 'parents', supportsAllDrives: true });
      const previousParents = (file.data.parents || []).join(',');

      const resp = await drive.files.update({
        fileId,
        addParents: newParentFolderId,
        removeParents: previousParents,
        fields: 'id, name, parents, webViewLink',
        supportsAllDrives: true,
      });
      return result({ id: resp.data.id, name: resp.data.name, webViewLink: resp.data.webViewLink });
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 14. Rename a file or folder (just changes the name; parents unchanged)
server.tool(
  'drive_rename_file',
  'Rename an existing file or folder in Google Drive. Only the display name changes — file ID, parents, content, and web link stay the same. Useful for in-place file renames (e.g. state.yaml → run_state.yaml during the 0.11.4 migration).',
  {
    fileId: z.string().describe('The file or folder ID to rename'),
    newName: z.string().min(1).describe('The new file/folder name'),
  },
  async ({ fileId, newName }) => {
    try {
      const resp = await drive.files.update({
        fileId,
        requestBody: { name: newName },
        fields: 'id, name, webViewLink, mimeType',
        supportsAllDrives: true,
      });
      return result({
        id: resp.data.id,
        name: resp.data.name,
        mimeType: resp.data.mimeType,
        webViewLink: resp.data.webViewLink,
      });
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 15. Move a file or folder to the Drive bin (recoverable for 30 days)
server.tool(
  'drive_trash_file',
  'Move a file or folder to the Google Drive bin. Recoverable for 30 days via the Drive UI; after that, Drive permanently deletes it. Use this for cleanup paths where you want the operation reversible — e.g. removing the stub `state.yaml` files left after the 0.11.4 → run_state.yaml migration. Sets `trashed: true` via files.update; does NOT call files.delete (which is irreversible).',
  {
    fileId: z.string().describe('The file or folder ID to trash'),
  },
  async ({ fileId }) => {
    try {
      const resp = await drive.files.update({
        fileId,
        requestBody: { trashed: true },
        fields: 'id, name, trashed',
        supportsAllDrives: true,
      });
      return result({
        id: resp.data.id,
        name: resp.data.name,
        trashed: resp.data.trashed,
      });
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 16. Transfer ownership of a Drive file or folder
server.tool(
  'drive_transfer_ownership',
  'Transfer ownership of a file or folder to another Google account',
  {
    fileId: z.string().describe('The file or folder ID'),
    email: z.string().describe('Email address of the new owner'),
  },
  async ({ fileId, email }) => {
    try {
      const resp = await drive.permissions.create({
        fileId,
        transferOwnership: true,
        supportsAllDrives: true,
        requestBody: {
          type: 'user',
          role: 'owner',
          emailAddress: email,
        },
      });
      return result({ permissionId: resp.data.id, newOwner: email });
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 15. Diagnose Drive API access
server.tool(
  'drive_diagnose',
  'Test Drive API access - checks scopes, lists recent files the SA can see, and tests a specific file ID',
  {
    testFileId: z.string().optional().describe('Optional file ID to test direct access'),
  },
  async ({ testFileId }) => {
    try {
      const results: Record<string, unknown> = {};

      try {
        const about = await drive.about.get({ fields: 'user,storageQuota' });
        results.driveScope = 'ACTIVE';
        results.saEmail = about.data.user?.emailAddress;
      } catch (e: any) {
        results.driveScope = `FAILED: ${e.message}`;
      }

      try {
        const list = await drive.files.list({
          pageSize: 10,
          fields: 'files(id, name, mimeType, owners, shared)',
          orderBy: 'modifiedTime desc',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        results.visibleFiles = list.data.files?.map(f => ({
          name: f.name,
          mimeType: f.mimeType,
          owners: f.owners?.map(o => o.emailAddress),
        }));
      } catch (e: any) {
        results.listFiles = `FAILED: ${e.message}`;
      }

      if (testFileId) {
        try {
          const file = await drive.files.get({ fileId: testFileId, fields: 'id, name, mimeType, owners, permissions', supportsAllDrives: true });
          results.testFile = { name: file.data.name, mimeType: file.data.mimeType };
        } catch (e: any) {
          results.testFile = `FAILED: ${e.message}`;
        }
      }

      return result(results);
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// ============================================================================
// Google Docs tools
// ============================================================================

// 16. Get full document structure
server.tool(
  'docs_get',
  'Read the full structured JSON of a Google Doc — paragraphs, tables, smart chips, inline objects, and all element indices. Use this to inspect document structure before making edits via docs_batch_update.',
  {
    documentId: z.string().describe('The Google Doc ID from the URL'),
    tabId: z.string().optional().describe('Specific tab ID (omit for first tab)'),
  },
  async ({ documentId, tabId }) => {
    try {
      const resp = await docs.documents.get({ documentId });
      if (tabId && resp.data.tabs) {
        const tab = resp.data.tabs.find(
          (t: any) => t.tabProperties?.tabId === tabId,
        );
        if (!tab) {
          return error(`Tab "${tabId}" not found. Available tabs: ${resp.data.tabs.map((t: any) => t.tabProperties?.tabId).join(', ')}`);
        }
        return result({ title: resp.data.title, documentId: resp.data.documentId, tab });
      }
      return result(resp.data);
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 17. Batch update a Google Doc (raw API)
server.tool(
  'docs_batch_update',
  'Execute raw Google Docs API batchUpdate requests. Supports all 40 request types: insertText, replaceAllText, deleteContentRange, insertTable, updateTextStyle, etc. See https://developers.google.com/docs/api/reference/rest/v1/documents/request for the full request schema.',
  {
    documentId: z.string().describe('The Google Doc ID'),
    requests: z.array(z.record(z.unknown())).describe('Array of Docs API request objects, e.g. [{"insertText": {"location": {"index": 1}, "text": "Hello"}}]'),
  },
  async ({ documentId, requests }) => {
    try {
      const resp = await docs.documents.batchUpdate({
        documentId,
        requestBody: { requests },
      });
      return result({
        documentId: resp.data.documentId,
        replies: resp.data.replies,
      });
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 18. Copy a template doc and replace placeholder text
server.tool(
  'docs_copy_template',
  'Copy a Google Doc template and optionally replace placeholder text. Smart chips (person chips, dates, building blocks) survive the copy. Use placeholders like {{NAME}} in the template, then pass replacements to fill them in. Useful for ACE training materials, PDD templates, and onboarding email templates.',
  {
    templateDocId: z.string().describe('The template Google Doc ID to copy'),
    title: z.string().describe('Title for the new document'),
    replacements: z.record(z.string()).optional().describe('Key-value map of placeholder text to replace, e.g. {"{{OPP_NAME}}": "Vaccine Hesitancy Pilot", "{{LLO_NAME}}": "TestLand Health Partners"}'),
    parentFolderId: z.string().optional().describe('Destination folder ID (omit to create in same location as template)'),
  },
  async ({ templateDocId, title, replacements, parentFolderId }) => {
    try {
      const copyMetadata: Record<string, unknown> = { name: title };
      if (parentFolderId) {
        copyMetadata.parents = [parentFolderId];
      }
      const copy = await drive.files.copy({
        fileId: templateDocId,
        requestBody: copyMetadata,
        fields: 'id, name, webViewLink',
        supportsAllDrives: true,
      });
      const newDocId = copy.data.id!;

      if (replacements && Object.keys(replacements).length > 0) {
        const requests = Object.entries(replacements).map(
          ([placeholder, replacement]) => ({
            replaceAllText: {
              containsText: { text: placeholder, matchCase: true },
              replaceText: replacement,
            },
          }),
        );
        await docs.documents.batchUpdate({
          documentId: newDocId,
          requestBody: { requests },
        });
      }

      return result({
        id: newDocId,
        title: copy.data.name,
        webViewLink: copy.data.webViewLink,
      });
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// ============================================================================
// Slides
// ============================================================================
//
// Mirror of the docs_* atoms (slides_get / slides_batch_update / slides_create).
// The Slides API has a strict separation: `presentations.create` makes a NEW
// (empty) deck and returns its presentationId; everything else — title slide,
// content slides, images, speaker notes — happens via batchUpdate. So the
// 3-atom shape is the API's natural shape, not an artificial reduction.
//
// Drive integration: `presentations.create` writes the new deck to the Service
// Account's My-Drive root. Service Accounts have zero My-Drive quota, so the
// next batchUpdate would fail with a misleading quota error. Workaround:
// create-then-move via `drive.files.update` with `addParents=<sharedDriveId>`
// + `removeParents=root`. The `slides_create_presentation` atom does this
// automatically when a `parentFolderId` is provided. Same Shared-Drive guard
// (`assertParentOnSharedDrive`) the docs atoms use.

// 19. Get full slides structure
server.tool(
  'slides_get',
  'Read the full structured JSON of a Google Slides presentation — slides, page elements (text boxes, images, shapes), speakerNotes, masters, layouts, and all element object IDs. Use this to inspect deck structure before making edits via slides_batch_update.',
  {
    presentationId: z.string().describe('The Google Slides presentation ID from the URL'),
  },
  async ({ presentationId }) => {
    try {
      const resp = await slides.presentations.get({ presentationId });
      return result(resp.data);
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 20. Batch update a Google Slides deck (raw API)
server.tool(
  'slides_batch_update',
  'Execute raw Google Slides API batchUpdate requests. Supports all request types: createSlide, insertText, createImage, updatePageElementTransform, updateSpeakerNotesProperties, etc. See https://developers.google.com/slides/api/reference/rest/v1/presentations/request for the full schema. For ACE training decks, the typical sequence is: createSlide (with layout) → createShape/createImage → insertText → optionally updateTextStyle.',
  {
    presentationId: z.string().describe('The Google Slides presentation ID'),
    requests: z.array(z.record(z.unknown())).describe('Array of Slides API request objects, e.g. [{"createSlide": {"objectId": "slide1", "slideLayoutReference": {"predefinedLayout": "TITLE_AND_BODY"}}}]'),
  },
  async ({ presentationId, requests }) => {
    try {
      const resp = await slides.presentations.batchUpdate({
        presentationId,
        requestBody: { requests },
      });
      return result({
        presentationId: resp.data.presentationId,
        replies: resp.data.replies,
      });
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 21. Copy a Slides template into a Shared-Drive folder
server.tool(
  'slides_copy_template',
  'Copy a Google Slides template deck into a Shared-Drive folder. Mirrors `docs_copy_template`. ACE training-deck workflow: the template contains stencil slides with placeholder text like {{TITLE}} / {{BODY}} that subsequent slides_batch_update calls fill in. Returns the new presentationId and webViewLink. Optional `replacements` runs a single deck-wide replaceAllText pass for any quick global substitutions; per-slide-scoped replacements happen via slides_batch_update.',
  {
    templatePresentationId: z.string().describe('The template Google Slides presentation ID to copy'),
    title: z.string().describe('Title for the new presentation'),
    parentFolderId: z.string().describe('Destination Shared-Drive folder ID. REQUIRED — Service Accounts cannot write to My Drive.'),
    replacements: z.record(z.string()).optional().describe('Optional deck-wide replaceAllText map, e.g. {"{{OPP_NAME}}": "Turmeric Survey"}. For per-slide-scoped replacements use slides_batch_update with pageObjectIds.'),
  },
  async ({ templatePresentationId, title, parentFolderId, replacements }) => {
    try {
      await assertParentOnSharedDrive(parentFolderId);
      const copy = await drive.files.copy({
        fileId: templatePresentationId,
        requestBody: { name: title, parents: [parentFolderId] },
        fields: 'id, name, webViewLink',
        supportsAllDrives: true,
      });
      const presentationId = copy.data.id!;

      if (replacements && Object.keys(replacements).length > 0) {
        const requests = Object.entries(replacements).map(
          ([placeholder, replacement]) => ({
            replaceAllText: {
              containsText: { text: placeholder, matchCase: true },
              replaceText: replacement,
            },
          }),
        );
        await slides.presentations.batchUpdate({
          presentationId,
          requestBody: { requests },
        });
      }

      return result({
        presentationId,
        title: copy.data.name,
        webViewLink: copy.data.webViewLink,
      });
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// ============================================================================
// Start
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('ACE google-drive MCP server error:', err);
  process.exit(1);
});
