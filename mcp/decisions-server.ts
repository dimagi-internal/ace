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
import { parse as yamlParse } from 'yaml';
import {
  DecisionRowStrictSchema,
  parseDecisionsYaml,
  serializeDecisionsLog,
} from '../lib/decisions-schema.js';
import { enrichDecisionsLog, reviewAskRows, type EnrichReport } from '../lib/decisions-enrich.js';
import { googleDriveLookup, installDriveTenancyGuard } from '../lib/drive-tenancy-guard.js';
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
import {
  OPEN_ASKS_FILENAME,
  buildOpenAsksFile,
  checkOpenAsksCarried,
  missingAskResiduals,
  parseOpenAsksYaml,
  requiredBeforeBlockers,
  serializeOpenAsks,
  type CarriedCheck,
  type MissingAskResidual,
  type RequiredBeforeAsk,
} from '../lib/open-asks.js';
import { NEEDED_BY, type NeededBy } from '../lib/decisions-schema.js';
import {
  OPERATOR_RULINGS_FILENAME,
  OperatorRulingsError,
  parseOperatorRulingsYaml,
  type OperatorRuling,
} from '../lib/operator-rulings.js';

logPluginDataDirDiag('ace-decisions', import.meta.url);

// Load .env so GOOGLE_APPLICATION_CREDENTIALS (if set there) and any
// future ACE env vars are visible. Matches the boot pattern of every
// other ace-* MCP. Must run before any code that reads process.env.
const __aceDecisionsPluginDataDir = resolvePluginDataDir(import.meta.url);
dotenvConfig({
  path: __aceDecisionsPluginDataDir
    ? path.join(__aceDecisionsPluginDataDir, '.env')
    : path.join(process.cwd(), '.env'),
  // ace#2114 — stdout IS this process's JSON-RPC transport, so nothing
  // diagnostic may go there. dotenv v17 prints `◇ injected env (N) …` via
  // console.log unless silenced, and it offers no stderr option. Every
  // diagnostic this server emits (see `[ace-plugin-data-dir]` above) is on
  // stderr; this makes dotenv obey the same rule.
  quiet: true,
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
  const inputsFolderId = await findOppInputsFolder(driveClient, runFolderId);
  return inputsFolderId ? readInputsFile(driveClient, inputsFolderId, DECISION_OVERRIDES_FILENAME) : null;
}

/** The `inputs/` folder of the opp that owns a run folder (run → runs/ → opp → inputs), or null. */
export async function findOppInputsFolder(driveClient: typeof drive, runFolderId: string): Promise<string | null> {
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
  return inputsList.data.files?.[0]?.id ?? null;
}

/**
 * A named file directly under an opp's `inputs/` folder, or null. Accepts
 * application/x-yaml, a Google Doc or any text/* (a human may recreate it by
 * hand).
 */
export async function readInputsFile(
  driveClient: typeof drive,
  inputsFolderId: string,
  filename: string,
): Promise<OverridesFileFound | null> {
  const escapedName = filename.replace(/'/g, "\\'");
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
      `${filename} under ${inputsFolderId} has unexpected mimeType ${mimeType}; ` +
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
  rulingsApplied: string[];
  rulingsSkippedUnattributed: string[];
  /** Appended rows stamped `human-decided` from the opp's `inputs/operator-rulings.yaml`. */
  operatorRulingsApplied: string[];
  /** `operator-rulings/<id>` refs naming no ruling in that file — left `ai-default`. */
  operatorRulingsUnmatched: string[];
  /**
   * Non-fatal repairs made to an inherited decisions.yaml header (ace#1029) —
   * a non-ISO `generated_at` normalized, or a seeded run's stale `run_id`
   * adopted. Empty on a healthy log. Surfaced so the repair is visible rather
   * than silent; it needs no caller action.
   */
  headerRepairs?: string[];
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
  const inputsFolderId = await findOppInputsFolder(driveClient, args.runFolderId);
  const overridesFile = inputsFolderId
    ? await readInputsFile(driveClient, inputsFolderId, DECISION_OVERRIDES_FILENAME)
    : null;
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

  // Operator rulings (inputs/operator-rulings.yaml) bind the same way: a row
  // whose feedback_ref is `operator-rulings/<id>` is stamped human-decided
  // with the file's attribution. A malformed file fails loud.
  const rulingsFile = inputsFolderId
    ? await readInputsFile(driveClient, inputsFolderId, OPERATOR_RULINGS_FILENAME)
    : null;
  let operatorRulings: OperatorRuling[] = [];
  if (rulingsFile) {
    const parsed = parseOperatorRulingsYaml(rulingsFile.content);
    if (parsed.opp !== args.opportunity) {
      throw new DecisionsWriteError(
        'IDENTITY_MISMATCH',
        `inputs/${OPERATOR_RULINGS_FILENAME} declares opp ${JSON.stringify(parsed.opp)} ` +
        `but this append is for ${JSON.stringify(args.opportunity)} — the file is in the wrong opp's inputs/.`,
      );
    }
    operatorRulings = parsed.rulings;
  }

  const composed = composeAppendedLog({
    existingYamlText: existing?.content ?? null,
    opportunity: args.opportunity,
    run_id: args.run_id,
    rows: args.rows,
    overrides,
    operatorRulings,
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
      rulingsApplied: [],
      rulingsSkippedUnattributed: [],
      operatorRulingsApplied: [],
      operatorRulingsUnmatched: composed.operatorRulingsUnmatched,
      ...(composed.warnings.length ? { headerRepairs: composed.warnings } : {}),
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
    rulingsApplied: composed.rulingsApplied,
    rulingsSkippedUnattributed: composed.rulingsSkippedUnattributed,
    operatorRulingsApplied: composed.operatorRulingsApplied,
    operatorRulingsUnmatched: composed.operatorRulingsUnmatched,
    ...(composed.warnings.length ? { headerRepairs: composed.warnings } : {}),
  };
}

// ─ decisions_enrich (schema v6 review contract) ───────────────────────────

/** Read a run folder's `run_state.yaml` (any text-ish mimetype). */
export async function readRunState(driveClient: typeof drive, runFolderId: string): Promise<unknown> {
  const list = await driveClient.files.list({
    q: `'${runFolderId}' in parents and name='run_state.yaml' and trashed=false`,
    fields: 'files(id, mimeType)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const file = list.data.files?.[0];
  if (!file?.id) throw new Error(`run_state.yaml not found under run folder ${runFolderId}`);
  const resp =
    file.mimeType === 'application/vnd.google-apps.document'
      ? await driveClient.files.export({ fileId: file.id, mimeType: 'text/plain' }, { responseType: 'text' })
      : await driveClient.files.get({ fileId: file.id, alt: 'media', supportsAllDrives: true }, { responseType: 'text' });
  return yamlParse(String(resp.data).replace(/^﻿/, ''));
}

export interface EnrichArgs {
  runFolderId: string;
  dryRun?: boolean;
}

export interface EnrichResult extends EnrichReport {
  fileId: string;
  written: boolean;
  reviewAsks: Array<{ id: string; plain?: string; confirm_reason?: string }>;
}

/**
 * Apply the deterministic half of the v6 review contract
 * (`lib/decisions-enrich.ts`) to a run's decisions.yaml, reading run_state.yaml
 * from the same folder. Writes only when something changed.
 */
export async function handleEnrich(args: EnrichArgs, driveClient: typeof drive = drive): Promise<EnrichResult> {
  const existing = await findDecisionsFile(driveClient, args.runFolderId);
  if (!existing) throw new Error(`decisions.yaml not found under run folder ${args.runFolderId}`);
  const runState = await readRunState(driveClient, args.runFolderId);
  const before = parseDecisionsYaml(existing.content.replace(/^﻿/, ''));
  const { log, report } = enrichDecisionsLog(before, { runState });
  const changed = JSON.stringify(log) !== JSON.stringify(before);
  if (changed && !args.dryRun) {
    await writeDecisionsFile(driveClient, {
      runFolderId: args.runFolderId,
      existingFileId: existing.fileId,
      content: serializeDecisionsLog(log),
    });
  }
  return {
    fileId: existing.fileId,
    written: changed && !args.dryRun,
    ...report,
    reviewAsks: reviewAskRows(log).map((r) => ({ id: r.id, plain: r.plain, confirm_reason: r.confirm_reason })),
  };
}

// ─ decisions_open_asks (the folded open-questions ledger) ──────────────────

/** The opp folder that owns a run folder (run → runs/ → opp), or null. */
export async function findOppFolder(driveClient: typeof drive, runFolderId: string): Promise<string | null> {
  const parentOf = async (fileId: string): Promise<string | null> => {
    const resp = await driveClient.files.get({ fileId, fields: 'id, parents', supportsAllDrives: true });
    return (resp.data as any).parents?.[0] ?? null;
  };
  const runsFolderId = await parentOf(runFolderId);
  if (!runsFolderId) return null;
  return parentOf(runsFolderId);
}

/** A named text file directly under a folder (Google Doc exported as text, else raw bytes). */
async function readNamedText(
  driveClient: typeof drive,
  folderId: string,
  name: string,
): Promise<{ fileId: string; content: string } | null> {
  const list = await driveClient.files.list({
    q: `'${folderId}' in parents and name='${name.replace(/'/g, "\\'")}' and trashed=false`,
    fields: 'files(id, mimeType)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const file = list.data.files?.[0];
  if (!file?.id) return null;
  const resp =
    file.mimeType === 'application/vnd.google-apps.document'
      ? await driveClient.files.export({ fileId: file.id, mimeType: 'text/plain' }, { responseType: 'text' })
      : await driveClient.files.get({ fileId: file.id, alt: 'media', supportsAllDrives: true }, { responseType: 'text' });
  return { fileId: file.id, content: String(resp.data).replace(/^﻿/, '') };
}

export interface OpenAsksArgs {
  runFolderId: string;
  opportunity: string;
  run_id: string;
  /** `check` reads only; `emit` also writes `ACE/<opp>/open-asks.yaml` (run end). */
  mode: 'check' | 'emit';
  /** Only report required-before asks needed before this gate. */
  neededBy?: NeededBy;
  /** Compare against the previous run's asks raised by phases up to this ordinal (Phase 1 passes 1). */
  throughPhase?: number;
  /** Solicitation question ids the chosen response answered (solicitation-review). */
  solicitationAnswered?: string[];
  /** Override the timestamp (tests). */
  now?: string;
}

export interface OpenAsksResult {
  asks: Array<Pick<RequiredBeforeAsk, 'id' | 'skill' | 'question' | 'owner' | 'answer_channel'> & {
    phase: string;
    status: string;
    review_ask?: string;
    needed_by?: string;
    revisit_when?: string;
  }>;
  requiredBefore: RequiredBeforeAsk[];
  closedBySolicitation: RequiredBeforeAsk[];
  /** null when there was no previous open-asks.yaml to compare against. */
  carried: (Omit<CarriedCheck, 'missing'> & { missing: string[]; residuals: MissingAskResidual[] }) | null;
  written: { fileId: string; created: boolean } | null;
}

/**
 * Read a run's decisions log (+ the opp's saved rulings and the previous
 * run's `open-asks.yaml`) and report what is still asked. `emit` writes the
 * new `open-asks.yaml` at the opp root, AFTER the carried check has read the
 * previous one.
 */
export async function handleOpenAsks(args: OpenAsksArgs, driveClient: typeof drive = drive): Promise<OpenAsksResult> {
  const existing = await findDecisionsFile(driveClient, args.runFolderId);
  const log = existing ? parseDecisionsYaml(existing.content.replace(/^﻿/, '')) : { decisions: [] };
  if (existing && 'opportunity' in log && log.opportunity !== args.opportunity) {
    throw new DecisionsWriteError(
      'IDENTITY_MISMATCH',
      `decisions.yaml under ${args.runFolderId} is for ${JSON.stringify(log.opportunity)}, not ${JSON.stringify(args.opportunity)}`,
    );
  }

  const overridesFile = await findDecisionOverridesFile(driveClient, args.runFolderId);
  const overrides = overridesFile ? parseDecisionOverridesYaml(overridesFile.content).overrides : null;

  const oppFolderId = await findOppFolder(driveClient, args.runFolderId);
  const priorFile = oppFolderId ? await readNamedText(driveClient, oppFolderId, OPEN_ASKS_FILENAME) : null;
  let carried: OpenAsksResult['carried'] = null;
  if (priorFile) {
    const prior = parseOpenAsksYaml(priorFile.content);
    if (prior.run_id !== args.run_id) {
      const check = checkOpenAsksCarried({ prior, log, throughOrdinal: args.throughPhase, overrides });
      carried = {
        priorRunId: check.priorRunId,
        carried: check.carried,
        notYetDue: check.notYetDue,
        missing: check.missing.map((r) => r.id),
        residuals: missingAskResiduals(check),
      };
    }
  }

  const file = buildOpenAsksFile({
    opp: args.opportunity,
    runId: args.run_id,
    log,
    generatedAt: args.now ?? new Date().toISOString(),
    overrides,
  });
  const gate = requiredBeforeBlockers(log, {
    overrides,
    neededBy: args.neededBy,
    answeredSolicitationQuestions: args.solicitationAnswered,
  });

  let written: OpenAsksResult['written'] = null;
  if (args.mode === 'emit') {
    if (!oppFolderId) throw new Error(`could not resolve the opp folder above run folder ${args.runFolderId}`);
    const body = serializeOpenAsks(file);
    if (priorFile) {
      await driveClient.files.update({
        fileId: priorFile.fileId,
        media: { mimeType: 'application/x-yaml', body },
        supportsAllDrives: true,
      } as any);
      written = { fileId: priorFile.fileId, created: false };
    } else {
      const resp = await driveClient.files.create({
        requestBody: { name: OPEN_ASKS_FILENAME, parents: [oppFolderId], mimeType: 'application/x-yaml' },
        media: { mimeType: 'application/x-yaml', body },
        fields: 'id',
        supportsAllDrives: true,
      } as any);
      written = { fileId: (resp.data as any).id, created: true };
    }
  }

  return {
    asks: file.asks.map((r) => ({
      id: r.id,
      skill: r.skill,
      phase: r.phase,
      status: r.status,
      question: r.plain_question ?? r.plain ?? r.question,
      ...(r.review_ask ? { review_ask: r.review_ask } : {}),
      ...(r.needed_by ? { needed_by: r.needed_by } : {}),
      ...(r.owner ? { owner: r.owner } : {}),
      ...(r.answer_channel ? { answer_channel: r.answer_channel } : {}),
      ...(r.revisit_when ? { revisit_when: r.revisit_when } : {}),
    })),
    requiredBefore: gate.blocking,
    closedBySolicitation: gate.closedBySolicitation,
    carried,
    written,
  };
}

// ─ MCP server registration ────────────────────────────────────────────────

const server = new McpServer({
  name: 'ace-decisions',
  version: '0.1.0',
});
// Tenancy guard (Drive half): a session bound to an opp writes only inside its
// folder. Must run before the first registration.
installDriveTenancyGuard(server as never, googleDriveLookup(drive as never));

function result(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function error(msg: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] };
}

server.tool(
  'decisions_append_rows',
  'Append validated load-bearing default rows to a run\'s decisions.yaml. The MCP transport enforces `lib/decisions-schema.ts` v6 on every row, so malformed writes (wrong field names, missing required fields, non-ordinal phase tags) are rejected at the call boundary — they never reach Drive. The tool seeds a fresh v4-compliant log header when decisions.yaml doesn\'t exist yet (and keeps appending to pre-existing v3 logs), and is idempotent: rows whose `id` is already present in the log are silently skipped (returned in `skipped`), so a re-run of the same skill is safe.\n\nReviewer decision-overrides bind automatically (ace#933): if the opp has `inputs/decision-overrides.yaml` (saved by ace-web\'s Phases tab → Decisions panel), any appended row whose `id` matches a saved override is written with `override` + `status: overridden` + `override_reasoning` from that file, with the override value appended to the row\'s `options` if missing. Emitting skills need no changes and should keep sending rows as `status: ai-default` — the binding happens here. Matched ids are reported in `overridesApplied`; override ids the run never raises are ignored.\n\nA saved ruling ALSO binds by `feedback_ref` when the id does not match (v5). Run-minted ids are not stable — measured across 22 runs of two opps, one reviewer\'s 9 comments were raised under 22 different ids — so id-only binding silently dropped every reviewer decision. A feedback_ref match stamps `status: human-decided` with `decided_by`/`decided_at` and carries the rationale, but deliberately does NOT overwrite `ai-default`: the saved string belongs to the old row\'s wording, and the new row phrases the same answer its own way. Reported in `rulingsApplied`. A match with no attribution is refused and reported in `rulingsSkippedUnattributed` rather than stamped anonymously.\n\nOperator rulings bind the same way (lib/operator-rulings.ts): when the opp has `inputs/operator-rulings.yaml`, a row whose `feedback_ref` is `operator-rulings/<ruling id>` is stamped `status: human-decided` with that ruling\'s `decided_by`/`decided_at` (send it as `ai-default`; build it with `rulingDecisionRow`). Reported in `operatorRulingsApplied`; a ref naming no ruling is reported in `operatorRulingsUnmatched` and left `ai-default`.\n\nField shape mirrors `DecisionRowSchema` from `lib/decisions-schema.ts`:\n- `id`: kebab-case (e.g. `archetype-selection`, `wo-period-of-performance`)\n- `phase`: `<N>-<kebab-name>` (e.g. `1-design`, `4-connect`) — ordinal-prefixed, matches the artifact-manifest folder convention\n- `skill`: emitter slug (e.g. `idea-to-pdd`, `pdd-to-work-order`)\n- `question`: the load-bearing question this row records\n- `ai-default`: the AI\'s picked value as a string (exact-match member of `options`)\n- `options`: array of short scannable labels for what was considered\n- `source`: citation only (where the info came from)\n- `evidence_basis` (REQUIRED, v4): how grounded the default is — `stated` (directly in a source), `inferred` (extrapolated beyond any source), or `conflicting` (resolves disagreeing sources). This forces Phase-1 to declare, per decision, whether it sourced, extrapolated, or resolved a contested fork — instead of silently presenting an inferred default as fact.\n- `conflict_signals` (REQUIRED iff `evidence_basis: conflicting`; >= 2 entries): the competing source readings you resolved, one per entry, each ideally citing where it came from. Omit for `stated`/`inferred`.\n- `status`: `ai-default` — ALWAYS, on every new row. A caller-asserted `status: human-decided` is REJECTED at this boundary (ace#2307): it is an attribution claim that `lib/decisions-ingest.ts` carries forward as BINDING into every later run of the opp, a subagent structurally cannot reach a human to originate one, and this atom cannot tell an L0 orchestrator from a subagent (these args carry no caller identity). Both legitimate routes are stamped HERE, from a saved record rather than from your prose: a `feedback_ref` match against an attributed ruling in `inputs/decision-overrides.yaml`, or an id match, which flips the row to `overridden`. To record a real human ruling, write it into that file with `decided_by` + `decided_at` (ace-web Phases tab -> Decisions panel) and send the row as `ai-default`.\n- `reasoning` (optional): AI\'s rationale (for `conflicting`, state WHY this resolution won)\n- `override` (optional; only with `status: overridden`)\n- `override_reasoning` (optional; only with `status: overridden`)\n- `plain` (REQUIRED v6 on partner-facing rows): one line in plain language for a programme partner — what was chosen. No field ids, no section refs, no ACE jargon (PDD, CCZ, skill names, issue numbers); quote a design rule in double quotes to keep its words.\n- `audience` (v6): `internal` for ACE test-harness rows (stamped here when the row is recognisably harness); absent = partner.\n- `check_at` + `correct_looks_like` (v6): where a reviewer spot-checks it and what right looks like. `check_at` is filled from a `Spot-check: <where>.` sentence in `reasoning` when omitted.\n- `review_ask: recommended-confirmation` + `confirm_reason` (v6): the run is built on this value but someone with authority should confirm it before launch (a [PROPOSED] parameter, a translation sign-off, an enforcement gap, an open design question). `decisions_enrich` derives the standard ones; set it yourself for any other.\n- The producer rule (replaces the retired open-questions ledger): a default you build on is a decision row. Where the sources do not settle it, add `owner` (partner | implementing-org | dimagi | free text — who answers), `needed_by` (award | go-live | closeout | extension), `answer_channel` (review | call | solicitation:<question-id>). `review_ask: required-before` REQUIRES `needed_by` and is the only gating ask (release readiness; solicitation-review refuses award while a `needed_by: award` one is unanswered). `status: deferred` + `revisit_when` (one plain sentence) for a question this pilot does not need answered — no `review_ask` on it.\n- `scope` + `enforcement` (v6, rule rows only): stamped here from the rule text when omitted.\nFull contract: docs/decisions-contract.md.\n\nReturns `{fileId, added, skipped[], total, created, modifiedTime, revisionVersion}`, plus `headerRepairs[]` when an inherited header needed repair — a SEEDED run copies the parent run\'s header verbatim, so its `generated_at` can arrive in a non-ISO spelling and its `run_id` can name the seed run. Both are repaired in place (the run folder is the authority on run_id) instead of rejecting the write: before ace#1029 either one rejected EVERY append for the whole run, and since this atom is the only sanctioned writer, the run silently lost its entire decisions trail. An `opportunity` mismatch is still a hard error — that one is data loss.',
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
      if (e instanceof DecisionsWriteError || e instanceof DecisionOverridesError || e instanceof OperatorRulingsError) {
        return error(`${e.code}: ${e.message}`);
      }
      return error(e?.message ?? String(e));
    }
  },
);

server.tool(
  'decisions_enrich',
  'Apply the deterministic half of the decisions review contract (schema v6, docs/decisions-contract.md) to a run\'s decisions.yaml — the step that makes the decisions log serve as the run\'s review artifact (the build memo is retired). Reads decisions.yaml and run_state.yaml from the run folder and: (1) stamps `audience: internal` on ACE test-harness rows, `scope`/`enforcement` + a `plain` line on rule rows, `check_at` from a `Spot-check:` sentence; (2) folds one question asked by two skills with one answer into one live row (`also_raised_by`); (3) marks `review_ask: recommended-confirmation` + `confirm_reason` on every [PROPOSED] program parameter the build picked (rate, organisation payment, budget, dates), every machine-translated working language, every enforcement gap, every OPEN row, and every open residual in run_state that a person must decide — synthesizing a row when none carries it. Never touches a row a human ruled on. Idempotent; writes only when something changed. Run it at every phase end BEFORE render_decisions_log (skills/decisions-render). Returns the report: `stamped`, `folded`, `asked`, `appended`, `missingPlain` (live partner rows a producer left without `plain`), `jargon`, `plainLanguageGate` ({verdict: pass|fail, findings: [{id, skill, field, finding}]} — the structural plain-language gate over every reviewer-visible row, docs/decisions-contract.md § Plain-language gate; a `fail` is a FAIL for decisions-render and a release blocker), and `reviewAsks` (id + plain + confirm_reason of every live ask).',
  {
    runFolderId: z.string().min(1).describe('Drive file ID of the run folder holding decisions.yaml and run_state.yaml.'),
    dryRun: z.boolean().optional().describe('Compute and report without writing.'),
  },
  async (args) => {
    try {
      return result(await handleEnrich(args));
    } catch (e: any) {
      return error(e?.message ?? String(e));
    }
  },
);

server.tool(
  'decisions_open_asks',
  'What a run still asks a person, and the one gate an ask can carry (docs/decisions-contract.md § Open asks). The open-questions ledger is retired: an open question is a decision row with an unanswered `review_ask` or `status: deferred`. Reads the run\'s decisions.yaml, the opp\'s `inputs/decision-overrides.yaml` (a saved ruling answers an ask even if the row predates it) and the previous run\'s `ACE/<opp>/open-asks.yaml`. Returns: `asks` (every open ask); `requiredBefore` (unanswered `review_ask: required-before` rows, filtered by `neededBy` when given — solicitation-review passes `neededBy: award` and MUST NOT call award_response while this is non-empty; release readiness blocks on them too); `closedBySolicitation` (required-before asks whose `answer_channel: solicitation:<id>` was answered by the chosen response, per `solicitationAnswered`); `carried` (null when there is no previous open-asks.yaml, or it is this run\'s own — otherwise which previous asks this run re-derived, and `missing` + ready-made `residuals` for each one it dropped: write those into `phases.<phase>.residuals`; values are never inherited). `mode: emit` (orchestrator, run end, once) also writes `open-asks.yaml` at the opp root as generated, read-only YAML: {schema_version: 1, opp, run_id, generated_at, asks: [<live decision rows with an unanswered review_ask or status deferred>]}. `mode: check` writes nothing (Phase 1 passes `throughPhase: 1` so only asks Phase 1 owns are compared).',
  {
    runFolderId: z.string().min(1).describe('Drive file ID of the run folder holding decisions.yaml.'),
    opportunity: z.string().min(1).describe('Opportunity slug; must match the log.'),
    run_id: z.string().min(1).describe('This run\'s id.'),
    mode: z.enum(['check', 'emit']).describe('`check` reads only; `emit` also writes ACE/<opp>/open-asks.yaml (run end).'),
    neededBy: z.enum(NEEDED_BY).optional().describe('Only report required-before asks needed before this gate (solicitation-review: `award`).'),
    throughPhase: z.number().int().min(1).optional().describe('Compare against previous-run asks raised by phases up to this ordinal (Phase 1: 1). Omit at run end.'),
    solicitationAnswered: z
      .array(z.string().min(1))
      .optional()
      .describe('Solicitation question ids the chosen response answered (non-empty). Closes a required-before ask whose answer_channel is `solicitation:<id>`.'),
  },
  async (args) => {
    try {
      return result(await handleOpenAsks(args));
    } catch (e: any) {
      if (e instanceof DecisionsWriteError || e instanceof DecisionOverridesError) return error(`${e.code}: ${e.message}`);
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
