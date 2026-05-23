/**
 * Bootstrap the ACE training-deck Slides template (v2).
 *
 * One-time setup: creates a Google Slides template deck with 14
 * stencil slides (one per layout variant) that the `training-deck-build`
 * skill duplicates and fills via placeholder substitution.
 *
 * All 14 stencils get well-known objectIds from `STENCILS` in
 * `lib/training-deck-spec.ts`. They survive `drive.files.copy`
 * (Slides preserves objectIds on copy unless they collide).
 *
 * Branding: Dimagi brand — Work Sans, Indigo/Amber/White/Gray palette.
 *
 * Iterating the template: edit the file in Slides directly. Do NOT
 * change the stencil objectIds or the {{...}} placeholder tokens —
 * both are wired to `lib/training-deck-spec.ts` constants. Branding
 * (fonts, colors, logo, theme), layout positions, background images,
 * and speaker-notes formatting are all template-level concerns and
 * can change freely.
 *
 * Usage (after enabling Slides API on the connect-labs GCP project):
 *
 *   npx tsx scripts/bootstrap-training-deck-template.ts
 *
 * Idempotent: re-running against an already-existing template with the
 * same name prints the existing ID without re-creating.
 *
 * Output: prints the template's presentationId. Add to `.env.tpl` and
 * `.env` as `ACE_TRAINING_DECK_TEMPLATE_ID`.
 */

import { google } from '../lib/google-shim.js';
import * as fs from 'node:fs';
import { STENCILS } from '../lib/training-deck-spec.js';

// ---------------------------------------------------------------------------
// Dimagi branding constants
// ---------------------------------------------------------------------------

const FONT_FAMILY = 'Work Sans';
const COLOR_INDIGO = { red: 0.09, green: 0, blue: 0.42 };     // #16006D approx
const COLOR_AMBER = { red: 0.99, green: 0.68, blue: 0.19 };   // #FDAE31 approx
const COLOR_WHITE = { red: 1, green: 1, blue: 1 };
const COLOR_GRAY = { red: 0.37, green: 0.42, blue: 0.49 };    // #5F6A7D

// ---------------------------------------------------------------------------
// Slide dimensions (EMU)
// ---------------------------------------------------------------------------

const SLIDE_W = 9_144_000;  // 10"
const SLIDE_H = 5_143_500;  // 5.625"
const MARGIN = 457_200;     // 0.5"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const KEY_FILE =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ??
  `${process.env.HOME}/.claude/plugins/data/ace-ace/gws-sa-key.json`;

const TEMPLATE_NAME = 'ACE Training Deck Template (v2)';
const PARENT_FOLDER_ID = process.env.ACE_DRIVE_ROOT_FOLDER_ID;

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
    q: `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.presentation' and trashed=false`,
    fields: 'files(id, name, webViewLink)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const file = resp.data.files?.[0];
  if (!file?.id || !file.webViewLink) return null;
  return { id: file.id, webViewLink: file.webViewLink };
}

// ---------------------------------------------------------------------------
// Shape builder helpers — cut down boilerplate for 14 stencils × N shapes each
// ---------------------------------------------------------------------------

type RgbColor = { red: number; green: number; blue: number };

interface TextBox {
  id: string;
  pageId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fontSize: number;
  bold?: boolean;
  fontWeight?: number;
  color?: RgbColor;
}

function textBoxRequests(tb: TextBox): Record<string, unknown>[] {
  const reqs: Record<string, unknown>[] = [
    {
      createShape: {
        objectId: tb.id,
        shapeType: 'TEXT_BOX',
        elementProperties: {
          pageObjectId: tb.pageId,
          size: {
            height: { magnitude: tb.h, unit: 'EMU' },
            width: { magnitude: tb.w, unit: 'EMU' },
          },
          transform: {
            scaleX: 1,
            scaleY: 1,
            translateX: tb.x,
            translateY: tb.y,
            unit: 'EMU',
          },
        },
      },
    },
    {
      insertText: {
        objectId: tb.id,
        text: tb.text,
        insertionIndex: 0,
      },
    },
  ];

  // Build text style
  const style: Record<string, unknown> = {
    fontSize: { magnitude: tb.fontSize, unit: 'PT' },
    fontFamily: FONT_FAMILY,
  };
  const fields = ['fontSize', 'fontFamily'];

  if (tb.bold) {
    style.bold = true;
    fields.push('bold');
  }
  if (tb.fontWeight) {
    style.weightedFontFamily = { fontFamily: FONT_FAMILY, weight: tb.fontWeight };
    fields.push('weightedFontFamily');
  }
  if (tb.color) {
    style.foregroundColor = { opaqueColor: { rgbColor: tb.color } };
    fields.push('foregroundColor');
  }

  reqs.push({
    updateTextStyle: {
      objectId: tb.id,
      textRange: { type: 'ALL' },
      style,
      fields: fields.join(','),
    },
  });

  return reqs;
}

