/**
 * scripts/clone-asset-rewrite.ts
 *
 * `skills/clone-to-new-workspace` § Step 4e — rewrite the copied run's prose
 * and artifacts from the SOURCE's assets (HQ space, app/build ids + versions,
 * Connect program/opportunity, org slugs) to the target's rebuilt copies.
 *
 *   npx tsx scripts/clone-asset-rewrite.ts \
 *     --source <source-run-folder-id> --target <target-run-folder-id> \
 *     --out <local-dir> [--to <workspace>] [--keep-phase-folder 8-solicitation-management]
 *
 * Read-only on Drive. Writes, under --out:
 *   - one rewritten file per changed Drive file (`<fileId>.<ext>`),
 *   - `run_state.patch.json` — an `update_yaml_file(merge: "deep")` patch,
 *   - `plan.json` — what to apply, and every file left on the source on purpose.
 * The agent applies the plan through the guarded MCP atoms
 * (`drive_update_file(fileId, localFilePath)` per file, `update_yaml_file`
 * for run_state), so the Drive tenancy guard sees every write. Re-run after
 * applying: `changes: 0` is the read-back.
 *
 * Exit 0 = plan written (or nothing to do), 2 = usage / Drive error.
 * Logic: lib/clone-asset-refs.ts (dimagi-internal/ace#2606).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import { google } from '../lib/google-shim.js';
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';
import { normalizeDriveExport } from '../lib/drive-export.js';
import {
  buildAssetMap,
  docTextFromExport,
  processCloneFile,
  rewriteRunState,
  runAssetsFromRunState,
} from '../lib/clone-asset-refs.js';

loadPluginEnv(import.meta.url);

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const GOOGLE_DOC = 'application/vnd.google-apps.document';

interface Entry { id: string; name: string; mimeType: string; path: string; parent: string }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => { if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]); });
  return out;
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
      else out.push({ id: f.id, name: f.name, mimeType: f.mimeType, path: p, parent: folderId });
    }
    pageToken = r.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

function isText(f: Entry): boolean {
  return f.mimeType === GOOGLE_DOC || /^text\/|json|yaml|xml/.test(f.mimeType);
}

async function readText(drive: any, f: Entry): Promise<string> {
  if (f.mimeType === GOOGLE_DOC) {
    const r = await drive.files.export({ fileId: f.id, mimeType: 'text/plain' }, { responseType: 'text' });
    // Docs' export doubles blank lines on a write-back unless inverted (ace#2606).
    return docTextFromExport(String(r.data));
  }
  const r = await drive.files.get({ fileId: f.id, alt: 'media', supportsAllDrives: true }, { responseType: 'text' });
  return String(r.data);
}

/** A Doc carrying real styles was rendered from markdown; a plain upload would flatten it. */
async function isStyledDoc(docs: any, documentId: string): Promise<boolean> {
  const d = await docs.documents.get({ documentId });
  return (d.data.body?.content ?? []).some(
    (el: any) => el.table || el.paragraph?.bullet || /HEADING/.test(el.paragraph?.paragraphStyle?.namedStyleType ?? ''),
  );
}

