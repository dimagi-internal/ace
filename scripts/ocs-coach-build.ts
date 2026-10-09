/**
 * Turn a cloned OCS chatbot into an ACE Coach
 * (docs/superpowers/specs/2026-10-06-ocs-coach-design.md):
 *
 *   1. Python node `templates/ocs-coach/status_node.py` spliced in between the
 *      LLM node and the End node (idempotent: an existing CodeNode gets the
 *      current code).
 *   2. LLM node: the rendered coach prompt (scripts/render-coach-prompt.ts) and
 *      the opp's knowledge collection(s), in one transactional save.
 *   3. A `commcare_connect` channel, so Labs' `trigger_bot` can reach a worker
 *      in the Connect app (idempotent: skipped if one exists). There is no MCP
 *      atom for this channel yet; this is the same form POST OCS's own UI makes
 *      (apps/channels/forms/commcare_connect.py: `commcare_connect_bot_name`).
 *
 *   npx tsx scripts/ocs-coach-build.ts --experiment <id> --prompt <file> \
 *     --collections 605 --connect-bot-name "Spark Coach" [--team connect-ace]
 *
 * `--collections none` detaches every collection (a clone keeps its source's
 * otherwise — a KMC coach cloned from the chlorine coach must not search chlorine docs).
 *
 * Does NOT publish: run `ocs_publish_chatbot_version` after reviewing.
 */
import { chromium } from 'playwright';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { PlaywrightBackend } from '../mcp/ocs/backends/playwright.js';
import { extractPipelineErrors } from '../mcp/ocs/backends/pipeline-patch.js';
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import { makeProductionRequest } from '../lib/ocs-script-request.js';

loadPluginEnv(import.meta.url);

const { values } = parseArgs({
  options: {
    experiment: { type: 'string' },
    prompt: { type: 'string' },
    collections: { type: 'string' },
    'connect-bot-name': { type: 'string' },
    team: { type: 'string' },
  },
});
const experimentId = Number(values.experiment);
if (!experimentId || !values.prompt || !values['connect-bot-name']) {
  throw new Error('--experiment, --prompt and --connect-bot-name are required');
}
const baseUrl = process.env.OCS_BASE_URL ?? 'https://www.openchatstudio.com';
const teamSlugOrNone = values.team ?? process.env.OCS_TEAM_SLUG;
if (!teamSlugOrNone) throw new Error('no --team and OCS_TEAM_SLUG is unset');
const teamSlug: string = teamSlugOrNone;
const detachCollections = values.collections === 'none';
const collections = detachCollections
  ? []
  : (values.collections ?? '')
      .split(',')
      .filter(Boolean)
      .map(Number);
const prompt = readFileSync(values.prompt, 'utf8');
const code = readFileSync(new URL('../templates/ocs-coach/status_node.py', import.meta.url), 'utf8');

interface GraphNode {
  id: string;
  data: { type: string };
}
interface GraphEdge {
  source: string;
  target: string;
}

