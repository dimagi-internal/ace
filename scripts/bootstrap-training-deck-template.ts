/**
 * Bootstrap the ACE training-deck Slides template (v6).
 *
 * Approach: clone Dimagi canonical slides as visual BACKGROUNDS (indigo
 * full-bleed, topographic illustration, Dimagi wordmark), strip the
 * designer's text boxes, stock mockups and layout decoration, stamp ONE
 * uniform set of deck chrome, then layer OUR text boxes (sized for our
 * content) on top. We get Dimagi-recognizable branding without fighting the
 * designer's fixed-bbox text placeholders.
 *
 * Why this works vs v4.x: v4 tried to reuse designer text boxes by
 * replacing their text content with our tokens. Designer boxes were
 * sized for short lorem strings ("Sample Heading", "2.7k"); per-opp
 * content overflowed and the Slides API doesn't allow programmatic
 * autofit (`updateShapeProperties` rejects autofitType other than NONE).
 * v5 sidestepped that completely — keep designer decoration, drop designer
 * text, create new text shapes from scratch with our geometry.
 *
 * ## What v6 changes, and why (all four observed in a rendered PDF)
 *
 * Cloning fourteen DIFFERENT designer pages gets fourteen different opinions
 * about the deck's own furniture, and the reader sees that as one deck that
 * cannot make up its mind:
 *
 *  - **Chrome.** Two different logo marks appeared across one deck, the
 *    left accent bar was amber on some slides and periwinkle on others, and
 *    `stats` + `checklist` had NO bar, NO rule and NO mark because the v5.8
 *    layout mask painted over them. Now: inherited chrome is found by
 *    position (`classifyChrome`), stripped from every body stencil, and
 *    redrawn identically from `CHROME` — after the mask, not before.
 *  - **Dividers.** `section` cloned a light-periwinkle page and drew white
 *    38pt text on it (~2.3:1 — fails WCAG AA at any size, washes out on a
 *    projector) and inherited a stray white rectangle at the left edge. It
 *    now clones the COVER page, so the white title is correct rather than
 *    merely intended. Enforced by `lib/slide-contrast.ts`.
 *  - **Timeline decoration.** ACE renders a timeline as a text list
 *    (ace#1503), so the source page's four node dots, four connectors and
 *    two amber segment bars — one running off the right edge — illustrated
 *    nothing and read as a rendering error. Stripped.
 *  - **Dead space.** Body text hung from the top of a full-height box,
 *    filling ~60% of the canvas. Bodies are now vertically centred
 *    (`contentAlignment: MIDDLE`) at 16pt rather than 14pt.
 *
 * The source-page map, the strip/mask sets and the chrome geometry all live
 * in `lib/training-deck-stencil-geometry.ts` beside the text-box builders
 * they have to agree with — see `STENCIL_SOURCES`.
 *
 * Usage:
 *   npx tsx scripts/bootstrap-training-deck-template.ts
 *
 * Output: prints the new template's presentationId. Update 1Password
 * "ACE - Drive Templates" → training_deck_template_id and the local
 * .env via op inject.
 */

import { google } from '../lib/google-shim.js';
import { STENCILS, type StencilKey } from '../lib/training-deck-spec.js';
import { loadPluginEnv } from '../lib/load-plugin-env.js';
// Slide dimensions + brand palette + all 14 per-stencil text-box builders
// live in lib/training-deck-stencil-geometry.ts — the single source of
// stencil text-box geometry (shared with the in-place re-render script
// and the mobile_flow caption logic in lib/training-deck-spec.ts).
import {
  STENCIL_TEXT_BUILDERS,
  STENCIL_SOURCES,
  UNIFORM_CHROME_ON,
  MASK_LAYOUT_ON,
  STRIP_DEC_SHAPES_ON,
  STRIP_IMAGES_ON,
  STRIP_LINES_ON,
  classifyChrome,
  chromeRequests,
  chromeLogoRequest,
  layoutMaskRequests,
  decorativeLeftoverIds,
} from '../lib/training-deck-stencil-geometry.js';

// ---------------------------------------------------------------------------
// Source: Dimagi canonical template
// ---------------------------------------------------------------------------

const DIMAGI_SOURCE_ID = '1NAkbjPjDZSx_Qw8legfuRUk8eTBqO4dn1H2XOqAM1Hc';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// ace#1964 — a script reached from a Bash tool call inherits NONE of ACE's
// secrets, so it has to load `<plugin-data>/.env` itself. Module top, before
// any credential read: ESM runs this body top-down, so "before main()" is
// already too late for a read at module level.
//
// This replaces a hand-rolled `loadEnvFile` that ran inside `main()` and
// hardcoded `$HOME/.claude/plugins/data/ace-ace/.env`, ignoring an explicit
// `CLAUDE_PLUGIN_DATA`. `KEY_FILE` below reads at module level, which the old
// placement could never have covered.
const PLUGIN_ENV = loadPluginEnv(import.meta.url);

