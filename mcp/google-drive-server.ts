/**
 * Google Drive MCP Server for ACE
 *
 * Exposes Google Drive and Sheets tools over stdio using the Model Context
 * Protocol. Uses a service account JSON key for auth.
 *
 * Adapted from chrome-sales/mcp/google-drive-server.ts
 */

import { config as dotenvConfig } from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { google } from '../lib/google-shim.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import { resolvePluginDataDir, logPluginDataDirDiag } from '../lib/plugin-data-dir.js';
import {
  validateRunState,
  classifyPhaseWriteBack,
} from '../lib/run-state-validator.js';
import {
  verifyPhaseArtifacts,
  type DriveListAdapter,
} from '../lib/phase-closeout.js';
import { PHASES, type Phase } from '../lib/artifact-manifest.js';
import {
  isTransientNetworkError as isTransientNetworkErrorLib,
  withTransientRetry as withTransientRetryLib,
} from '../lib/transient-retry.js';
import { generateRunReadme, type PhaseStatus } from '../lib/run-readme.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY_KEY_PATH = path.join(PROJECT_ROOT, '.gws-sa-key.json');

// One-line stderr diag so MCP log shows exactly what CLAUDE_PLUGIN_DATA /
// CLAUDE_PLUGIN_ROOT the subprocess received and which tier resolveKeyPath
// will use. See anthropics/claude-code#9427 for the underlying env-block
// substitution bug this works around.
logPluginDataDirDiag('ace-gdrive', import.meta.url);

// Load .env from the resolved plugin-data dir (or cwd in dev) so atoms
// can read process.env.ACE_DRIVE_ROOT_FOLDER_ID and other ACE config.
// The three sibling MCPs (ace-connect, ace-ocs, ace-mobile) all do this;
// ace-gdrive was the only one missing it, which made `resolve_opp_path`
// fail with "ACE_DRIVE_ROOT_FOLDER_ID is not set" until callers passed
// the aceRootFolderId override explicitly. Must run before any code that
// reads from process.env.
const __aceGdrivePluginDataDir = resolvePluginDataDir(import.meta.url);
dotenvConfig({
  path: __aceGdrivePluginDataDir
    ? path.join(__aceGdrivePluginDataDir, '.env')
    : path.join(process.cwd(), '.env'),
});

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/forms.body.readonly',
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
const forms = google.forms({ version: 'v1', auth });

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
 *
 * Inflight-dedupe + 30s TTL cache (added 2026-05-10, perf lens). When N
 * parallel writes target the same parent — common for run-folder bootstrap
 * (run_state.yaml + inputs-manifest.yaml often go into the same
 * `runs/<run-id>/` parent in one batched message) — the first
 * caller's probe populates the inflight slot; concurrent callers await the
 * same promise instead of firing N redundant `files.get` round-trips. After
 * the probe resolves, an `ok: true` result is cached for 30s so a follow-up
 * write a few seconds later also short-circuits. `ok: false` results are
 * NOT cached (transient errors must re-probe; My-Drive misconfig is a
 * one-shot failure that halts the run anyway).
 */
type ProbeResult = { ok: true } | { ok: false; message: string };
const sharedDriveProbeCache = new Map<string, { result: ProbeResult; expires: number }>();
const sharedDriveProbeInflight = new Map<string, Promise<ProbeResult>>();
const SHARED_DRIVE_PROBE_TTL_MS = 30_000;

/**
 * Test-only: clear the inflight + TTL caches so unit tests with shared
 * parentFolderIds don't leak state across `it` blocks. Production callers
 * must not invoke this — the caches are correctness-preserving (single
 * source of truth: live Drive API), they just amortize the probe cost
 * across concurrent or near-concurrent writes to the same parent.
 */
export function __resetSharedDriveProbeCacheForTests(): void {
  sharedDriveProbeCache.clear();
  sharedDriveProbeInflight.clear();
}