async function main() {
  const stateFile = path.join(os.homedir(), '.ace', `ocs-session-${teamSlug}.json`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: stateFile, baseURL: baseUrl });
  try {
    const health = await context.request.get(`/a/${teamSlug}/chatbots/`);
    if (!health.ok() || health.url().includes('/accounts/login')) {
      throw new Error(`OCS session for ${teamSlug} is not logged in — run /ace:ocs-login`);
    }
    const csrfToken = (await context.cookies()).find((c) => c.name === 'csrftoken')?.value;
    if (!csrfToken) throw new Error('no csrftoken cookie in the OCS session');
    const request = makeProductionRequest(context, csrfToken, baseUrl);
    const backend = new PlaywrightBackend({ teamSlug, baseUrl, csrfToken, request });

    // 1. Status node between LLM and End.
    const pipelineId = await backend.pipelineIdFor(experimentId);
    const dataRes = await context.request.get(`/a/${teamSlug}/pipelines/data/${pipelineId}/`);
    const payload = (await dataRes.json()) as {
      pipeline: { name: string; data: { nodes: GraphNode[]; edges: GraphEdge[] } };
    };
    const graph = payload.pipeline.data;
    const pipelineName = payload.pipeline.name;
    const llm = graph.nodes.find((n) => n.data.type === 'LLMResponseWithPrompt');
    const end = graph.nodes.find((n) => n.data.type === 'EndNode');
    if (!llm || !end) throw new Error(`pipeline ${pipelineId} has no LLM or End node`);
    const existing = graph.nodes.find((n) => n.data.type === 'CodeNode');
    if (existing) {
      // Refresh the code (and repair a node saved without its required name: OCS
      // persists the graph even when it then reports a validation error).
      (existing.data as { params?: Record<string, unknown> }).params = {
        ...((existing.data as { params?: Record<string, unknown> }).params ?? {}),
        name: 'Coach status',
        code,
      };
      const post = await context.request.post(`/a/${teamSlug}/pipelines/data/${pipelineId}/`, {
        headers: { 'X-CSRFToken': csrfToken, Referer: baseUrl },
        data: { name: pipelineName, data: graph },
      });
      const errs = post.ok() ? extractPipelineErrors(await post.json()) : [`HTTP ${post.status()}`];
      if (errs.length) throw new Error(`status node refresh rejected: ${errs.join('; ')}`);
      console.log(`status node: refreshed ${existing.id}`);
    } else {
      const { node_id } = await backend.addPipelineNode({
        pipeline_id: pipelineId,
        node_type: 'CodeNode',
        params: { name: 'Coach status', code, tag: '' },
        disconnect_edge: { source: llm.id, target: end.id },
        connect_from: llm.id,
        connect_to: end.id,
      });
      console.log(`status node added: ${node_id}`);
    }

    // 2. Prompt + collections.
    await backend.setChatbotPipeline({
      experiment_id: experimentId,
      prompt,
      ...(collections.length || detachCollections ? { collection_index_ids: collections } : {}),
    });
    console.log(`prompt set (${prompt.length} chars); collections ${JSON.stringify(collections)}`);

    // 3. commcare_connect channel.
    const home = await (await context.request.get(`/a/${teamSlug}/chatbots/${experimentId}/`)).text();
    if (/fa-commcare_connect/.test(home)) {
      console.log('commcare_connect channel: already present, left as is');
    } else {
      const channelPath = `/channels/${teamSlug}/chatbots/${experimentId}/channels/create-dialog/commcare_connect/`;
      const res = await context.request.post(channelPath, {
        headers: { 'X-CSRFToken': csrfToken, Referer: baseUrl },
        form: {
          name: values['connect-bot-name']!,
          platform: 'commcare_connect',
          commcare_connect_bot_name: values['connect-bot-name']!,
          enabled: 'on',
          csrfmiddlewaretoken: csrfToken,
        },
        maxRedirects: 0,
      });
      const body = await res.text();
      if (!res.ok() && res.status() !== 302) {
        throw new Error(`commcare_connect channel create failed: HTTP ${res.status()} ${body.slice(0, 400)}`);
      }
      if (/already used or not available/.test(body)) {
        // apps/channels/models.py ChannelPlatform.for_dropdown: CommCare Connect is
        // offered only when the team has the `flag_commcare_connect` feature flag.
        throw new Error(
          `commcare_connect channel not available on team ${teamSlug}: an OCS admin must enable the ` +
            '`flag_commcare_connect` feature flag for the team (or a channel already exists).',
        );
      }
      if (/errorlist|is-invalid/i.test(body)) {
        throw new Error(`commcare_connect channel form refused: ${body.replace(/\s+/g, ' ').slice(0, 600)}`);
      }
      console.log(`commcare_connect channel created (HTTP ${res.status()})`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
