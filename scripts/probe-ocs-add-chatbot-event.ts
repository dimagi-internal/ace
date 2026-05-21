/**
 * Probe: attach a 24hr inactivity-timeout event to the V1 stub chatbot
 * via the new `ocs_add_chatbot_event` atom.
 *
 * Default target: experiment 12213 (ACE Interviews Stub Template).
 * Event: timeout, 24hr, action_type=log (simplest valid choice for V1).
 *
 * For real Connect Interviews bots the action_type would be
 * `pipeline_start` pointing at the secondary "expiry" pipeline (see
 * docs/connect-interviews/ocs-verification.md § "Architectural mismatch").
 *
 * Run from worktree root:
 *   npx tsx scripts/probe-ocs-add-chatbot-event.ts           # dry-run (peek events)
 *   npx tsx scripts/probe-ocs-add-chatbot-event.ts --commit  # attach the event
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PlaywrightSession } from '../mcp/ocs/auth/playwright-session.js';
import { PlaywrightBackend } from '../mcp/ocs/backends/playwright.js';
import type { RequestFn } from '../mcp/ocs/backends/pipeline-patch.js';

const COMMIT = process.argv.includes('--commit');
const EXPERIMENT_ID = Number(process.env.PROBE_EXPERIMENT_ID ?? 12213);

if (!process.env.OCS_USERNAME) {
  const envPath = path.join(os.homedir(), '.claude/plugins/data/ace-ace/.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  }
}

const baseUrl = process.env.OCS_BASE_URL ?? 'https://www.openchatstudio.com';
const teamSlug = process.env.OCS_TEAM_SLUG!;
if (!teamSlug) throw new Error('OCS_TEAM_SLUG missing from env');

console.log(`[probe-ocs-add-chatbot-event]`);
console.log(`  Team:       ${teamSlug}`);
console.log(`  Experiment: ${EXPERIMENT_ID}`);
console.log(`  Commit:     ${COMMIT ? 'YES — will attach 24hr timeout event' : 'no (dry run)'}`);
console.log('');

const session = new PlaywrightSession({
  baseUrl, teamSlug,
  username: process.env.OCS_USERNAME!,
  password: process.env.OCS_PASSWORD!,
});

try {
  const ctx = await session.getContext();
  const csrfToken = session.getCsrfToken();
  const request: RequestFn = async (method, url, body, options) => {
    const maxRedirects = options?.followRedirects === false ? 0 : undefined;
    const headers = { 'X-CSRFToken': csrfToken, Referer: baseUrl };
    const fullUrl = url.startsWith('http') ? url : `${baseUrl}${url}`;
    let res;
    if (method === 'GET') res = await ctx.request.get(fullUrl, { maxRedirects });
    else if (options?.multipart) res = await ctx.request.post(fullUrl, { headers, multipart: options.multipart as any, maxRedirects });
    else if (options?.formEncoded) res = await ctx.request.post(fullUrl, { headers, form: body as Record<string, string>, maxRedirects });
    else res = await ctx.request.post(fullUrl, { headers, data: body as any, maxRedirects });
    return {
      ok: res.ok(), status: res.status(), headers: res.headers(),
      text: async () => await res.text(), json: async () => await res.json(),
    };
  };

  // Peek the chatbot home page first to confirm session and reach.
  const peek = await ctx.request.get(`${baseUrl}/a/${teamSlug}/chatbots/${EXPERIMENT_ID}/`, { maxRedirects: 0 });
  console.log(`GET chatbot home → ${peek.status()}`);
  if (peek.status() !== 200) {
    console.error(`Unexpected — expected 200. Body: ${(await peek.text()).slice(0, 200)}`);
    process.exit(1);
  }

  if (!COMMIT) {
    console.log('[dry-run] Re-run with --commit to attach the event.');
    process.exit(0);
  }

  const backend = new PlaywrightBackend({ teamSlug, baseUrl, csrfToken, request });
  console.log(`Attaching 24hr timeout event (action_type=log)...`);
  const result = await backend.addChatbotEvent({
    experiment_id: EXPERIMENT_ID,
    delay_seconds: 86400,           // 24 hours
    total_num_triggers: 1,
    trigger_from_first_message: false,
    action_type: 'log',
  });
  console.log(`  ✓ ${JSON.stringify(result)}`);
  console.log('');
  console.log(`Visit: ${baseUrl}/a/${teamSlug}/chatbots/${EXPERIMENT_ID}/#events to verify`);
} finally {
  await session.close().catch(() => {});
}
