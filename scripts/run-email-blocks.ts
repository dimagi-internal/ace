/**
 * Run `insertEmailBlocks` against a live Doc outside the MCP — the same code
 * path `docs_insert_email_blocks` uses, for validating a change before the MCP
 * subprocess has been restarted onto it.
 *
 *   npx tsx scripts/run-email-blocks.ts <documentId> <blocks.json>
 *
 * Auth: ACE's service-account key — GOOGLE_APPLICATION_CREDENTIALS, else the
 * plugin-data dir's gws-sa-key.json (resolved the same way the ace-gdrive MCP does).
 */
import fs from 'fs';
import path from 'path';
import { google } from '../lib/google-shim.js';
import { insertEmailBlocks } from '../lib/docs-email-block.js';
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import { resolvePluginDataDir } from '../lib/plugin-data-dir.js';

loadPluginEnv(import.meta.url);

const [documentId, blocksPath] = process.argv.slice(2);
if (!documentId || !blocksPath) {
  console.error('usage: run-email-blocks.ts <documentId> <blocks.json>');
  process.exit(2);
}
function resolveKeyPath(): string {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const dataDir = resolvePluginDataDir(import.meta.url);
  const k = dataDir ? path.join(dataDir, 'gws-sa-key.json') : '';
  if (k && fs.existsSync(k)) return k;
  console.error('No Google service-account key found. Set GOOGLE_APPLICATION_CREDENTIALS or run /ace:setup.');
  process.exit(2);
}
const keyFile = resolveKeyPath();
const auth = new google.auth.GoogleAuth({ keyFile, scopes: ['https://www.googleapis.com/auth/documents'] });
const docs = google.docs({ version: 'v1', auth });

const r = await insertEmailBlocks(
  {
    get: async (id) => (await docs.documents.get({ documentId: id })).data as any,
    batchUpdate: (id, requests) => docs.documents.batchUpdate({ documentId: id, requestBody: { requests } }),
  },
  documentId,
  JSON.parse(fs.readFileSync(blocksPath, 'utf8')),
);
console.log(JSON.stringify(r, null, 2));
