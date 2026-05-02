/**
 * Probe: can we create a Slides deck via Drive API into a Shared Drive folder?
 *
 * Slides API's `presentations.create` always writes to My Drive root and
 * has no `parents` field. Service Accounts have zero My-Drive quota AND
 * (apparently) lack create permission there. Drive API's `files.create`
 * with `mimeType: 'application/vnd.google-apps.presentation'` accepts
 * `parents` and can land directly in a Shared Drive — no two-step move.
 *
 * Validates the alternate path before refactoring the bootstrap script
 * + MCP atom.
 */
import { google } from 'googleapis';
import * as fs from 'node:fs';

const KEY_FILE = `${process.env.HOME}/.claude/plugins/data/ace-ace/gws-sa-key.json`;

function loadEnvFile(envPath: string): void {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

async function main() {
  loadEnvFile(`${process.env.HOME}/.claude/plugins/data/ace-ace/.env`);
  const parentFolderId = process.env.ACE_DRIVE_ROOT_FOLDER_ID!;
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/presentations',
    ],
  });
  const drive = google.drive({ version: 'v3', auth });
  const slides = google.slides({ version: 'v1', auth });

  console.log('Step 1: drive.files.create with Slides MIME type into Shared Drive');
  const created = await drive.files.create({
    requestBody: {
      name: 'ACE probe — drive-route create (delete me)',
      mimeType: 'application/vnd.google-apps.presentation',
      parents: [parentFolderId],
    },
    fields: 'id, name, webViewLink, parents',
    supportsAllDrives: true,
  });
  const presentationId = created.data.id!;
  console.log(`  presentationId=${presentationId}`);
  console.log(`  webViewLink=${created.data.webViewLink}`);

  console.log('Step 2: slides.presentations.get — verify the deck exists');
  const got = await slides.presentations.get({ presentationId });
  console.log(`  title=${got.data.title}  slides=${got.data.slides?.length}  initialSlideId=${got.data.slides?.[0]?.objectId}`);

  console.log('Step 3: slides.presentations.batchUpdate — can we mutate it?');
  await slides.presentations.batchUpdate({
    presentationId,
    requestBody: {
      requests: [
        {
          createSlide: {
            objectId: 'probe_slide_2',
            insertionIndex: 1,
            slideLayoutReference: { predefinedLayout: 'BLANK' },
          },
        },
      ],
    },
  });
  const after = await slides.presentations.get({ presentationId });
  console.log(`  slides after batchUpdate=${after.data.slides?.length}`);

  console.log('Step 4: cleanup');
  await drive.files.delete({ fileId: presentationId, supportsAllDrives: true });
  console.log('  deleted');

  console.log('\n✓ drive.files.create route works end-to-end.');
}

main().catch((e: any) => {
  console.error('FAILED:', e.message);
  if (e.response?.data) console.error('  response:', JSON.stringify(e.response.data, null, 2));
  process.exit(1);
});
