/**
 * Probe: create the two ACE-owned HQ test domains for the Connect
 * Interviews V1 work via the new `commcare_create_domain` atom.
 *
 * Domains:
 *   - ace-interviews-master  (upstream / master apps + plumbing)
 *   - ace-interviews-test    (downstream / receives linked-app pushes)
 *
 * Run from worktree root:
 *   # Dry run — does GET /register/domain/ only; verifies session + form is reachable.
 *   npx tsx scripts/probe-commcare-create-domain.ts
 *
 *   # Actually create the domains:
 *   npx tsx scripts/probe-commcare-create-domain.ts --commit
 *
 *   # Create one with a custom name:
 *   npx tsx scripts/probe-commcare-create-domain.ts --commit --name foo-bar-baz
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

// Allow --name <slug> override; otherwise create both V1 domains.
const nameArgIdx = process.argv.indexOf('--name');
const namesToCreate: string[] = nameArgIdx > -1 && process.argv[nameArgIdx + 1]
  ? [process.argv[nameArgIdx + 1]]
  : ['ace-interviews-master', 'ace-interviews-test'];

// Load .env from plugin data dir if not already in env (mirrors probe-flw-invite.ts).
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

console.log(`[probe-commcare-create-domain]`);
console.log(`  HQ base URL:      ${CCHQ_BASE_URL}`);
console.log(`  HQ user:          ${process.env.ACE_HQ_USERNAME}`);
console.log(`  Domains to create: ${JSON.stringify(namesToCreate)}`);
console.log(`  Commit:           ${COMMIT ? 'YES — will create real domains' : 'no (dry run)'}`);
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
    console.log('[dry-run] Verifying session + /register/domain/ is reachable...');
    const ctx = await session.getContext();
    const refreshRes = await ctx.request.get(`${CCHQ_BASE_URL}/register/domain/`, { maxRedirects: 0 });
    console.log(`  GET /register/domain/  → ${refreshRes.status()}`);
    if (refreshRes.status() !== 200) {
      console.error(`  Unexpected status ${refreshRes.status()} (expected 200). First 300 chars:`);
      console.error((await refreshRes.text()).slice(0, 300));
      process.exit(1);
    }
    console.log('  Session is live, form reachable. Re-run with --commit to actually create.');
    process.exit(0);
  }

  for (const hrName of namesToCreate) {
    console.log(`Creating "${hrName}"...`);
    try {
      const result = await backend.createDomain({ hr_name: hrName });
      console.log(`  ✓ created — slug: ${result.domain}`);
      console.log(`    URL: ${CCHQ_BASE_URL}/a/${result.domain}/dashboard/`);
    } catch (err) {
      console.error(`  ✗ FAILED: ${(err as Error).message}`);
      throw err;
    }
  }

  console.log('');
  console.log('All domains created. Next steps:');
  console.log('  - Send accounts@ subscription request (task #12)');
  console.log('  - Set up linked-domain relationship via commcare_link_domains (TBD)');
} finally {
  await session.close().catch(() => {});
}
