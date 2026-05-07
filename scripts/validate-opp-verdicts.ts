/**
 * validate-opp-verdicts.ts — fetch a turmeric-shape opp's verdicts/ folder
 * from Drive and validate each YAML against lib/verdict-schema.ts.
 *
 * Run:
 *   npx tsx scripts/validate-opp-verdicts.ts <opp-name>
 *   # e.g. npx tsx scripts/validate-opp-verdicts.ts turmeric
 *
 * Exit status: 0 if all verdicts valid, 1 if any drift, 2 on harness error.
 *
 * This is the operator-side preventer — pairs with the test-side preventer
 * in test/lib/real-verdict-validation.test.ts. Run it after a full opp
 * cycle to catch any verdict drift before downstream consumers (opp-eval,
 * future tooling) trip on it.
 */

import { google } from '../lib/google-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';
import { parseVerdictYaml } from '../lib/parse-verdict.js';

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
  // Worktree fallback (mirrors loadEnv's homeDataEnv).
  const homeDataKey = path.join(
    process.env.HOME || '',
    '.claude',
    'plugins',
    'data',
    'ace-ace',
    'gws-sa-key.json',
  );
  if (fs.existsSync(homeDataKey)) return homeDataKey;
  if (fs.existsSync(LEGACY_KEY_PATH)) return LEGACY_KEY_PATH;
  throw new Error(
    'No Google service-account key found. Set GOOGLE_APPLICATION_CREDENTIALS, ' +
      'place the key at $CLAUDE_PLUGIN_DATA/gws-sa-key.json, ' +
      `or at ${LEGACY_KEY_PATH}. Run /ace:setup for help.`,
  );
}

function loadEnv() {
  // Load .env from plugin-data-dir, then a known canonical fallback (so
  // the script works when run from a dev worktree, not just the cache path),
  // then plugin root (legacy).
  const dataDir = resolvePluginDataDir(import.meta.url);
  if (dataDir) {
    const p = path.join(dataDir, '.env');
    if (fs.existsSync(p)) dotenv.config({ path: p, override: false });
  }
  // Worktree fallback: $HOME/.claude/plugins/data/ace-ace/.env. This is the
  // canonical location of the installed .env; using it from a dev checkout
  // means operators don't need to duplicate secrets.
  const homeDataEnv = path.join(
    process.env.HOME || '',
    '.claude',
    'plugins',
    'data',
    'ace-ace',
    '.env',
  );
  if (fs.existsSync(homeDataEnv)) dotenv.config({ path: homeDataEnv, override: false });
  const legacy = path.join(PROJECT_ROOT, '.env');
  if (fs.existsSync(legacy)) dotenv.config({ path: legacy, override: false });
}

async function findChildFolder(
  drive: ReturnType<typeof google.drive>,
  parentId: string,
  name: string,
): Promise<string | null> {
  const q = `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`;
  const resp = await drive.files.list({
    q,
    fields: 'files(id, name, mimeType, shortcutDetails)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const files = resp.data.files || [];
  if (files.length === 0) return null;
  const f = files[0];
  if (f.mimeType === 'application/vnd.google-apps.shortcut') {
    return f.shortcutDetails?.targetId || null;
  }
  return f.id || null;
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

async function readDocText(drive: ReturnType<typeof google.drive>, fileId: string): Promise<string> {
  // Files written via drive_create_file are Google Docs (with text/plain media
  // upload). Export them back as plain text.
  const resp = await drive.files.export(
    { fileId, mimeType: 'text/plain' },
    { responseType: 'text' },
  );
  return resp.data as unknown as string;
}

async function main() {
  loadEnv();

  const opp = process.argv[2];
  if (!opp) {
    console.error('usage: validate-opp-verdicts.ts <opp-name>');
    process.exit(2);
  }

  const aceRootId = process.env.ACE_DRIVE_ROOT_FOLDER_ID;
  if (!aceRootId) {
    console.error('FAIL: ACE_DRIVE_ROOT_FOLDER_ID env var not set.');
    console.error('  fix: ensure .env was created via op inject and ACE_DRIVE_ROOT_FOLDER_ID is populated.');
    process.exit(2);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: resolveKeyPath(),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const drive = google.drive({ version: 'v3', auth });

  console.log(`INFO opp=${opp} ace_root=${aceRootId}`);

  const oppFolderId = await findChildFolder(drive, aceRootId, opp);
  if (!oppFolderId) {
    console.error(`FAIL: opp folder '${opp}' not found under ACE root ${aceRootId}.`);
    process.exit(2);
  }
  console.log(`INFO opp_folder=${oppFolderId}`);

  const verdictsId = await findChildFolder(drive, oppFolderId, 'verdicts');
  if (!verdictsId) {
    console.error(`FAIL: verdicts/ folder not found under '${opp}'.`);
    process.exit(2);
  }
  console.log(`INFO verdicts_folder=${verdictsId}`);

  const files = (await listFolder(drive, verdictsId))
    .filter((f) => (f.name || '').endsWith('.yaml'))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  if (files.length === 0) {
    console.log('INFO no verdict YAML files found in verdicts/');
    process.exit(0);
  }

  let pass = 0;
  let fail = 0;
  for (const f of files) {
    const name = f.name || '(unnamed)';
    try {
      const text = await readDocText(drive, f.id!);
      const r = parseVerdictYaml(text);
      if (r.ok) {
        console.log(`PASS ${name}`);
        pass++;
      } else {
        console.log(`FAIL ${name}`);
        for (const e of r.errors) console.log(`  - ${e}`);
        fail++;
      }
    } catch (e: any) {
      console.log(`FAIL ${name} (read error)`);
      console.log(`  - ${e.message}`);
      fail++;
    }
  }

  console.log('');
  console.log(`STATUS: ${fail === 0 ? 'OK' : 'DRIFT'} pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e);
  process.exit(2);
});
