/**
 * Probe: create the V1 stub "Session Completion" custom action that the
 * ACE Interviews Stub Template bot will eventually be wired to call.
 *
 * Per docs/connect-interviews/ocs-verification.md, OCS custom actions
 * are OpenAPI-driven (not simple webhook configs). For V1 stub we use
 * a placeholder OpenAPI schema pointing at a stand-in HQ inbound API
 * URL — the real URL will be substituted per-domain by the
 * /ace:interview-domain-bootstrap skill once the HQ inbound API
 * Playwright atoms are built.
 *
 * Run from worktree root:
 *   npx tsx scripts/probe-ocs-add-custom-action.ts           # dry-run
 *   npx tsx scripts/probe-ocs-add-custom-action.ts --commit  # create the action
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PlaywrightSession } from '../mcp/ocs/auth/playwright-session.js';
import { PlaywrightBackend } from '../mcp/ocs/backends/playwright.js';
import type { RequestFn } from '../mcp/ocs/backends/pipeline-patch.js';

const COMMIT = process.argv.includes('--commit');

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

// V1 stub: minimal OpenAPI 3.0 schema pointing at a placeholder HQ
// inbound API URL. Real cohorts substitute the actual URL per-domain.
const SESSION_COMPLETION_SCHEMA = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'HQ Session Completion (Connect Interviews — V1 stub)', version: '1.0.0' },
  servers: [{ url: 'https://www.commcarehq.org' }],
  paths: {
    '/a/{domain}/api/inbound_api/{api_id}/': {
      post: {
        operationId: 'postSessionCompletion',
        description: 'Post session_completion + last_bot_interaction_date + interaction_validation back to HQ.',
        parameters: [
          { name: 'domain', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'api_id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  session_completion: { type: 'string', enum: ['session completed', 'session incomplete'] },
                  last_bot_interaction_date: { type: 'string', format: 'date' },
                  interaction_validation: { type: 'string' },
                },
                required: ['session_completion', 'last_bot_interaction_date', 'interaction_validation'],
              },
            },
          },
        },
        responses: { '200': { description: 'ok' } },
      },
    },
  },
});

const ACTION_NAME = 'ACE Interviews — Session Completion (V1 stub)';

console.log(`[probe-ocs-add-custom-action]`);
console.log(`  Team:        ${teamSlug}`);
console.log(`  Action name: ${ACTION_NAME}`);
console.log(`  Commit:      ${COMMIT ? 'YES — will create the action' : 'no (dry run)'}`);
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

  if (!COMMIT) {
    const r = await ctx.request.get(`${baseUrl}/a/${teamSlug}/actions/new/`, { maxRedirects: 0 });
    console.log(`[dry-run] GET /a/${teamSlug}/actions/new/ → ${r.status()}`);
    console.log('Re-run with --commit to actually create.');
    process.exit(0);
  }

  const backend = new PlaywrightBackend({ teamSlug, baseUrl, csrfToken, request });
  console.log('Creating custom action...');
  const result = await backend.addCustomAction({
    name: ACTION_NAME,
    server_url: 'https://www.commcarehq.org',
    api_schema: SESSION_COMPLETION_SCHEMA,
    description: 'Post session_completion back to CommCare HQ Inbound API. V1 stub; real cohorts substitute the actual {domain} + {api_id} per HQ inbound API config.',
    prompt: 'When the user has answered all interview questions and the interview is complete, call this action to record session completion back to CommCare HQ.',
  });
  console.log(`  ✓ action_id = ${result.action_id}`);
  console.log(`    URL: ${baseUrl}/a/${teamSlug}/actions/${result.action_id}/`);
} finally {
  await session.close().catch(() => {});
}
