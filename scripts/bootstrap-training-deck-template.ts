/**
 * Bootstrap the ACE training-deck Slides template (v5).
 *
 * Approach: clone Dimagi canonical slides as visual BACKGROUNDS (indigo
 * full-bleed, topographic illustration, amber accent strips, Dimagi
 * wordmark + O logo, thin red right edge), then strip the designer's
 * text boxes and stock mockup images, then layer OUR text boxes (sized
 * for our content) on top. We get Dimagi-recognizable branding without
 * fighting the designer's fixed-bbox text placeholders.
 *
 * Why this works vs v4.x: v4 tried to reuse designer text boxes by
 * replacing their text content with our tokens. Designer boxes were
 * sized for short lorem strings ("Sample Heading", "2.7k"); per-opp
 * content overflowed and the Slides API doesn't allow programmatic
 * autofit (`updateShapeProperties` rejects autofitType other than NONE).
 * v5 sidesteps that completely — keeps designer decoration, drops
 * designer text, creates new text shapes from scratch with our
 * geometry (carried over from v3.4 where it proved publishable).
 *
 * Stencil → Dimagi source slide mappings (surveyed 2026-05-25):
 *   cover        ← page 3   "Sample Heading / Subheading"   (dark indigo bg)
 *   section      ← page 6   "Basic Layouts" divider          (light indigo bg)
 *   agenda       ← page 5   "Table of contents"              (white bg)
 *   content      ← page 10  "Bulleted Plaintext with Image"  (white bg)
 *   walkthrough  ← page 46  "Solo Mobile UI mockup"          (white bg)
 *   mobile_flow  ← page 47  "Three mobile mockups"           (white bg)
 *   web_screen   ← page 48  "Solo Web Mockup"                (white bg)
 *   mobile_zoom  ← page 46  (clone of walkthrough)
 *   two_column   ← page 11  "Comparison"                     (white bg)
 *   stats        ← page 34  "Stat+Description Combo"         (white bg)
 *   timeline     ← page 36  "Horizontal Timeline Basic"      (white bg)
 *   checklist    ← page 29  "5 numbered callouts"            (white bg)
 *   exercise     ← page 25  "Boxed Headers"                  (white bg)
 *   closing      ← page 71  "Thank You"                      (white bg + topographic)
 *
 * Usage:
 *   npx tsx scripts/bootstrap-training-deck-template.ts
 *
 * Output: prints the new template's presentationId. Update 1Password
 * "ACE - Drive Templates" → training_deck_template_id and the local
 * .env via op inject.
 */

import { google } from '../lib/google-shim.js';
import * as fs from 'node:fs';
import { STENCILS, type StencilKey } from '../lib/training-deck-spec.js';
// Slide dimensions + brand palette + all 14 per-stencil text-box builders
// live in lib/training-deck-stencil-geometry.ts — the single source of
// stencil text-box geometry (shared with the in-place re-render script
// and the mobile_flow caption logic in lib/training-deck-spec.ts).
import {
  SLIDE_W,
  SLIDE_H,
  STENCIL_TEXT_BUILDERS,
} from '../lib/training-deck-stencil-geometry.js';

// ---------------------------------------------------------------------------
// Source: Dimagi canonical template
// ---------------------------------------------------------------------------

const DIMAGI_SOURCE_ID = '1NAkbjPjDZSx_Qw8legfuRUk8eTBqO4dn1H2XOqAM1Hc';

// ---------------------------------------------------------------------------
// Per-stencil clone config
// ---------------------------------------------------------------------------
//
// sourcePageId: the Dimagi page we duplicate for its visual background +
// decoration (no text reused — text boxes get deleted and recreated).
//
// stripImageIds: mockup placeholder images to delete (stock phone/web
// screenshots that render's createImage will replace per-opp).
//
// onDarkBackground: true if the source slide has a dark fill (cover) so
// we emit white text instead of indigo. section uses light-indigo
// background but white text reads well there too.

interface StencilConfig {
  sourcePageId: string;
  stripImageIds: string[];
  onDarkBackground?: boolean;
  /**
   * Set to true if this stencil reuses another stencil's source page.
   * The first stencil to mention the source page gets the slide; later
   * stencils sharing the same source duplicate the SAME source again
   * (Slides allows multiple duplicates of one source). Used for
   * mobile_zoom which clones the walkthrough source.
   */
  sourceIsShared?: boolean;
}

