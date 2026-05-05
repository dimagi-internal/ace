/**
 * Bootstrap the ACE training-deck Slides template.
 *
 * One-time setup: creates a Google Slides template deck with two
 * stencil slides that the `training-deck-build` skill duplicates and
 * fills via placeholder substitution:
 *
 *   - `ace_stencil_title`: title slide with {{TITLE}} + {{SUBTITLE}}
 *   - `ace_stencil_content`: content slide with {{TITLE}} + {{BODY}}
 *
 * Both stencils get well-known objectIds that survive `drive.files.copy`
 * (Slides preserves objectIds on copy unless they collide). The skill
 * resolves them via `slides_get` and dispatches batchUpdate from there.
 *
 * Iterating the template: edit the file in Slides directly. Do NOT
 * change the stencil objectIds or the {{TITLE}} / {{SUBTITLE}} / {{BODY}}
 * placeholder tokens — both are wired to `lib/training-deck-spec.ts`
 * constants. Branding (fonts, colors, logo, theme), layout positions,
 * background images, and speaker-notes formatting are all template-
 * level concerns and can change freely.
 *
 * Usage (after enabling Slides API on the connect-labs GCP project):
 *
 *   npx tsx scripts/bootstrap-training-deck-template.ts
 *
 * Idempotent: re-running with the same `--name` against an already-
 * existing template prints the existing ID without re-creating.
 *
 * Output: prints the template's presentationId. Add to `.env.tpl` and
 * `.env` as `ACE_TRAINING_DECK_TEMPLATE_ID`.
 */

import { google } from 'googleapis';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  STENCIL_TITLE_OBJECT_ID,
  STENCIL_CONTENT_OBJECT_ID,
  PLACEHOLDER_TITLE,
  PLACEHOLDER_SUBTITLE,
  PLACEHOLDER_BODY,
} from '../lib/training-deck-spec.js';

const KEY_FILE =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ??
  `${process.env.HOME}/.claude/plugins/data/ace-ace/gws-sa-key.json`;

