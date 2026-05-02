/**
 * End-to-end smoke test for the training-deck-build pipeline.
 *
 * Exercises every code path the skill will use:
 *   - parseDeckOutline on a synthetic outline
 *   - bootstrap-training-deck-template (creates template if absent)
 *   - slides_copy_template (copy template into a Drive folder)
 *   - slides_get (discover stencils + speaker-notes shape IDs)
 *   - buildSlidesRequests + slides_batch_update (main fill-in)
 *   - buildSpeakerNotesRequests + second slides_batch_update
 *
 * Prerequisites:
 *   1. Slides API enabled on the connect-labs GCP project (one-time
 *      browser click — script will surface the enable URL on failure)
 *   2. ~/.claude/plugins/data/ace-ace/.env populated (SA key + Drive
 *      root folder ID)
 *
 * Output: a real Slides deck in
 *   <ACE_DRIVE_ROOT_FOLDER_ID>/training-deck-build-smoke/
 *
 * Idempotent — re-running creates a NEW dated deck each time, the
 * template itself is reused.
 */

import { google } from 'googleapis';
import * as fs from 'node:fs';
import {
  parseDeckOutline,
  buildSlidesRequests,
  buildSpeakerNotesRequests,
  STENCIL_TITLE_OBJECT_ID,
  STENCIL_CONTENT_OBJECT_ID,
} from '../lib/training-deck-spec.js';

const KEY_FILE =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ??
  `${process.env.HOME}/.claude/plugins/data/ace-ace/gws-sa-key.json`;
const TEMPLATE_NAME = 'ACE Training Deck Template (v1)';

