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
 * Released build ids/versions are read from each run's
 * `3-commcare/app-release_summary.md` frontmatter (app-release's contracted
 * record), falling back to run_state (ace#2702).
 *
 * It also re-points FRAMES (ace#2697). Phase 4's re-capture in 4b gives
 * `4-connect/previews/<slug>/*.png` new ids, so a guide that links or embeds
 * the earlier frames shows the SOURCE org. Every cited or embedded Drive id
 * that is no longer live in the target run is paired with the live file at the
 * same run path (`plan.frames.repointed`). A styled Doc that cites or embeds
 * one is re-rendered, and its screenshots must then be re-embedded. A cited
 * image with no live counterpart is `plan.frames.foreign`.
 *
 * Exit 0 = plan written (or nothing to do); 2 = usage / Drive error;
 * 3 = a frame cannot be re-pointed (`frames.foreign`), or the read-back found
 * an embedded image outside the target run with nothing left to apply
 * (`frames.embedded_outside_run`). The clone is NOT DONE on 3.
 * Logic: lib/clone-asset-refs.ts (dimagi-internal/ace#2606),
 * lib/clone-frame-repoint.ts (dimagi-internal/ace#2697).
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
import { APP_RELEASE_SUMMARY } from '../lib/app-release-record.js';
import { docTextAndLinks, rewriteDriveIds } from '../lib/clone-readback.js';
import {
  citedDriveIds,
  embeddedImageIds,
  embeddedOutsideRun,
  planFrameRepoint,
  type CitedFile,
  type LiveFile,
} from '../lib/clone-frame-repoint.js';

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

/** folder id → run-relative path ('' for the run folder), filled by `walk`. */
type Folders = Map<string, string>;

async function walk(drive: any, folderId: string, prefix = '', folders: Folders = new Map()): Promise<Entry[]> {
  folders.set(folderId, prefix);
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
      if (f.mimeType === FOLDER_MIME) out.push(...(await walk(drive, f.id, p, folders)));
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

  const sourceFolders: Folders = new Map();
  const targetFolders: Folders = new Map();
  const sourceFiles = await walk(drive, source, '', sourceFolders);
  const targetFiles = await walk(drive, target, '', targetFolders);
  const srcRsFile = sourceFiles.find((f) => f.path === 'run_state.yaml');
  const dstRsFile = targetFiles.find((f) => f.path === 'run_state.yaml');
  if (!srcRsFile || !dstRsFile) { console.error('run_state.yaml missing in source or target run folder'); return 2; }
  const srcRs = YAML.parse(await readText(drive, srcRsFile));
  const dstRs = YAML.parse(await readText(drive, dstRsFile));

  // Released build ids/versions come from app-release's summary, their
  // contracted owner; run_state is the fallback (ace#2702).
  const summaryText = async (files: Entry[]): Promise<string | null> => {
    const f = files.find((x) => APP_RELEASE_SUMMARY.test(x.path));
    return f ? readText(drive, f) : null;
  };
  const map = buildAssetMap(
    runAssetsFromRunState(srcRs, await summaryText(sourceFiles)),
    runAssetsFromRunState(dstRs, await summaryText(targetFiles)),
  );
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
  // Frames (ace#2697): every Drive id a rewrite-class file cites or embeds.
  // A Doc's text export hides link targets, so read its links and embedded
  // images from the Docs API.
  const docJson = new Map<string, any>();
  const citedBy = new Map<string, Set<string>>(); // id -> paths
  const embeddedBy = new Map<string, string[]>(); // doc path -> embedded ids
  const cite = (id: string, where: string) => citedBy.set(id, (citedBy.get(id) ?? new Set()).add(where));
  for (const { f, r } of pending) {
    if (r.kind !== 'rewrite') continue;
    for (const id of citedDriveIds(r.text)) cite(id, f.path);
    if (f.mimeType === GOOGLE_DOC) {
      const d = (await docs.documents.get({ documentId: f.id })).data;
      docJson.set(f.id, d);
      for (const l of docTextAndLinks(d).links) for (const id of citedDriveIds(l.url)) cite(id, f.path);
      const emb = embeddedImageIds(d);
      embeddedBy.set(f.path, emb);
      for (const id of emb) cite(id, f.path);
    }
  }
  const live: LiveFile[] = targetFiles.map((f) => ({ id: f.id, path: f.path }));
  const liveIds = new Set(live.map((f) => f.id));
  const embeddedAll = new Set([...embeddedBy.values()].flat());
  const cited: CitedFile[] = [];
  for (const [id, where] of citedBy) {
    if (liveIds.has(id)) continue;
    let p: string | null = null;
    let isImage = embeddedAll.has(id);
    let shared = false;
    try {
      // Works for a trashed file too — a re-capture trashes the frames it replaces.
      const m = (await drive.files.get({ fileId: id, fields: 'id,name,mimeType,parents', supportsAllDrives: true })).data;
      const parent = m.parents?.[0];
      const dir = parent !== undefined ? (targetFolders.get(parent) ?? sourceFolders.get(parent)) : undefined;
      if (dir !== undefined) p = dir ? `${dir}/${m.name}` : String(m.name);
      isImage = isImage || String(m.mimeType ?? '').startsWith('image/');
      // Outside both runs: is it a cross-opp baseline under ACE/_common/?
      for (let up = parent, i = 0; p === null && up && i < 5; i++) {
        const a = (await drive.files.get({ fileId: up, fields: 'name,parents', supportsAllDrives: true })).data;
        if (a.name === '_common') { shared = true; break; }
        up = a.parents?.[0];
      }
    } catch {
      // unreadable: outside both runs as far as this clone can tell
    }
    cited.push({ id, path: p, isImage, shared, where: [...where].join(', ') });
  }
  const frames = planFrameRepoint(cited, live);
  const sharedIds = new Set(cited.filter((c) => c.shared).map((c) => c.id));
  // Pass 2: write the plan. A STYLED Doc (headings / bullets / tables — a
  // markdown render) must not be written back as plain text: that strips every
  // style (ace#2606 did it to the LLO guide). Re-render it from markdown — its
  // `.source.md` companion when it has one, else its own markdown export.
  const stale = new Set([...Object.keys(frames.ids), ...frames.foreign.map((c) => c.id)]);
  for (const { f, r: r0 } of pending) {
    const fr = r0.kind === 'rewrite' ? rewriteDriveIds(r0.text, frames.ids) : { text: r0.text, replacements: 0 };
    const embedsStale = (embeddedBy.get(f.path) ?? []).some((id) => stale.has(id));
    const r = { ...r0, text: fr.text, changed: r0.changed || fr.replacements > 0 || embedsStale };
    if (r.changed && f.mimeType === GOOGLE_DOC && (embedsStale || (await isStyledDoc(docs, f.id)))) {
      const sibling = f.path.replace(/\.md$/i, '.source.md');
      let md = sibling !== f.path ? texts.get(sibling) : undefined;
      if (md === undefined) {
        const ex = await drive.files.export({ fileId: f.id, mimeType: 'text/markdown' }, { responseType: 'text' });
        md = normalizeDriveExport(String(ex.data));
      }
      const rr = processCloneFile(f.path, md, map, label, { ...opts, rich: true });
      const rf = rewriteDriveIds(rr.text, frames.ids);
      const local = path.resolve(outDir, `${f.id}.render.md`);
      fs.writeFileSync(local, rf.text.replace(/<!-- clone-provenance -->\n/, ''));
      // A re-render drops the Doc's inline images; an illustrated Doc must be re-embedded.
      const reembed = (embeddedBy.get(f.path) ?? []).length > 0 || Object.keys(docJson.get(f.id)?.inlineObjects ?? {}).length > 0;
      plan.files.push({ action: 'render', fileId: f.id, path: f.path, name: f.name, parentFolderId: f.parent, kind: r.kind, replacements: rr.replacements, frames_repointed: rf.replacements, reembed_screenshots: reembed, localFilePath: local });
    } else if (r.changed) {
      const ext = path.extname(f.name) || '.txt';
      const local = path.resolve(outDir, `${f.id}${ext}`);
      fs.writeFileSync(local, r.text);
      plan.files.push({ action: 'update', fileId: f.id, path: f.path, mimeType: f.mimeType, kind: r.kind, replacements: r.replacements, frames_repointed: fr.replacements, localFilePath: local });
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
  // Read-back half: images a Doc embeds RIGHT NOW that are not live in the target run.
  const embeddedOutside: Array<{ path: string; ids: string[] }> = [];
  for (const [p, ids] of embeddedBy) {
    const out = embeddedOutsideRun(ids, live, sharedIds);
    if (out.length) embeddedOutside.push({ path: p, ids: out });
  }
  plan.frames = {
    repointed: frames.ids,
    foreign: frames.foreign,
    embedded_outside_run: embeddedOutside,
    // The target's own preview folders, for `embed-doc-screenshots.ts --screenshots`
    // (plus the folders app-screenshot-capture_manifest.yaml names).
    preview_folders: [...targetFolders].filter(([, p]) => /(^|\/)previews\/[^/]+$/.test(p)).map(([id, p]) => ({ id, path: p })),
  };
  fs.writeFileSync(path.resolve(outDir, 'plan.json'), JSON.stringify(plan, null, 2));
  console.log(JSON.stringify({
    pairs: map.pairs.length,
    changes: plan.files.length + (plan.run_state ? 1 : 0),
    files: plan.files.map((f: any) => `${f.action}/${f.kind} ${f.path} (${f.replacements})`),
    run_state: plan.run_state?.changed ?? [],
    left_on_source: plan.left_on_source.map((x: any) => x.path),
    frames_repointed: Object.keys(frames.ids).length,
    frames_foreign: frames.foreign.map((c) => `${c.id} (${c.path ?? 'outside both runs'}; cited in ${c.where})`),
    embedded_outside_run: embeddedOutside.map((e) => `${e.path}: ${e.ids.join(', ')}`),
    plan: path.resolve(outDir, 'plan.json'),
  }, null, 2));
  const changes = plan.files.length + (plan.run_state ? 1 : 0);
  if (frames.foreign.length || (changes === 0 && embeddedOutside.length)) return 3;
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => { console.error(err?.message ?? err); process.exit(2); },
);
