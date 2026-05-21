/**
 * Probe: create a brand-new OCS chatbot from scratch via the new
 * `ocs_create_chatbot` atom. This is the first step of building the
 * "ACE Interviews Stub Template" that ACE will use as the clone source
 * for every per-cohort Dynamic Router Bot.
 *
 * Run from worktree root:
 *   npx tsx scripts/probe-ocs-create-chatbot.ts             # dry-run (verify session)
 *   npx tsx scripts/probe-ocs-create-chatbot.ts --commit    # actually create
 *   npx tsx scripts/probe-ocs-create-chatbot.ts --commit --name "Custom Name"
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PlaywrightSession } from '../mcp/ocs/auth/playwright-session.js';
import { PlaywrightBackend } from '../mcp/ocs/backends/playwright.js';
import type { RequestFn } from '../mcp/ocs/backends/pipeline-patch.js';

const COMMIT = process.argv.includes('--commit');
const nameArgIdx = process.argv.indexOf('--name');
const NAME = nameArgIdx > -1 && process.argv[nameArgIdx + 1]
  ? process.argv[nameArgIdx + 1]
  : 'ACE Interviews Stub Template';
const DESCRIPTION =
  'V1 stub Dynamic Router Bot for the ACE Connect Interviews automation. ' +
  'Clone source for per-cohort bots. Built by scripts/probe-ocs-create-chatbot.ts on ' +
  new Date().toISOString().slice(0, 10) + '.';

if (!process.env.OCS_USERNAME) {
  const envPath = path.join(os.homedir(), '.claude/plugins/data/ace-ace/.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  }
}

const baseUrl = process.env.OCS_BASE_URL ?? 'https://chatbots.dimagi.com';
const teamSlug = process.env.OCS_TEAM_SLUG;
if (!teamSlug) throw new Error('OCS_TEAM_SLUG missing from env');
if (!process.env.OCS_USERNAME || !process.env.OCS_PASSWORD) {
  throw new Error('OCS_USERNAME / OCS_PASSWORD missing from env');
}

console.log(`[probe-ocs-create-chatbot]`);
console.log(`  OCS base URL: ${baseUrl}`);
console.log(`  Team slug:    ${teamSlug}`);
console.log(`  Bot name:     ${NAME}`);
console.log(`  Commit:       ${COMMIT ? 'YES — will create the bot' : 'no (dry run)'}`);
console.log('');

const session = new PlaywrightSession({
  baseUrl,
  teamSlug,
  username: process.env.OCS_USERNAME,
  password: process.env.OCS_PASSWORD,
});

try {
  if (!COMMIT) {
    console.log('[dry-run] Verifying OCS session + /chatbots/new/ reachable...');
    const ctx = await session.getContext();
    const res = await ctx.request.get(`${baseUrl}/a/${teamSlug}/chatbots/new/`, { maxRedirects: 0 });
    console.log(`  GET /a/${teamSlug}/chatbots/new/  → ${res.status()}`);
    if (res.status() !== 200) {
      console.error(`  Unexpected status; first 200 chars: ${(await res.text()).slice(0, 200)}`);
      process.exit(1);
    }
    console.log('  Session live, form reachable. Re-run with --commit.');
    process.exit(0);
  }

  // Wire the RequestFn shim that translates RequestOptions -> Playwright opts.
  // Mirrors mcp/ocs-server.ts production wiring.
  const ctx = await session.getContext();
  const csrfToken = session.getCsrfToken();
  const request: RequestFn = async (method, url, body, options) => {
    const maxRedirects = options?.followRedirects === false ? 0 : undefined;
    const headers = { 'X-CSRFToken': csrfToken, Referer: baseUrl };
    const fullUrl = url.startsWith('http') ? url : `${baseUrl}${url}`;
    let res;
    if (method === 'GET') {
      res = await ctx.request.get(fullUrl, { maxRedirects });
    } else if (options?.multipart) {
      res = await ctx.request.post(fullUrl, { headers, multipart: options.multipart as any, maxRedirects });
    } else if (options?.formEncoded) {
      res = await ctx.request.post(fullUrl, { headers, form: body as Record<string, string>, maxRedirects });
    } else {
      res = await ctx.request.post(fullUrl, { headers, data: body as any, maxRedirects });
    }
    return {
      ok: res.ok(),
      status: res.status(),
      headers: res.headers(),
      text: async () => await res.text(),
      json: async () => await res.json(),
    };
  };
  const backend = new PlaywrightBackend({ teamSlug, baseUrl, csrfToken, request });

  console.log(`Creating "${NAME}"...`);
  const result = await backend.createChatbot({ name: NAME, description: DESCRIPTION });
  console.log(`  ✓ created`);
  console.log(`    experiment_id: ${result.experiment_id}`);
  console.log(`    pipeline_id:   ${result.pipeline_id}`);
  console.log(`    URL:           ${baseUrl}/a/${teamSlug}/chatbots/${result.experiment_id}/`);
  console.log('');
  console.log('Next: build out the bot structure via ocs_add_pipeline_node, ocs_add_chatbot_event,');
  console.log('ocs_add_custom_action (next-up atoms in task #13).');
} finally {
  await session.close().catch(() => {});
}
