#!/usr/bin/env npx tsx
/**
 * Embed a run's captured screenshots into an already-published Google Doc.
 *
 *   npx tsx scripts/embed-doc-screenshots.ts <docId> \
 *     --screenshots <folderId> [--screenshots <folderId> ...] \
 *     [--width-pt 140] [--dry-run]
 *
 * Step 2 of the two-step write for an ILLUSTRATED artifact: render the
 * markdown with `drive_create_doc_from_markdown`, then run this. See
 * `lib/doc-image-embed.ts` for why the images cannot ride in the markdown
 * (they can — at 9.4 inches wide and a page and a half tall each, which is
 * why they don't).
 *
 * Anchors on what the prose ALREADY cites — a Drive file link or a `.png`
 * filename — and appends those frames after the citing paragraph. It adds no
 * prose, moves nothing, and re-running is safe: a paragraph already followed
 * by its images is skipped.
 *
 * VERIFICATION IS PART OF THE RUN, not an afterthought. A batchUpdate that
 * returns 200 proves the API accepted the request, not that a reader sees a
 * picture — that is exactly the failure mode this whole class came from. So
 * after writing, the doc is re-read for its inline-image count AND, when the
 * doc is publicly readable, its ANONYMOUS HTML export is counted. Exit is
 * non-zero unless both agree that images are present.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { google } from '../lib/google-shim.js';
import { AceGoogleAuth } from '../lib/ace-google-auth.js';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';
import {
  buildEmbedRequests,
  classifyFrameSharing,
  collectImageAnchors,
  countInlineImages,
  DEFAULT_IMAGE_WIDTH_PT,
  explainEmbedFailure,
  unsharedFramesMessage,
  type DocLike,
  type DrivePermissionLike,
} from '../lib/doc-image-embed.js';

import { loadPluginEnv } from '../lib/load-plugin-env.js';

// ace#1964 — a script reached from a Bash tool call inherits NONE of ACE's
// secrets, so it has to load `<plugin-data>/.env` itself. Module top, before
// any credential read: ESM runs this body top-down, so "before main()" is
// already too late for a read at module level.
loadPluginEnv(import.meta.url);

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FOLDER_MIME = 'application/vnd.google-apps.folder';

function loadEnv() {
  const dataDir = resolvePluginDataDir(import.meta.url);
  if (dataDir) {
    const p = path.join(dataDir, '.env');
    if (fs.existsSync(p)) dotenv.config({ path: p, override: false });
  }
}

interface Args {
  docId: string;
  folders: string[];
  widthPt: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { docId: '', folders: [], widthPt: DEFAULT_IMAGE_WIDTH_PT, dryRun: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--screenshots': args.folders.push(argv[++i]); break;
      case '--width-pt': args.widthPt = Number(argv[++i]); break;
      case '--dry-run': args.dryRun = true; break;
      default:
        if (argv[i].startsWith('--')) throw new Error(`unknown flag ${argv[i]}`);
        positional.push(argv[i]);
    }
  }
  args.docId = positional[0] ?? '';
  if (!args.docId) {
    throw new Error(
      'usage: embed-doc-screenshots.ts <docId> [--screenshots <folderId>]... [--width-pt N] [--dry-run]',
    );
  }
  return args;
}

interface ImageFile {
  id: string;
  name: string;
  width?: number;
  height?: number;
}

/** Every image under the given folders, recursively. */
async function listImages(drive: any, folderIds: string[]): Promise<ImageFile[]> {
  const out: ImageFile[] = [];
  const queue = [...folderIds];
  const seen = new Set<string>();
  while (queue.length) {
    const folderId = queue.shift()!;
    if (seen.has(folderId)) continue;
    seen.add(folderId);
    let pageToken: string | undefined;
    do {
      const r = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'nextPageToken, files(id,name,mimeType,imageMediaMetadata(width,height))',
        pageSize: 200,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageToken,
      });
      for (const f of r.data.files ?? []) {
        if (f.mimeType === FOLDER_MIME) { queue.push(f.id!); continue; }
        if (!String(f.mimeType ?? '').startsWith('image/')) continue;
        out.push({
          id: f.id!,
          name: f.name!,
          width: f.imageMediaMetadata?.width ?? undefined,
          height: f.imageMediaMetadata?.height ?? undefined,
        });
      }
      pageToken = r.data.nextPageToken ?? undefined;
    } while (pageToken);
  }
  return out;
}

/**
 * Every pending frame that is not shared anyone-with-link (ace#3234). Docs
 * fetches inserted images without the SA's credentials, so an SA-only frame
 * fails the whole batch with a message that does not name sharing. Read each
 * frame's permissions first; an unreadable list is `unknown` and does not
 * block (the post-write verify still runs).
 */
