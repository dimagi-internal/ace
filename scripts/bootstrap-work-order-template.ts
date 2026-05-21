/**
 * Bootstrap the ACE Work Order template (Google Doc).
 *
 * One-time (or refresh) setup. Uploads templates/work-order-template.md to
 * Drive as a Google Doc inside ACE_TEMPLATES_FOLDER_ID, and prints the
 * resulting file_id for recording as WORK_ORDER_TEMPLATE_ID in the ACE
 * environment's .env.
 *
 * Usage:
 *   npx tsx scripts/bootstrap-work-order-template.ts
 *   (reads ACE_DRIVE_ROOT_FOLDER_ID from the plugin-data .env;
 *   ACE_TEMPLATES_FOLDER_ID also accepted for a custom parent.)
 *
 * Refresh: set WORK_ORDER_BOOTSTRAP_FORCE=1 to trash the existing template
 * (matched by name in the templates folder) and recreate.
 *
 * Output: bare file_id on stdout (capturable); progress + errors on stderr.
 */

import { google } from '../lib/google-shim.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY_FILE =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ??
  `${process.env.HOME}/.claude/plugins/data/ace-ace/gws-sa-key.json`;

const TEMPLATE_NAME =
  process.env.WORK_ORDER_TEMPLATE_NAME ?? 'ACE Work Order Template';
const FORCE = process.env.WORK_ORDER_BOOTSTRAP_FORCE === '1';

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
): Promise<{ id: string; name: string } | null> {
  const resp = await drive.files.list({
    q: `name = '${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed = false`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const file = resp.data.files?.[0];
  if (!file?.id || !file.name) return null;
  return { id: file.id, name: file.name };
}

async function main() {
  // Try the plugin-data .env if shell hasn't loaded it.
  loadEnvFile(`${process.env.HOME}/.claude/plugins/data/ace-ace/.env`);

  const parentFolderId =
    process.env.ACE_TEMPLATES_FOLDER_ID ?? process.env.ACE_DRIVE_ROOT_FOLDER_ID;
  if (!parentFolderId) {
    console.error(
      'ACE_DRIVE_ROOT_FOLDER_ID (or ACE_TEMPLATES_FOLDER_ID) is required (set via .env or shell env).',
    );
    process.exit(2);
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const templatePath = path.resolve(scriptDir, '..', 'templates', 'work-order-template.md');
  const body = fs.readFileSync(templatePath, 'utf8');

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/documents',
    ],
  });
  const drive = google.drive({ version: 'v3', auth });

  const existing = await findExistingTemplate(drive, parentFolderId, TEMPLATE_NAME);
  if (existing) {
    if (!FORCE) {
      console.error(
        `Template already exists at file_id=${existing.id} (name=${existing.name}). ` +
          `Re-run with WORK_ORDER_BOOTSTRAP_FORCE=1 to recreate.`,
      );
      // stdout: bare file_id for capture
      console.log(existing.id);
      return;
    }
    await drive.files.update({
      fileId: existing.id,
      requestBody: { trashed: true },
      supportsAllDrives: true,
    });
    console.error(`Trashed existing template file_id=${existing.id}.`);
  }

  const created = await drive.files.create({
    requestBody: {
      name: TEMPLATE_NAME,
      mimeType: 'application/vnd.google-apps.document',
      parents: [parentFolderId],
    },
    media: { mimeType: 'text/markdown', body },
    fields: 'id',
    supportsAllDrives: true,
  });

  const fileId = created.data.id;
  if (!fileId) {
    throw new Error('drive.files.create returned no id');
  }

  console.error(`Created ACE Work Order template file_id=${fileId}`);
  console.error(`Add to .env: WORK_ORDER_TEMPLATE_ID=${fileId}`);
  // stdout: bare file_id for capture
  console.log(fileId);
}

main().catch((e: any) => {
  console.error('FAILED:', e?.message ?? e);
  if (e?.response?.data) {
    console.error('  response:', JSON.stringify(e.response.data, null, 2));
  }
  process.exit(1);
});
