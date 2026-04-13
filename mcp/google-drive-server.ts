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
import { fileURLToPath } from 'url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY_KEY_PATH = path.join(PROJECT_ROOT, '.gws-sa-key.json');

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
];

// ============================================================================
// Auth
// ============================================================================

/**
 * Resolve the Google service-account key path.
 *
 * Priority:
 *   1. $GOOGLE_APPLICATION_CREDENTIALS — Google's standard env var. In .mcp.json
 *      we set this to ${CLAUDE_PLUGIN_DATA}/gws-sa-key.json so Claude Code expands
 *      it to the per-plugin persistent data dir at launch (survives plugin updates
 *      and is shared across worktrees / installed copies).
 *   2. <plugin-root>/.gws-sa-key.json — legacy fallback so existing local dev
 *      checkouts and pre-migration installs keep working.
 */
function resolveKeyPath(): string {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }
  if (fs.existsSync(LEGACY_KEY_PATH)) {
    return LEGACY_KEY_PATH;
  }
  throw new Error(
    `No Google service-account key found. Set GOOGLE_APPLICATION_CREDENTIALS ` +
      `or place the key at ${LEGACY_KEY_PATH}. Run /ace:setup for help.`,
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
      const resp = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
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
  'Read the text content of a file in Google Drive. Works with Google Docs (exported as plain text) and plain text files.',
  {
    fileId: z.string().describe('The Google Drive file ID'),
  },
  async ({ fileId }) => {
    try {
      const meta = await drive.files.get({ fileId, fields: 'mimeType, name, shortcutDetails', supportsAllDrives: true });
      let resolvedId = fileId;
      let mimeType = meta.data.mimeType || '';

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
      }

      let content: string;
      if (mimeType === 'application/vnd.google-apps.document') {
        const resp = await drive.files.export({ fileId: resolvedId, mimeType: 'text/plain' }, { responseType: 'text' });
        content = resp.data as string;
      } else {
        const resp = await drive.files.get({ fileId: resolvedId, alt: 'media', supportsAllDrives: true }, { responseType: 'text' });
        content = resp.data as string;
      }

      return result({ name: meta.data.name, mimeType, content });
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 10. Update a Drive file's content
server.tool(
  'drive_update_file',
  'Update the text content of an existing Google Doc in Drive. Use for updating IDDs, summaries, and other docs as ACE skills produce new content.',
  {
    fileId: z.string().describe('The Google Drive file ID'),
    content: z.string().describe('The new text content to write'),
  },
  async ({ fileId, content: newContent }) => {
    try {
      const resp = await drive.files.update({
        fileId,
        media: { mimeType: 'text/plain', body: newContent },
        fields: 'id, name, modifiedTime',
        supportsAllDrives: true,
      });
      return result({ id: resp.data.id, name: resp.data.name, modifiedTime: resp.data.modifiedTime });
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 11. Create a file in Google Drive
server.tool(
  'drive_create_file',
  'Create a new Google Doc in Drive with the given name and content, optionally inside a parent folder. Used by ACE skills (idea-to-idd, idd-to-learn-app, etc.) to write artifacts to opportunity folders.',
  {
    name: z.string().describe('Name for the new file'),
    content: z.string().describe('Text content for the file'),
    parentFolderId: z.string().optional().describe('Parent folder ID (omit to create in root)'),
  },
  async ({ name: fileName, content: fileContent, parentFolderId }) => {
    try {
      const fileMetadata: Record<string, unknown> = {
        name: fileName,
        mimeType: 'application/vnd.google-apps.document',
      };
      if (parentFolderId) {
        fileMetadata.parents = [parentFolderId];
      }
      const created = await drive.files.create({
        requestBody: fileMetadata,
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

// 12. Create a folder in Google Drive
server.tool(
  'drive_create_folder',
  'Create a new folder in Google Drive, optionally inside a parent folder. ACE uses this to set up the per-opportunity folder structure (ACE/<opp-name>/).',
  {
    name: z.string().describe('Name for the new folder'),
    parentFolderId: z.string().optional().describe('Parent folder ID (omit to create in root)'),
  },
  async ({ name: folderName, parentFolderId }) => {
    try {
      const fileMetadata: Record<string, unknown> = {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
      };
      if (parentFolderId) {
        fileMetadata.parents = [parentFolderId];
      }
      const resp = await drive.files.create({
        requestBody: fileMetadata,
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
  'Copy a Google Doc template and optionally replace placeholder text. Smart chips (person chips, dates, building blocks) survive the copy. Use placeholders like {{NAME}} in the template, then pass replacements to fill them in. Useful for ACE training materials, IDD templates, and onboarding email templates.',
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
