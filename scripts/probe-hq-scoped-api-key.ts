/**
 * Live contract probe for `commcare_create_api_key` (CommCareBackend.createApiKey).
 *
 * Mints a throwaway key restricted to ONE project space through HQ's
 * `/account/api_keys/` form, proves HQ enforces the restriction (200 on that
 * space, 401 on another space ace@ belongs to), then deletes the key. Never
 * prints the key. Re-run when HQ's ApiKeyView changes shape.
 *
 *   npx tsx scripts/probe-hq-scoped-api-key.ts [domain]   (default: $ACE_HQ_DOMAIN)
 *
 * Reads HQ credentials from the installed plugin .env (CLAUDE_PLUGIN_DATA or
 * ~/.claude/plugins/data/ace-ace/.env).
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { config as dotenvConfig } from 'dotenv';

import { PlaywrightSession } from '../mcp/connect/auth/playwright-session.js';
import { CommCareBackend } from '../mcp/connect/backends/commcare.js';

dotenvConfig({
  path: path.join(process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude/plugins/data/ace-ace'), '.env'),
  quiet: true,
});

const hq = process.env.ACE_HQ_BASE_URL ?? 'https://www.commcarehq.org';
const user = process.env.ACE_HQ_USERNAME ?? '';
const domain = process.argv[2] ?? process.env.ACE_HQ_DOMAIN ?? '';
if (!domain || !user) throw new Error('need a domain (arg or ACE_HQ_DOMAIN) and ACE_HQ_USERNAME');

async function status(url: string, key: string): Promise<number> {
  const res = await fetch(url, { headers: { Authorization: `ApiKey ${user}:${key}` }, redirect: 'manual' });
  return res.status;
}

async function main(): Promise<void> {
  const session = new PlaywrightSession({
    baseUrl: process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com',
    cchqBaseUrl: hq,
    hqUsername: user,
    hqPassword: process.env.ACE_HQ_PASSWORD,
  });
  const backend = new CommCareBackend({ baseUrl: hq, session, hqUsername: user, hqApiKey: process.env.ACE_HQ_API_KEY });
  const name = `ace-probe-scoped-key-${Date.now()}`;
  let id: number | undefined;
  try {
    const created = await backend.createApiKey({ domain, name });
    id = created.id;
    console.log(`created key id=${created.id} name=${created.name} domain=${created.domain} last4=${created.key.slice(-4)}`);

    const own = await status(`${hq}/a/${domain}/api/v0.5/user/?limit=1&format=json`, created.key);
    console.log(`GET /a/${domain}/api/v0.5/user/ with the scoped key -> ${own} (expect 200)`);

    // Another space ace@ belongs to, via the global key.
    const domains = await fetch(`${hq}/api/user_domains/v1/?format=json`, {
      headers: { Authorization: `ApiKey ${user}:${process.env.ACE_HQ_API_KEY}` },
    }).then((r) => r.json() as Promise<{ objects?: Array<{ domain_name: string }> }>);
    const other = (domains.objects ?? []).map((d) => d.domain_name).find((d) => d !== domain);
    if (other) {
      const cross = await status(`${hq}/a/${other}/api/v0.5/user/?limit=1&format=json`, created.key);
      console.log(`GET /a/${other}/api/v0.5/user/ with the scoped key -> ${cross} (expect 401)`);
    } else {
      console.log('ace@ belongs to no other project space; cross-space refusal not checked');
    }
  } finally {
    if (id !== undefined) {
      const ctx = await session.getContext();
      const url = `${hq}/account/api_keys/`;
      await ctx.request.get(url);
      const state = await ctx.request.storageState();
      const csrf = state.cookies.find((c) => c.name === 'csrftoken' && c.domain.includes('commcarehq'))?.value ?? '';
      const del = await ctx.request.post(url, {
        data: `csrfmiddlewaretoken=${encodeURIComponent(csrf)}&action=delete&itemId=${id}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRFToken': csrf, Referer: url },
      });
      console.log(`deleted probe key id=${id} -> ${del.status()}`);
    }
    await session.close();
  }
}

main().catch((err) => {
  console.error(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