const TEMPLATE_NAME = 'ACE Training Deck Template (v1)';
const PARENT_FOLDER_ID = process.env.ACE_DRIVE_ROOT_FOLDER_ID;

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

  // Slides API's `presentations.create` always writes to My Drive root and
  // has no `parents` field, but Service Accounts can't write there
  // (PERMISSION_DENIED, not just quota). Use Drive API's `files.create` with
  // `mimeType: application/vnd.google-apps.presentation` and `parents:
  // [sharedDriveFolder]` instead — the deck lands directly in the Shared
  // Drive in one call. Verified live 2026-05-02 via probe-slides-create-via-drive.ts.
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

  console.log('Step 2: slides.presentations.get — discover default slide objectId');
  const initial = await slides.presentations.get({ presentationId });
  const initialSlideId = initial.data.slides?.[0]?.objectId!;

  console.log('Step 3: batchUpdate — convert default slide to title stencil + add content stencil');
  // Strategy: rename the default slide's objectId to STENCIL_TITLE_OBJECT_ID,
  // drop {{TITLE}} + {{SUBTITLE}} text boxes on it. Then create
  // STENCIL_CONTENT_OBJECT_ID with {{TITLE}} + {{BODY}} text boxes.
  await slides.presentations.batchUpdate({
    presentationId,
    requestBody: {
      requests: [
        // Reassign the default slide's objectId so the stencil has a
        // stable, well-known ID after copy.
        {
          updateSlideProperties: {
            objectId: initialSlideId,
            slideProperties: {},
            fields: '',
          },
        },
        // Replace the existing default slide with one of our own (we
        // can't rename objectIds in-place, so we delete + recreate).
        { deleteObject: { objectId: initialSlideId } },
        {
          createSlide: {
            objectId: STENCIL_TITLE_OBJECT_ID,
            insertionIndex: 0,
            slideLayoutReference: { predefinedLayout: 'BLANK' },
          },
        },
        // Title placeholder text box on the title stencil.
        {
          createShape: {
            objectId: 'ace_stencil_title_titlebox',
            shapeType: 'TEXT_BOX',
            elementProperties: {
              pageObjectId: STENCIL_TITLE_OBJECT_ID,
              size: {
                height: { magnitude: 914_400, unit: 'EMU' },
                width: { magnitude: 8_229_600, unit: 'EMU' },
              },
              transform: {
                scaleX: 1,
                scaleY: 1,
                translateX: 457_200,
                translateY: 1_828_800,
                unit: 'EMU',
              },
            },
          },
        },
        {
          insertText: {
            objectId: 'ace_stencil_title_titlebox',
            text: PLACEHOLDER_TITLE,
            insertionIndex: 0,
          },
        },
        {
          updateTextStyle: {
            objectId: 'ace_stencil_title_titlebox',
            textRange: { type: 'ALL' },
            style: { fontSize: { magnitude: 36, unit: 'PT' }, bold: true },
            fields: 'fontSize,bold',
          },
        },
        // Subtitle placeholder text box.
        {
          createShape: {
            objectId: 'ace_stencil_title_subbox',
            shapeType: 'TEXT_BOX',
            elementProperties: {
              pageObjectId: STENCIL_TITLE_OBJECT_ID,
              size: {
                height: { magnitude: 685_800, unit: 'EMU' },
                width: { magnitude: 8_229_600, unit: 'EMU' },
              },
              transform: {
                scaleX: 1,
                scaleY: 1,
                translateX: 457_200,
                translateY: 2_971_800,
                unit: 'EMU',
              },
            },
          },
        },
        {
          insertText: {
            objectId: 'ace_stencil_title_subbox',
            text: PLACEHOLDER_SUBTITLE,
            insertionIndex: 0,
          },
        },
        {
          updateTextStyle: {
            objectId: 'ace_stencil_title_subbox',
            textRange: { type: 'ALL' },
            style: { fontSize: { magnitude: 18, unit: 'PT' } },
            fields: 'fontSize',
          },
        },
        // Content stencil: title + body text boxes. Body sits at the
        // top so that any per-slide image (createImage from
        // training-deck-spec.ts) can occupy the lower 60% of the slide
        // without overlapping the body text.
        {
          createSlide: {
            objectId: STENCIL_CONTENT_OBJECT_ID,
            insertionIndex: 1,
            slideLayoutReference: { predefinedLayout: 'BLANK' },
          },
        },
        {
          createShape: {
            objectId: 'ace_stencil_content_titlebox',
            shapeType: 'TEXT_BOX',
            elementProperties: {
              pageObjectId: STENCIL_CONTENT_OBJECT_ID,
              size: {
                height: { magnitude: 685_800, unit: 'EMU' },
                width: { magnitude: 8_229_600, unit: 'EMU' },
              },
              transform: {
                scaleX: 1,
                scaleY: 1,
                translateX: 457_200,
                translateY: 457_200,
                unit: 'EMU',
              },
            },
          },
        },
        {
          insertText: {
            objectId: 'ace_stencil_content_titlebox',
            text: PLACEHOLDER_TITLE,
            insertionIndex: 0,
          },
        },
        {
          updateTextStyle: {
            objectId: 'ace_stencil_content_titlebox',
            textRange: { type: 'ALL' },
            style: { fontSize: { magnitude: 24, unit: 'PT' }, bold: true },
            fields: 'fontSize,bold',
          },
        },
        // Body text box — sits between title and the image area at
        // ~2.5in down. Constrains to ~1.3in tall so a paragraph or 4-6
        // bullet list fits without spilling onto the image.
        {
          createShape: {
            objectId: 'ace_stencil_content_bodybox',
            shapeType: 'TEXT_BOX',
            elementProperties: {
              pageObjectId: STENCIL_CONTENT_OBJECT_ID,
              size: {
                height: { magnitude: 1_143_000, unit: 'EMU' },
                width: { magnitude: 8_229_600, unit: 'EMU' },
              },
              transform: {
                scaleX: 1,
                scaleY: 1,
                translateX: 457_200,
                translateY: 1_143_000,
                unit: 'EMU',
              },
            },
          },
        },
        {
          insertText: {
            objectId: 'ace_stencil_content_bodybox',
            text: PLACEHOLDER_BODY,
            insertionIndex: 0,
          },
        },
        {
          updateTextStyle: {
            objectId: 'ace_stencil_content_bodybox',
            textRange: { type: 'ALL' },
            style: { fontSize: { magnitude: 14, unit: 'PT' } },
            fields: 'fontSize',
          },
        },
      ],
    },
  });

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
