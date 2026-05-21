/**
 * Probe: wire the V1 stub "Session Completion" custom action (id 35) to
 * the LLM node in the ACE Interviews Stub Template's pipeline (5981).
 *
 * After this probe:
 *   stub bot's LLM node `data.params.custom_actions` = ["35:postSessionCompletion"]
 *
 * Run from worktree root:
 *   npx tsx scripts/probe-ocs-link-action-to-node.ts           # dry-run
 *   npx tsx scripts/probe-ocs-link-action-to-node.ts --commit  # link
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PlaywrightSession } from '../mcp/ocs/auth/playwright-session.js';
import { PlaywrightBackend } from '../mcp/ocs/backends/playwright.js';
import type { RequestFn } from '../mcp/ocs/backends/pipeline-patch.js';

const COMMIT = process.argv.includes('--commit');
const PIPELINE_ID = Number(process.env.PROBE_PIPELINE_ID ?? 5981);
const NODE_ID = process.env.PROBE_NODE_ID ?? 'LLMResponseWithPrompt-45d67';
const ACTION_ID = Number(process.env.PROBE_ACTION_ID ?? 35);
const OPERATION_ID = process.env.PROBE_OPERATION_ID ?? 'postSessionCompletion';

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

console.log(`[probe-ocs-link-action-to-node]`);
console.log(`  Pipeline:    ${PIPELINE_ID}`);
console.log(`  Node:        ${NODE_ID}`);
console.log(`  Action id:   ${ACTION_ID}`);
console.log(`  Operation:   ${OPERATION_ID}`);
console.log(`  Commit:      ${COMMIT ? 'YES — will link' : 'no (dry run, peek node)'}`);
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

  // Peek current node state
  const peek = await ctx.request.get(`${baseUrl}/a/${teamSlug}/pipelines/data/${PIPELINE_ID}/`);
  const data = await peek.json() as any;
  const node = data.pipeline.data.nodes.find((n: any) => n.id === NODE_ID);
  console.log(`Before — ${NODE_ID}.data.params.custom_actions:`,
    JSON.stringify(node?.data?.params?.custom_actions ?? null));

  if (!COMMIT) {
    console.log('[dry-run] Re-run with --commit to link.');
    process.exit(0);
  }

  const backend = new PlaywrightBackend({ teamSlug, baseUrl, csrfToken, request });
  const result = await backend.linkActionToNode({
    pipeline_id: PIPELINE_ID,
    node_id: NODE_ID,
    custom_action_id: ACTION_ID,
    operation_id: OPERATION_ID,
  });
  console.log(`  ✓ ${JSON.stringify(result)}`);

  // Confirm
  const after = await ctx.request.get(`${baseUrl}/a/${teamSlug}/pipelines/data/${PIPELINE_ID}/`);
  const afterData = await after.json() as any;
  const afterNode = afterData.pipeline.data.nodes.find((n: any) => n.id === NODE_ID);
  console.log(`After  — ${NODE_ID}.data.params.custom_actions:`,
    JSON.stringify(afterNode?.data?.params?.custom_actions ?? null));
} finally {
  await session.close().catch(() => {});
}
