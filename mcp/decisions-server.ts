#!/usr/bin/env tsx
/**
 * ACE Decisions MCP Server
 *
 * Owns the per-run `decisions.yaml` contract. Skills that emit load-bearing
 * defaults (idea-to-pdd, pdd-to-work-order, connect-opp-setup, …) append
 * rows via the typed `decisions_append_rows` tool — the MCP transport
 * enforces `lib/decisions-schema.ts` at the call boundary, so malformed
 * writes are rejected BEFORE they touch Drive. Schema bumps land in one
 * file (`lib/decisions-schema.ts`); every skill inherits via this tool.
 *
 * Storage is Google Drive; this server reuses the same service-account
 * credentials as ace-gdrive. We deliberately do not `import` from
 * `mcp/google-drive-server.ts` because that module starts its own stdio
 * loop at import time — pulling its exports would inadvertently spawn a
 * duplicate gdrive MCP. The small amount of auth/drive boilerplate
 * duplicated below is the right trade.
 */

import { config as dotenvConfig } from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { google } from '../lib/google-shim.js';
import { resolvePluginDataDir, logPluginDataDirDiag } from '../lib/plugin-data-dir.js';
import { DecisionRowStrictSchema } from '../lib/decisions-schema.js';
import {
  DECISIONS_FILENAME,
  DecisionsWriteError,
  composeAppendedLog,
} from '../lib/decisions-write.js';
import {
  DECISION_OVERRIDES_FILENAME,
  DecisionOverridesError,
  parseDecisionOverridesYaml,
  type DecisionOverrideRow,
} from '../lib/decision-overrides.js';

logPluginDataDirDiag('ace-decisions', import.meta.url);

// Load .env so GOOGLE_APPLICATION_CREDENTIALS (if set there) and any
// future ACE env vars are visible. Matches the boot pattern of every
// other ace-* MCP. Must run before any code that reads process.env.
const __aceDecisionsPluginDataDir = resolvePluginDataDir(import.meta.url);
dotenvConfig({
  path: __aceDecisionsPluginDataDir
    ? path.join(__aceDecisionsPluginDataDir, '.env')
    : path.join(process.cwd(), '.env'),
});

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY_KEY_PATH = path.join(PROJECT_ROOT, '.gws-sa-key.json');

function resolveKeyPath(): string {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const dataDir = resolvePluginDataDir(import.meta.url);
  if (dataDir) {
    const dataKey = path.join(dataDir, 'gws-sa-key.json');
    if (fs.existsSync(dataKey)) return dataKey;
  }
  if (fs.existsSync(LEGACY_KEY_PATH)) return LEGACY_KEY_PATH;
  throw new Error(
    `No Google service-account key found. Set GOOGLE_APPLICATION_CREDENTIALS, ` +
    `place the key at $CLAUDE_PLUGIN_DATA/gws-sa-key.json, ` +
    `or place it at ${LEGACY_KEY_PATH}. Run /ace:setup for help.`,
  );
}

let auth: ReturnType<typeof getAuth> | undefined;
try {
  auth = getAuth();
} catch {
  // Tests mock the drive client directly via the exported handler.
}
function getAuth() {
  return new google.auth.GoogleAuth({ keyFile: resolveKeyPath(), scopes: SCOPES });
}
const drive = google.drive({ version: 'v3', auth });

// ─ Drive primitives (small, decisions-specific) ───────────────────────────

interface DecisionsFileFound {
  fileId: string;
  mimeType: string;
  content: string;
}

/**
 * Locate `decisions.yaml` under a run folder.
 *
 * Returns `null` when the file doesn't exist yet — that's a normal state
 * for the first append of a run. We accept either of:
 *   - `application/vnd.google-apps.document` (the historical writer creates
 *     these via `drive_create_file`, which uploads text as a Google Doc)
 *   - any text/* mimetype (in case a future writer uploads raw YAML)
 *
 * Anything else (folder, PDF, …) under the canonical name is a real
 * structural problem — surfaced as a typed error.
 */
