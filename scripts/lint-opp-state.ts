/**
 * lint-opp-state.ts — flag plugin-wide entries living in per-opp run_state.yaml.
 *
 * Usage:
 *   npx tsx scripts/lint-opp-state.ts <opp-name>
 *
 * Drives the doctor's `state-yaml-lint <opp>` sub-command. Reads the opp's
 * canonical `run_state.yaml` from Drive (multi-run layout: newest run-folder;
 * legacy: opp root) and walks `phase_X_backlog:` entries looking for ones
 * that describe plugin-wide concerns rather than this opp's lifecycle.
 *
 * The convention these checks enforce is documented in
 * `agents/ace-orchestrator.md` § Scope boundaries (added 0.11.6): per-opp
 * `run_state.yaml` is for opp state, not plugin-wide bug tracking. Plugin
 * bugs go in GitHub issues + CHANGELOG; cross-opp learnings go in canopy
 * run logs.
 *
 * Heuristics:
 *   - `location:` field references plugin source paths (`mcp/`, `skills/`,
 *     `lib/`, `agents/`, `commands/`, `bin/`, `scripts/`, `test/`).
 *   - `summary:` mentions sweeping language ("all opps", "every Nova app",
 *     "any future run", "upstream PR", "MCP atom").
 *
 * Exit status: 0 if clean, 1 if any flag, 2 on harness error. Always prints
 * one line per finding so the doctor can surface them inline.
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
  const f = files[0];
  return { id: f.id!, mimeType: f.mimeType! };
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
  // Google Docs need export; raw text/plain etc. need get with alt=media.
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

export interface Finding {
  phase: string;
  entry_id: string;
  reason: string;
  detail: string;
}

export const PLUGIN_PATH_PREFIXES = [
  'mcp/', 'skills/', 'lib/', 'agents/', 'commands/', 'bin/', 'scripts/', 'test/',
];

export const PLUGIN_WIDE_PHRASES = [
  /\ball opps\b/i,
  /\bevery (nova|connect|ocs) app\b/i,
  /\bany future run\b/i,
  /\bupstream pr\b/i,
  /\bmcp atom\b/i,
  /\bnova-plugin#\d+/i,
  /\bcommcare-connect#\d+/i,
];

export function lintBacklogEntries(state: any): Finding[] {
  const findings: Finding[] = [];
  for (const [key, value] of Object.entries(state || {})) {
    if (!/^phase_\d+_backlog$/.test(key)) continue;
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const id = String(entry.id || '<no-id>');
      const summary = String(entry.summary || '');
      const location = String(entry.location || '');

      // Heuristic 1: location references plugin source.
      if (location) {
        const trimmed = location.trim().split(/[,\s]/, 1)[0];
        if (PLUGIN_PATH_PREFIXES.some((p) => trimmed.startsWith(p))) {
          findings.push({
            phase: key,
            entry_id: id,
            reason: 'location-in-plugin-source',
            detail: `location: ${trimmed}`,
          });
          continue;
        }
      }

      // Heuristic 2: summary uses plugin-wide language.
      for (const re of PLUGIN_WIDE_PHRASES) {
        const m = summary.match(re);
        if (m) {
          findings.push({
            phase: key,
            entry_id: id,
            reason: 'summary-plugin-wide-language',
            detail: `matched /${re.source}/ — "${m[0]}"`,
          });
          break;
        }
      }
    }
  }
  return findings;
}

async function findRunStateFile(
  drive: ReturnType<typeof google.drive>,
  oppFolderId: string,
): Promise<{ id: string; mimeType: string; via: string } | null> {
  // 1. Multi-run layout: <opp>/runs/<newest>/run_state.yaml
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
  // 2. Flat layout: <opp>/run_state.yaml or <opp>/state.yaml.
  const flatNew = await findChild(drive, oppFolderId, 'run_state.yaml');
  if (flatNew) return { ...flatNew, via: 'run_state.yaml (opp root)' };
  const flatLegacy = await findChild(drive, oppFolderId, 'state.yaml');
  if (flatLegacy) return { ...flatLegacy, via: 'state.yaml (opp root, legacy)' };
  return null;
}

async function main() {
  loadEnv();

  const opp = process.argv[2];
  if (!opp) {
    console.error('usage: lint-opp-state.ts <opp-name>');
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
  let parsed: any;
  try {
    parsed = yaml.parse(text);
  } catch (e: any) {
    console.error(`FAIL: parse error in ${stateFile.via}: ${e.message}`);
    process.exit(2);
  }

  const findings = lintBacklogEntries(parsed);
  if (findings.length === 0) {
    console.log(`PASS state-yaml-lint: no plugin-wide entries in any phase_*_backlog`);
    process.exit(0);
  }

  for (const f of findings) {
    console.log(`WARN state-yaml-lint: ${f.phase}.${f.entry_id} — ${f.reason}`);
    console.log(`  detail: ${f.detail}`);
    console.log(`  fix: move to a GitHub issue on the ACE repo or CHANGELOG entry; remove from this opp's run_state.yaml`);
  }
  console.log(`\nFound ${findings.length} plugin-wide entr${findings.length === 1 ? 'y' : 'ies'} in per-opp run_state.yaml. See agents/ace-orchestrator.md § Scope boundaries.`);
  process.exit(1);
}

// Only run main() when invoked as a script — not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`FAIL state-yaml-lint: ${e.message ?? e}`);
    process.exit(2);
  });
}
