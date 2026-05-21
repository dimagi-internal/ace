/**
 * Probe: splice a DynamicRouterNode into the stub-template pipeline using
 * the new `ocs_add_pipeline_node` atom.
 *
 * Default target is the V1 stub template:
 *   experiment 12213, pipeline 5981 (in team connect-ace)
 *
 * Starting graph (created by ocs_create_chatbot):
 *   Start → LLMResponseWithPrompt → End
 *
 * After this probe:
 *   Start → DynamicRouterNode → LLMResponseWithPrompt → End
 *
 * Run from worktree root:
 *   npx tsx scripts/probe-ocs-add-pipeline-node.ts            # dry-run (peek graph)
 *   npx tsx scripts/probe-ocs-add-pipeline-node.ts --commit   # splice the router
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

console.log(`[probe-ocs-add-pipeline-node]`);
console.log(`  Team:        ${teamSlug}`);
console.log(`  Pipeline:    ${PIPELINE_ID}`);
console.log(`  Commit:      ${COMMIT ? 'YES — will splice in DynamicRouterNode' : 'no (dry run, peek graph)'}`);
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

  // Always peek first — surface current shape so we know what edges to splice.
  const peekRes = await request('GET', `/a/${teamSlug}/pipelines/data/${PIPELINE_ID}/`);
  const peek = await peekRes.json() as any;
  console.log('Current graph:');
  for (const n of peek?.pipeline?.data?.nodes ?? []) {
    console.log(`  ${n.id}  type=${n.data?.type}`);
  }
  console.log('Edges:');
  for (const e of peek?.pipeline?.data?.edges ?? []) {
    console.log(`  ${e.source} → ${e.target}`);
  }
  console.log('');

  if (!COMMIT) {
    console.log('[dry-run] Not splicing. Re-run with --commit.');
    process.exit(0);
  }

  // Find StartNode and LLM node to identify the edge we'll disconnect.
  const startNode = peek.pipeline.data.nodes.find((n: any) => n.data?.type === 'StartNode');
  const llmNode = peek.pipeline.data.nodes.find((n: any) => n.data?.type === 'LLMResponseWithPrompt');
  if (!startNode || !llmNode) {
    throw new Error('Expected to find both StartNode and LLMResponseWithPrompt in the default pipeline.');
  }
  console.log(`Splicing DynamicRouterNode between ${startNode.id} and ${llmNode.id}...`);

  const backend = new PlaywrightBackend({ teamSlug, baseUrl, csrfToken, request });
  // The team's "Dynamic Router Bot" architecture maps to OCS's StaticRouterNode
  // (routes by participant_data field values via the `keywords` array, not
  // LLM judgment). See apps/pipelines/tests/node_schemas/StaticRouterNode.json
  // for the params shape. For V1 stub, one routing keyword is enough — real
  // cohort builds will populate the schedule's interview_ids.
  const result = await backend.addPipelineNode({
    pipeline_id: PIPELINE_ID,
    node_type: 'StaticRouterNode',
    position: { x: 200, y: 100 },
    params: {
      name: 'Interview Router',
      // Required per StaticRouterNode.json schema:
      //   `route_key` — the key within data_source to look up
      //   data_source defaults to "participant_data"
      // For Connect Interviews the team routes on participant_data.interview_id
      // (te001, te002, etc. per the cohort's lookup-table schedule).
      route_key: 'interview_id',
      keywords: ['default'],
      default_keyword_index: 0,
      tag_output_message: false,
      data_source: 'participant_data',
    },
    disconnect_edge: { source: startNode.id, target: llmNode.id },
    connect_from: startNode.id,
    connect_to: llmNode.id,
  });
  console.log(`  ✓ added node_id = ${result.node_id}`);
} finally {
  await session.close().catch(() => {});
}