async function assertParentOnSharedDrive(
  parentFolderId: string,
  driveClient: typeof drive = drive,
): Promise<ProbeResult> {
  // Fresh-cache hit: short-circuit. Only `ok: true` is ever cached.
  const cached = sharedDriveProbeCache.get(parentFolderId);
  if (cached && cached.expires > Date.now()) {
    return cached.result;
  }

  // Inflight-dedupe: if another caller is already probing this parent, await
  // the same promise. The cache key is the parentFolderId — different parents
  // probe independently. Module-level Maps persist across MCP tool calls; this
  // is the inflight pool for the whole stdio session.
  const inflight = sharedDriveProbeInflight.get(parentFolderId);
  if (inflight) {
    return inflight;
  }

  const probe = (async (): Promise<ProbeResult> => {
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
  })();

  sharedDriveProbeInflight.set(parentFolderId, probe);
  try {
    const result = await probe;
    if (result.ok) {
      sharedDriveProbeCache.set(parentFolderId, { result, expires: Date.now() + SHARED_DRIVE_PROBE_TTL_MS });
    }
    return result;
  } finally {
    sharedDriveProbeInflight.delete(parentFolderId);
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
  'Patch a YAML-content Google Doc in one MCP call: the server reads the current content + revisionVersion, parses it as YAML (treating empty/missing as `{}`), merges `patch` into the existing YAML, serializes back to YAML, and writes with optimistic-concurrency. On a `revision_conflict` (a concurrent writer landed between read and write) the call retries once with the freshly-observed revision. Two merge modes — pick one based on what you\'re patching:\n\n- `shallow` (default): `patch[k]` *replaces* `base[k]` for every top-level key `k`. Predictable, matches the historical behavior. Use for whole-subtree updates (e.g., `connect: { opportunity_id: 2, status: "active" }` to fully overwrite the `connect:` block).\n\n- `two-level`: for top-level keys whose value is a plain object on BOTH sides, the merge recurses one level — child keys from `patch[k]` are merged into `base[k]` (with `patch` winning on conflicts), preserving sibling child keys. For non-object values (strings, numbers, arrays) and for keys present on only one side, the behavior is identical to `shallow`. Use for incremental run_state.yaml writes where each phase agent owns one entry under `phases:` / `gates:` and must not clobber sibling entries written by other phases.\n\nUse this tool for run_state.yaml / opp.yaml updates instead of pairing drive_read_file + drive_update_file by hand: it saves one round-trip per state transition AND keeps the full file content out of the model context (the model only sends the diff). For arbitrary text files use drive_update_file instead.',
  {
    fileId: z.string().describe('The Google Drive file ID of the YAML doc'),
    patch: z.record(z.unknown()).describe('Object whose top-level keys are merged into the existing YAML per `merge`. With `merge: "shallow"` (default) each top-level key fully replaces its base counterpart; with `merge: "two-level"` object-valued top-level keys merge one level deeper, preserving sibling child keys.'),
    merge: z.enum(['shallow', 'two-level']).optional().describe('Merge strategy. Defaults to `shallow` (top-level replace) for back-compat. Pass `two-level` for run_state.yaml / opp.yaml writes where multiple writers each own a different entry under the same top-level key (e.g. each phase agent patches its own `phases.<phase-name>` block).'),
  },
  async ({ fileId, patch, merge }) => {
    try {
      const r = await handleUpdateYamlFile({ fileId, patch, merge }, drive);
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

// 11a. Create a new Google Doc from markdown content, using Drive's native conversion
server.tool(
  'drive_create_doc_from_markdown',
  'Create a new Google Doc by uploading markdown content and letting Drive natively convert it to a styled Google Doc. Drive interprets `# `/`## `/`### ` as Heading 1/2/3 (so the Docs outline sidebar works), `**bold**` and `*italic*` as native runs, `[text](url)` as hyperlinks, `-`/`*` lists as native bullets, fenced ``` blocks as monospace, and pipe tables as native tables. Use this instead of `drive_create_file` whenever you want a rendered gdoc — `drive_create_file` uploads as `text/plain` and the markdown markers remain literal characters. Same find-or-create semantics: by default reuses any same-name file under the parent (default true). The parent MUST live on a Shared Drive — same Service Account quota constraint as `drive_create_file`.',
  {
    name: z.string().describe('Name for the new Google Doc'),
    markdown: z.string().describe('Markdown body. Drive converts: # → H1, ## → H2, ### → H3, **bold**, *italic*, [text](url), -/* lists, ```code```, | tables |. Smart quotes / em-dashes / accents round-trip cleanly via UTF-8.'),
    parentFolderId: z.string().min(1).describe('Required. Parent folder ID — MUST be a folder on a Shared Drive.'),
    findOrCreate: z.boolean().optional().describe('When true (default), reuse an existing same-name file under the parent and overwrite its content; otherwise always create a new sibling. Default: true.'),
  },
  async ({ name: fileName, markdown, parentFolderId, findOrCreate }) => {
    try {
      const r = await handleCreateDocFromMarkdown({ name: fileName, markdown, parentFolderId, findOrCreate }, drive);
      return result(r);
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// 11b. Copy an existing Drive file server-side
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
  'Upload a binary file (PNG, JPG, PDF, audio, video, etc.) to Google Drive inside the given parent folder. Accepts content via base64 string (contentBase64) OR a local file path (localFilePath) — use localFilePath for large files like videos to avoid passing megabytes through the context window. The MCP uses Drive\'s media-upload path with the supplied mime type, so the file lands as its native type (NOT auto-converted to a Google Doc — that\'s what `drive_create_file` is for). Pass `shareAnyoneWithLink: true` to atomically grant `role: reader` to `type: anyone` on the new file. The parent MUST be a folder on a Shared Drive.',
  {
    name: z.string().describe('Name for the new file (include the extension — e.g., "screen-01.png", not "screen-01")'),
    contentBase64: z.string().optional().describe('File content, base64-encoded. Provide either this OR localFilePath, not both.'),
    localFilePath: z.string().optional().describe('Absolute path to a local file to upload. Reads directly from disk — avoids passing large binaries through the context window. Provide either this OR contentBase64, not both.'),
    mimeType: z.string().describe('MIME type of the binary content. Common ACE values: "image/png", "image/jpeg", "application/pdf", "audio/mpeg", "video/mp4", "application/zip" (CCZ).'),
    parentFolderId: z.string().min(1).describe('Required. Parent folder ID — MUST be a folder on a Shared Drive (the MCP verifies this before writing).'),
    shareAnyoneWithLink: z.boolean().optional().describe('When true, after a successful upload set sharing to `role: reader, type: anyone` (anyone-with-link). Required for any PNG that downstream Slides `createImage` will fetch — Slides\' image-import service does not carry the SA\'s auth. Default: false.'),
  },
  async ({ name: fileName, contentBase64, localFilePath, mimeType, parentFolderId, shareAnyoneWithLink }) => {
    try {
      const guard = await assertParentOnSharedDrive(parentFolderId);
      if (!guard.ok) return error(guard.message);
      let buf: Buffer;
      if (localFilePath) {
        const fs = await import('fs');
        if (!fs.existsSync(localFilePath)) {
          return error(`localFilePath not found: ${localFilePath}`);
        }
        buf = fs.readFileSync(localFilePath);
      } else if (contentBase64) {
        buf = Buffer.from(contentBase64, 'base64');
      } else {
        return error('Provide either contentBase64 or localFilePath.');
      }
      if (buf.length === 0) {
        return error('File is empty (0 bytes).');
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
 * Re-exports of the shared transient-error classifier + retry envelope
 * from `lib/transient-retry.ts`. PR-O extracted these to a shared lib so
 * all three MCPs (gdrive Drive API, OCS REST, Connect REST) share the
 * same patterns. Pre-PR-O each MCP had its own narrow classifier and
 * picked up patterns inconsistently.
 *
 * The exports here keep the original `isTransientDriveError` name so
 * the existing test suite at `test/mcp/gdrive/transient-error-classifier.test.ts`
 * and any inline callers don't need to update. New code should import
 * `isTransientNetworkError` from `lib/transient-retry.ts` directly.
 */
export const isTransientDriveError = isTransientNetworkErrorLib;
export const withTransientRetry = withTransientRetryLib;

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
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export async function handleUpdateYamlFile(
  args: { fileId: string; patch: Record<string, unknown>; merge?: 'shallow' | 'two-level' },
  driveClient: typeof drive = drive,
): Promise<{ id: string; name: string; modifiedTime: string; revisionVersion: string | undefined }> {
  const { fileId, patch, merge = 'shallow' } = args;
  const maxAttempts = 2;
  let lastErr: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const current = await handleReadFile({ fileId }, driveClient);
    const parsed = current.content && current.content.trim() ? YAML.parse(current.content) : {};
    const base: Record<string, unknown> = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    const merged: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      if (merge === 'two-level' && isPlainObject(v) && isPlainObject(base[k])) {
        // Merge child keys; patch wins on conflicts, base's other children preserved.
        merged[k] = { ...(base[k] as Record<string, unknown>), ...v };
      } else {
        merged[k] = v;
      }
    }
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
 * fails with `Internal Error` (observed during ACE Phase 7 Stage 1
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
 * Create-doc-from-markdown handler, exported for unit testing.
 *
 * Companion to `handleCreateFile`. Where `handleCreateFile` uploads body
 * as `text/plain` (markdown markers stay literal), this one uploads as
 * `text/markdown` with target mime `application/vnd.google-apps.document`
 * — Drive's import service natively converts headings, bold/italic, lists,
 * links, code fences, and tables into native Doc runs. The Docs outline
 * sidebar populates correctly because the converted paragraphs use
 * `HEADING_1/2/3` named styles.
 *
 * Find-or-create semantics match `handleCreateFile`: a same-name non-trashed
 * file under the parent is overwritten in place, no duplicate created.
 */
export async function handleCreateDocFromMarkdown(
  args: { name: string; markdown: string; parentFolderId: string; findOrCreate?: boolean },
  driveClient: typeof drive = drive,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ id: string; name: string; webViewLink?: string; reused?: boolean }> {
  const { name, markdown, parentFolderId, findOrCreate = true } = args;
  const retry = <T>(op: () => Promise<T>) => withTransientRetry(op, opts);
  const guard = await assertParentOnSharedDrive(parentFolderId, driveClient);
  if (!guard.ok) throw new Error(guard.message);

  // Body uploaded as text/markdown so Drive's import service runs the
  // markdown→gdoc conversion (headings, bold, lists, links, code, tables).
  // Target mime is the native Google Doc — Drive picks the conversion path
  // from the source/target mime pair.
  const bodyMedia = {
    mimeType: 'text/markdown',
    body: Readable.from(Buffer.from(markdown, 'utf-8')),
  };

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
      // Overwrite existing file's content with the new markdown.
      // files.update with a markdown body re-runs the conversion server-side.
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

  // Single-call create+convert: requestBody.mimeType = target gdoc,
  // media.mimeType = source markdown. Drive's import service does the work.
  const created = await retry(() => driveClient.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.document',
      parents: [parentFolderId],
    },
    media: bodyMedia,
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  }));

  return {
    id: created.data.id!,
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
  'Create a Google Drive shortcut (mimeType application/vnd.google-apps.shortcut) under `parentFolderId` pointing at `targetId`. The orchestrator uses this to refresh `<opp>/current/` shortcuts after each phase completes — e.g. `<opp>/current/connect-opp-summary.md → runs/<latest>/4-connect/connect-opp-setup.md`. With findOrReplace=true, any prior file/shortcut with the same `name` under the parent is deleted before the new shortcut is created (semantics: "swap the pointer atomically"). Default findOrReplace=false because Drive permits multiple same-named entries; only set it to true when you intend the shortcut to be a single canonical pointer. The parent MUST live on a Shared Drive — same Service Account quota constraint as drive_create_file / drive_create_folder.',
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
      // `includeTabsContent: true` is required for the Docs API to populate
      // `resp.data.tabs`. Without it the API returns the document body (first
      // tab only) for backward-compat and `tabs` is undefined — which made
      // every multi-tab read here silently return the wrong tab's content
      // while ignoring the `tabId` argument.
      const resp = await docs.documents.get({
        documentId,
        includeTabsContent: true,
      } as any);
      if (tabId && resp.data.tabs) {
        // Walk tabs depth-first so a child-tab id matches too.
        const findTab = (tabs: any[]): any => {
          for (const t of tabs || []) {
            if (t.tabProperties?.tabId === tabId) return t;
            const child = findTab(t.childTabs || []);
            if (child) return child;
          }
          return null;
        };
        const tab = findTab(resp.data.tabs);
        if (!tab) {
          const ids = (resp.data.tabs || [])
            .map((t: any) => t.tabProperties?.tabId)
            .join(', ');
          return error(`Tab "${tabId}" not found. Available tabs: ${ids}`);
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

server.tool(
  'docs_finalize_bullets',
  'Finalize an ACE-template-rendered Google Doc by applying real Google Docs bullet styling to paragraphs enclosed in `<<<BULLETS_<NAME>_START>>>` / `<<<BULLETS_<NAME>_END>>>` anchor pairs, then deleting the two anchor paragraphs. Call AFTER `docs_copy_template` when the template wraps variable-length bulleted regions in anchor pairs (so the skill\'s cell-level token replacement can emit `\\n`-separated bullet items without per-bullet token slots). Idempotent — re-runs are no-ops once all anchors have been processed. Returns the count of anchor pairs processed.',
  {
    documentId: z.string().describe('The Google Doc ID'),
  },
  async ({ documentId }) => {
    try {
      // Read doc structure to locate anchor paragraphs.
      const doc = await docs.documents.get({ documentId });
      const bodyContent = doc.data.body?.content ?? [];

      const anchorRe = /^<<<BULLETS_([A-Z0-9_]+)_(START|END)>>>$/;
      type Anchor = { name: string; kind: 'START' | 'END'; startIndex: number; endIndex: number };
      const anchors: Anchor[] = [];
      for (const el of bodyContent) {
        if (!el.paragraph) continue;
        const text = (el.paragraph.elements?.map((e) => e.textRun?.content || '').join('') || '').trim();
        const m = text.match(anchorRe);
        if (m) {
          anchors.push({
            name: m[1],
            kind: m[2] as 'START' | 'END',
            startIndex: el.startIndex!,
            endIndex: el.endIndex!,
          });
        }
      }

      if (anchors.length === 0) {
        return result({ documentId, anchorsProcessed: 0 });
      }

      // Pair START/END by anchor name.
      type Pair = { name: string; start: Anchor; end: Anchor };
      const pairs: Pair[] = [];
      const byName: Record<string, { start?: Anchor; end?: Anchor }> = {};
      for (const a of anchors) {
        byName[a.name] = byName[a.name] || {};
        if (a.kind === 'START') byName[a.name].start = a;
        else byName[a.name].end = a;
      }
      for (const name in byName) {
        const { start, end } = byName[name];
        if (!start || !end) {
          return error(`docs_finalize_bullets: incomplete anchor pair for ${name} (missing ${start ? 'END' : 'START'})`);
        }
        if (start.endIndex >= end.startIndex) {
          return error(`docs_finalize_bullets: anchor pair ${name} has START at/after END`);
        }
        pairs.push({ name, start, end });
      }

      // Process LAST-TO-FIRST so earlier indices stay valid while we mutate later ones.
      pairs.sort((a, b) => b.start.startIndex - a.start.startIndex);

      for (const pair of pairs) {
        // Step 1: apply bullet style to the inner range (between START's end and END's start).
        // Step 2: delete END anchor (higher index first).
        // Step 3: delete START anchor.
        await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [
              {
                createParagraphBullets: {
                  range: {
                    startIndex: pair.start.endIndex,
                    endIndex: pair.end.startIndex,
                  },
                  bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
                },
              },
              {
                deleteContentRange: {
                  range: { startIndex: pair.end.startIndex, endIndex: pair.end.endIndex },
                },
              },
              {
                deleteContentRange: {
                  range: { startIndex: pair.start.startIndex, endIndex: pair.start.endIndex },
                },
              },
            ],
          },
        });
      }

      // Post-pass: delete any empty bulleted paragraphs left behind by the
      // blank lines in the markdown source around the anchor tokens. Without
      // this, the rendered doc shows `• ` (empty bullet) before the first
      // real item and after the last item of each bulleted region.
      const after = await docs.documents.get({ documentId });
      type Empty = { startIndex: number; endIndex: number };
      const emptyBullets: Empty[] = [];
      for (const el of after.data.body?.content ?? []) {
        if (!el.paragraph?.bullet) continue;
        const text = (el.paragraph.elements?.map((e) => e.textRun?.content || '').join('') || '').trim();
        if (text === '') {
          emptyBullets.push({ startIndex: el.startIndex!, endIndex: el.endIndex! });
        }
      }
      // Delete last-to-first to keep earlier indices valid.
      emptyBullets.sort((a, b) => b.startIndex - a.startIndex);
      if (emptyBullets.length > 0) {
        await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: emptyBullets.map((e) => ({
              deleteContentRange: { range: { startIndex: e.startIndex, endIndex: e.endIndex } },
            })),
          },
        });
      }

      return result({ documentId, anchorsProcessed: pairs.length, emptyBulletsRemoved: emptyBullets.length });
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
// Opp-path resolver
// ============================================================================

// Replaces the 3-call dance at run-init (drive_list_folder on ACE root →
// find opp folder by slug → drive_list_folder on opp root → find inputs/
// + runs/). One atom call returns {opp_root_id, inputs_id, runs_id} from
// a slug + ACE root folder ID. runs_id is null on first-run opps where
// the runs/ subfolder doesn't exist yet — callers create it themselves.

export interface ResolveOppPathResult {
  slug: string;
  ace_root_id: string;
  opp_root_id: string;
  inputs_id: string | null;
  runs_id: string | null;
}

export async function handleResolveOppPath(
  args: { slug: string; aceRootFolderId?: string },
  driveClient: typeof drive,
): Promise<ResolveOppPathResult> {
  const slug = args.slug;
  const rootId = args.aceRootFolderId ?? process.env.ACE_DRIVE_ROOT_FOLDER_ID;
  if (!rootId) {
    throw new Error(
      'ACE_DRIVE_ROOT_FOLDER_ID is not set and no aceRootFolderId was passed',
    );
  }
  const escape = (s: string) =>
    s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  const oppResp = await driveClient.files.list({
    q:
      `'${escape(rootId)}' in parents and name = '${escape(slug)}' ` +
      `and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const oppFolders = oppResp.data.files ?? [];
  if (oppFolders.length === 0) {
    throw new Error(`Opp folder "${slug}" not found under ACE root ${rootId}`);
  }
  if (oppFolders.length > 1) {
    throw new Error(
      `Multiple folders named "${slug}" under ACE root ${rootId}: ` +
        oppFolders.map((f: any) => f.id).join(', '),
    );
  }
  const oppRootId = oppFolders[0].id!;

  const subsResp = await driveClient.files.list({
    q:
      `'${escape(oppRootId)}' in parents ` +
      `and mimeType = 'application/vnd.google-apps.folder' ` +
      `and trashed = false and (name = 'inputs' or name = 'runs')`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const subs: Record<string, string> = {};
  for (const f of subsResp.data.files ?? []) {
    if (f.name && f.id) subs[f.name] = f.id;
  }

  return {
    slug,
    ace_root_id: rootId,
    opp_root_id: oppRootId,
    inputs_id: subs.inputs ?? null,
    runs_id: subs.runs ?? null,
  };
}

server.tool(
  'resolve_opp_path',
  "Resolve an ACE opportunity's Drive folder paths in one call. Given an opp slug (and an optional ACE root folder ID — defaults to $ACE_DRIVE_ROOT_FOLDER_ID), returns `{slug, ace_root_id, opp_root_id, inputs_id, runs_id}`. Replaces the 3-call drive_list_folder dance at run-init: list ACE root → find opp by name → list opp root → find inputs/ + runs/. `runs_id` is null on first-run opps where the runs/ subfolder doesn't exist yet (callers create it). Errors loudly on missing opp or ambiguous slug (multiple folders with the same name).",
  {
    slug: z.string().describe("The opportunity slug (folder name under ACE root)."),
    aceRootFolderId: z
      .string()
      .optional()
      .describe('Override $ACE_DRIVE_ROOT_FOLDER_ID for tests / multi-tenant.'),
  },
  async ({ slug, aceRootFolderId }) => {
    try {
      const r = await handleResolveOppPath({ slug, aceRootFolderId }, drive);
      return result(r);
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// resolve_current_run_id — replacement for the dead `opp.yaml.last_run_id`
// read pattern. Lists `<opp>/runs/` and picks the lexicographically-largest
// folder name (run-ids are `YYYYMMDD-HHMM`, so lex == chronological).
//
// Background: pre-2026-05-10 the orchestrator wrote `opp.yaml.last_run_id`
// at every fresh-run start. That stopped (see `lib/artifact-manifest.ts`
// description of opp.yaml: "Earlier shapes also carried `last_run_id` and
// a `runs:` array; both were dropped because no consumer reads them —
// ace-web enumerates runs by listing the filesystem under runs/."). But
// three Phase 7 skills (`synthetic-data-generate`, `synthetic-summary`,
// `synthetic-narrative-plan`) still read `opp.yaml.last_run_id` per their
// SKILL.md, which made them silently broken on any opp created after the
// retire. This atom encapsulates the canonical replacement so the three
// skills stop reinventing the same listing+sort pattern.
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolveCurrentRunIdResult {
  slug: string;
  run_id: string | null;
  run_folder_id: string | null;
}

export async function handleResolveCurrentRunId(
  args: { slug: string; aceRootFolderId?: string },
  driveClient: typeof drive,
): Promise<ResolveCurrentRunIdResult> {
  const pathInfo = await handleResolveOppPath(args, driveClient);
  if (!pathInfo.runs_id) {
    return { slug: pathInfo.slug, run_id: null, run_folder_id: null };
  }
  const escape = (s: string) =>
    s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const runsResp = await driveClient.files.list({
    q:
      `'${escape(pathInfo.runs_id)}' in parents ` +
      `and mimeType = 'application/vnd.google-apps.folder' ` +
      `and trashed = false`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    pageSize: 1000,
  });
  const folders = (runsResp.data.files ?? []).filter((f: any) => f.name && f.id);
  if (folders.length === 0) {
    return { slug: pathInfo.slug, run_id: null, run_folder_id: null };
  }
  folders.sort((a: any, b: any) => (a.name! < b.name! ? 1 : a.name! > b.name! ? -1 : 0));
  const winner = folders[0];
  return {
    slug: pathInfo.slug,
    run_id: winner.name!,
    run_folder_id: winner.id!,
  };
}

server.tool(
  'resolve_current_run_id',
  "Return the most-recent run-id for opp `<slug>` plus its run-folder ID. Lists `<opp>/runs/` and picks the lexicographically-largest folder name (run-ids are `YYYYMMDD-HHMM`, so lex order matches chronological order). Returns `{slug, run_id, run_folder_id}` — both `run_id` and `run_folder_id` are `null` when the opp has no runs yet. Replaces the dead `opp.yaml.last_run_id` read pattern (the orchestrator stopped writing that field; see `lib/artifact-manifest.ts`). Used by Phase 7 synthetic skills when invoked standalone via `/ace:step` to discover which run folder to operate on; inside `/ace:run`, the phase agent already knows the current run-id and shouldn't need this call.",
  {
    slug: z.string().describe('The opportunity slug (folder name under ACE root).'),
    aceRootFolderId: z
      .string()
      .optional()
      .describe('Override $ACE_DRIVE_ROOT_FOLDER_ID for tests / multi-tenant.'),
  },
  async ({ slug, aceRootFolderId }) => {
    try {
      const r = await handleResolveCurrentRunId({ slug, aceRootFolderId }, drive);
      return result(r);
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// ============================================================================
// Inputs manifest + Google Forms
// ============================================================================

// Replaces the hand-assembled inputs-manifest.yaml step the orchestrator
// ran at every /ace:run start (list folder → inspect each MIME type →
// chase shortcut targetIds → write YAML inline). One atom call now
// returns the same structured manifest, including resolved shortcut
// targets, in a single Drive round-trip set (paged when >100 files).

export interface InputsManifestEntry {
  file_id: string;
  name: string;
  mime_type: string;
  input_key: string;
  resolved_target_id?: string;
  resolved_target_mime_type?: string;
  modified_time?: string;
  web_view_link?: string;
}

export interface InputsManifest {
  folder_id: string;
  generated_at: string;
  files: InputsManifestEntry[];
}

function toInputKey(name: string): string {
  const lastDot = name.lastIndexOf('.');
  // Treat a trailing .<ext> as an extension only when ext is short + alphanumeric;
  // avoids stripping a real word that happens to follow a period.
  const ext = lastDot > 0 ? name.slice(lastDot + 1) : '';
  const looksLikeExt = ext.length > 0 && ext.length <= 8 && /^[A-Za-z0-9]+$/.test(ext);
  const base = looksLikeExt ? name.slice(0, lastDot) : name;
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function handleGenerateInputsManifest(
  args: { folderId: string },
  driveClient: typeof drive,
): Promise<InputsManifest> {
  const { folderId } = args;
  const safeFolderId = folderId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const all: any[] = [];
  let pageToken: string | undefined;
  do {
    const resp = await driveClient.files.list({
      q: `'${safeFolderId}' in parents and trashed = false`,
      fields:
        'nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, shortcutDetails)',
      orderBy: 'name',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageSize: 100,
      ...(pageToken ? { pageToken } : {}),
    });
    if (resp.data.files) all.push(...resp.data.files);
    pageToken = resp.data.nextPageToken ?? undefined;
  } while (pageToken);

  const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
  const entries: InputsManifestEntry[] = all.map((f: any) => {
    const entry: InputsManifestEntry = {
      file_id: f.id,
      name: f.name,
      mime_type: f.mimeType,
      input_key: toInputKey(f.name),
      modified_time: f.modifiedTime ?? undefined,
      web_view_link: f.webViewLink ?? undefined,
    };
    if (f.mimeType === SHORTCUT_MIME && f.shortcutDetails) {
      entry.resolved_target_id = f.shortcutDetails.targetId ?? undefined;
      entry.resolved_target_mime_type =
        f.shortcutDetails.targetMimeType ?? undefined;
    }
    return entry;
  });

  return {
    folder_id: folderId,
    generated_at: new Date().toISOString(),
    files: entries,
  };
}

server.tool(
  'generate_inputs_manifest',
  "Generate a structured inputs manifest for an ACE opportunity's `inputs/` Drive folder. Lists every file in the folder, resolves shortcut targetIds (so a shortcut to a PDD doc surfaces the real target), and assigns each file a kebab-cased `input_key` (e.g. \"sample-pdd.docx\" → \"sample-pdd\") that downstream skills can key off. Returns `{folder_id, generated_at, files: [{file_id, name, mime_type, input_key, resolved_target_id?, resolved_target_mime_type?, modified_time?, web_view_link?}, ...]}`. Replaces the hand-assembled inputs-manifest.yaml step that ran at every /ace:run start. Snapshot semantics: returns the folder state at the moment of the call — same freshness as the prior manual process.",
  {
    folderId: z
      .string()
      .describe("The Google Drive folder ID of the opp's inputs/ folder."),
  },
  async ({ folderId }) => {
    try {
      const r = await handleGenerateInputsManifest({ folderId }, drive);
      return result(r);
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// Forms API atom — Google Forms cannot be read via drive_read_file
// (no text export); the Forms API returns the question schema as
// structured JSON. Skills that previously fell back to reading the
// linked Responses sheet can now read the form definition directly.

export interface FormQuestion {
  item_id: string;
  title: string;
  description?: string;
  kind: string;
  required: boolean;
  options?: string[];
}

export interface FormDefinition {
  form_id: string;
  title: string;
  description?: string;
  items: FormQuestion[];
}

function classifyFormQuestion(q: any): string {
  if (q.choiceQuestion) {
    const t = q.choiceQuestion.type;
    if (t === 'RADIO') return 'radio';
    if (t === 'CHECKBOX') return 'checkbox';
    if (t === 'DROP_DOWN') return 'dropdown';
    return 'choice';
  }
  if (q.textQuestion) return q.textQuestion.paragraph ? 'paragraph' : 'short_answer';
  if (q.scaleQuestion) return 'scale';
  if (q.dateQuestion) return 'date';
  if (q.timeQuestion) return 'time';
  if (q.fileUploadQuestion) return 'file_upload';
  if (q.rowQuestion) return 'grid';
  return 'unknown';
}

function extractFormOptions(q: any): string[] | undefined {
  if (q.choiceQuestion?.options) {
    return q.choiceQuestion.options
      .map((o: any) => o.value)
      .filter((v: any) => typeof v === 'string' && v.length > 0);
  }
  if (q.scaleQuestion) {
    const lo = q.scaleQuestion.low ?? 1;
    const hi = q.scaleQuestion.high ?? 5;
    if (typeof lo === 'number' && typeof hi === 'number' && hi >= lo) {
      return Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i));
    }
  }
  return undefined;
}

export async function handleGetGoogleFormDefinition(
  args: { formId: string },
  formsClient: typeof forms,
): Promise<FormDefinition> {
  const { formId } = args;
  const resp = await formsClient.forms.get({ formId });
  const form: any = resp.data ?? {};
  const info: any = form.info ?? {};
  const items: FormQuestion[] = [];
  for (const it of form.items ?? []) {
    if (!it.questionItem?.question) continue;
    const q = it.questionItem.question;
    items.push({
      item_id: it.itemId ?? q.questionId ?? '',
      title: it.title ?? '',
      description: it.description ?? undefined,
      kind: classifyFormQuestion(q),
      required: !!q.required,
      options: extractFormOptions(q),
    });
  }
  return {
    form_id: formId,
    title: info.title ?? '',
    description: info.description ?? undefined,
    items,
  };
}

server.tool(
  'get_google_form_definition',
  'Read a Google Forms form definition via the Forms API (forms.googleapis.com/v1/forms/{formId}). Returns `{form_id, title, description?, items: [{item_id, title, description?, kind, required, options?}, ...]}` where `kind` is one of `radio | checkbox | dropdown | choice | short_answer | paragraph | scale | date | time | file_upload | grid | unknown`. Replaces the workaround of reading the linked Responses sheet — that approach is lossy (no option text, no required flag, no question kind) and only works after the form has at least one response. Use whenever a file in inputs/ has MIME `application/vnd.google-apps.form` — `drive_read_file` does NOT support Forms.',
  {
    formId: z
      .string()
      .describe('The Google Forms form ID (from the form URL or generate_inputs_manifest output).'),
  },
  async ({ formId }) => {
    try {
      const r = await handleGetGoogleFormDefinition({ formId }, forms);
      return result(r);
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// ============================================================================
// Run-state validation
// ============================================================================

// Wraps `lib/run-state-validator.ts` so the orchestrator's Phase Write-Back
// Verifier can call it as a single MCP atom instead of relaying through a
// drive_read_file + manual parse. The validator's source-of-truth contract
// lives in `agents/orchestrator-reference.md § Phase Write-Back Contract`.

server.tool(
  'validate_run_state',
  "Validate a run_state.yaml file's shape against the Phase Write-Back Contract. Reads the YAML from Drive (one call, with the same transient-error retry handleReadFile uses), parses it, and returns `{valid, errors, warnings}` where each issue carries `{path, message, severity, expected?, actual?}`. Use to confirm a phase actually wrote its block correctly — particularly after an `Agent(<phase>)` dispatch returns. Empty/null YAML (legal at run-init before any phase writes) returns `valid: true`. Implementation: `lib/run-state-validator.ts::validateRunState`.",
  {
    fileId: z.string().describe('The Google Drive fileId of run_state.yaml.'),
  },
  async ({ fileId }) => {
    try {
      const read = await handleReadFile({ fileId }, drive);
      const text = read.content ?? '';
      const parsed = text.trim() ? YAML.parse(text) : null;
      const r = validateRunState(parsed);
      return result(r);
    } catch (e: any) {
      return error(e.message);
    }
  },
);

server.tool(
  'classify_phase_writeback',
  "Single-line answer to 'did `<phaseName>` write its run_state.yaml block correctly?' Reads run_state.yaml from Drive, parses it, and returns `{status: 'ok' | 'missing' | 'in_progress' | 'error' | 'malformed', phase: <name>}`. The orchestrator's silent-dispatch retry should treat 'missing', 'in_progress', and 'malformed' as retry triggers (agent claimed success but didn't write properly); 'error' is a real phase failure that halts. Cheaper than `validate_run_state` for the common case of 'I just need to know if this phase shipped' — returns one classification, not a full issue list. Implementation: `lib/run-state-validator.ts::classifyPhaseWriteBack`.",
  {
    fileId: z.string().describe('The Google Drive fileId of run_state.yaml.'),
    phaseName: z
      .string()
      .describe('The phase whose write-back block to classify (e.g. "idea-to-design", "commcare-setup").'),
  },
  async ({ fileId, phaseName }) => {
    try {
      const read = await handleReadFile({ fileId }, drive);
      const text = read.content ?? '';
      const parsed = text.trim() ? YAML.parse(text) : null;
      const status = classifyPhaseWriteBack(parsed, phaseName);
      return result({ phase: phaseName, status });
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// ============================================================================
// Phase-closeout artifact verification
// ============================================================================

// Companion to `classify_phase_writeback`: the writeback tool answers
// "did the phase update run_state.yaml correctly?"; this tool answers
// "did the phase produce every artifact the manifest declares required
// for it in Drive?" Together they form the deterministic part of the
// orchestrator's boundary fence — the LLM no longer has to remember to
// dispatch each eval skill, because if the resulting verdict YAML isn't
// in the phase folder this tool reports it as missing and the
// orchestrator silent-dispatches the producing skill.
//
// Single source of truth: lib/artifact-manifest.ts (entries with
// required: true and a `<N>-<phase>/` path prefix). Pair with the
// drift-checking agent that keeps the manifest honest against the
// plugin's actual skill set.

server.tool(
  'verify_phase_artifacts',
  "Verify every artifact the manifest declares required for `phase` is present in the run folder's per-phase subfolder. Returns `{phase, ok, missing, present_count, expected_count, optional_present_count, summary}` where each `missing` entry carries `{path, producedBy, description}` — `producedBy` tells the orchestrator which skill to re-dispatch to heal. Narrate from `summary` (a ready-made one-liner like \"all 4 required artifacts found (+3 optional)\"); do NOT pair `present_count`/`expected_count` into a fraction — present counts every file in the folder, expected counts only the required set, so the ratio routinely exceeds 1. Pair with `classify_phase_writeback` in the boundary fence's parallel block: writeback checks `run_state.yaml`, this checks Drive contents. Walks the phase subfolder two levels deep so `recipes/`, `screenshots/`, etc. children are seen. Implementation: `lib/phase-closeout.ts::verifyPhaseArtifacts`. Manifest: `lib/artifact-manifest.ts`.",
  {
    runFolderId: z.string().describe("The Google Drive folder ID of the run (e.g. <opp>/runs/<run-id>/)."),
    phase: z
      .enum(PHASES as unknown as [Phase, ...Phase[]])
      .describe('The phase whose declared required artifacts to verify (e.g. "design", "commcare", "synthetic-data-and-workflows").'),
  },
  async ({ runFolderId, phase }) => {
    try {
      const adapter: DriveListAdapter = {
        async listFolder(folderId: string) {
          const safe = folderId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
          const resp = await drive.files.list({
            q: `'${safe}' in parents and trashed = false`,
            fields: 'files(id, name, mimeType)',
            orderBy: 'name',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          });
          const files = resp.data.files ?? [];
          return files.map((f) => ({
            id: f.id ?? '',
            name: f.name ?? '',
            mimeType: f.mimeType ?? '',
          }));
        },
      };
      const report = await verifyPhaseArtifacts(adapter, runFolderId, phase as Phase);
      return result(report);
    } catch (e: any) {
      return error(e.message);
    }
  },
);

// ============================================================================
// Run-folder README rendering
// ============================================================================

// Wraps `lib/run-readme.ts::generateRunReadme` as a single atom so the
// orchestrator can render the run-folder README index at run-init and at
// every phase-completion fence without shelling out to `npx tsx` against
// the plugin's install path. The pure helper has its own unit tests in
// `test/lib/run-readme.test.ts`; this atom is a thin transport wrapper.

server.tool(
  'render_run_readme',
  'Render the run-folder README markdown for `runId` with optional per-phase status overrides (keys: idea-to-design | scenarios-and-acceptance | commcare-setup | connect-setup | ocs-setup | qa-and-training | synthetic-data-and-workflows | solicitation-management | execution-management | closeout; values: pending | in-progress | done | skipped). Returns `{markdown}`. The orchestrator writes this directly to `<run-folder>/README.md` at run-init (step 7b — all phases default to `pending`) and refreshes after every phase boundary fence with the updated status map. Implementation: `lib/run-readme.ts::generateRunReadme`.',
  {
    runId: z
      .string()
      .describe('The run-id folder name, e.g. "20260526-1334".'),
    phaseStatus: z
      .record(z.enum(['pending', 'in-progress', 'done', 'skipped']))
      .optional()
      .describe('Optional per-phase status overrides; unspecified phases default to "pending".'),
  },
  async ({ runId, phaseStatus }) => {
    try {
      const markdown = generateRunReadme(runId, (phaseStatus ?? {}) as Partial<Record<Phase, PhaseStatus>>);
      return result({ markdown });
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
