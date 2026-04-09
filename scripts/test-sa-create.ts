/**
 * Throwaway test: verify the ACE service account can create + update + delete
 * a doc inside the target ACE folder. Mirrors the key resolution logic from
 * mcp/google-drive-server.ts so this script also validates the
 * GOOGLE_APPLICATION_CREDENTIALS env var code path. Run with:
 *
 *   # fallback path (in-repo key):
 *   npx tsx scripts/test-sa-create.ts
 *
 *   # canonical env-var path:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json npx tsx scripts/test-sa-create.ts
 */
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY_KEY_PATH = path.join(PROJECT_ROOT, '.gws-sa-key.json');
const TARGET_FOLDER_ID = '1HThsA_0Lr5p1OdI5r-aQ446HlNBaySLz';

function resolveKeyPath(): { path: string; source: 'env' | 'legacy' } {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (envPath && fs.existsSync(envPath)) {
    return { path: envPath, source: 'env' };
  }
  if (fs.existsSync(LEGACY_KEY_PATH)) {
    return { path: LEGACY_KEY_PATH, source: 'legacy' };
  }
  throw new Error(
    `No SA key found. Set GOOGLE_APPLICATION_CREDENTIALS or drop key at ${LEGACY_KEY_PATH}`,
  );
}

async function main() {
  const key = resolveKeyPath();
  console.log(`Key source: ${key.source}`);
  console.log(`Key path:   ${key.path}`);
  const keyFile = JSON.parse(fs.readFileSync(key.path, 'utf-8'));
  console.log(`SA email:   ${keyFile.client_email}`);

  const auth = new google.auth.GoogleAuth({
    keyFile: key.path,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/documents',
    ],
  });
  const drive = google.drive({ version: 'v3', auth });

  // Step 1: can we see the target folder at all?
  console.log('\n[1] get target folder metadata...');
  const folder = await drive.files.get({
    fileId: TARGET_FOLDER_ID,
    fields: 'id, name, mimeType, driveId, parents',
    supportsAllDrives: true,
  });
  console.log('    name:', folder.data.name);
  console.log('    driveId (shared drive):', folder.data.driveId ?? '(none — this is My Drive!)');

  // Step 2: create a Google Doc inside it.
  console.log('\n[2] create Google Doc in folder...');
  const created = await drive.files.create({
    requestBody: {
      name: `ACE SA smoke test ${new Date().toISOString()}`,
      mimeType: 'application/vnd.google-apps.document',
      parents: [TARGET_FOLDER_ID],
    },
    fields: 'id, name, webViewLink, driveId, parents',
    supportsAllDrives: true,
  });
  const fileId = created.data.id!;
  console.log('    created id:', fileId);
  console.log('    name:', created.data.name);
  console.log('    webViewLink:', created.data.webViewLink);
  console.log('    driveId:', created.data.driveId ?? '(none)');

  // Step 3: write content.
  console.log('\n[3] write content...');
  await drive.files.update({
    fileId,
    media: { mimeType: 'text/plain', body: 'Hello from the ACE service account!\n' },
    fields: 'id',
    supportsAllDrives: true,
  });
  console.log('    ok');

  // Step 4: clean up — trash the file so we don't leave noise.
  console.log('\n[4] cleanup (trash the test file)...');
  await drive.files.update({
    fileId,
    requestBody: { trashed: true },
    supportsAllDrives: true,
  });
  console.log('    ok');

  console.log('\nSUCCESS: service account can create, update, and trash docs in the folder.');
}

main().catch((err) => {
  console.error('\nFAILED:', err?.message ?? err);
  if (err?.errors) console.error(JSON.stringify(err.errors, null, 2));
  process.exit(1);
});
