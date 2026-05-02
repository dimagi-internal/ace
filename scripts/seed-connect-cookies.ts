/**
 * Seed Playwright cookies for connect.dimagi.com via the headless
 * Connect→CommCareHQ OAuth flow. Used by `/ace:mobile-bootstrap` step 6 so
 * operators don't have to do an interactive headed sign-in.
 *
 * Inputs (env): ACE_HQ_USERNAME, ACE_HQ_PASSWORD, CONNECT_BASE_URL (optional,
 * defaults to https://connect.dimagi.com), USERDATA (optional, defaults to
 * $HOME/.ace/playwright-userdata).
 *
 * Run from worktree root or from the installed plugin cache:
 *   npx tsx scripts/seed-connect-cookies.ts
 *
 * Loads $HOME/.claude/plugins/data/ace-ace/.env automatically if HQ creds
 * are not already in process.env.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium } from 'playwright';
import { hqOAuthLogin } from '../mcp/connect/auth/hq-oauth-login.js';

function loadEnvFromPluginData(): void {
  if (process.env.ACE_HQ_USERNAME && process.env.ACE_HQ_PASSWORD) return;
  const envPath = path.join(os.homedir(), '.claude/plugins/data/ace-ace/.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  }
}

async function main() {
  loadEnvFromPluginData();

  const baseUrl = process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com';
  const userDataDir = process.env.USERDATA ?? path.join(os.homedir(), '.ace/playwright-userdata');
  const hqUsername = process.env.ACE_HQ_USERNAME;
  const hqPassword = process.env.ACE_HQ_PASSWORD;

  if (!hqUsername || !hqPassword) {
    console.error(
      'ACE_HQ_USERNAME / ACE_HQ_PASSWORD must be set (in process.env or in ' +
        '$HOME/.claude/plugins/data/ace-ace/.env). Did you run `/ace:setup`?',
    );
    process.exit(2);
  }

  fs.mkdirSync(userDataDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(userDataDir, { headless: true });
  try {
    await hqOAuthLogin({ context: ctx, baseUrl, hqUsername, hqPassword });
    const cookies = await ctx.cookies();
    const dimagi = cookies.filter(
      (c) => c.domain.includes('dimagi') || c.domain.includes('commcarehq'),
    );
    const domains = [...new Set(cookies.map((c) => c.domain))].sort();
    console.log(
      `LOGIN_OK total_cookies=${cookies.length} dimagi=${dimagi.length} ` +
        `userdata=${userDataDir} domains=${JSON.stringify(domains)}`,
    );
  } finally {
    await ctx.close();
  }
}

main().catch((e) => {
  console.error('LOGIN_FAIL:', e?.message ?? e);
  process.exit(1);
});
