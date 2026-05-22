/**
 * Probe: round-trip the new commcare_get_lookup_table +
 * commcare_create_lookup_table atoms against the ACE-owned HQ master
 * domain (ace-interviews-master). Creates the `interview_schedule`
 * table that the Connect Interviews team uses to drive the bot's
 * routing logic.
 *
 * Run from worktree root:
 *   npx tsx scripts/probe-commcare-lookup-table.ts            # dry-run (peek)
 *   npx tsx scripts/probe-commcare-lookup-table.ts --commit   # create the table
 *
 * Optional --table <name>     override table name (default interview_schedule)
 * Optional --domain <slug>    override target domain (default ace-interviews-master)
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PlaywrightSession } from '../mcp/connect/auth/playwright-session.js';
import { CommCareBackend } from '../mcp/connect/backends/commcare.js';

const BASE_URL = process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com';
const CCHQ_BASE_URL = process.env.ACE_HQ_BASE_URL ?? 'https://www.commcarehq.org';
const COMMIT = process.argv.includes('--commit');
const tableIdx = process.argv.indexOf('--table');
const TABLE = tableIdx > -1 ? process.argv[tableIdx + 1] : 'interview_schedule';
const domainIdx = process.argv.indexOf('--domain');
const DOMAIN = domainIdx > -1 ? process.argv[domainIdx + 1] : 'ace-interviews-master';

if (!process.env.ACE_HQ_USERNAME) {
  const envPath = path.join(os.homedir(), '.claude/plugins/data/ace-ace/.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  }
}

console.log(`[probe-commcare-lookup-table]`);
console.log(`  Domain:   ${DOMAIN}`);
console.log(`  Table:    ${TABLE}`);
console.log(`  Commit:   ${COMMIT ? 'YES — will create if missing' : 'no (read-only)'}`);
console.log('');

const session = new PlaywrightSession({
  baseUrl: BASE_URL,
  cchqBaseUrl: CCHQ_BASE_URL,
  hqUsername: process.env.ACE_HQ_USERNAME!,
  hqPassword: process.env.ACE_HQ_PASSWORD!,
});

try {
  const backend = new CommCareBackend({
    baseUrl: CCHQ_BASE_URL,
    session,
    hqUsername: process.env.ACE_HQ_USERNAME,
    hqApiKey: process.env.ACE_HQ_API_KEY,
  });

  const before = await backend.getLookupTable({ domain: DOMAIN, tag: TABLE });
  console.log('Before:', before.table ? `exists (id=${before.table.id})` : 'not found');

  if (!COMMIT) {
    console.log('[dry-run] Re-run with --commit to create if missing.');
    process.exit(0);
  }

  if (before.table) {
    console.log('Table already exists; nothing to create.');
    process.exit(0);
  }

  // Standard Connect Interviews schedule shape from the team's tech doc:
  //   cohort_id | previous_interview | next_interview | frequency_days
  const result = await backend.createLookupTable({
    domain: DOMAIN,
    tag: TABLE,
    fields: [
      { field_name: 'cohort_id', properties: [] },
      { field_name: 'previous_interview', properties: [] },
      { field_name: 'next_interview', properties: [] },
      { field_name: 'frequency_days', properties: [] },
    ],
    is_global: false,
  });
  console.log(`  ✓ created — id=${result.id}, tag=${result.tag}`);

  const after = await backend.getLookupTable({ domain: DOMAIN, tag: TABLE });
  console.log('After read-back:', after.table
    ? `tag=${after.table.tag} fields=${after.table.fields.map((f) => f.field_name).join(',')}`
    : 'NOT FOUND — round-trip broken');
} finally {
  await session.close().catch(() => {});
}
