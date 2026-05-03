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

const auth = getAuth();
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
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const meta = await drive.files.get({
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
  'Read the text content of a file in Google Drive. Works with Google Docs (exported as plain text) and plain text files. Returns revisionVersion so callers can pair the read with an optimistic-concurrency `ifMatchRevisionId` on `drive_update_file` (read-modify-write without lost updates).',
  {
    fileId: z.string().describe('The Google Drive file ID'),
  },
  async ({ fileId }) => {
    try {
      // Drive API exposes the monotonic revision counter as `version` (a string in
      // the wire format). It IS populated for Docs Editors files (which is most of
      // ACE's writes) — unlike `headRevisionId`, which is binary-files-only. We
      // surface it as `revisionVersion` to make its role obvious to callers.
      const meta = await drive.files.get({ fileId, fields: 'mimeType, name, shortcutDetails, version', supportsAllDrives: true });
      let resolvedId = fileId;
      let mimeType = meta.data.mimeType || '';
      let revisionVersion = (meta.data as any).version as string | undefined;

      // If the file is a Drive shortcut, resolve to the target file.
      // Shortcuts have their own mimeType (application/vnd.google-apps.shortcut)
      // and store the target's ID and mimeType in shortcutDetails.
      if (mimeType === 'application/vnd.google-apps.shortcut') {
        const targetId = (meta.data as any).shortcutDetails?.targetId;
        const targetMimeType = (meta.data as any).shortcutDetails?.targetMimeType;
        if (!targetId) {
          return error('Shortcut has no target file ID');
        }
        resolvedId = targetId;
        mimeType = targetMimeType || '';
        // Re-fetch the resolved file's metadata to get its current version
        // (the shortcut's version is not the target's version).
        const targetMeta = await drive.files.get({ fileId: resolvedId, fields: 'version', supportsAllDrives: true });
        revisionVersion = (targetMeta.data as any).version as string | undefined;
      }

      let content: string;
      if (mimeType === 'application/vnd.google-apps.document') {
        const resp = await drive.files.export({ fileId: resolvedId, mimeType: 'text/plain' }, { responseType: 'text' });
        content = resp.data as string;
      } else {
        const resp = await drive.files.get({ fileId: resolvedId, alt: 'media', supportsAllDrives: true }, { responseType: 'text' });
        content = resp.data as string;
      }

      return result({ name: meta.data.name, mimeType, content, revisionVersion });
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
        const meta = await drive.files.get({ fileId, fields: 'version', supportsAllDrives: true });
        const current = (meta.data as any).version as string | undefined;
        if (current && current !== ifMatchRevisionId) {
          return error(
            `revision_conflict: file ${fileId} revisionVersion is ${current}, expected ${ifMatchRevisionId}. ` +
              `Re-read and retry.`,
          );
        }
      }
      const resp = await drive.files.update({
        fileId,
        media: { mimeType: 'text/plain', body: newContent },
        fields: 'id, name, modifiedTime, version',
        supportsAllDrives: true,
      });
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

// 11. Create a file in Google Drive
server.tool(
  'drive_create_file',
  'Create a new Google Doc in Drive with the given name and content, inside the given parent folder. The parent MUST be a folder on a Shared Drive — Service Accounts have zero My-Drive quota, so files created in My Drive fail with a misleading "user storage quota exceeded" error. Used by ACE skills (idea-to-pdd, pdd-to-learn-app, etc.) to write artifacts to opportunity folders.',
  {
    name: z.string().describe('Name for the new file'),
    content: z.string().describe('Text content for the file'),
    parentFolderId: z.string().min(1).describe('Required. Parent folder ID — MUST be a folder on a Shared Drive (the MCP verifies this before writing).'),
  },
  async ({ name: fileName, content: fileContent, parentFolderId }) => {
    try {
      const guard = await assertParentOnSharedDrive(parentFolderId);
      if (!guard.ok) return error(guard.message);
      const created = await drive.files.create({
        requestBody: {
          name: fileName,
          mimeType: 'application/vnd.google-apps.document',
          parents: [parentFolderId],
        },
        fields: 'id, name, webViewLink',
        supportsAllDrives: true,
      });
      const fileId = created.data.id!;

      await drive.files.update({
        fileId,
        media: { mimeType: 'text/plain', body: fileContent },
        fields: 'id',
        supportsAllDrives: true,
      });

      return result({ id: fileId, name: created.data.name, webViewLink: created.data.webViewLink });
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
  'Upload a binary file (PNG, JPG, PDF, audio, video, etc.) to Google Drive inside the given parent folder. Content is base64-encoded; the MCP decodes it and uses Drive\'s media-upload path with the supplied mime type, so the file lands as its native type (NOT auto-converted to a Google Doc — that\'s what `drive_create_file` is for). Used by ACE skills that need to upload screenshots (Phase 5 `app-screenshot-capture`), CCZs, training-material attachments, audio session recordings, etc. The parent MUST be a folder on a Shared Drive — same Service Account quota constraint as `drive_create_file` / `drive_create_folder`.',
  {
    name: z.string().describe('Name for the new file (include the extension — e.g., "screen-01.png", not "screen-01")'),
    contentBase64: z.string().describe('File content, base64-encoded. For PNGs from `cat foo.png | base64`, just paste the result. The MCP decodes before upload.'),
    mimeType: z.string().describe('MIME type of the binary content. Common ACE values: "image/png", "image/jpeg", "application/pdf", "audio/mpeg", "application/zip" (CCZ).'),
    parentFolderId: z.string().min(1).describe('Required. Parent folder ID — MUST be a folder on a Shared Drive (the MCP verifies this before writing).'),
  },
  async ({ name: fileName, contentBase64, mimeType, parentFolderId }) => {
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
      return result({
        id: created.data.id,
        name: created.data.name,
        mimeType: created.data.mimeType,
        size: created.data.size,
        webViewLink: created.data.webViewLink,
      });
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 12. Create a folder in Google Drive
server.tool(
  'drive_create_folder',
  'Create a new folder in Google Drive, inside the given parent folder. The parent MUST be a folder on a Shared Drive — when the parent is in My Drive (or unset), the new folder lands in the SA\'s My Drive root and every subsequent file write into it fails with a "user storage quota exceeded" error. ACE uses this to set up the per-opportunity folder structure (ACE/<opp-name>/).',
  {
    name: z.string().describe('Name for the new folder'),
    parentFolderId: z.string().min(1).describe('Required. Parent folder ID — MUST be a folder on a Shared Drive (the MCP verifies this before writing).'),
  },
  async ({ name: folderName, parentFolderId }) => {
    try {
      const guard = await assertParentOnSharedDrive(parentFolderId);
      if (!guard.ok) return error(guard.message);
      const resp = await drive.files.create({
        requestBody: {
          name: folderName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentFolderId],
        },
        fields: 'id, name, webViewLink',
        supportsAllDrives: true,
      });
      return result({ id: resp.data.id, name: resp.data.name, webViewLink: resp.data.webViewLink });
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

// 14. Transfer ownership of a Drive file or folder
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
