/**
 * Probe: link ace-interviews-master → ace-interviews-test via the new
 * `commcare_link_domains` atom.
 *
 * Run from worktree root:
 *   npx tsx scripts/probe-commcare-link-domains.ts          # dry-run (GET refresh only)
 *   npx tsx scripts/probe-commcare-link-domains.ts --commit # actually create link
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
const UPSTREAM = process.env.PROBE_UPSTREAM ?? 'ace-interviews-master';
const DOWNSTREAM = process.env.PROBE_DOWNSTREAM ?? 'ace-interviews-test';

if (!process.env.ACE_HQ_USERNAME) {
  const envPath = path.join(os.homedir(), '.claude/plugins/data/ace-ace/.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  }
}

if (!process.env.ACE_HQ_USERNAME || !process.env.ACE_HQ_PASSWORD) {
  throw new Error('ACE_HQ_USERNAME / ACE_HQ_PASSWORD missing from env');
}

console.log(`[probe-commcare-link-domains]`);
console.log(`  Upstream:   ${UPSTREAM}`);
console.log(`  Downstream: ${DOWNSTREAM}`);
console.log(`  Commit:     ${COMMIT ? 'YES — will create link' : 'no (dry run)'}`);
console.log('');

const session = new PlaywrightSession({
  baseUrl: BASE_URL,
  cchqBaseUrl: CCHQ_BASE_URL,
  hqUsername: process.env.ACE_HQ_USERNAME,
  hqPassword: process.env.ACE_HQ_PASSWORD,
});

try {
  const backend = new CommCareBackend({ baseUrl: CCHQ_BASE_URL, session });
  if (!COMMIT) {
    console.log('[dry-run] Verifying both domains reachable from session...');
    const ctx = await session.getContext();
    for (const slug of [UPSTREAM, DOWNSTREAM]) {
      const res = await ctx.request.get(`${CCHQ_BASE_URL}/a/${slug}/dashboard/`, { maxRedirects: 0 });
      console.log(`  GET /a/${slug}/dashboard/  → ${res.status()}`);
      if (res.status() !== 200 && res.status() !== 302) {
        console.error(`  Unexpected status; first 200 chars: ${(await res.text()).slice(0, 200)}`);
        process.exit(1);
      }
    }
    console.log('  Re-run with --commit to actually link.');
    process.exit(0);
  }
  console.log(`Linking ${UPSTREAM} → ${DOWNSTREAM}...`);
  const result = await backend.linkDomains({ upstream_domain: UPSTREAM, downstream_domain: DOWNSTREAM });
  console.log('  ✓ link created:');
  console.log(`    upstream:   ${result.upstream_domain}`);
  console.log(`    downstream: ${result.downstream_domain}`);
  console.log(`    domain_link payload: ${JSON.stringify(result.domain_link).slice(0, 400)}`);
} finally {
  await session.close().catch(() => {});
}
