/**
 * Cleanup script — delete any disposable smoke/test decks from
 * `ACE_DRIVE_ROOT_FOLDER_ID`. Conservative — only deletes files whose
 * name matches the smoke / Turmeric-test / probe naming convention.
 *
 * Safe to re-run; idempotent.
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

const DELETE_PATTERNS = [
  /^Smoke \d{4}-\d{2}-\d{2}/,                    // test-deck-build-smoke output
  /^Turmeric Training Deck \(\d{4}-/,            // test-deck-build-turmeric output
  /^ACE probe — drive-route create/,             // probe-slides-create-via-drive output (if any leaked)
];

async function main() {
  loadEnvFile(`${process.env.HOME}/.claude/plugins/data/ace-ace/.env`);
  const parentFolderId = process.env.ACE_DRIVE_ROOT_FOLDER_ID!;
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const drive = google.drive({ version: 'v3', auth });

  console.log(`Scanning ${parentFolderId} for disposable decks/files...`);
  let pageToken: string | undefined;
  const toDelete: { id: string; name: string }[] = [];

  do {
    const resp = await drive.files.list({
      q: `'${parentFolderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageToken,
    });
    for (const f of resp.data.files ?? []) {
      if (!f.id || !f.name) continue;
      if (DELETE_PATTERNS.some((re) => re.test(f.name!))) {
        toDelete.push({ id: f.id, name: f.name });
      }
    }
    pageToken = resp.data.nextPageToken ?? undefined;
  } while (pageToken);

  console.log(`Matched ${toDelete.length} disposable file(s):`);
  for (const f of toDelete) console.log(`  ${f.id}  "${f.name}"`);

  if (toDelete.length === 0) {
    console.log('Nothing to delete.');
    return;
  }

  for (const f of toDelete) {
    // Try `delete` first — works when SA owns the file. On Shared Drives
    // some perms only allow trash-not-delete; fall back to update with
    // `trashed: true` if delete returns 404 / forbidden. Same files
    // visible in `list` but a hard delete returning "File not found" is
    // the canonical signal of a Shared-Drive perm gap, not actual
    // missingness.
    try {
      await drive.files.delete({ fileId: f.id, supportsAllDrives: true });
      console.log(`  ✓ deleted ${f.name}`);
    } catch (e: any) {
      if (e.code === 404 || e.code === 403) {
        try {
          await drive.files.update({
            fileId: f.id,
            requestBody: { trashed: true },
            supportsAllDrives: true,
          });
          console.log(`  ✓ trashed ${f.name} (delete denied, trash succeeded)`);
        } catch (e2: any) {
          console.log(`  ✗ both delete and trash failed for ${f.name}: ${e2.message}`);
        }
      } else {
        console.log(`  ✗ delete failed for ${f.name}: ${e.message}`);
      }
    }
  }
}

main().catch((e: any) => {
  console.error('FAILED:', e.message);
  if (e.response?.data) console.error('  response:', JSON.stringify(e.response.data, null, 2));
  process.exit(1);
});
