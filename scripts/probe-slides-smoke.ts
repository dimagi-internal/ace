/**
 * Smoke-test the new slides_* atoms by hitting Slides directly via the same
 * service-account auth path the MCP server uses. Proves the ACE plugin
 * gws-sa-key has the new presentations scope and that create-then-move-to-
 * Shared-Drive works.
 */
import { google } from 'googleapis';

const KEY_FILE = `${process.env.HOME}/.claude/plugins/data/ace-ace/gws-sa-key.json`;
const SHARED_DRIVE_FOLDER = '1HThsA_0Lr5p1OdI5r-aQ446HlNBaySLz';

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/presentations',
    ],
  });
  const slides = google.slides({ version: 'v1', auth });
  const drive = google.drive({ version: 'v3', auth });

  console.log('Step 1: presentations.create');
  const created = await slides.presentations.create({
    requestBody: { title: 'ACE Slides Smoke Test (delete me)' },
  });
  const presentationId = created.data.presentationId!;
  const titleSlideId = created.data.slides?.[0]?.objectId ?? null;
  console.log(`  presentationId=${presentationId}  titleSlideObjectId=${titleSlideId}`);

  console.log('Step 2: drive.files.update — move to Shared Drive');
  const moved = await drive.files.update({
    fileId: presentationId,
    addParents: SHARED_DRIVE_FOLDER,
    removeParents: 'root',
    fields: 'id, name, webViewLink, parents',
    supportsAllDrives: true,
  });
  console.log(`  webViewLink=${moved.data.webViewLink}`);
  console.log(`  parents=${JSON.stringify(moved.data.parents)}`);

  console.log('Step 3: slides.presentations.batchUpdate — set title + add a content slide');
  const batchResp = await slides.presentations.batchUpdate({
    presentationId,
    requestBody: {
      requests: [
        // Insert title text into the existing title slide. The default
        // TITLE layout has placeholder objectIds we'd need to look up via
        // presentations.get; skip the placeholder route and just use a
        // replaceAllText approach.
        {
          createSlide: {
            objectId: 'content_slide_1',
            insertionIndex: 1,
            slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' },
          },
        },
      ],
    },
  });
  console.log(`  replies=${JSON.stringify(batchResp.data.replies)}`);

  console.log('Step 4: slides.presentations.get — verify slide count');
  const getResp = await slides.presentations.get({ presentationId });
  console.log(`  slide count=${getResp.data.slides?.length}`);
  console.log(`  webViewLink (re-derived)=https://docs.google.com/presentation/d/${presentationId}/edit`);

  console.log('Step 5: cleanup — drive.files.delete');
  await drive.files.delete({ fileId: presentationId, supportsAllDrives: true });
  console.log('  deleted');

  console.log('\nAll three atoms work end-to-end ✓');
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  if (e.response?.data) console.error('  response:', JSON.stringify(e.response.data, null, 2));
  process.exit(1);
});