async function main(): Promise<number> {
  const source = arg('source');
  const target = arg('target');
  const outDir = arg('out');
  if (!source || !target || !outDir) {
    console.error('usage: clone-asset-rewrite.ts --source <run-folder-id> --target <run-folder-id> --out <dir> [--to <ws>] [--keep-phase-folder <name>]...');
    return 2;
  }
  const key = keyPath();
  if (!key) { console.error('GWS service-account key not found (run /ace:setup)'); return 2; }
  const auth = new google.auth.GoogleAuth({
    keyFile: key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/documents.readonly'],
  });
  const drive = google.drive({ version: 'v3', auth });
  const docs = (google as any).docs({ version: 'v1', auth });

  const sourceFiles = await walk(drive, source);
  const targetFiles = await walk(drive, target);
  const srcRsFile = sourceFiles.find((f) => f.path === 'run_state.yaml');
  const dstRsFile = targetFiles.find((f) => f.path === 'run_state.yaml');
  if (!srcRsFile || !dstRsFile) { console.error('run_state.yaml missing in source or target run folder'); return 2; }
  const srcRs = YAML.parse(await readText(drive, srcRsFile));
  const dstRs = YAML.parse(await readText(drive, dstRsFile));

  const map = buildAssetMap(runAssetsFromRunState(srcRs), runAssetsFromRunState(dstRs));
  const from = dstRs?.clone?.from
    ? `${dstRs.clone.from.workspace}/${dstRs.clone.from.opp}/${dstRs.clone.from.run}`
    : `${srcRs.opportunity}/${srcRs.run_id}`;
  const to = arg('to') ?? /\/opps\/([^/]+)\//.exec(String(dstRs?.ace_web_summary_url ?? ''))?.[1];
  if (!to) { console.error('cannot tell the target workspace: pass --to <ws>'); return 2; }
  const label = { from, to };
  const keepFolders = args('keep-phase-folder');
  const opts = keepFolders.length ? { keepPhaseFolders: keepFolders } : {};
  const keepPhases = (keepFolders.length ? keepFolders : ['8-solicitation-management']).map((f) => f.replace(/^\d+-/, ''));

  fs.mkdirSync(outDir, { recursive: true });
  const plan: any = { label, pairs: map.pairs, versions: map.versions, files: [], left_on_source: [], run_state: null };
  // Pass 1: plain-text processing of every text file.
  const texts = new Map<string, string>(); // path -> current text (rewritten when changed)
  const pending: Array<{ f: Entry; r: ReturnType<typeof processCloneFile> }> = [];
  for (const f of targetFiles) {
    if (!isText(f) || f.path === 'run_state.yaml') continue;
    const text = await readText(drive, f);
    // Any Doc, styled or plain, prints an HTML comment as text (ace-web showed
    // "<!-- clone-provenance -->" on a plain-text app summary).
    const r = processCloneFile(f.path, text, map, label, { ...opts, rich: f.mimeType === GOOGLE_DOC });
    texts.set(f.path, r.text);
    pending.push({ f, r });
  }
  // Pass 2: write the plan. A STYLED Doc (headings / bullets / tables — a
  // markdown render) must not be written back as plain text: that strips every
  // style (ace#2606 did it to the LLO guide). Re-render it from markdown — its
  // `.source.md` companion when it has one, else its own markdown export.
  for (const { f, r } of pending) {
    if (r.changed && f.mimeType === GOOGLE_DOC && (await isStyledDoc(docs, f.id))) {
      const sibling = f.path.replace(/\.md$/i, '.source.md');
      let md = sibling !== f.path ? texts.get(sibling) : undefined;
      if (md === undefined) {
        const ex = await drive.files.export({ fileId: f.id, mimeType: 'text/markdown' }, { responseType: 'text' });
        md = normalizeDriveExport(String(ex.data));
      }
      const rr = processCloneFile(f.path, md, map, label, { ...opts, rich: true });
      const local = path.resolve(outDir, `${f.id}.render.md`);
      fs.writeFileSync(local, rr.text.replace(/<!-- clone-provenance -->\n/, ''));
      plan.files.push({ action: 'render', fileId: f.id, path: f.path, name: f.name, parentFolderId: f.parent, kind: r.kind, replacements: rr.replacements, localFilePath: local });
    } else if (r.changed) {
      const ext = path.extname(f.name) || '.txt';
      const local = path.resolve(outDir, `${f.id}${ext}`);
      fs.writeFileSync(local, r.text);
      plan.files.push({ action: 'update', fileId: f.id, path: f.path, mimeType: f.mimeType, kind: r.kind, replacements: r.replacements, localFilePath: local });
    } else if (r.sourceRefs.length) {
      plan.left_on_source.push({ path: f.path, kind: r.kind, refs: r.sourceRefs });
    }
  }
  const rsr = rewriteRunState(dstRs, map, label, keepPhases);
  if (rsr.changed.length) {
    const local = path.resolve(outDir, 'run_state.patch.json');
    fs.writeFileSync(local, JSON.stringify(rsr.patch, null, 2));
    plan.run_state = { fileId: dstRsFile.id, merge: 'deep', changed: rsr.changed, localFilePath: local };
  }
  for (const p of rsr.skippedWithRefs) plan.left_on_source.push({ path: `run_state.yaml ${p}`, kind: 'skip' });
  fs.writeFileSync(path.resolve(outDir, 'plan.json'), JSON.stringify(plan, null, 2));
  console.log(JSON.stringify({
    pairs: map.pairs.length,
    changes: plan.files.length + (plan.run_state ? 1 : 0),
    files: plan.files.map((f: any) => `${f.action}/${f.kind} ${f.path} (${f.replacements})`),
    run_state: plan.run_state?.changed ?? [],
    left_on_source: plan.left_on_source.map((x: any) => x.path),
    plan: path.resolve(outDir, 'plan.json'),
  }, null, 2));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => { console.error(err?.message ?? err); process.exit(2); },
);
