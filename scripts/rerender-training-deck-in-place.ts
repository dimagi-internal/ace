/**
 * In-place re-render of an already-shared training deck — SAME URL, new
 * slides. First-class successor to the hh-poverty-targeting one-off
 * (ace#856); closes dimagi-internal/ace#864.
 *
 * Why not slides_copy_template: once a deck has been shared at a stable
 * URL, regenerating it must not mint a new presentationId. The Slides API
 * can't copy slides across presentations, but the existing deck's slides
 * ARE duplicates of the 14 stencils (with tokens replaced), and the deck
 * retains the template's masters/layouts. So:
 *
 *  1. duplicate one representative existing slide per layout →
 *     ace_stencil_<key> ids (layout list derived from --old-spec)
 *  2. strip their text / oversized content images, re-lay the {{TOKEN}}
 *     text boxes (geometry from lib/training-deck-stencil-geometry.ts —
 *     the single source of stencil text-box geometry) + reset {{NOTES}}
 *  3. run the stock buildSlidesRequestsV2 pipeline against this deck
 *     (new-slide ids renamed ace_slide_ → a non-colliding prefix so they
 *     never collide with the old slides)
 *  4. delete the old slides ONLY after the render batch succeeds — a
 *     failed batch leaves the old deck intact
 *  5. verify: coverage before/after, leftover {{TOKEN}}s, notes-filled
 *     count; print a JSON report
 *
 * Usage:
 *   npx tsx scripts/rerender-training-deck-in-place.ts \
 *     --deck <presentationId> \
 *     --spec <new-spec.yaml path> \
 *     --old-spec <spec.yaml path that produced the CURRENT slides> \
 *     [--key <gws-sa-key.json path>]
 *
 * The --old-spec is load-bearing: it tells the script which layout each
 * live slide carries (for representative-stencil selection) and how many
 * slides the deck SHOULD have. If the live slide count differs from the
 * old spec's, someone edited the deck by hand — the script HALTS and the
 * operator must reconcile first.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { google } from '../lib/google-shim.js';
import {
  parseTrainingSpec,
  resolveManifest,
  buildSlidesRequestsV2,
  STENCILS,
  type StencilKey,
  type TrainingDeckSpec,
} from '../lib/training-deck-spec.js';
import { STENCIL_TEXT_BUILDERS } from '../lib/training-deck-stencil-geometry.js';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  deck: string;
  spec: string;
  oldSpec: string;
  key?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--(deck|spec|old-spec|key)$/);
    if (!m) throw new Error(`unknown argument: ${argv[i]}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for --${m[1]}`);
    }
    args[m[1]] = value;
    i++;
  }
  for (const required of ['deck', 'spec', 'old-spec']) {
    if (!args[required]) {
      throw new Error(
        `--${required} is required.\n` +
          'Usage: npx tsx scripts/rerender-training-deck-in-place.ts ' +
          '--deck <presentationId> --spec <new-spec.yaml> --old-spec <old-spec.yaml> [--key <sa-key.json>]',
      );
    }
  }
  return { deck: args.deck, spec: args.spec, oldSpec: args['old-spec'], key: args.key };
}

function resolveKeyFile(cliKey: string | undefined): string {
  if (cliKey) {
    if (!fs.existsSync(cliKey)) throw new Error(`--key file not found: ${cliKey}`);
    return cliKey;
  }
  const dataDir = resolvePluginDataDir(import.meta.url);
  if (dataDir) {
    const derived = path.join(dataDir, 'gws-sa-key.json');
    if (fs.existsSync(derived)) return derived;
  }
  // Dev-checkout fallback (resolvePluginDataDir returns null outside the
  // installed plugin cache): the conventional installed data dir.
  const conventional = path.join(os.homedir(), '.claude', 'plugins', 'data', 'ace-ace', 'gws-sa-key.json');
  if (fs.existsSync(conventional)) return conventional;
  throw new Error(
    'Cannot resolve the GWS service-account key: no --key given, no plugin data dir ' +
      `resolvable, and ${conventional} does not exist. Pass --key <path-to-gws-sa-key.json>.`,
  );
}

// ---------------------------------------------------------------------------
// Deck digestion helpers
// ---------------------------------------------------------------------------

// Layouts whose RENDERED slides carry content images (createImage output)
// that must be stripped from the duplicated representative before re-use
// as a stencil. Decorative logos/watermarks fall below the size threshold.
const STRIP_IMAGES_ON = new Set<StencilKey>([
  'walkthrough', 'mobile_flow', 'web_screen', 'mobile_zoom', 'two_column',
]);
const STRIP_AREA = 2_058_675 * 2_058_675; // 1.5in x 1.5in in EMU^2

const SUBSTANTIVE_W = 762_000; // 60pt in EMU — coverage counts wider images

type SlideInfo = {
  objectId: string;
  notesShapeId?: string;
  notesHasText: boolean;
  textShapeIds: string[];
  images: { id: string; w: number; h: number; x: number; y: number }[];
};

/* eslint-disable @typescript-eslint/no-explicit-any */
function digestSlides(pres: any): SlideInfo[] {
  return (pres.data.slides ?? []).map((s: any) => {
    const textShapeIds: string[] = [];
    const images: SlideInfo['images'] = [];
    for (const el of s.pageElements ?? []) {
      if (el.shape?.text && el.objectId) textShapeIds.push(el.objectId);
      if (el.image && el.objectId) {
        const w = (el.size?.width?.magnitude ?? 0) * (el.transform?.scaleX ?? 1);
        const h = (el.size?.height?.magnitude ?? 0) * (el.transform?.scaleY ?? 1);
        images.push({ id: el.objectId, w, h, x: el.transform?.translateX ?? 0, y: el.transform?.translateY ?? 0 });
      }
    }
    const notesProps = s.slideProperties?.notesPage;
    const notesShapeId = notesProps?.notesProperties?.speakerNotesObjectId ?? undefined;
    let notesHasText = false;
    for (const el of notesProps?.pageElements ?? []) {
      if (el.objectId === notesShapeId && el.shape?.text) notesHasText = true;
    }
    return { objectId: s.objectId, notesShapeId, notesHasText, textShapeIds, images };
  });
}

