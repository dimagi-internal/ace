/**
 * lint-opp-cruft.ts — flag resolved entries still living in the active
 * `open_questions:` / `phase_X_backlog:` blocks of a per-opp
 * `run_state.yaml`.
 *
 * Usage:
 *   npx tsx scripts/lint-opp-cruft.ts <opp-name>
 *
 * Drives the doctor's `state-yaml-cruft <opp>` sub-command introduced
 * in 0.11.7. Enforces the convention documented in
 * `agents/ace-orchestrator.md` § Cruft management: when a skill
 * resolves an entry, it MOVES it to a top-level `archive:` block
 * rather than annotating in place.
 *
 * Heuristics (any one fires):
 *   - `resolution_phase:` starts with `resolved` (e.g. `resolved-in-0.10.91`)
 *   - `default_in_use:` starts with `(resolved`
 *   - `summary:` starts with `RESOLVED ` or contains `RESOLVED in <version>`
 *     (case-insensitive on the first hit)
 *   - `note:` starts with `RESOLVED in <version>` (the `phase_X_backlog`
 *     entries use `note:` rather than `default_in_use:`)
 *
 * Items already in `archive:` are skipped.
 *
 * Exit status: 0 if clean, 1 if any candidate found, 2 on harness error.
 */

import { google } from '../lib/google-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import yaml from 'yaml';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';

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
  const homeDataKey = path.join(
    process.env.HOME || '',
    '.claude', 'plugins', 'data', 'ace-ace', 'gws-sa-key.json',
  );
  if (fs.existsSync(homeDataKey)) return homeDataKey;
  if (fs.existsSync(LEGACY_KEY_PATH)) return LEGACY_KEY_PATH;
  throw new Error('No Google service-account key found.');
}

function loadEnv() {
  const dataDir = resolvePluginDataDir(import.meta.url);
  if (dataDir) {
    const p = path.join(dataDir, '.env');
    if (fs.existsSync(p)) dotenv.config({ path: p, override: false });
  }
  const homeDataEnv = path.join(
    process.env.HOME || '',
    '.claude', 'plugins', 'data', 'ace-ace', '.env',
  );
  if (fs.existsSync(homeDataEnv)) dotenv.config({ path: homeDataEnv, override: false });
  const legacy = path.join(PROJECT_ROOT, '.env');
  if (fs.existsSync(legacy)) dotenv.config({ path: legacy, override: false });
}

async function findChild(
  drive: ReturnType<typeof google.drive>,
  parentId: string,
  name: string,
): Promise<{ id: string; mimeType: string } | null> {
  const resp = await drive.files.list({
    q: `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`,
    fields: 'files(id, name, mimeType)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const files = resp.data.files || [];
  if (!files.length) return null;
  return { id: files[0].id!, mimeType: files[0].mimeType! };
}

async function listFolder(drive: ReturnType<typeof google.drive>, folderId: string) {
  const resp = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    pageSize: 100,
  });
  return resp.data.files || [];
}

async function readDocText(
  drive: ReturnType<typeof google.drive>,
  file: { id: string; mimeType: string },
): Promise<string> {
  if (file.mimeType === 'application/vnd.google-apps.document') {
    const resp = await drive.files.export(
      { fileId: file.id, mimeType: 'text/plain' },
      { responseType: 'text' },
    );
    return resp.data as unknown as string;
  }
  const resp = await drive.files.get(
    { fileId: file.id, alt: 'media', supportsAllDrives: true },
    { responseType: 'text' },
  );
  return resp.data as unknown as string;
}

async function findRunStateFile(
  drive: ReturnType<typeof google.drive>,
  oppFolderId: string,
): Promise<{ id: string; mimeType: string; via: string } | null> {
  const runs = await findChild(drive, oppFolderId, 'runs');
  if (runs && runs.mimeType === 'application/vnd.google-apps.folder') {
    const runFolders = (await listFolder(drive, runs.id))
      .filter((f) => f.mimeType === 'application/vnd.google-apps.folder')
      .sort((a, b) => (b.name || '').localeCompare(a.name || ''));
    for (const rf of runFolders) {
      const rs = await findChild(drive, rf.id!, 'run_state.yaml');
      if (rs) return { ...rs, via: `runs/${rf.name}/run_state.yaml` };
      const sy = await findChild(drive, rf.id!, 'state.yaml');
      if (sy) return { ...sy, via: `runs/${rf.name}/state.yaml (legacy)` };
    }
  }
  const flatNew = await findChild(drive, oppFolderId, 'run_state.yaml');
  if (flatNew) return { ...flatNew, via: 'run_state.yaml (opp root)' };
  const flatLegacy = await findChild(drive, oppFolderId, 'state.yaml');
  if (flatLegacy) return { ...flatLegacy, via: 'state.yaml (opp root, legacy)' };
  return null;
}

export interface CruftFinding {
  block: string;        // e.g. "open_questions" or "phase_3_backlog"
  entry_id: string;     // entry's id (or <no-id>)
  reason: string;       // which heuristic fired
  detail: string;       // matched substring for context
}

const RESOLVED_IN_VERSION_RE = /\bRESOLVED\b[^.\n]*?\bin\s+\d+\.\d+\.\d+\b/i;

