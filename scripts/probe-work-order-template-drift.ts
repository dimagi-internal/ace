/**
 * Probe: does the LIVE Work Order template gdoc carry the tokens the repo
 * mirror declares? (dimagi-internal/ace#2126)
 *
 * `templates/work-order-template.md` is a mirror of a Drive document, and
 * `pdd-to-work-order` renders from the Drive document, never from the repo
 * file. Nothing checked that the two agree, so the ace#2126 fix landed in the
 * repo and was inert in production for a day: the live gdoc had no
 * `{{partner_first_reference}}` slot, so the producer's replacement matched
 * zero occurrences, returned 200, and left no trace for any rendered-doc check
 * to catch.
 *
 * Read-only. Exits 0 when in sync, 2 on drift, 1 on an operational failure
 * (no credentials, doc unreachable). CI cannot run this — it needs live Drive
 * credentials — so it is an operator/doctor-tier probe, the live counterpart
 * to the repo-only `test/skills/work-order-template-token-contract.test.ts`.
 *
 * Usage:
 *   npx tsx scripts/probe-work-order-template-drift.ts
 *
 * Reads WORK_ORDER_TEMPLATE_ID and GOOGLE_APPLICATION_CREDENTIALS from the
 * environment via `loadPluginEnv`, falling back to the plugin-data SA key.
 * From a DEV CHECKOUT `loadPluginEnv` cannot derive the data dir from the
 * module path (it is not under `plugins/cache/`) and falls back to `<cwd>/.env`,
 * so point it at the real one:
 *
 *   CLAUDE_PLUGIN_DATA=~/.claude/plugins/data/ace-ace \
 *     npx tsx scripts/probe-work-order-template-drift.ts
 */

import { google } from '../lib/google-shim.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPluginEnv } from '../lib/load-plugin-env.js';
import { diffTemplateTokens, formatTokenDrift } from '../lib/template-token-drift.js';

// Bash-reachable script: the parent shell has none of ACE's secrets, so load
// the plugin-data .env before the first WORK_ORDER_TEMPLATE_ID read (ace#1957).
loadPluginEnv(import.meta.url);

const PLUGIN_DATA = `${process.env.HOME}/.claude/plugins/data/ace-ace`;

async function main(): Promise<number> {
  const templateId = process.env.WORK_ORDER_TEMPLATE_ID;
  if (!templateId) {
    console.error('WORK_ORDER_TEMPLATE_ID is not set — see the [ace-env] line above for');
    console.error('which .env was read. From a dev checkout, re-run with');
    console.error('CLAUDE_PLUGIN_DATA=~/.claude/plugins/data/ace-ace; from an installed');
    console.error('plugin, run /ace:setup --force-env and retry.');
    return 1;
  }

  const keyFile =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ?? path.join(PLUGIN_DATA, 'gws-sa-key.json');
  if (!fs.existsSync(keyFile)) {
    console.error(`No Google service-account key at ${keyFile}. Run /ace:setup.`);
    return 1;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const mirrorPath = path.resolve(scriptDir, '..', 'templates', 'work-order-template.md');
  const mirrorText = fs.readFileSync(mirrorPath, 'utf8');

  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  const drive = google.drive({ version: 'v3', auth });

  let liveText: string;
  try {
    const resp = await drive.files.export(
      { fileId: templateId, mimeType: 'text/plain' },
      { responseType: 'text' },
    );
    liveText = String(resp.data);
  } catch (e: any) {
    console.error(`Could not export live template ${templateId}: ${e?.message ?? e}`);
    console.error('If this is a 404, the SA has lost access — see ace#829.');
    return 1;
  }

  const drift = diffTemplateTokens(mirrorText, liveText);
  console.log(formatTokenDrift(drift, templateId));
  return drift.inSync ? 0 : 2;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error('FAILED:', e?.message ?? e);
    process.exit(1);
  },
);
