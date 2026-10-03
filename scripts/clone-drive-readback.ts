/**
 * scripts/clone-drive-readback.ts
 *
 * The Drive-link read-back of `skills/clone-to-new-workspace` § Step 2.
 *
 *   npx tsx scripts/clone-drive-readback.ts --source <source-run-folder-id> \
 *     --target <target-run-folder-id> [--plan <local-dir>]
 *
 * Walks both run folders, reads every TEXT copy in the TARGET — YAML,
 * markdown, plain text, JSON, and Google Docs (visible text AND hyperlink
 * targets) — and reports any SOURCE run file id still in one. Read-only on
 * Drive.
 *
 * Prints one JSON object: {checked, hits[], left_behind[], provenance[]}.
 * `left_behind` = comms-log ids (not cloned, expected); `provenance` = the
 * decisions log and eval/QA records (history, left as is). Exit 0 = clean,
 * 1 = source ids remain in `hits`, 2 = usage / Drive error.
 *
 * `--plan <dir>` also writes the repair, without applying it: source → copy
 * ids paired by relative path, then per hit file either a rewritten local
 * file (`action: update` → `drive_update_file(fileId, localFilePath)`, which
 * keeps a plain file's own type) or a Docs request list (`action: docs` →
 * `docs_batch_update(documentId, requests)`, which retargets links and ids in
 * place and never flattens a formatted Doc). The agent applies it through the
 * guarded MCP atoms so the Drive tenancy guard sees every write; re-run
 * without `--plan` to read back. Logic: lib/clone-readback.ts
 * (dimagi-internal/ace#2603, #2607).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { google } from '../lib/google-shim.js';
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';
import {
  buildCopyIdMap,
  docIdRewriteRequests,
  docTextAndLinks,
  findLeftoverSourceIds,
  isIdBearingCopy,
  rewriteDriveIds,
  type CopiedText,
  type SourceFile,
} from '../lib/clone-readback.js';

loadPluginEnv(import.meta.url);

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const GOOGLE_DOC = 'application/vnd.google-apps.document';

interface Entry { id: string; name: string; mimeType: string; path: string; folder: boolean }

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
      const folder = f.mimeType === FOLDER_MIME;
      out.push({ id: f.id, name: f.name, mimeType: f.mimeType, path: folder ? `${p}/` : p, folder });
      if (folder) out.push(...(await walk(drive, f.id, p)));
    }
    pageToken = r.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

async function readPlain(drive: any, f: Entry): Promise<string> {
  const r = await drive.files.get(
    { fileId: f.id, alt: 'media', supportsAllDrives: true },
    { responseType: 'text' },
  );
  return String(r.data);
}

async function main(): Promise<number> {
  const source = arg('source');
  const target = arg('target');
  const planDir = arg('plan');
  if (!source || !target) {
    console.error('usage: clone-drive-readback.ts --source <run-folder-id> --target <run-folder-id> [--plan <dir>]');
    return 2;
  }
  const key = keyPath();
  if (!key) {
    console.error('GWS service-account key not found (run /ace:setup)');
    return 2;
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/documents.readonly'],
  });
  const drive = google.drive({ version: 'v3', auth });
  const docs = (google as any).docs({ version: 'v1', auth });

  const sourceTree = await walk(drive, source);
  const targetTree = await walk(drive, target);
  const sourceFiles: SourceFile[] = [
    { id: source, path: '' },
    ...sourceTree.map((f) => ({ id: f.id, path: f.path })),
  ];
  const copies: Array<CopiedText & { entry: Entry; doc?: any }> = [];
  for (const f of targetTree) {
    if (f.folder || !isIdBearingCopy(f.path, f.mimeType)) continue;
    if (f.mimeType === GOOGLE_DOC) {
      const doc = (await docs.documents.get({ documentId: f.id })).data;
      const { text, links } = docTextAndLinks(doc);
      copies.push({ path: f.path, text, links: links.map((l) => l.url), mimeType: f.mimeType, entry: f, doc });
    } else if (!f.mimeType.startsWith('application/vnd.google-apps.')) {
      copies.push({ path: f.path, text: await readPlain(drive, f), mimeType: f.mimeType, entry: f });
    }
  }
  const r = findLeftoverSourceIds(sourceFiles, copies);
  const report: any = {
    source_files: sourceFiles.length,
    checked: r.checked.length,
    hits: r.hits,
    left_behind: r.leftBehind,
    provenance: r.provenance.map((h) => ({ copyPath: h.copyPath, sourceId: h.sourceId, occurrences: h.occurrences })),
  };

  if (planDir) {
    fs.mkdirSync(planDir, { recursive: true });
    const map = buildCopyIdMap(sourceTree, targetTree, { source, target });
    const hitPaths = new Set(r.hits.map((h) => h.copyPath));
    const files: any[] = [];
    for (const c of copies) {
      if (!hitPaths.has(c.path)) continue;
      if (c.doc) {
        const rw = docIdRewriteRequests(c.doc, map.ids);
        if (!rw.requests.length) continue;
        const local = path.resolve(planDir, `${c.entry.id}.requests.json`);
        fs.writeFileSync(local, JSON.stringify(rw.requests, null, 2));
        files.push({ action: 'docs', fileId: c.entry.id, path: c.path, links: rw.links, text_ids: rw.textIds, unsafe: rw.unsafe, requestsPath: local });
      } else {
        const rw = rewriteDriveIds(c.text, map.ids);
        if (!rw.replacements) continue;
        const local = path.resolve(planDir, `${c.entry.id}${path.extname(c.entry.name) || '.txt'}`);
        fs.writeFileSync(local, rw.text);
        files.push({ action: 'update', fileId: c.entry.id, path: c.path, mimeType: c.mimeType, replacements: rw.replacements, localFilePath: local });
      }
    }
    const plan = { ids: Object.keys(map.ids).length, ambiguous: map.ambiguous, unmatched: map.unmatched, files };
    fs.writeFileSync(path.resolve(planDir, 'plan.json'), JSON.stringify(plan, null, 2));
    report.plan = { path: path.resolve(planDir, 'plan.json'), files: files.length, ambiguous: map.ambiguous.length };
  }
  console.log(JSON.stringify(report, null, 2));
  return r.hits.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => { console.error(err?.message ?? err); process.exit(2); },
);
