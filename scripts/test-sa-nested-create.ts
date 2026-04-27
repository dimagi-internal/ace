/**
 * Reproduces and validates the Shared-Drive guard added in 0.5.18:
 *   - PASS: create file under the ACE Shared Drive root succeeds
 *   - GUARD-CATCH: create under the My-Drive-stranded turmeric folder is
 *     rejected by `assertParentOnSharedDrive` BEFORE the API call (and
 *     therefore before the misleading "user storage quota" error)
 *
 * This duplicates the helper inline so the script can run standalone without
 * importing from the MCP server module (which is structured for stdio).
 */
import { google } from 'googleapis';
import fs from 'fs';

const ROOT_FOLDER_ID = '1HThsA_0Lr5p1OdI5r-aQ446HlNBaySLz';
const STRANDED_MY_DRIVE_FOLDER_ID = '1SwMTQWE1C-KCqVeT7XPTeP0dOc3Gx6eT';

async function main() {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS!;
  console.log('SA email:', JSON.parse(fs.readFileSync(keyPath, 'utf-8')).client_email);

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const drive = google.drive({ version: 'v3', auth });

  async function assertParentOnSharedDrive(parentFolderId: string) {
    const meta = await drive.files.get({
      fileId: parentFolderId,
      fields: 'id, name, driveId, mimeType',
      supportsAllDrives: true,
    });
    if (meta.data.mimeType !== 'application/vnd.google-apps.folder')
      return { ok: false as const, message: `not a folder` };
    if (!meta.data.driveId)
      return { ok: false as const, message: `My-Drive (no driveId) — would land in SA root` };
    return { ok: true as const, driveId: meta.data.driveId, name: meta.data.name };
  }

  console.log('\n[1] guard against Shared Drive root:');
  const okGuard = await assertParentOnSharedDrive(ROOT_FOLDER_ID);
  console.log('   ->', okGuard);

  if (okGuard.ok) {
    console.log('\n[2] PASS: create file under Shared Drive root');
    const created = await drive.files.create({
      requestBody: {
        name: `guard-test-${Date.now()}`,
        mimeType: 'application/vnd.google-apps.document',
        parents: [ROOT_FOLDER_ID],
      },
      fields: 'id, name, driveId',
      supportsAllDrives: true,
    });
    console.log('   created:', created.data.id, 'driveId:', created.data.driveId);
    await drive.files.update({ fileId: created.data.id!, requestBody: { trashed: true }, supportsAllDrives: true });
    console.log('   trashed.');
  }

  console.log('\n[3] guard against My-Drive-stranded folder:');
  const badGuard = await assertParentOnSharedDrive(STRANDED_MY_DRIVE_FOLDER_ID);
  console.log('   ->', badGuard);
  if (!badGuard.ok) console.log('   GUARD CAUGHT BEFORE API CALL.');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