const KEY_FILE =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ??
  `${process.env.HOME}/.claude/plugins/data/ace-ace/gws-sa-key.json`;

const TEMPLATE_NAME = 'ACE Training Deck Template (v6.1 — uniform chrome, dark dividers, centred bodies)';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findExistingTemplate(
  drive: ReturnType<typeof google.drive>,
  parentId: string,
  name: string,
): Promise<{ id: string; webViewLink: string } | null> {
  const resp = await drive.files.list({
    q: `'${parentId}' in parents and name='${name.replace(/'/g, "\\'")}' and trashed=false`,
    fields: 'files(id, name, webViewLink)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    pageSize: 1,
  });
  const f = resp.data.files?.[0];
  if (!f?.id) return null;
  return { id: f.id, webViewLink: f.webViewLink ?? '' };
}

async function batchUpdate(
  slides: ReturnType<typeof google.slides>,
  presentationId: string,
  requests: Record<string, unknown>[],
  label: string,
): Promise<void> {
  const BATCH_SIZE = 100;
  for (let start = 0; start < requests.length; start += BATCH_SIZE) {
    const batch = requests.slice(start, start + BATCH_SIZE);
    const batchNum = Math.floor(start / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(requests.length / BATCH_SIZE);
    console.log(`    ${label} batch ${batchNum}/${totalBatches} (${batch.length} requests)`);
    await slides.presentations.batchUpdate({
      presentationId,
      requestBody: { requests: batch },
    });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!process.env.ACE_DRIVE_ROOT_FOLDER_ID) {
    throw new Error(
      `ACE_DRIVE_ROOT_FOLDER_ID is required — not in the shell env and not in ` +
        `${PLUGIN_ENV.path}. Run /ace:setup --force-env.`,
    );
  }
  const parentFolderId = process.env.ACE_DRIVE_ROOT_FOLDER_ID;

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/presentations',
    ],
  });
  const slides = google.slides({ version: 'v1', auth });
  const drive = google.drive({ version: 'v3', auth });

  const existing = await findExistingTemplate(drive, parentFolderId, TEMPLATE_NAME);
  if (existing) {
    console.log(`Template already exists: ${existing.id}`);
    console.log(`  ${existing.webViewLink}`);
    return;
  }

  // ---------------------------------------------------------------------------
  // Step 1: Copy the Dimagi canonical master to a new file in the parent folder
  // ---------------------------------------------------------------------------
  console.log(`Step 1: drive.files.copy(${DIMAGI_SOURCE_ID}) → "${TEMPLATE_NAME}"`);
  const copied = await drive.files.copy({
    fileId: DIMAGI_SOURCE_ID,
    requestBody: { name: TEMPLATE_NAME, parents: [parentFolderId] },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });
  const presentationId = copied.data.id!;
  const webViewLink = copied.data.webViewLink!;
  console.log(`  presentationId=${presentationId}`);

  // ---------------------------------------------------------------------------
  // Step 2: Duplicate 14 chosen source slides with our objectIds
  // ---------------------------------------------------------------------------
  console.log('Step 2: duplicate 14 Dimagi source slides as ace_stencil_<key>');
  const stencilKeys = Object.keys(STENCIL_SOURCES) as StencilKey[];
  const duplicateRequests: Record<string, unknown>[] = stencilKeys.map((key) => ({
    duplicateObject: {
      objectId: STENCIL_SOURCES[key].sourcePageId,
      objectIds: { [STENCIL_SOURCES[key].sourcePageId]: STENCILS[key] },
    },
  }));
  await batchUpdate(slides, presentationId, duplicateRequests, 'duplicate');

  // ---------------------------------------------------------------------------
  // Step 3: Enumerate what each duplicated stencil has to lose
  // ---------------------------------------------------------------------------
  // Designer text boxes (sized for short lorem strings) always go — we
  // re-create our own. Mockup images, connector lines, layout decoration and
  // the inherited CHROME go per the sets declared in the geometry module. The
  // duplicates' element objectIds are auto-generated by Slides, so everything
  // is discovered here rather than hardcoded.
  //
  // Image stripping is heuristic by size: any image larger than 1.5in² (below
  // the ~2-3in mockup screens, above ~0.5in watermarks / logos / social icons)
  // gets stripped. The per-opp createImage at render time places the actual
  // content image in the intended slot.
  console.log('Step 3: enumerate designer text, mockups, decoration and inherited chrome');
  const pagesResp = await slides.presentations.get({
    presentationId,
    fields:
      'slides(objectId,slideProperties(notesPage(notesProperties(speakerNotesObjectId))),pageElements(objectId,size,transform,shape(shapeType,text,shapeProperties),image,line))',
  });
  const stencilSet = new Set<string>(Object.values(STENCILS));
  /** One de-duplicated delete set per stencil page — a deleteObject issued
   * twice for the same element fails the whole batch. */
  const deleteIdsByPageId = new Map<string, Set<string>>();
  const notesIdByPageId = new Map<string, string>();

  const pageIdToStencilKey = new Map<string, StencilKey>();
  for (const key of Object.keys(STENCILS) as StencilKey[]) {
    pageIdToStencilKey.set(STENCILS[key], key);
  }

  // Image-size threshold: 1.5in² for the body stencils (walkthrough et al).
  // Closing uses a smaller 0.25in² threshold so its headshot circle
  // (~0.5in²) is stripped too.
  const STRIP_THRESHOLD_EMU_SQ = 2_058_675 * 2_058_675;
  const STRIP_THRESHOLD_EMU_SQ_CLOSING = 457_200 * 457_200;

  // The corner mark ACE stamps on every body stencil. Harvested from the
  // canonical `content` SOURCE page — which survives until step 5 — rather
  // than from a duplicate this same batch is about to delete. Observing the
  // mark the deck already uses beats guessing at a hosted Dimagi asset URL,
  // and the Slides API accepts a `contentUrl` in createImage (verified
  // 2026-09-07 against a scratch presentation).
  let chromeLogoUrl = '';
  const logoSourcePageId = STENCIL_SOURCES.content.sourcePageId;

  for (const s2 of pagesResp.data.slides ?? []) {
    const id = s2.objectId;
    if (!id) continue;

    if (id === logoSourcePageId && !chromeLogoUrl) {
      for (const el of s2.pageElements ?? []) {
        if (classifyChrome(el) === 'corner_logo') {
          chromeLogoUrl = el.image?.contentUrl ?? '';
          break;
        }
      }
    }

    if (!stencilSet.has(id)) continue;
    const notesId = s2.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;
    if (notesId) notesIdByPageId.set(id, notesId);

    const stencilKey = pageIdToStencilKey.get(id);
    if (!stencilKey) continue;
    const stripImagesHere = STRIP_IMAGES_ON.has(stencilKey);
    const stripLinesHere = STRIP_LINES_ON.has(stencilKey);
    const stripDecShapesHere = STRIP_DEC_SHAPES_ON.has(stencilKey);
    const uniformChromeHere = UNIFORM_CHROME_ON.has(stencilKey);

    const elements = s2.pageElements ?? [];
    const doomed = new Set<string>();
    for (const el of elements) {
      if (!el.objectId) continue;
      // Text-bearing shapes: always (we re-create our own).
      if (el.shape?.text) { doomed.add(el.objectId); continue; }
      // Inherited chrome — replaced wholesale by one uniform treatment.
      if (uniformChromeHere && classifyChrome(el)) { doomed.add(el.objectId); continue; }
      // Large designer mockup images.
      if (stripImagesHere && el.image && el.size && el.transform) {
        const w = (el.size.width?.magnitude ?? 0) * (el.transform.scaleX ?? 1);
        const h = (el.size.height?.magnitude ?? 0) * (el.transform.scaleY ?? 1);
        const threshold = stencilKey === 'closing'
          ? STRIP_THRESHOLD_EMU_SQ_CLOSING
          : STRIP_THRESHOLD_EMU_SQ;
        if (Math.abs(w * h) >= threshold) { doomed.add(el.objectId); continue; }
      }
      // Connector/annotation lines: mockup callout leaders whose mockups are
      // gone, and the timeline's connectors to nodes that are also going.
      if (stripLinesHere && el.line) { doomed.add(el.objectId); continue; }
      // Every non-TEXT_BOX shape on the decoration-only stencils.
      if (stripDecShapesHere && el.shape) {
        const shapeType = el.shape.shapeType;
        if (shapeType && shapeType !== 'TEXT_BOX') { doomed.add(el.objectId); continue; }
      }
    }

    // Generic sweep, SECOND pass: tiny decorative clone-leftovers (the 6x6pt
    // Dimagi walkthrough ellipse class). `isDecorativeLeftover` spares an
    // ellipse whose slide also holds a LINE, on the theory that it is a
    // functional diagram node — so the siblings it is shown must be the ones
    // that SURVIVE this strip, not the ones we started with. Shown the raw
    // list, the walkthrough page's own callout leader (itself queued for
    // deletion two rules up) vouched for the stray dot, and mobile_zoom
    // shipped with a floating blue dot beside its title — observed in the
    // v6.0 mint's own render before this pass existed.
    for (const leftoverId of decorativeLeftoverIds(elements, doomed)) doomed.add(leftoverId);
    deleteIdsByPageId.set(id, doomed);
  }

  if (!chromeLogoUrl) {
    console.warn(
      `  WARN: no corner mark found on the canonical source page ${logoSourcePageId} — ` +
        'stencils will get the bar + rule but no logo.',
    );
  }

  // ---------------------------------------------------------------------------
  // Step 4: Per stencil — strip, mask, stamp uniform chrome, layer text
  // ---------------------------------------------------------------------------
  //
  // Order is load-bearing. Slides z-orders by creation, so:
  //   1. deletes      — everything the clone brought that we are replacing
  //   2. layout mask  — a full-slide white rectangle over layout-level panels
  //                     a page-level strip cannot reach (stats, checklist)
  //   3. chrome       — bar, rule, mark. AFTER the mask: v5.8 drew the mask
  //                     last-but-one and it painted over the inherited chrome,
  //                     which is why those two slides shipped bare.
  //   4. text boxes   — on top of both.
  console.log('Step 4: strip, mask, stamp uniform chrome, layer text boxes + {{NOTES}}');
  const layerRequests: Record<string, unknown>[] = [];
  for (const key of stencilKeys) {
    const pageId = STENCILS[key];
    const builder = STENCIL_TEXT_BUILDERS[key];

    for (const objectId of deleteIdsByPageId.get(pageId) ?? []) {
      layerRequests.push({ deleteObject: { objectId } });
    }
    if (MASK_LAYOUT_ON.has(key)) {
      layerRequests.push(...layoutMaskRequests(pageId));
    }
    if (UNIFORM_CHROME_ON.has(key)) {
      layerRequests.push(...chromeRequests(pageId));
      if (chromeLogoUrl) layerRequests.push(chromeLogoRequest(pageId, chromeLogoUrl));
    }
    layerRequests.push(...builder(pageId));

    // Inject {{NOTES}} placeholder into the notes page.
    const notesId = notesIdByPageId.get(pageId);
    if (notesId) {
      layerRequests.push({
        insertText: { objectId: notesId, text: '{{NOTES}}', insertionIndex: 0 },
      });
    } else {
      console.warn(`  WARN: no speakerNotesObjectId for ${key} (${pageId})`);
    }
  }
  await batchUpdate(slides, presentationId, layerRequests, 'layer');

  // ---------------------------------------------------------------------------
  // Step 5: Delete all original Dimagi slides (keep only the 14 stencils)
  // ---------------------------------------------------------------------------
  console.log('Step 5: delete original Dimagi slides (keep 14 stencils)');
  const allPages = await slides.presentations.get({
    presentationId,
    fields: 'slides(objectId)',
  });
  const stencilIds = new Set<string>(Object.values(STENCILS));
  const deleteRequests: Record<string, unknown>[] = [];
  for (const s of allPages.data.slides ?? []) {
    const id = s.objectId;
    if (id && !stencilIds.has(id)) {
      deleteRequests.push({ deleteObject: { objectId: id } });
    }
  }
  console.log(`  deleting ${deleteRequests.length} non-stencil slides`);
  await batchUpdate(slides, presentationId, deleteRequests, 'delete');

  // ---------------------------------------------------------------------------
  // Step 6: Reorder stencils into canonical sequence
  // ---------------------------------------------------------------------------
  console.log('Step 6: reorder stencils into canonical sequence');
  const orderRequests: Record<string, unknown>[] = stencilKeys.map((key, i) => ({
    updateSlidesPosition: {
      slideObjectIds: [STENCILS[key]],
      insertionIndex: i,
    },
  }));
  await batchUpdate(slides, presentationId, orderRequests, 'reorder');

  // ---------------------------------------------------------------------------
  // Done
  // ---------------------------------------------------------------------------
  console.log('\nTemplate created:');
  console.log(`  ${webViewLink}`);
  console.log(`  presentationId=${presentationId}`);
  console.log('\nUpdate 1Password "ACE - Drive Templates" → training_deck_template_id:');
  console.log(`  ${presentationId}`);
}

main().catch((e: { message: string; response?: { data?: unknown } }) => {
  console.error('FAILED:', e.message);
  if (e.response?.data) console.error('  response:', JSON.stringify(e.response.data, null, 2));
  process.exit(1);
});