const STENCIL_CONFIGS: Record<StencilKey, StencilConfig> = {
  cover: {
    sourcePageId: 'g15b43284eab_0_101',
    stripImageIds: [],
    onDarkBackground: true,
  },
  section: {
    sourcePageId: 'g16117138c42_0_14',
    stripImageIds: [],
    onDarkBackground: true, // light-indigo bg; white text reads better
  },
  agenda: {
    sourcePageId: 'g16117138c42_0_41',
    stripImageIds: [],
  },
  content: {
    sourcePageId: 'g16117138c42_0_31',
    stripImageIds: ['g16117138c42_0_40'], // stock photo
  },
  walkthrough: {
    sourcePageId: 'g157d905314c_0_17',
    stripImageIds: ['g157d905314c_0_29', 'g2a7f28d47a6_0_10'],
  },
  mobile_flow: {
    sourcePageId: 'g157c2e0650a_0_10',
    stripImageIds: [
      'g2a7f28d47a6_0_12', 'g2a7f28d47a6_0_13',
      'g2a7f28d47a6_0_14', 'g2a7f28d47a6_0_15',
      'g2a7f28d47a6_0_16', 'g2a7f28d47a6_0_17',
    ],
  },
  web_screen: {
    sourcePageId: 'g157d905314c_0_41',
    stripImageIds: ['g157d905314c_0_62', 'g180c769904c_1_1'],
  },
  mobile_zoom: {
    sourcePageId: 'g157d905314c_0_17',
    sourceIsShared: true,
    stripImageIds: ['g157d905314c_0_29', 'g2a7f28d47a6_0_10'],
  },
  two_column: {
    sourcePageId: 'g1b29c53f2a5_6_0',
    stripImageIds: [],
  },
  stats: {
    sourcePageId: 'g1582f059303_0_125',
    stripImageIds: [],
  },
  timeline: {
    sourcePageId: 'g19718957c31_0_0',
    stripImageIds: [],
  },
  checklist: {
    sourcePageId: 'g1582f059303_0_110',
    stripImageIds: [],
  },
  exercise: {
    sourcePageId: 'g19d7c017c36_0_773',
    stripImageIds: [],
  },
  closing: {
    sourcePageId: 'g157d905314c_0_85',
    stripImageIds: ['g157d905314c_0_99'], // stock headshot
  },
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const KEY_FILE =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ??
  `${process.env.HOME}/.claude/plugins/data/ace-ace/gws-sa-key.json`;

const TEMPLATE_NAME = 'ACE Training Deck Template (v5.8 — mask layout panels with white rect)';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadEnvFile(envPath: string): void {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

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
  loadEnvFile(`${process.env.HOME}/.claude/plugins/data/ace-ace/.env`);

  if (!process.env.ACE_DRIVE_ROOT_FOLDER_ID) {
    throw new Error('ACE_DRIVE_ROOT_FOLDER_ID is required (set via .env or shell env)');
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
  const stencilKeys = Object.keys(STENCIL_CONFIGS) as StencilKey[];
  const duplicateRequests: Record<string, unknown>[] = stencilKeys.map((key) => ({
    duplicateObject: {
      objectId: STENCIL_CONFIGS[key].sourcePageId,
      objectIds: { [STENCIL_CONFIGS[key].sourcePageId]: STENCILS[key] },
    },
  }));
  await batchUpdate(slides, presentationId, duplicateRequests, 'duplicate');

  // ---------------------------------------------------------------------------
  // Step 3: Enumerate text shape IDs + large image IDs on each duplicated stencil
  // ---------------------------------------------------------------------------
  // We need this to delete the designer text boxes (sized for short lorem
  // strings) before we add our own. The duplicates' element objectIds are
  // auto-generated by Slides, so we discover them via slides_get.
  //
  // Image stripping is heuristic by size: any image larger than 1.5in²
  // (the threshold below ~2-3in mockup screens but above ~0.5in
  // watermarks / O-logos / social icons / decorative dots) gets stripped.
  // The per-opp createImage at render time will place the actual content
  // image in the intended slot.
  console.log('Step 3: enumerate text shapes + large images + lines + dec shapes on each duplicated stencil');
  const pagesResp = await slides.presentations.get({
    presentationId,
    fields:
      'slides(objectId,slideProperties(notesPage(notesProperties(speakerNotesObjectId))),pageElements(objectId,size,transform,shape(shapeType,text,shapeProperties),image,line))',
  });
  const stencilSet = new Set<string>(Object.values(STENCILS));
  const textShapeIdsByPageId = new Map<string, string[]>();
  const imageIdsToStripByPageId = new Map<string, string[]>();
  const lineIdsToStripByPageId = new Map<string, string[]>();
  const decShapeIdsToStripByPageId = new Map<string, string[]>();
  const notesIdByPageId = new Map<string, string>();

  // v5.5: strip floating decoration on stencils where the Dimagi designer
  // intended a specific bullet/panel layout that our text-box geometry
  // doesn't match. Specifically:
  // - checklist: 5 amber ellipse dots + a light-grey background panel
  //   that designer intended to sit BEHIND a list, but our text-box
  //   renders at MARGIN x so the dots float in empty space.
  // - stats: a half-grey `#fafafa` rectangle behind column 3.
  // Rule: on these stencils, strip every non-placeholder RECTANGLE and
  // ELLIPSE shape.
  const STRIP_DEC_SHAPES_ON: Set<StencilKey> = new Set([
    'checklist', 'stats',
  ]);

  // Stencils that strip designer mockup images:
  // - walkthrough / mobile_flow / web_screen / mobile_zoom: phone/web
  //   mockup screenshots (1.5in² threshold)
  // - content: v5.4 — the Dimagi content_v2 source has a 3.7×5.6in
  //   stock photo on the right that overlays body text.
  // - closing: smaller 0.25in² threshold catches the Dimagi headshot
  //   circle (~0.5in²) which otherwise survives.
  const STRIP_IMAGES_ON: Set<StencilKey> = new Set([
    'walkthrough', 'mobile_flow', 'web_screen', 'mobile_zoom', 'content', 'closing',
  ]);
  const pageIdToStencilKey = new Map<string, StencilKey>();
  for (const key of Object.keys(STENCILS) as StencilKey[]) {
    pageIdToStencilKey.set(STENCILS[key], key);
  }

  // Image-size threshold: 1.5in² (= 2,058,675² EMU) for the body
  // stencils (walkthrough et al). Closing uses a smaller 0.25in²
  // threshold (= 457,200² EMU) so the headshot circle gets stripped too.
  const STRIP_THRESHOLD_EMU_SQ = 2_058_675 * 2_058_675;
  const STRIP_THRESHOLD_EMU_SQ_CLOSING = 457_200 * 457_200;

  for (const s of pagesResp.data.slides ?? []) {
    const id = s.objectId;
    if (!id || !stencilSet.has(id)) continue;
    const notesId = s.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;
    if (notesId) notesIdByPageId.set(id, notesId);

    const stencilKey = pageIdToStencilKey.get(id);
    const stripImagesHere = stencilKey ? STRIP_IMAGES_ON.has(stencilKey) : false;
    const stripDecShapesHere = stencilKey ? STRIP_DEC_SHAPES_ON.has(stencilKey) : false;

    const textIds: string[] = [];
    const imageIds: string[] = [];
    const lineIds: string[] = [];
    const decShapeIds: string[] = [];
    for (const el of s.pageElements ?? []) {
      // Text-bearing shapes: always delete (we re-create our own).
      if (el.shape?.text && el.objectId) {
        textIds.push(el.objectId);
        continue;
      }
      // Large images on image-bearing stencils: strip.
      if (stripImagesHere && el.image && el.objectId && el.size && el.transform) {
        const w = (el.size.width?.magnitude ?? 0) * (el.transform.scaleX ?? 1);
        const h = (el.size.height?.magnitude ?? 0) * (el.transform.scaleY ?? 1);
        const threshold = stencilKey === 'closing'
          ? STRIP_THRESHOLD_EMU_SQ_CLOSING
          : STRIP_THRESHOLD_EMU_SQ;
        if (w * h >= threshold) imageIds.push(el.objectId);
      }
      // Line/connector elements (thin diagonal annotations the designer
      // uses to link mockup callouts) — strip from image-bearing stencils
      // since we removed the mockups they were annotating. Lines have
      // negligible bounding-box area so they escaped the image filter.
      // Lines on cover/section/closing are decorative (Dimagi-specific)
      // — preserved by gating on stripImagesHere.
      if (stripImagesHere && el.line && el.objectId) {
        lineIds.push(el.objectId);
      }
      // v5.6: strip ALL non-TEXT_BOX shape types on checklist + stats
      // stencils. v5.5 only stripped RECTANGLE + ELLIPSE, but the stats
      // slide's indigo background panel behind column 3 is a FREEFORM
      // shape and survived. Bednet v5.5 render had this panel making
      // column 3's label illegible. v5.6 nukes everything decorative
      // by stripping any shape with shapeType !== 'TEXT_BOX'.
      if (stripDecShapesHere && el.shape && el.objectId) {
        const shapeType = el.shape.shapeType;
        if (shapeType && shapeType !== 'TEXT_BOX') {
          decShapeIds.push(el.objectId);
        }
      }
    }
    textShapeIdsByPageId.set(id, textIds);
    imageIdsToStripByPageId.set(id, imageIds);
    lineIdsToStripByPageId.set(id, lineIds);
    decShapeIdsToStripByPageId.set(id, decShapeIds);
  }

  // ---------------------------------------------------------------------------
  // Step 4: Per stencil — delete designer text + stock images, emit our
  //         text boxes, inject {{NOTES}}
  // ---------------------------------------------------------------------------
  console.log('Step 4: strip designer text + stock images, layer our text boxes + {{NOTES}}');
  const layerRequests: Record<string, unknown>[] = [];
  for (const key of stencilKeys) {
    const config = STENCIL_CONFIGS[key];
    const pageId = STENCILS[key];
    const builder = STENCIL_TEXT_BUILDERS[key];

    // Delete designer text shapes.
    const textShapes = textShapeIdsByPageId.get(pageId) ?? [];
    for (const objectId of textShapes) {
      layerRequests.push({ deleteObject: { objectId } });
    }

    // Delete stock mockup images (discovered by size at step 3).
    const imagesToStrip = imageIdsToStripByPageId.get(pageId) ?? [];
    for (const objectId of imagesToStrip) {
      layerRequests.push({ deleteObject: { objectId } });
    }
    // Delete connector/line annotations on image-bearing stencils.
    const linesToStrip = lineIdsToStripByPageId.get(pageId) ?? [];
    for (const objectId of linesToStrip) {
      layerRequests.push({ deleteObject: { objectId } });
    }
    // v5.5: Delete floating decoration shapes (rectangles + ellipses)
    // on checklist + stats stencils.
    const decShapesToStrip = decShapeIdsToStripByPageId.get(pageId) ?? [];
    for (const objectId of decShapesToStrip) {
      layerRequests.push({ deleteObject: { objectId } });
    }
    void config.stripImageIds; // legacy field on config — discovery replaces it

    // v5.8: layer a full-slide white rectangle BEFORE our text boxes
    // on checklist + stats stencils. The Slides layout (p9 etc) has
    // indigo/grey panels as layout-level pageElements that paint OVER
    // the page background fill, so v5.7's pageBackgroundFill override
    // was invisible. A page-element rectangle paints on TOP of layout
    // elements, masking them. Our text boxes that follow then paint
    // on TOP of the white mask. Net: clean white slide.
    // MUST come BEFORE the builder() call below so z-order puts text
    // on top of the mask, not the other way around.
    if (STRIP_DEC_SHAPES_ON.has(key)) {
      const maskId = `${pageId}_layout_mask`;
      layerRequests.push(
        {
          createShape: {
            objectId: maskId,
            shapeType: 'RECTANGLE',
            elementProperties: {
              pageObjectId: pageId,
              size: {
                width: { magnitude: SLIDE_W, unit: 'EMU' },
                height: { magnitude: SLIDE_H, unit: 'EMU' },
              },
              transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, unit: 'EMU' },
            },
          },
        },
        {
          updateShapeProperties: {
            objectId: maskId,
            shapeProperties: {
              shapeBackgroundFill: {
                solidFill: { color: { rgbColor: { red: 1, green: 1, blue: 1 } } },
              },
              outline: { propertyState: 'NOT_RENDERED' },
            },
            fields: 'shapeBackgroundFill.solidFill.color,outline.propertyState',
          },
        },
      );
    }

    // Layer OUR text boxes (on top of the v5.8 mask if it was pushed).
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
