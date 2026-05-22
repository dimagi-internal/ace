import 'dotenv/config';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { PlaywrightSession } from '../mcp/connect/auth/playwright-session.js';
import { CommCareBackend } from '../mcp/connect/backends/commcare.js';
if (!process.env.ACE_HQ_USERNAME) {
  for (const line of fs.readFileSync(path.join(os.homedir(), '.claude/plugins/data/ace-ace/.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}
const DOMAIN = 'connect-ace-prod';
const TAG = 'ace-interviews-probe-table';
const COMMIT = process.argv.includes('--commit');
const s = new PlaywrightSession({
  baseUrl: process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com',
  cchqBaseUrl: process.env.ACE_HQ_BASE_URL ?? 'https://www.commcarehq.org',
  hqUsername: process.env.ACE_HQ_USERNAME!, hqPassword: process.env.ACE_HQ_PASSWORD!,
});
try {
  const backend = new CommCareBackend({
    baseUrl: process.env.ACE_HQ_BASE_URL ?? 'https://www.commcarehq.org',
    session: s, hqUsername: process.env.ACE_HQ_USERNAME, hqApiKey: process.env.ACE_HQ_API_KEY,
  });
  const before = await backend.getLookupTableRows({ domain: DOMAIN, table_id_or_tag: TAG });
  console.log(`Rows before: ${before.rows.length}`);
  if (!COMMIT) { console.log('Dry-run; re-run with --commit'); process.exit(0); }
  const created = await backend.appendLookupTableRows({
    domain: DOMAIN, table_id_or_tag: TAG,
    rows: [
      { cohort_id: '1A', previous_interview: '', next_interview: 'te001', frequency_days: '2' },
      { cohort_id: '1A', previous_interview: 'te001', next_interview: 'te002', frequency_days: '2' },
      { cohort_id: '1A', previous_interview: 'te002', next_interview: 'te003', frequency_days: '9999' },
    ],
  });
  console.log(`Created row_ids: ${JSON.stringify(created.row_ids)}`);
  const after = await backend.getLookupTableRows({ domain: DOMAIN, table_id_or_tag: TAG });
  console.log(`Rows after: ${after.rows.length}`);
  for (const r of after.rows) console.log(`  ${r.id}: ${JSON.stringify(r.fields)}`);
} finally { await s.close().catch(()=>{}); }