/**
 * Scan one block of entries for resolved-but-not-archived items.
 *
 * Pure helper exported for unit testing. Operates on parsed YAML — no
 * Drive I/O.
 */
export function detectResolvedInBlock(blockName: string, entries: unknown): CruftFinding[] {
  if (!Array.isArray(entries)) return [];
  const findings: CruftFinding[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = String(e.id ?? '<no-id>');

    // Heuristic 1: resolution_phase: starts with "resolved"
    const resolutionPhase = String(e.resolution_phase ?? '').trim();
    if (/^resolved\b/i.test(resolutionPhase)) {
      findings.push({
        block: blockName,
        entry_id: id,
        reason: 'resolution_phase-starts-resolved',
        detail: `resolution_phase: ${resolutionPhase}`,
      });
      continue;
    }

    // Heuristic 2: default_in_use: starts with "(resolved"
    const defaultInUse = String(e.default_in_use ?? '').trim();
    if (/^\(resolved/i.test(defaultInUse)) {
      findings.push({
        block: blockName,
        entry_id: id,
        reason: 'default_in_use-resolved-marker',
        detail: `default_in_use: ${defaultInUse.slice(0, 60)}`,
      });
      continue;
    }

    // Heuristic 3: summary: starts with "RESOLVED " or contains "RESOLVED in <ver>"
    const summary = String(e.summary ?? '').trim();
    if (/^RESOLVED\b/i.test(summary)) {
      findings.push({
        block: blockName,
        entry_id: id,
        reason: 'summary-starts-resolved',
        detail: `summary: ${summary.slice(0, 80)}…`,
      });
      continue;
    }
    const m = summary.match(RESOLVED_IN_VERSION_RE);
    if (m) {
      findings.push({
        block: blockName,
        entry_id: id,
        reason: 'summary-resolved-in-version',
        detail: `matched: "${m[0]}"`,
      });
      continue;
    }

    // Heuristic 4: note: starts with "RESOLVED in <version>"
    const note = String(e.note ?? '').trim();
    const nm = note.match(RESOLVED_IN_VERSION_RE);
    if (nm) {
      findings.push({
        block: blockName,
        entry_id: id,
        reason: 'note-resolved-in-version',
        detail: `note matched: "${nm[0]}"`,
      });
      continue;
    }
  }
  return findings;
}

/**
 * Walk a parsed run_state.yaml and return every cruft finding across
 * `open_questions:` and every `phase_*_backlog:` key. Entries already
 * inside `archive:` are skipped (the convention's whole point).
 *
 * Pure helper exported for unit testing.
 */
export function detectCruft(state: unknown): CruftFinding[] {
  if (!state || typeof state !== 'object') return [];
  const s = state as Record<string, unknown>;
  const findings: CruftFinding[] = [];
  for (const [key, value] of Object.entries(s)) {
    if (key === 'archive') continue;
    if (key === 'open_questions' || /^phase_\d+_backlog$/.test(key)) {
      findings.push(...detectResolvedInBlock(key, value));
    }
  }
  return findings;
}

async function main() {
  loadEnv();

  const opp = process.argv[2];
  if (!opp) {
    console.error('usage: lint-opp-cruft.ts <opp-name>');
    process.exit(2);
  }

  const aceRootId = process.env.ACE_DRIVE_ROOT_FOLDER_ID;
  if (!aceRootId) {
    console.error('FAIL: ACE_DRIVE_ROOT_FOLDER_ID env var not set.');
    process.exit(2);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: resolveKeyPath(),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const drive = google.drive({ version: 'v3', auth });

  const oppFolder = await findChild(drive, aceRootId, opp);
  if (!oppFolder || oppFolder.mimeType !== 'application/vnd.google-apps.folder') {
    console.error(`FAIL: opp folder "${opp}" not found under ACE/`);
    process.exit(2);
  }

  const stateFile = await findRunStateFile(drive, oppFolder.id);
  if (!stateFile) {
    console.error(`FAIL: no run_state.yaml or state.yaml found under ACE/${opp}/`);
    process.exit(2);
  }

  console.log(`reading: ACE/${opp}/${stateFile.via}`);
  const text = await readDocText(drive, stateFile);
  let parsed: unknown;
  try {
    parsed = yaml.parse(text);
  } catch (e: any) {
    console.error(`FAIL: parse error in ${stateFile.via}: ${e.message}`);
    process.exit(2);
  }

  const findings = detectCruft(parsed);
  if (findings.length === 0) {
    console.log(`PASS state-yaml-cruft: no resolved entries left in active blocks`);
    process.exit(0);
  }

  for (const f of findings) {
    console.log(`WARN state-yaml-cruft: ${f.block}.${f.entry_id} — ${f.reason}`);
    console.log(`  detail: ${f.detail}`);
    console.log(`  fix: move entry to archive.${f.block}[] with resolved_at + resolved_by + resolution_note`);
  }
  console.log(`\nFound ${findings.length} resolved entr${findings.length === 1 ? 'y' : 'ies'} still in active blocks. See agents/ace-orchestrator.md § Cruft management.`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`FAIL state-yaml-cruft: ${e.message ?? e}`);
    process.exit(2);
  });
}
