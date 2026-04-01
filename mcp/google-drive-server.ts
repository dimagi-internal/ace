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
const SA_KEY_PATH = path.join(PROJECT_ROOT, '.gws-sa-key.json');

// ============================================================================
// Auth
// ============================================================================

function getAuth() {
  const keyFile = JSON.parse(fs.readFileSync(SA_KEY_PATH, 'utf-8'));
  return new google.auth.GoogleAuth({
    credentials: keyFile,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
}

const auth = getAuth();
const sheets = google.sheets({ version: 'v4', auth });
const drive = google.drive({ version: 'v3', auth });

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
  name: 'google-drive',
  version: '2.0.0',
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
        fields: 'files(id, name, mimeType, modifiedTime, webViewLink)',
        orderBy: 'name',
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
      const meta = await drive.files.get({ fileId, fields: 'mimeType, name' });
      const mimeType = meta.data.mimeType || '';

      let content: string;
      if (mimeType === 'application/vnd.google-apps.document') {
        const resp = await drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'text' });
        content = resp.data as string;
      } else {
        const resp = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' });
        content = resp.data as string;
      }

      return result({ name: meta.data.name, mimeType, content });
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 10. Diagnose Drive API access
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
          const file = await drive.files.get({ fileId: testFileId, fields: 'id, name, mimeType, owners, permissions' });
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
// Start
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Google Drive MCP server error:', err);
  process.exit(1);
});