function coverage(slideInfos: SlideInfo[]): { total: number; withImage: number; detail: string[] } {
  let withImage = 0;
  const detail: string[] = [];
  for (const s of slideInfos) {
    const substantive = s.images.filter((im) => im.w > SUBSTANTIVE_W);
    if (substantive.length) {
      withImage++;
      detail.push(`${s.objectId}: ${substantive.map((im) => `${im.id}(${(im.w / 914400).toFixed(1)}x${(im.h / 914400).toFixed(1)}in)`).join(', ')}`);
    }
  }
  return { total: slideInfos.length, withImage, detail };
}

const GET_FIELDS =
  'slides(objectId,slideProperties(notesPage(pageElements(objectId,shape(text)),notesProperties(speakerNotesObjectId))),pageElements(objectId,size,transform,shape(shapeType,text),image,line))';

// ---------------------------------------------------------------------------
// Spec helpers
// ---------------------------------------------------------------------------

/** Flatten a spec's modules → ordered per-slide layout list. */
function flattenLayouts(spec: TrainingDeckSpec): StencilKey[] {
  return spec.modules.flatMap((m) => m.slides.map((s) => s.layout as StencilKey));
}

/**
 * Pick a non-colliding new-slide id prefix: `ace_slide_` if no live
 * objectId starts with it, else `ace_slide_b_`, `ace_slide_c_`, …
 * (buildSlidesRequestsV2 emits `ace_slide_<n>`; the rename is a JSON
 * string-replace over the request batch).
 */