export async function findDecisionsFile(
  driveClient: typeof drive,
  runFolderId: string,
): Promise<DecisionsFileFound | null> {
  const escapedName = DECISIONS_FILENAME.replace(/'/g, "\\'");
  const list = await driveClient.files.list({
    q: `'${runFolderId}' in parents and name='${escapedName}' and trashed=false`,
    fields: 'files(id, mimeType, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const file = list.data.files?.[0];
  if (!file?.id) return null;

  const mimeType = file.mimeType ?? '';
  const fileId = file.id;

  let content: string;
  if (mimeType === 'application/vnd.google-apps.document') {
    const resp = await driveClient.files.export(
      { fileId, mimeType: 'text/plain' },
      { responseType: 'text' },
    );
    content = resp.data as string;
  } else if (
    mimeType === 'application/x-yaml' ||
    mimeType === 'text/yaml' ||
    mimeType.startsWith('text/')
  ) {
    const resp = await driveClient.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'text' },
    );
    content = resp.data as string;
  } else {
    throw new Error(
      `decisions.yaml under ${runFolderId} has unexpected mimeType ${mimeType}; ` +
      `expected a Google Doc or text/yaml file.`,
    );
  }
  return { fileId, mimeType, content };
}

interface OverridesFileFound {
  fileId: string;
  content: string;
}

/**
 * Locate `inputs/decision-overrides.yaml` for the opp that owns a run
 * folder — the consume half of ace-web's "Save to Drive" flow (ace#933).
 *
 * Walks up from the run folder (run → runs/ → opp), then looks for an
 * `inputs` folder and the canonical overrides filename inside it. Every
 * missing link returns `null` — no overrides saved is the normal state.
 * ace-web writes the file as `application/x-yaml`; we also accept a
 * Google Doc or any text/* in case a human recreates it by hand.
 */
export async function findDecisionOverridesFile(
  driveClient: typeof drive,
  runFolderId: string,
): Promise<OverridesFileFound | null> {
  const parentOf = async (fileId: string): Promise<string | null> => {
    const resp = await driveClient.files.get({
      fileId,
      fields: 'id, parents',
      supportsAllDrives: true,
    });
    return (resp.data as any).parents?.[0] ?? null;
  };

  const runsFolderId = await parentOf(runFolderId);
  if (!runsFolderId) return null;
  const oppFolderId = await parentOf(runsFolderId);
  if (!oppFolderId) return null;

  const inputsList = await driveClient.files.list({
    q: `'${oppFolderId}' in parents and name='inputs' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const inputsFolderId = inputsList.data.files?.[0]?.id;
  if (!inputsFolderId) return null;

  const escapedName = DECISION_OVERRIDES_FILENAME.replace(/'/g, "\\'");
  const fileList = await driveClient.files.list({
    q: `'${inputsFolderId}' in parents and name='${escapedName}' and trashed=false`,
    fields: 'files(id, mimeType)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const file = fileList.data.files?.[0];
  if (!file?.id) return null;

  const mimeType = file.mimeType ?? '';
  let content: string;
  if (mimeType === 'application/vnd.google-apps.document') {
    const resp = await driveClient.files.export(
      { fileId: file.id, mimeType: 'text/plain' },
      { responseType: 'text' },
    );
    content = resp.data as string;
  } else if (
    mimeType === 'application/x-yaml' ||
    mimeType === 'text/yaml' ||
    mimeType.startsWith('text/')
  ) {
    const resp = await driveClient.files.get(
      { fileId: file.id, alt: 'media', supportsAllDrives: true },
      { responseType: 'text' },
    );
    content = resp.data as string;
  } else {
    throw new Error(
      `${DECISION_OVERRIDES_FILENAME} under ${inputsFolderId} has unexpected mimeType ${mimeType}; ` +
      `expected application/x-yaml, a Google Doc, or text/*.`,
    );
  }
  return { fileId: file.id, content };
}

interface WriteResult {
  fileId: string;
  modifiedTime: string | undefined;
  revisionVersion: string | undefined;
}

/**
 * Create-or-replace `decisions.yaml` under a run folder.
 *
 * - When `existingFileId` is null: create a new Google Doc (matches the
 *   shape ace-gdrive's drive_create_file produces, so existing readers
 *   that export-as-text keep working).
 * - When `existingFileId` is set: replace the body via `files.update` with
 *   `text/plain` media. Read-modify-write is racy under truly concurrent
 *   writers; in practice decisions writers are serialized per-phase and
 *   the schema's `duplicate decision id` check catches the only realistic
 *   conflict (two skills emitting the same id) at compose time.
 */
export async function writeDecisionsFile(
  driveClient: typeof drive,
  args: { runFolderId: string; existingFileId: string | null; content: string },
): Promise<WriteResult> {
  const { runFolderId, existingFileId, content } = args;

  if (existingFileId) {
    const resp = await driveClient.files.update({
      fileId: existingFileId,
      media: { mimeType: 'text/plain', body: content },
      fields: 'id, modifiedTime, version',
      supportsAllDrives: true,
    } as any);
    return {
      fileId: (resp.data as any).id ?? existingFileId,
      modifiedTime: (resp.data as any).modifiedTime,
      revisionVersion: (resp.data as any).version,
    };
  }

  // Create as Google Doc to match ace-gdrive's drive_create_file shape.
  const resp = await driveClient.files.create({
    requestBody: {
      name: DECISIONS_FILENAME,
      parents: [runFolderId],
      mimeType: 'application/vnd.google-apps.document',
    },
    media: { mimeType: 'text/plain', body: content },
    fields: 'id, modifiedTime, version',
    supportsAllDrives: true,
  } as any);
  return {
    fileId: (resp.data as any).id,
    modifiedTime: (resp.data as any).modifiedTime,
    revisionVersion: (resp.data as any).version,
  };
}

// ─ Tool handler (exported for unit testing with a mocked drive client) ────

export interface AppendRowsArgs {
  runFolderId: string;
  opportunity: string;
  run_id: string;
  rows: unknown[];
}

export interface AppendRowsResult {
  fileId: string;
  added: number;
  skipped: string[];
  total: number;
  modifiedTime?: string;
  revisionVersion?: string;
  created: boolean;
  /**
   * ids of appended rows a reviewer override from the opp's
   * `inputs/decision-overrides.yaml` bound to (ace#933). Empty when no
   * overrides file exists or nothing matched.
   */
  overridesApplied: string[];
}

export async function handleAppendRows(
  args: AppendRowsArgs,
  driveClient: typeof drive = drive,
  opts: { now?: () => string } = {},
): Promise<AppendRowsResult> {
  const existing = await findDecisionsFile(driveClient, args.runFolderId);

  // Reviewer overrides saved by ace-web bind at this write boundary so an
  // expert's review applies to whatever runs next with zero per-skill
  // changes. A malformed file fails LOUD — silently dropping a reviewer's
  // saved intent is the failure mode this feature exists to close.
  const overridesFile = await findDecisionOverridesFile(driveClient, args.runFolderId);
  let overrides: DecisionOverrideRow[] = [];
  if (overridesFile) {
    const parsed = parseDecisionOverridesYaml(overridesFile.content);
    if (parsed.opp !== args.opportunity) {
      throw new DecisionsWriteError(
        'IDENTITY_MISMATCH',
        `inputs/${DECISION_OVERRIDES_FILENAME} declares opp ${JSON.stringify(parsed.opp)} ` +
        `but this append is for ${JSON.stringify(args.opportunity)} — the file is in the wrong opp's inputs/.`,
      );
    }
    overrides = parsed.overrides;
  }

  const composed = composeAppendedLog({
    existingYamlText: existing?.content ?? null,
    opportunity: args.opportunity,
    run_id: args.run_id,
    rows: args.rows,
    overrides,
    now: opts.now,
  });

  // Idempotent no-op: nothing new to write, return early.
  if (composed.added === 0 && existing) {
    return {
      fileId: existing.fileId,
      added: 0,
      skipped: composed.skipped,
      total: composed.total,
      created: false,
      overridesApplied: [],
    };
  }

  const written = await writeDecisionsFile(driveClient, {
    runFolderId: args.runFolderId,
    existingFileId: existing?.fileId ?? null,
    content: composed.content,
  });

  return {
    fileId: written.fileId,
    added: composed.added,
    skipped: composed.skipped,
    total: composed.total,
    modifiedTime: written.modifiedTime,
    revisionVersion: written.revisionVersion,
    created: !existing,
    overridesApplied: composed.overridesApplied,
  };
}

// ─ MCP server registration ────────────────────────────────────────────────

const server = new McpServer({
  name: 'ace-decisions',
  version: '0.1.0',
});

function result(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function error(msg: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] };
}

server.tool(
  'decisions_append_rows',
  'Append validated load-bearing default rows to a run\'s decisions.yaml. The MCP transport enforces `lib/decisions-schema.ts` v4 on every row, so malformed writes (wrong field names, missing required fields, non-ordinal phase tags) are rejected at the call boundary — they never reach Drive. The tool seeds a fresh v4-compliant log header when decisions.yaml doesn\'t exist yet (and keeps appending to pre-existing v3 logs), and is idempotent: rows whose `id` is already present in the log are silently skipped (returned in `skipped`), so a re-run of the same skill is safe.\n\nReviewer decision-overrides bind automatically (ace#933): if the opp has `inputs/decision-overrides.yaml` (saved by ace-web\'s Phases tab → Decisions panel), any appended row whose `id` matches a saved override is written with `override` + `status: overridden` + `override_reasoning` from that file, with the override value appended to the row\'s `options` if missing. Emitting skills need no changes and should keep sending rows as `status: ai-default` — the binding happens here. Matched ids are reported in `overridesApplied`; override ids the run never raises are ignored.\n\nField shape mirrors `DecisionRowSchema` from `lib/decisions-schema.ts`:\n- `id`: kebab-case (e.g. `archetype-selection`, `wo-period-of-performance`)\n- `phase`: `<N>-<kebab-name>` (e.g. `1-design`, `4-connect`) — ordinal-prefixed, matches the artifact-manifest folder convention\n- `skill`: emitter slug (e.g. `idea-to-pdd`, `pdd-to-work-order`)\n- `question`: the load-bearing question this row records\n- `ai-default`: the AI\'s picked value as a string (exact-match member of `options`)\n- `options`: array of short scannable labels for what was considered\n- `source`: citation only (where the info came from)\n- `evidence_basis` (REQUIRED, v4): how grounded the default is — `stated` (directly in a source), `inferred` (extrapolated beyond any source), or `conflicting` (resolves disagreeing sources). This forces Phase-1 to declare, per decision, whether it sourced, extrapolated, or resolved a contested fork — instead of silently presenting an inferred default as fact.\n- `conflict_signals` (REQUIRED iff `evidence_basis: conflicting`; >= 2 entries): the competing source readings you resolved, one per entry, each ideally citing where it came from. Omit for `stated`/`inferred`.\n- `status`: `ai-default` (always for new rows; the renderer + sync skills flip to `overridden` after human edits)\n- `reasoning` (optional): AI\'s rationale (for `conflicting`, state WHY this resolution won)\n- `override` (optional; only with `status: overridden`)\n- `override_reasoning` (optional; only with `status: overridden`)\n\nReturns `{fileId, added, skipped[], total, created, modifiedTime, revisionVersion}`.',
  {
    runFolderId: z
      .string()
      .min(1)
      .describe(
        'Drive file ID of the run folder (e.g. resolved via resolve_opp_path → runs/<run-id>). decisions.yaml lives at the root of this folder.',
      ),
    opportunity: z
      .string()
      .min(1)
      .describe('Opportunity slug (e.g. `bednet-spot-check`). Must match an existing log\'s `opportunity` if one is already in place.'),
    run_id: z
      .string()
      .min(1)
      .describe('Run id (e.g. `20260525-2013`). Must match an existing log\'s `run_id` if one is already in place.'),
    rows: z
      .array(DecisionRowStrictSchema)
      .min(1)
      .describe('Array of validated decision rows to append. Each row\'s `ai-default` (and `override` if set) MUST be one of the strings in its `options` array, exact-match — put rationale in `reasoning`, never in `ai-default`. Duplicate ids within the batch are rejected; ids already present in the existing log are silently skipped (idempotent re-run).'),
  },
  async (args) => {
    try {
      const r = await handleAppendRows(args);
      return result(r);
    } catch (e: any) {
      if (e instanceof DecisionsWriteError || e instanceof DecisionOverridesError) {
        return error(`${e.code}: ${e.message}`);
      }
      return error(e?.message ?? String(e));
    }
  },
);

// ─ Boot ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Matches the pattern in mcp/google-drive-server.ts: main() runs at module
// load. StdioServerTransport.start() attaches listeners to process.stdin
// without blocking, so importing this module from a vitest test (which
// only needs the exported handlers below) is safe — the server happily
// "runs" in the background without ever receiving a message.
main().catch((err) => {
  console.error('ACE decisions MCP server error:', err);
  process.exit(1);
});