function loadEnvFile(envPath: string): void {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

// Synthetic test deck — exercises title slide, multi-slide content,
// bullets, paragraphs, speaker notes. Skips images for the smoke test
// (separate concern; would need a Drive fileId the SA can read).
const TEST_OUTLINE = `# Turmeric Survey FLW Training (smoke test)

A 5-minute walkthrough for new field workers.

---

## Slide: Welcome

You'll be helping us survey turmeric quality across local markets.

- Each visit takes about 10 minutes
- You can do up to 5 visits per market per day
- Please complete the Learn module before starting

> Speaker notes: Open with a smile. Set expectations on time commitment per visit so the FLW knows what to budget for their day.

---

## Slide: Taking the photo

Use natural light when possible. Hold the MTN card flat next to the
turmeric so both are clearly in frame.

- Card and turmeric in the same shot
- No bending or folding the card
- Avoid harsh shadows

> Speaker notes: This is the most important step — the photo plus the card is what verifies authenticity downstream.

---

## Slide: If a vendor refuses

Some vendors won't agree to be photographed. That's fine.

- Complete the form anyway — the delivery is logged but flagged
- Be polite and thank them
- Move on to the next vendor

> Speaker notes: Don't argue with the vendor. We'd rather have a clean partial record than a tense interaction.

---

## Slide: Where to get help

If you have questions, the OCS support widget is available at all times.

- Tap the chat icon in Connect to start
- It knows the program details
- Your LLO manager can help with logistics
`;

async function findTemplate(
  drive: ReturnType<typeof google.drive>,
  parentId: string,
): Promise<string | null> {
  const resp = await drive.files.list({
    q: `name='${TEMPLATE_NAME.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.presentation' and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return resp.data.files?.[0]?.id ?? null;
}

async function main() {
  loadEnvFile(`${process.env.HOME}/.claude/plugins/data/ace-ace/.env`);
  const parentFolderId = process.env.ACE_DRIVE_ROOT_FOLDER_ID;
  if (!parentFolderId) throw new Error('ACE_DRIVE_ROOT_FOLDER_ID not set');

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/presentations',
    ],
  });
  const slides = google.slides({ version: 'v1', auth });
  const drive = google.drive({ version: 'v3', auth });

  // ─── Phase A: ensure template exists ──────────────────────────────
  console.log('A1. Looking for existing template...');
  let templateId = await findTemplate(drive, parentFolderId);
  if (templateId) {
    console.log(`    found: ${templateId}`);
  } else {
    console.log('    not found — creating template inline');
    // Drive API route — Slides API's presentations.create can't write to a
    // Shared Drive (and SAs can't write to My Drive). drive.files.create
    // with the Slides mimeType + parents lands directly in the target folder.
    const created = await drive.files.create({
      requestBody: {
        name: TEMPLATE_NAME,
        mimeType: 'application/vnd.google-apps.presentation',
        parents: [parentFolderId],
      },
      fields: 'id',
      supportsAllDrives: true,
    });
    templateId = created.data.id!;
    const initial = await slides.presentations.get({ presentationId: templateId });
    const initialSlideId = initial.data.slides![0].objectId!;
    await slides.presentations.batchUpdate({
      presentationId: templateId,
      requestBody: {
        requests: [
          { deleteObject: { objectId: initialSlideId } },
          {
            createSlide: {
              objectId: STENCIL_TITLE_OBJECT_ID,
              insertionIndex: 0,
              slideLayoutReference: { predefinedLayout: 'BLANK' },
            },
          },
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
                transform: { scaleX: 1, scaleY: 1, translateX: 457_200, translateY: 1_828_800, unit: 'EMU' },
              },
            },
          },
          { insertText: { objectId: 'ace_stencil_title_titlebox', text: '{{TITLE}}', insertionIndex: 0 } },
          {
            updateTextStyle: {
              objectId: 'ace_stencil_title_titlebox',
              textRange: { type: 'ALL' },
              style: { fontSize: { magnitude: 36, unit: 'PT' }, bold: true },
              fields: 'fontSize,bold',
            },
          },
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
                transform: { scaleX: 1, scaleY: 1, translateX: 457_200, translateY: 2_971_800, unit: 'EMU' },
              },
            },
          },
          { insertText: { objectId: 'ace_stencil_title_subbox', text: '{{SUBTITLE}}', insertionIndex: 0 } },
          {
            updateTextStyle: {
              objectId: 'ace_stencil_title_subbox',
              textRange: { type: 'ALL' },
              style: { fontSize: { magnitude: 18, unit: 'PT' } },
              fields: 'fontSize',
            },
          },
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
                transform: { scaleX: 1, scaleY: 1, translateX: 457_200, translateY: 457_200, unit: 'EMU' },
              },
            },
          },
          { insertText: { objectId: 'ace_stencil_content_titlebox', text: '{{TITLE}}', insertionIndex: 0 } },
          {
            updateTextStyle: {
              objectId: 'ace_stencil_content_titlebox',
              textRange: { type: 'ALL' },
              style: { fontSize: { magnitude: 24, unit: 'PT' }, bold: true },
              fields: 'fontSize,bold',
            },
          },
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
                transform: { scaleX: 1, scaleY: 1, translateX: 457_200, translateY: 1_143_000, unit: 'EMU' },
              },
            },
          },
          { insertText: { objectId: 'ace_stencil_content_bodybox', text: '{{BODY}}', insertionIndex: 0 } },
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
    console.log(`    created: ${templateId}`);
  }

  // ─── Phase B: parse + build ──────────────────────────────────────
  console.log('\nB1. parseDeckOutline');
  const spec = parseDeckOutline(TEST_OUTLINE);
  console.log(`    title="${spec.title}" subtitle="${spec.subtitle}" slides=${spec.slides.length}`);

  console.log('B2. buildSlidesRequests');
  const { mainRequests, speakerNotes } = buildSlidesRequests(spec, {
    stencils: { title: STENCIL_TITLE_OBJECT_ID, content: STENCIL_CONTENT_OBJECT_ID },
  });
  console.log(`    mainRequests=${mainRequests.length}  speakerNotes=${speakerNotes.length}`);

  // ─── Phase C: copy template → fill → notes ────────────────────────
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const deckTitle = `Smoke ${stamp}`;
  console.log(`\nC1. copy template → "${deckTitle}"`);
  const copy = await drive.files.copy({
    fileId: templateId,
    requestBody: { name: deckTitle, parents: [parentFolderId] },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });
  const presentationId = copy.data.id!;
  console.log(`    presentationId=${presentationId}`);
  console.log(`    webViewLink=${copy.data.webViewLink}`);

  console.log('C2. main batchUpdate (fill placeholders, duplicate stencil per slide)');
  const mainResp = await slides.presentations.batchUpdate({
    presentationId,
    requestBody: { requests: mainRequests as any[] },
  });
  console.log(`    replies=${mainResp.data.replies?.length}`);

  console.log('C3. slides.get → discover speakerNotesObjectId per new slide');
  const getResp = await slides.presentations.get({ presentationId });
  const speakerNotesByObjectId: Record<string, string> = {};
  for (const slide of getResp.data.slides ?? []) {
    const slideId = slide.objectId!;
    const notesObjId =
      slide.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;
    if (notesObjId) speakerNotesByObjectId[slideId] = notesObjId;
  }
  console.log(`    discovered notes IDs for ${Object.keys(speakerNotesByObjectId).length} slides`);

  console.log('C4. speaker-notes batchUpdate');
  const notesRequests = buildSpeakerNotesRequests(speakerNotes, speakerNotesByObjectId);
  if (notesRequests.length > 0) {
    const notesResp = await slides.presentations.batchUpdate({
      presentationId,
      requestBody: { requests: notesRequests as any[] },
    });
    console.log(`    replies=${notesResp.data.replies?.length}`);
  } else {
    console.log('    (no speaker notes to insert)');
  }

  console.log('\n✓ End-to-end smoke passed.');
  console.log(`  Open: ${copy.data.webViewLink}`);
  console.log(`  Slides: ${getResp.data.slides?.length} total`);
}

main().catch((e: any) => {
  console.error('\n✗ FAILED:', e.message);
  if (e.response?.data) console.error('  response:', JSON.stringify(e.response.data, null, 2));
  process.exit(1);
});