export function pickSlideIdPrefix(liveIds: string[]): string {
  const candidates = ['ace_slide_'];
  for (let c = 'b'.charCodeAt(0); c <= 'z'.charCodeAt(0); c++) {
    candidates.push(`ace_slide_${String.fromCharCode(c)}_`);
  }
  for (const prefix of candidates) {
    if (!liveIds.some((id) => id.startsWith(prefix))) return prefix;
  }
  throw new Error('no non-colliding ace_slide_ prefix available (deck has 25+ prior re-renders?)');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const keyFile = resolveKeyFile(cli.key);

  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/presentations'],
  });
  const drive = google.drive({ version: 'v3', auth });
  const slides = google.slides({ version: 'v1', auth });

  const spec = parseTrainingSpec(fs.readFileSync(cli.spec, 'utf8'));
  const oldSpec = parseTrainingSpec(fs.readFileSync(cli.oldSpec, 'utf8'));
  const manifest = resolveManifest(spec.manifest);
  const oldLayouts = flattenLayouts(oldSpec);
  const newLayouts = flattenLayouts(spec);
  const expectedSlides = newLayouts.length;
  console.log(`new spec: ${expectedSlides} slides, layouts: ${[...new Set(newLayouts)].join(',')}`);
  console.log(`old spec: ${oldLayouts.length} slides, layouts: ${[...new Set(oldLayouts)].join(',')}`);

  // Every layout the NEW spec uses needs a representative slide in the OLD
  // deck to duplicate as its stencil background. A dummy stencil (cloned
  // from slide 0) would render the wrong background — halt instead.
  const oldLayoutSet = new Set(oldLayouts);
  const unrepresentable = [...new Set(newLayouts)].filter((l) => !oldLayoutSet.has(l));
  if (unrepresentable.length) {
    throw new Error(
      `new spec uses layout(s) with no representative slide in the old deck: ` +
        `${unrepresentable.join(', ')}. In-place re-render can only rebuild layouts the ` +
        'deck already contains — render a fresh deck from the template instead.',
    );
  }

  // -- pre-flight: anyone-with-link on every manifest fileId ---------------
  const allIds = [
    ...Object.values(spec.manifest.common ?? {}),
    ...Object.values(spec.manifest.opp ?? {}),
  ].map((v) => String(v).replace(/^drive:/, ''));
  for (const id of allIds) {
    try {
      await drive.permissions.create({
        fileId: id,
        supportsAllDrives: true,
        requestBody: { role: 'reader', type: 'anyone' },
      });
    } catch (e: any) {
      console.log(`share skip (${id}): ${String(e?.message).slice(0, 60)}`);
    }
  }
  console.log(`pre-flight sharing done (${allIds.length} ids)`);

  // -- read current deck ----------------------------------------------------
  const before = await slides.presentations.get({ presentationId: cli.deck, fields: GET_FIELDS });
  const beforeInfo = digestSlides(before);
  if (beforeInfo.length !== oldLayouts.length) {
    throw new Error(
      `HALT: live deck has ${beforeInfo.length} slides but --old-spec declares ${oldLayouts.length}. ` +
        'The deck was edited by hand since the old spec was rendered — reconcile (update the old ' +
        'spec, or restore the deck) before re-rendering in place.',
    );
  }
  const beforeCov = coverage(beforeInfo);
  console.log(`BEFORE coverage: ${beforeCov.withImage}/${beforeCov.total}`);
  beforeCov.detail.forEach((d) => console.log('  ' + d));

  const slideIdPrefix = pickSlideIdPrefix(beforeInfo.map((s) => s.objectId));
  console.log(`new-slide id prefix: ${slideIdPrefix}`);

  // -- step 1: duplicate representative slides → stencil ids ----------------
  const repIndexByLayout = new Map<StencilKey, number>();
  oldLayouts.forEach((l, i) => { if (!repIndexByLayout.has(l)) repIndexByLayout.set(l, i); });
  const dupRequests: Record<string, unknown>[] = [];
  const realStencils: StencilKey[] = [];
  for (const key of Object.keys(STENCILS) as StencilKey[]) {
    const idx = repIndexByLayout.get(key);
    // Dummy stencils (layouts absent from BOTH specs) source = slide 0 —
    // they exist only so buildSlidesRequestsV2's delete-all-14 step has
    // an object to delete; no new slide ever duplicates them.
    const srcId = beforeInfo[idx ?? 0].objectId;
    if (idx !== undefined) realStencils.push(key);
    dupRequests.push({ duplicateObject: { objectId: srcId, objectIds: { [srcId]: STENCILS[key] } } });
  }
  await slides.presentations.batchUpdate({ presentationId: cli.deck, requestBody: { requests: dupRequests as any[] } });
  console.log(`step 1: duplicated ${dupRequests.length} stencil sources (${realStencils.length} real, ${dupRequests.length - realStencils.length} dummies)`);

  // -- step 2: strip + rebuild the real stencils -----------------------------
  const mid = await slides.presentations.get({ presentationId: cli.deck, fields: GET_FIELDS });
  const midInfo = digestSlides(mid);
  const byId = new Map(midInfo.map((s) => [s.objectId, s]));
  const rebuild: Record<string, unknown>[] = [];
  for (const key of realStencils) {
    const pageId = STENCILS[key];
    const info = byId.get(pageId);
    if (!info) throw new Error(`stencil ${pageId} missing after duplication`);
    for (const tid of info.textShapeIds) rebuild.push({ deleteObject: { objectId: tid } });
    if (STRIP_IMAGES_ON.has(key)) {
      for (const im of info.images) {
        if (im.w * im.h >= STRIP_AREA) rebuild.push({ deleteObject: { objectId: im.id } });
      }
    }
    rebuild.push(...STENCIL_TEXT_BUILDERS[key](pageId));
    if (info.notesShapeId) {
      if (info.notesHasText) {
        rebuild.push({ deleteText: { objectId: info.notesShapeId, textRange: { type: 'ALL' } } });
      }
      rebuild.push({ insertText: { objectId: info.notesShapeId, text: '{{NOTES}}', insertionIndex: 0 } });
    } else {
      console.warn(`WARN: no speakerNotesObjectId for stencil ${key}`);
    }
  }
  await slides.presentations.batchUpdate({ presentationId: cli.deck, requestBody: { requests: rebuild as any[] } });
  console.log(`step 2: stripped + rebuilt ${realStencils.length} stencils (${rebuild.length} requests)`);

  // -- step 3: stock render pipeline, new ids renamed to the safe prefix ----
  const builderReqs = buildSlidesRequestsV2(spec, { stencils: STENCILS as unknown as Record<StencilKey, string>, manifest });
  const renamed =
    slideIdPrefix === 'ace_slide_'
      ? builderReqs
      : (JSON.parse(JSON.stringify(builderReqs).replace(/ace_slide_/g, slideIdPrefix)) as Record<string, unknown>[]);
  await slides.presentations.batchUpdate({ presentationId: cli.deck, requestBody: { requests: renamed as any[] } });
  console.log(`step 3: render batch OK (${renamed.length} requests incl. ${renamed.filter((r: any) => r.createImage).length} createImage)`);

  // -- step 4: delete the old slides — ONLY after the render batch succeeded
  const delRequests = beforeInfo.map((s) => ({ deleteObject: { objectId: s.objectId } }));
  await slides.presentations.batchUpdate({ presentationId: cli.deck, requestBody: { requests: delRequests as any[] } });
  console.log(`step 4: deleted ${delRequests.length} old slides`);

  // -- verify ----------------------------------------------------------------
  const after = await slides.presentations.get({ presentationId: cli.deck, fields: GET_FIELDS });
  const afterInfo = digestSlides(after);
  const afterCov = coverage(afterInfo);

  // token-leak check on rendered slides + notes presence count
  const leftoverTokens: string[] = [];
  let notesFilled = 0;
  for (const s of (after.data.slides ?? []) as any[]) {
    for (const el of s.pageElements ?? []) {
      const txt = (el.shape?.text?.textElements ?? [])
        .map((t: any) => t.textRun?.content ?? '')
        .join('');
      if (/\{\{[A-Z_0-9]+\}\}/.test(txt)) leftoverTokens.push(`${s.objectId}/${el.objectId}`);
    }
    const notesId = s.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;
    for (const el of s.slideProperties?.notesPage?.pageElements ?? []) {
      if (el.objectId === notesId) {
        const txt = (el.shape?.text?.textElements ?? [])
          .map((t: any) => t.textRun?.content ?? '')
          .join('');
        if (txt.trim() && !/\{\{NOTES\}\}/.test(txt)) notesFilled++;
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        deck_url: `https://docs.google.com/presentation/d/${cli.deck}/edit`,
        rendered_slides: afterInfo.length,
        expected_slides: expectedSlides,
        slide_id_prefix: slideIdPrefix,
        coverage_before: `${beforeCov.withImage}/${beforeCov.total}`,
        coverage_after: `${afterCov.withImage}/${afterCov.total}`,
        image_slides_detail: afterCov.detail,
        leftover_tokens: leftoverTokens,
        notes_filled: `${notesFilled}/${afterInfo.length}`,
      },
      null,
      2,
    ),
  );
}

main().catch((e: any) => {
  console.error('RERENDER FAILED:', e?.message ?? e);
  if (e?.response?.data) console.error(JSON.stringify(e.response.data).slice(0, 2000));
  process.exit(1);
});
