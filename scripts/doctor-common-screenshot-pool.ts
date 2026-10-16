/**
 * doctor probe: common_screenshot_pool — does `ACE/_common/connect-screenshots/`
 * hold a usable pool for the PINNED Connect APK? (dimagi-internal/ace#3060)
 * Read-only. Logic + rationale: lib/common-screenshot-pool.ts.
 *
 *   --format=lines   PASS/WARN line for bin/ace-doctor (default; always exit 0)
 *   --format=json    the verdict object; exit 1 when the pool is not usable, so
 *                    the training skills' preflight can branch on the exit code
 *   --version=<v>    check this version instead of the pinned one
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { google } from '../lib/google-shim.js';
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';
import { classifyCommonPool, type CommonPoolVerdict } from '../lib/common-screenshot-pool.js';
import { getConfiguredApkVersion } from '../mcp/mobile/client.js';

loadPluginEnv(import.meta.url);

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
}

function resolveKeyPath(): string | null {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const dataDir = resolvePluginDataDir(import.meta.url);
  const dataKey = dataDir ? path.join(dataDir, 'gws-sa-key.json') : '';
  return dataKey && fs.existsSync(dataKey) ? dataKey : null;
}

type Entry = { id: string; name: string; mimeType: string };

async function list(drive: any, folderId: string): Promise<Entry[]> {
  const out: Entry[] = [];
  let pageToken: string | undefined;
  do {
    const r = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id,name,mimeType)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageToken,
    });
    out.push(...((r.data.files ?? []) as Entry[]));
    pageToken = r.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

async function readText(drive: any, f: Entry): Promise<string> {
  if (f.mimeType === DOC_MIME) {
    const r = await drive.files.export({ fileId: f.id, mimeType: 'text/plain' }, { responseType: 'text' });
    return String(r.data);
  }
  const r = await drive.files.get({ fileId: f.id, alt: 'media', supportsAllDrives: true }, { responseType: 'text' });
  return String(r.data);
}

/** `skipped` = the check could not run; a caller must not read that as a pass. */
async function probe(pinnedVersion: string): Promise<CommonPoolVerdict | { skipped: string }> {
  const rootId = process.env.ACE_DRIVE_ROOT_FOLDER_ID;
  if (!rootId) return { skipped: 'ACE_DRIVE_ROOT_FOLDER_ID not set' };
  const keyPath = resolveKeyPath();
  if (!keyPath) return { skipped: 'GWS service-account key not found' };
  const auth = new google.auth.GoogleAuth({ keyFile: keyPath, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  const drive = google.drive({ version: 'v3', auth });

  const folder = async (parent: string, name: string) =>
    (await list(drive, parent)).find((e) => e.mimeType === FOLDER_MIME && e.name === name);

  const common = await folder(rootId, '_common');
  const pool = common ? await folder(common.id, 'connect-screenshots') : undefined;
  const versions = pool ? (await list(drive, pool.id)).filter((e) => e.mimeType === FOLDER_MIME) : [];
  const pinned = versions.find((v) => v.name === pinnedVersion);
  let manifestText: string | null = null;
  if (pinned) {
    const m = (await list(drive, pinned.id)).find((e) => e.name === 'manifest.yaml');
    if (m) manifestText = await readText(drive, m);
  }
  return classifyCommonPool({ pinnedVersion, versionsPresent: versions.map((v) => v.name), manifestText });
}

async function main(): Promise<number> {
  const format = arg('format') ?? 'lines';
  const pinnedVersion = arg('version') ?? getConfiguredApkVersion();
  const v = await probe(pinnedVersion);
  if ('skipped' in v) {
    if (format === 'json') {
      console.log(JSON.stringify({ status: 'skipped', pinnedVersion, summary: v.skipped }));
      return 2;
    }
    console.log(`WARN common_screenshot_pool: not checked (${v.skipped}) — this is NOT a pass`);
    return 0;
  }
  if (format === 'json') {
    console.log(JSON.stringify(v));
    return v.status === 'pass' ? 0 : 1;
  }
  console.log(`${v.status === 'pass' ? 'PASS' : 'WARN'} common_screenshot_pool: ${v.summary}`);
  if (v.remediation) console.log(`  fix: ${v.remediation}`);
  return 0;
}

let code = 0;
try {
  code = await main();
} catch (e) {
  const msg = (e as Error).message;
  if ((process.argv.find((a) => a.startsWith('--format=')) ?? '').endsWith('json')) {
    console.log(JSON.stringify({ status: 'skipped', summary: `probe crashed: ${msg}` }));
    code = 2;
  } else {
    console.log(`WARN common_screenshot_pool: probe crashed (${msg}) — this is NOT a pass`);
  }
}
process.exit(code);
