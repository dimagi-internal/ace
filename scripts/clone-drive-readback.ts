/**
 * scripts/clone-drive-readback.ts
 *
 * The Drive-link read-back of `skills/clone-to-new-workspace` § Step 2.
 *
 *   npx tsx scripts/clone-drive-readback.ts --source <source-run-folder-id> \
 *     --target <target-run-folder-id>
 *
 * Walks both run folders, reads every YAML file in the TARGET (run_state,
 * decisions, each previews/<output>/_previews.yaml, the Phase 6 capture
 * manifest, …) and reports any SOURCE run file id still in one. Read-only.
 *
 * Prints one JSON object: {checked, hits[], left_behind[]}. Exit 0 = clean,
 * 1 = source ids remain (stop and report — ace-web's rewrite did not run),
 * 2 = usage / Drive error. Logic: lib/clone-readback.ts (dimagi-internal/ace#2603).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { google } from '../lib/google-shim.js';
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';
import {
  findLeftoverSourceIds,
  isIdBearingCopy,
  type CopiedText,
  type SourceFile,
} from '../lib/clone-readback.js';

loadPluginEnv(import.meta.url);

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const GOOGLE_DOC = 'application/vnd.google-apps.document';

interface Entry { id: string; name: string; mimeType: string; path: string }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function keyPath(): string | null {
  const env = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (env && fs.existsSync(env)) return env;
  const dataDir = resolvePluginDataDir(import.meta.url);
  const candidates = [
    dataDir ? path.join(dataDir, 'gws-sa-key.json') : '',
    path.join(process.env.HOME || '', '.claude', 'plugins', 'data', 'ace-ace', 'gws-sa-key.json'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

async function walk(drive: any, folderId: string, prefix = ''): Promise<Entry[]> {
  const out: Entry[] = [];
  let pageToken: string | undefined;
  do {
    const r = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id,name,mimeType)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageSize: 1000,
      pageToken,
    });
    for (const f of r.data.files ?? []) {
      const p = prefix ? `${prefix}/${f.name}` : f.name;
      if (f.mimeType === FOLDER_MIME) out.push(...(await walk(drive, f.id, p)));
      else out.push({ id: f.id, name: f.name, mimeType: f.mimeType, path: p });
    }
    pageToken = r.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

async function readText(drive: any, f: Entry): Promise<string> {
  if (f.mimeType === GOOGLE_DOC) {
    const r = await drive.files.export({ fileId: f.id, mimeType: 'text/plain' }, { responseType: 'text' });
    return String(r.data);
  }
  const r = await drive.files.get(
    { fileId: f.id, alt: 'media', supportsAllDrives: true },
    { responseType: 'text' },
  );
  return String(r.data);
}

async function main(): Promise<number> {
  const source = arg('source');
  const target = arg('target');
  if (!source || !target) {
    console.error('usage: clone-drive-readback.ts --source <run-folder-id> --target <run-folder-id>');
    return 2;
  }
  const key = keyPath();
  if (!key) {
    console.error('GWS service-account key not found (run /ace:setup)');
    return 2;
  }
  const auth = new google.auth.GoogleAuth({ keyFile: key, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  const drive = google.drive({ version: 'v3', auth });

  const sourceFiles: SourceFile[] = (await walk(drive, source)).map((f) => ({ id: f.id, path: f.path }));
  const copies: CopiedText[] = [];
  for (const f of await walk(drive, target)) {
    if (isIdBearingCopy(f.path)) copies.push({ path: f.path, text: await readText(drive, f) });
  }
  const r = findLeftoverSourceIds(sourceFiles, copies);
  console.log(JSON.stringify({
    source_files: sourceFiles.length,
    checked: r.checked.length,
    hits: r.hits,
    left_behind: r.leftBehind,
  }, null, 2));
  return r.hits.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => { console.error(err?.message ?? err); process.exit(2); },
);
