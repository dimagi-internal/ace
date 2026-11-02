/**
 * scripts/doctor-drive-layout.ts
 *
 * Backing dispatcher for the [Drive layout] section of bin/ace-doctor.
 * Walks ACE_DRIVE_ROOT_FOLDER_ID, lists every opp folder and every run
 * under each opp's runs/ subfolder, and runs the pure checks from
 * lib/doctor-drive-layout.ts. Prints one PASS/WARN line per check, plus
 * an explanatory hint on WARN (the same shape as the rest of ace-doctor's
 * pass/warn/fail helpers).
 *
 * Exit status: always 0 (results go to stdout — same convention as
 * bin/ace-doctor).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { google } from '../lib/google-shim.js';
import { AceGoogleAuth } from '../lib/ace-google-auth.js';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';
import {
  detectDuplicateFolders,
  detectStrayOppRootFiles,
  isOppFolder,
  type DriveEntry,
} from '../lib/doctor-drive-layout.js';

import { loadPluginEnv } from '../lib/load-plugin-env.js';

// ace#1964 — a script reached from a Bash tool call inherits NONE of ACE's
// secrets, so it has to load `<plugin-data>/.env` itself. Module top, before
// any credential read: ESM runs this body top-down, so "before main()" is
// already too late for a read at module level.
loadPluginEnv(import.meta.url);

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FOLDER_MIME = 'application/vnd.google-apps.folder';

function pass(msg: string) { console.log(`PASS ${msg}`); }
function warn(msg: string, fix?: string) {
  console.log(`WARN ${msg}`);
  if (fix) console.log(`  fix: ${fix}`);
}
function info(msg: string) { console.log(`INFO ${msg}`); }

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

async function listFolder(driveClient: any, folderId: string): Promise<DriveEntry[]> {
  const out: DriveEntry[] = [];
  let pageToken: string | undefined;
  do {
    const r = await driveClient.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id,name,mimeType)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageToken,
    });
    out.push(...((r.data.files ?? []) as DriveEntry[]));
    pageToken = r.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

async function main() {
  loadEnv();

  const rootId = process.env.ACE_DRIVE_ROOT_FOLDER_ID;
  if (!rootId) {
    info('drive_layout: ACE_DRIVE_ROOT_FOLDER_ID not set — skipping');
    return;
  }
  const auth = new AceGoogleAuth();
  const driveClient = google.drive({ version: 'v3', auth });
  const drive = { list: (id: string) => listFolder(driveClient, id) };

  const candidateFolders = (await drive.list(rootId)).filter(
    (c) => c.mimeType === FOLDER_MIME,
  );
  const oppFolders: typeof candidateFolders = [];
  const nonOppFolders: string[] = [];
  for (const c of candidateFolders) {
    if (await isOppFolder(c.id, drive)) {
      oppFolders.push(c);
    } else {
      nonOppFolders.push(c.name);
    }
  }

  let totalDups = 0;
  let totalStrays = 0;
  const strayByOpp: string[] = [];
  for (const opp of oppFolders) {
    // Stray opp-root entries
    const strays = await detectStrayOppRootFiles(opp.id, drive);
    if (strays.length > 0) {
      totalStrays += strays.length;
      strayByOpp.push(`${opp.name} (${strays.map((x) => x.name).join(', ')})`);
    }

    // Duplicate folders under each run
    const oppChildren = await drive.list(opp.id);
    const runsFolder = oppChildren.find(
      (c) => c.name === 'runs' && c.mimeType === FOLDER_MIME,
    );
    if (!runsFolder) continue;
    const runs = (await drive.list(runsFolder.id)).filter(
      (c) => c.mimeType === FOLDER_MIME,
    );
    for (const run of runs) {
      const dups = await detectDuplicateFolders(run.id, drive);
      if (dups.length > 0) {
        totalDups += dups.length;
        for (const d of dups) {
          warn(
            `drive_layout/${opp.name}/${run.name}: duplicate folder '${d.name}' (${d.ids.length} copies: ${d.ids.join(', ')})`,
            `parallel skill writes created sibling same-named folders. Coalesce: move children into one and delete the empty duplicate. Future writes are guarded by drive_create_folder findOrCreate (added 0.11.9).`,
          );
        }
      }
    }
  }

  // Stray opp-root entries are shared-Drive CONTENT, identical from every
  // machine — not a fault in this machine's setup — so they are one INFO line
  // (cleanup belongs to /ace:sweep), never a WARN per opp. Duplicate folders
  // stay WARN: they mean parallel skill writes raced, which is a real defect.
  if (totalStrays > 0) {
    info(`drive_layout: ${totalStrays} stray opp-root entr${totalStrays === 1 ? 'y' : 'ies'} across ${strayByOpp.length} opp(s) — shared-Drive content, not this machine; tidy with /ace:sweep: ${strayByOpp.join('; ')}`);
  }
  if (totalDups === 0) {
    pass(`drive_layout: ${oppFolders.length} opp folder(s) checked, no duplicate run folders${nonOppFolders.length ? ` (${nonOppFolders.length} non-opp folder(s) at the root ignored)` : ''}`);
  }
}

main().catch((e) => {
  console.log(`WARN drive_layout: probe failed: ${e.message}`);
});