function accentBarRequests(
  id: string,
  pageId: string,
  x: number,
  y: number,
  w: number,
  h: number,
  color: RgbColor,
): Record<string, unknown>[] {
  return [
    {
      createShape: {
        objectId: id,
        shapeType: 'RECTANGLE',
        elementProperties: {
          pageObjectId: pageId,
          size: {
            height: { magnitude: h, unit: 'EMU' },
            width: { magnitude: w, unit: 'EMU' },
          },
          transform: {
            scaleX: 1,
            scaleY: 1,
            translateX: x,
            translateY: y,
            unit: 'EMU',
          },
        },
      },
    },
    {
      updateShapeProperties: {
        objectId: id,
        shapeProperties: {
          shapeBackgroundFill: {
            solidFill: { color: { rgbColor: color } },
          },
          outline: { outlineFill: { solidFill: { color: { rgbColor: color } } }, weight: { magnitude: 0, unit: 'PT' } },
        },
        fields: 'shapeBackgroundFill.solidFill.color,outline',
      },
    },
  ];
}

function dashedOutlineBox(
  id: string,
  pageId: string,
  x: number,
  y: number,
  w: number,
  h: number,
): Record<string, unknown>[] {
  return [
    {
      createShape: {
        objectId: id,
        shapeType: 'RECTANGLE',
        elementProperties: {
          pageObjectId: pageId,
          size: {
            height: { magnitude: h, unit: 'EMU' },
            width: { magnitude: w, unit: 'EMU' },
          },
          transform: {
            scaleX: 1,
            scaleY: 1,
            translateX: x,
            translateY: y,
            unit: 'EMU',
          },
        },
      },
    },
    {
      updateShapeProperties: {
        objectId: id,
        shapeProperties: {
          shapeBackgroundFill: {
            solidFill: { color: { rgbColor: COLOR_WHITE }, alpha: 0 },
          },
          outline: {
            outlineFill: { solidFill: { color: { rgbColor: COLOR_GRAY } } },
            weight: { magnitude: 1, unit: 'PT' },
            dashStyle: 'DASH',
          },
        },
        fields: 'shapeBackgroundFill,outline',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Per-stencil slide request generators
// ---------------------------------------------------------------------------

function coverStencilRequests(pageId: string): Record<string, unknown>[] {
  const s = pageId; // short alias
  const contentW = SLIDE_W - MARGIN * 2 - 200_000; // leave room for accent bar
  return [
    // Title
    ...textBoxRequests({
      id: `${s}_titlebox`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: 1_600_000, w: contentW, h: 914_400,
      fontSize: 36, bold: true, color: COLOR_INDIGO,
    }),
    // Subtitle
    ...textBoxRequests({
      id: `${s}_subbox`, pageId, text: '{{SUBTITLE}}',
      x: MARGIN, y: 2_600_000, w: contentW, h: 685_800,
      fontSize: 18, color: COLOR_GRAY,
    }),
    // Date
    ...textBoxRequests({
      id: `${s}_datebox`, pageId, text: '{{DATE}}',
      x: MARGIN, y: 3_400_000, w: contentW, h: 457_200,
      fontSize: 14, color: COLOR_GRAY,
    }),
    // Accent bar right edge (20px = ~182880 EMU)
    ...accentBarRequests(
      `${s}_accent`, pageId,
      SLIDE_W - 182_880, 0, 182_880, SLIDE_H,
      COLOR_AMBER,
    ),
  ];
}

function sectionStencilRequests(pageId: string): Record<string, unknown>[] {
  const titleH = 914_400;
  const titleY = (SLIDE_H - titleH) / 2; // vertically centered
  const barH = 54_864; // ~6px
  return [
    ...textBoxRequests({
      id: `${pageId}_titlebox`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: titleY, w: SLIDE_W - MARGIN * 2, h: titleH,
      fontSize: 38, fontWeight: 500, color: COLOR_INDIGO,
    }),
    ...accentBarRequests(
      `${pageId}_accent`, pageId,
      0, SLIDE_H - barH, SLIDE_W, barH,
      COLOR_AMBER,
    ),
  ];
}

function agendaStencilRequests(pageId: string): Record<string, unknown>[] {
  return [
    ...textBoxRequests({
      id: `${pageId}_titlebox`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: SLIDE_W - MARGIN * 2, h: 685_800,
      fontSize: 24, bold: true, color: COLOR_INDIGO,
    }),
    ...textBoxRequests({
      id: `${pageId}_bodybox`, pageId, text: '{{BODY}}',
      x: MARGIN, y: 1_200_000, w: SLIDE_W - MARGIN * 2, h: 3_500_000,
      fontSize: 14, color: COLOR_GRAY,
    }),
  ];
}

function contentStencilRequests(pageId: string): Record<string, unknown>[] {
  return [
    ...textBoxRequests({
      id: `${pageId}_titlebox`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: SLIDE_W - MARGIN * 2, h: 685_800,
      fontSize: 24, bold: true, color: COLOR_INDIGO,
    }),
    ...textBoxRequests({
      id: `${pageId}_bodybox`, pageId, text: '{{BODY}}',
      x: MARGIN, y: 1_200_000, w: SLIDE_W - MARGIN * 2, h: 3_500_000,
      fontSize: 14, color: COLOR_GRAY,
    }),
  ];
}

function walkthroughStencilRequests(pageId: string): Record<string, unknown>[] {
  const leftW = Math.round(SLIDE_W * 0.4) - MARGIN;
  const rightX = Math.round(SLIDE_W * 0.4);
  const rightW = SLIDE_W - rightX - MARGIN;
  return [
    ...textBoxRequests({
      id: `${pageId}_titlebox`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: leftW, h: 685_800,
      fontSize: 24, bold: true, color: COLOR_INDIGO,
    }),
    ...textBoxRequests({
      id: `${pageId}_bodybox`, pageId, text: '{{BODY}}',
      x: MARGIN, y: 1_200_000, w: leftW, h: 3_500_000,
      fontSize: 14, color: COLOR_GRAY,
    }),
    // Image placeholder area (right 60%, dashed outline)
    ...dashedOutlineBox(
      `${pageId}_imgarea`, pageId,
      rightX, MARGIN, rightW, SLIDE_H - MARGIN * 2,
    ),
  ];
}

function mobileFlowStencilRequests(pageId: string): Record<string, unknown>[] {
  // The builder uses 0-indexed placeholders: {{STEP_0_CAPTION}} .. {{STEP_3_CAPTION}}
  const captionW = Math.round((SLIDE_W - MARGIN * 2) / 4);
  const captionY = SLIDE_H - 600_000;
  const reqs: Record<string, unknown>[] = [
    ...textBoxRequests({
      id: `${pageId}_titlebox`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: SLIDE_W - MARGIN * 2, h: 685_800,
      fontSize: 24, bold: true, color: COLOR_INDIGO,
    }),
  ];
  for (let i = 0; i < 4; i++) {
    const x = MARGIN + i * captionW;
    reqs.push(...textBoxRequests({
      id: `${pageId}_cap${i}`, pageId, text: `{{STEP_${i}_CAPTION}}`,
      x, y: captionY, w: captionW - 50_000, h: 400_000,
      fontSize: 12, color: COLOR_GRAY,
    }));
  }
  return reqs;
}

function webScreenStencilRequests(pageId: string): Record<string, unknown>[] {
  return [
    ...textBoxRequests({
      id: `${pageId}_titlebox`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: SLIDE_W - MARGIN * 2, h: 685_800,
      fontSize: 24, bold: true, color: COLOR_INDIGO,
    }),
    ...textBoxRequests({
      id: `${pageId}_captionbox`, pageId, text: '{{CAPTION}}',
      x: MARGIN, y: SLIDE_H - 600_000, w: SLIDE_W - MARGIN * 2, h: 400_000,
      fontSize: 12, color: COLOR_GRAY,
    }),
  ];
}

function mobileZoomStencilRequests(pageId: string): Record<string, unknown>[] {
  return [
    ...textBoxRequests({
      id: `${pageId}_titlebox`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: SLIDE_W - MARGIN * 2, h: 685_800,
      fontSize: 24, bold: true, color: COLOR_INDIGO,
    }),
    ...textBoxRequests({
      id: `${pageId}_calloutsbox`, pageId, text: '{{CALLOUTS}}',
      x: MARGIN, y: 1_200_000, w: Math.round(SLIDE_W * 0.4), h: 3_500_000,
      fontSize: 14, color: COLOR_GRAY,
    }),
  ];
}

function twoColumnStencilRequests(pageId: string): Record<string, unknown>[] {
  const colW = Math.round((SLIDE_W - MARGIN * 3) / 2); // gap between columns = MARGIN
  const rightX = MARGIN * 2 + colW;
  return [
    ...textBoxRequests({
      id: `${pageId}_titlebox`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: SLIDE_W - MARGIN * 2, h: 685_800,
      fontSize: 24, bold: true, color: COLOR_INDIGO,
    }),
    // Left heading
    ...textBoxRequests({
      id: `${pageId}_lhead`, pageId, text: '{{LEFT_HEADING}}',
      x: MARGIN, y: 1_200_000, w: colW, h: 457_200,
      fontSize: 16, bold: true, color: COLOR_INDIGO,
    }),
    // Left body
    ...textBoxRequests({
      id: `${pageId}_lbody`, pageId, text: '{{LEFT_BODY}}',
      x: MARGIN, y: 1_700_000, w: colW, h: 3_000_000,
      fontSize: 14, color: COLOR_GRAY,
    }),
    // Right heading
    ...textBoxRequests({
      id: `${pageId}_rhead`, pageId, text: '{{RIGHT_HEADING}}',
      x: rightX, y: 1_200_000, w: colW, h: 457_200,
      fontSize: 16, bold: true, color: COLOR_INDIGO,
    }),
    // Right body
    ...textBoxRequests({
      id: `${pageId}_rbody`, pageId, text: '{{RIGHT_BODY}}',
      x: rightX, y: 1_700_000, w: colW, h: 3_000_000,
      fontSize: 14, color: COLOR_GRAY,
    }),
  ];
}

function statsStencilRequests(pageId: string): Record<string, unknown>[] {
  const colW = Math.round((SLIDE_W - MARGIN * 2) / 3);
  const reqs: Record<string, unknown>[] = [
    ...textBoxRequests({
      id: `${pageId}_titlebox`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: SLIDE_W - MARGIN * 2, h: 685_800,
      fontSize: 24, bold: true, color: COLOR_INDIGO,
    }),
  ];
  for (let i = 1; i <= 3; i++) {
    const x = MARGIN + (i - 1) * colW;
    // Stat number (big)
    reqs.push(...textBoxRequests({
      id: `${pageId}_stat${i}`, pageId, text: `{{STAT${i}}}`,
      x, y: 1_600_000, w: colW - 50_000, h: 1_371_600,
      fontSize: 72, bold: true, color: COLOR_INDIGO,
    }));
    // Stat label
    reqs.push(...textBoxRequests({
      id: `${pageId}_stat${i}_label`, pageId, text: `{{STAT${i}_LABEL}}`,
      x, y: 3_100_000, w: colW - 50_000, h: 457_200,
      fontSize: 14, color: COLOR_GRAY,
    }));
  }
  return reqs;
}

function timelineStencilRequests(pageId: string): Record<string, unknown>[] {
  const colW = Math.round((SLIDE_W - MARGIN * 2) / 5);
  const reqs: Record<string, unknown>[] = [
    ...textBoxRequests({
      id: `${pageId}_titlebox`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: SLIDE_W - MARGIN * 2, h: 685_800,
      fontSize: 24, bold: true, color: COLOR_INDIGO,
    }),
  ];
  for (let i = 1; i <= 5; i++) {
    const x = MARGIN + (i - 1) * colW;
    // Step label (bold)
    reqs.push(...textBoxRequests({
      id: `${pageId}_step${i}_label`, pageId, text: `{{STEP${i}_LABEL}}`,
      x, y: 1_500_000, w: colW - 50_000, h: 457_200,
      fontSize: 14, bold: true, color: COLOR_INDIGO,
    }));
    // Step detail
    reqs.push(...textBoxRequests({
      id: `${pageId}_step${i}_detail`, pageId, text: `{{STEP${i}_DETAIL}}`,
      x, y: 2_100_000, w: colW - 50_000, h: 2_500_000,
      fontSize: 12, color: COLOR_GRAY,
    }));
  }
  return reqs;
}

function checklistStencilRequests(pageId: string): Record<string, unknown>[] {
  return [
    ...textBoxRequests({
      id: `${pageId}_titlebox`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: SLIDE_W - MARGIN * 2, h: 685_800,
      fontSize: 24, bold: true, color: COLOR_INDIGO,
    }),
    ...textBoxRequests({
      id: `${pageId}_bodybox`, pageId, text: '{{BODY}}',
      x: MARGIN, y: 1_200_000, w: SLIDE_W - MARGIN * 2, h: 3_500_000,
      fontSize: 14, color: COLOR_GRAY,
    }),
  ];
}

function exerciseStencilRequests(pageId: string): Record<string, unknown>[] {
  return [
    // Title (white on amber background — the slide itself is amber)
    ...textBoxRequests({
      id: `${pageId}_titlebox`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: SLIDE_W - MARGIN * 2, h: 914_400,
      fontSize: 24, bold: true, color: COLOR_WHITE,
    }),
    // Duration badge
    ...textBoxRequests({
      id: `${pageId}_duration`, pageId, text: '{{DURATION}}',
      x: SLIDE_W - MARGIN - 1_500_000, y: MARGIN + 100_000, w: 1_500_000, h: 457_200,
      fontSize: 14, bold: true, color: COLOR_INDIGO,
    }),
    // Body
    ...textBoxRequests({
      id: `${pageId}_bodybox`, pageId, text: '{{BODY}}',
      x: MARGIN, y: 1_600_000, w: SLIDE_W - MARGIN * 2, h: 3_000_000,
      fontSize: 14, color: COLOR_GRAY,
    }),
  ];
}

function closingStencilRequests(pageId: string): Record<string, unknown>[] {
  return [
    ...textBoxRequests({
      id: `${pageId}_titlebox`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: SLIDE_W - MARGIN * 2, h: 914_400,
      fontSize: 28, bold: true, color: COLOR_INDIGO,
    }),
    ...textBoxRequests({
      id: `${pageId}_bodybox`, pageId, text: '{{BODY}}',
      x: MARGIN, y: 1_600_000, w: SLIDE_W - MARGIN * 2, h: 3_000_000,
      fontSize: 14, color: COLOR_GRAY,
    }),
  ];
}

// Map stencil key → request generator
const STENCIL_BUILDERS: Record<
  keyof typeof STENCILS,
  (pageId: string) => Record<string, unknown>[]
> = {
  cover: coverStencilRequests,
  section: sectionStencilRequests,
  agenda: agendaStencilRequests,
  content: contentStencilRequests,
  walkthrough: walkthroughStencilRequests,
  mobile_flow: mobileFlowStencilRequests,
  web_screen: webScreenStencilRequests,
  mobile_zoom: mobileZoomStencilRequests,
  two_column: twoColumnStencilRequests,
  stats: statsStencilRequests,
  timeline: timelineStencilRequests,
  checklist: checklistStencilRequests,
  exercise: exerciseStencilRequests,
  closing: closingStencilRequests,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Try the plugin-data .env if shell hasn't loaded it.
  loadEnvFile(`${process.env.HOME}/.claude/plugins/data/ace-ace/.env`);

  if (!PARENT_FOLDER_ID && !process.env.ACE_DRIVE_ROOT_FOLDER_ID) {
    throw new Error(
      'ACE_DRIVE_ROOT_FOLDER_ID is required (set via .env or shell env)',
    );
  }
  const parentFolderId = process.env.ACE_DRIVE_ROOT_FOLDER_ID!;

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/presentations',
    ],
  });
  const slides = google.slides({ version: 'v1', auth });
  const drive = google.drive({ version: 'v3', auth });

  // Idempotency check — skip create if template with this name already exists.
  const existing = await findExistingTemplate(drive, parentFolderId, TEMPLATE_NAME);
  if (existing) {
    console.log(`Template already exists: ${existing.id}`);
    console.log(`  ${existing.webViewLink}`);
    console.log(`  ACE_TRAINING_DECK_TEMPLATE_ID=${existing.id}`);
    return;
  }

  // -------------------------------------------------------------------------
  // Step 1: Create the presentation via Drive API (lands on Shared Drive)
  // -------------------------------------------------------------------------
  console.log('Step 1: drive.files.create with Slides mimeType into Shared Drive');
  const created = await drive.files.create({
    requestBody: {
      name: TEMPLATE_NAME,
      mimeType: 'application/vnd.google-apps.presentation',
      parents: [parentFolderId],
    },
    fields: 'id, name, parents',
    supportsAllDrives: true,
  });
  const presentationId = created.data.id!;
  console.log(`  presentationId=${presentationId}`);

  // -------------------------------------------------------------------------
  // Step 2: Discover the default slide objectId
  // -------------------------------------------------------------------------
  console.log('Step 2: slides.presentations.get — discover default slide objectId');
  const initial = await slides.presentations.get({ presentationId });
  const initialSlideId = initial.data.slides?.[0]?.objectId!;

  // -------------------------------------------------------------------------
  // Step 3: Build all 14 stencil slides via batchUpdate
  // -------------------------------------------------------------------------
  console.log('Step 3: batchUpdate — create 14 stencil slides with Dimagi branding');

  const stencilKeys = Object.keys(STENCILS) as Array<keyof typeof STENCILS>;
  const allRequests: Record<string, unknown>[] = [];

  // Delete the default blank slide first
  allRequests.push({ deleteObject: { objectId: initialSlideId } });

  // Create each stencil slide
  for (let i = 0; i < stencilKeys.length; i++) {
    const key = stencilKeys[i];
    const pageId = STENCILS[key];

    // Create the slide
    allRequests.push({
      createSlide: {
        objectId: pageId,
        insertionIndex: i,
        slideLayoutReference: { predefinedLayout: 'BLANK' },
      },
    });

    // Exercise stencil gets an amber background
    if (key === 'exercise') {
      allRequests.push({
        updatePageProperties: {
          objectId: pageId,
          pageProperties: {
            pageBackgroundFill: {
              solidFill: { color: { rgbColor: COLOR_AMBER } },
            },
          },
          fields: 'pageBackgroundFill.solidFill.color',
        },
      });
    }

    // Add all shapes and text for this stencil
    allRequests.push(...STENCIL_BUILDERS[key](pageId));
  }

  // Slides API has a per-request limit; split into batches of ~100 requests
  // to stay well under the wire. Each stencil averages ~10-15 requests, so
  // 14 stencils × ~12 = ~170 total — split into two batches.
  const BATCH_SIZE = 100;
  for (let start = 0; start < allRequests.length; start += BATCH_SIZE) {
    const batch = allRequests.slice(start, start + BATCH_SIZE);
    const batchNum = Math.floor(start / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(allRequests.length / BATCH_SIZE);
    console.log(`  batchUpdate ${batchNum}/${totalBatches} (${batch.length} requests)`);
    await slides.presentations.batchUpdate({
      presentationId,
      requestBody: { requests: batch },
    });
  }

  const webViewLink = `https://docs.google.com/presentation/d/${presentationId}/edit`;
  console.log('\nTemplate created:');
  console.log(`  ${webViewLink}`);
  console.log(`  presentationId=${presentationId}`);
  console.log(`\nAdd to .env.tpl and .env:`);
  console.log(`  ACE_TRAINING_DECK_TEMPLATE_ID=${presentationId}`);
}

main().catch((e: any) => {
  console.error('FAILED:', e.message);
  if (e.response?.data) console.error('  response:', JSON.stringify(e.response.data, null, 2));
  process.exit(1);
});