async function unsharedFrames(
  drive: any,
  fileIds: string[],
  byId: Map<string, ImageFile>,
): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = [];
  for (const id of [...new Set(fileIds)]) {
    let perms: DrivePermissionLike[] | null = null;
    try {
      const r = await drive.permissions.list({
        fileId: id,
        supportsAllDrives: true,
        fields: 'permissions(type,role)',
      });
      perms = r.data.permissions ?? [];
    } catch (e: any) {
      console.log(`WARN could not read sharing of ${byId.get(id)?.name ?? id}: ${e?.message ?? e}`);
    }
    if (classifyFrameSharing(perms) === 'not-shared') out.push({ id, name: byId.get(id)?.name ?? id });
  }
  return out;
}

/** `<img>` count in the ANONYMOUS HTML export — what an outsider actually gets. */
async function anonymousImageCount(docId: string): Promise<number | null> {
  try {
    const r = await fetch(`https://docs.google.com/document/d/${docId}/export?format=html`, {
      redirect: 'follow',
      credentials: 'omit',
    });
    if (!r.ok || r.url.includes('accounts.google.com')) return null;
    const body = await r.text();
    return (body.match(/<img\b/gi) ?? []).length;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnv();
  // ace@'s canopy-minted Google token, the same identity ace-gdrive writes the doc as
  // (lib/ace-google-auth.ts). The service-account key this script used to read no
  // longer exists on any machine (ace#3310).
  const auth = new AceGoogleAuth();
  const drive = google.drive({ version: 'v3', auth }) as any;
  const docs = google.docs({ version: 'v1', auth }) as any;

  const images = await listImages(drive, args.folders);
  const byName = new Map<string, ImageFile>();
  const byId = new Map<string, ImageFile>();
  for (const f of images) {
    byName.set(f.name, f);
    byId.set(f.id, f);
  }
  console.log(`screenshot pool: ${images.length} image(s) across ${args.folders.length} folder(s)`);

  const before = (await docs.documents.get({ documentId: args.docId })).data as DocLike;
  const beforeCount = countInlineImages(before);

  const { anchors, unresolvedCitations: unresolved } = collectImageAnchors(
    before,
    (filename) => byName.get(filename)?.id ?? null,
  );

  const pending = anchors.filter((a) => !a.alreadyIllustrated);
  const totalImages = pending.reduce((n, a) => n + a.fileIds.length, 0);
  console.log(
    `doc ${args.docId}: ${countInlineImages(before)} inline image(s) present, ` +
      `${anchors.length} citing paragraph(s), ${pending.length} to fill, ${totalImages} image(s) to insert`,
  );
  if (unresolved.length) {
    console.log(
      `NOTE ${new Set(unresolved).size} filename citation(s) matched no captured frame ` +
        `(left as text): ${[...new Set(unresolved)].slice(0, 10).join(', ')}`,
    );
  }
  for (const a of pending) {
    console.log(`  + ${a.fileIds.length} @${a.endIndex}  ${a.excerpt.replace(/\s+/g, ' ')}`);
  }

  // Sharing pre-flight (ace#3234) — before the dry-run exit too, so a dry run
  // reports the frames a real run would fail on.
  const unshared = await unsharedFrames(drive, pending.flatMap((a) => a.fileIds), byId);
  if (unshared.length) {
    console.error(unsharedFramesMessage(unshared));
    process.exit(1);
  }

  if (args.dryRun) { console.log('DRY RUN — nothing written.'); return; }
  if (!pending.length) { console.log('nothing to do.'); }
  else {
    const requests = buildEmbedRequests(anchors, {
      widthPt: args.widthPt,
      naturalSize: (id) => {
        const f = byId.get(id);
        return f?.width && f?.height ? { width: f.width, height: f.height } : null;
      },
    });
    // One atomic batch on purpose: Docs applies requests in order against
    // shifting indices, so a partial application would leave the remaining
    // (descending) indices pointing at the wrong paragraphs. All-or-nothing
    // plus the idempotent skip is the safe pair — a failed run is simply
    // re-run once the offending frame is readable.
    try {
      await docs.documents.batchUpdate({ documentId: args.docId, requestBody: { requests } });
    } catch (e: any) {
      throw new Error(explainEmbedFailure(String(e?.message ?? e)));
    }
    console.log(`batchUpdate applied: ${requests.length} request(s)`);
  }

  // ── Verify, because a 200 is not a picture ──────────────────────────
  const after = (await docs.documents.get({ documentId: args.docId })).data as DocLike;
  const afterCount = countInlineImages(after);
  const anon = await anonymousImageCount(args.docId);
  console.log(`VERIFY inline images: ${beforeCount} -> ${afterCount}`);
  console.log(
    `VERIFY anonymous <img> count: ${anon === null ? 'not publicly readable (skipped)' : anon}`,
  );

  const expected = beforeCount + totalImages;
  if (afterCount !== expected) {
    console.error(`FAIL expected ${expected} inline image(s), the document has ${afterCount}`);
    process.exit(1);
  }
  if (afterCount > 0 && anon !== null && anon < afterCount) {
    console.error(
      `FAIL the document holds ${afterCount} inline image(s) but an anonymous reader sees ${anon}`,
    );
    process.exit(1);
  }
  console.log('OK');
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
