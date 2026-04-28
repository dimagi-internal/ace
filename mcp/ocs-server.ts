/**
 * OCS MCP Server for ACE
 *
 * Exposes 22 atomic OCS capabilities as MCP tools. Delegates to a CompositeBackend
 * that routes each atom to either REST (public OCS API) or Playwright (authenticated
 * Django session + CSRF) based on capability-map.ts.
 *
 * See docs/superpowers/specs/2026-04-08-ace-ocs-chatbot-buildout-design.md
 */

// Load env vars from <plugin-data-dir>/.env (plugin install) or ./.env (dev).
// Must be first import so all subsequent process.env reads see the values.
//
// Uses resolvePluginDataDir() which tries $CLAUDE_PLUGIN_DATA first and falls
// back to self-deriving from this module's path. Works around
// anthropics/claude-code#9427 where env-block substitution in plugin MCP
// configs is broken on current Claude Code (confirmed on 2.1.116 in the
// eoi-llm-judge session 2026-04-21: the env var arrives empty even with an
// inline `mcpServers` in plugin.json).
import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
import { resolvePluginDataDir, logPluginDataDirDiag } from '../lib/plugin-data-dir.js';
logPluginDataDirDiag('ace-ocs', import.meta.url);
const __pluginDataDir = resolvePluginDataDir(import.meta.url);
dotenvConfig({
  path: __pluginDataDir
    ? path.join(__pluginDataDir, '.env')
    : path.join(process.cwd(), '.env'),
});

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { RestBackend } from './ocs/backends/rest.js';
import { PlaywrightBackend } from './ocs/backends/playwright.js';
import { CompositeBackend } from './ocs/backends/composite.js';
import { PlaywrightSession } from './ocs/auth/playwright-session.js';
import { loadBaseUrl, loadRestToken } from './ocs/auth/rest-token.js';
import type { RequestFn } from './ocs/backends/pipeline-patch.js';
import { createLoggingProxy, defaultFileLogger } from './ocs/logging.js';
import { CsrfTokenMissingError } from './ocs/errors.js';

const baseUrl = loadBaseUrl();
const teamSlug = process.env.OCS_TEAM_SLUG ?? 'dimagi';

// REST backend (immediate, stateless)
const rest = new RestBackend({ baseUrl, token: loadRestToken() });

// Playwright backend — lazily initialized on first authoring call
let playwright: PlaywrightBackend | undefined;
let session: PlaywrightSession | undefined;
let playwrightInitPromise: Promise<PlaywrightBackend> | undefined;

// Simple promise-queue serializer so concurrent authoring calls can't race
// on CSRF token rotation or cookie mutation. Spec section: Playwright backend → Concurrency.
let requestChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = requestChain.then(fn, fn);
  requestChain = next.catch(() => undefined);
  return next;
}

// Cleanup: close the Playwright browser on process exit to avoid zombie Chromium
function cleanupPlaywright() {
  if (session) {
    session.close().catch(() => {});
  }
}
process.on('SIGTERM', () => { cleanupPlaywright(); process.exit(0); });
process.on('SIGINT', () => { cleanupPlaywright(); process.exit(0); });
process.on('exit', cleanupPlaywright);

async function getPlaywrightBackend(): Promise<PlaywrightBackend> {
  if (playwright) return playwright;
  // Guard against concurrent initialization — return the same promise
  if (playwrightInitPromise) return playwrightInitPromise;
  playwrightInitPromise = initPlaywright();
  try {
    return await playwrightInitPromise;
  } catch (e) {
    playwrightInitPromise = undefined;
    throw e;
  }
}

async function initPlaywright(): Promise<PlaywrightBackend> {
  session = new PlaywrightSession({
    baseUrl,
    teamSlug,
    username: process.env.OCS_USERNAME,
    password: process.env.OCS_PASSWORD,
  });
  const ctx = await session.getContext();
  let csrfToken = session.getCsrfToken();

  // Refetch the CSRF token from the cookie jar. Django rotates it on certain
  // events; we call this on a 403 and retry the request once before failing.
  async function refreshCsrf(): Promise<void> {
    const cookies = await ctx.cookies();
    const fresh = cookies.find((c) => c.name === 'csrftoken')?.value;
    if (!fresh) throw new CsrfTokenMissingError();
    csrfToken = fresh;
  }

  async function doRequest(
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
    options?: {
      followRedirects?: boolean;
      multipart?: Record<string, unknown>;
      formEncoded?: boolean;
    },
  ) {
    if (method === 'GET') {
      return ctx.request.get(url, {
        maxRedirects: options?.followRedirects === false ? 0 : undefined,
      });
    }
    const maxRedirects = options?.followRedirects === false ? 0 : undefined;
    const headers = { 'X-CSRFToken': csrfToken, Referer: baseUrl };

    if (options?.multipart) {
      // Real multipart/form-data — for Django views that parse request.FILES
      // (e.g. add_collection_files). Use Node's FormData so repeated field
      // names (`files`) are handled correctly, since Playwright's dict-based
      // multipart option doesn't allow duplicate keys.
      const form = new FormData();
      for (const [key, value] of Object.entries(options.multipart)) {
        if (typeof value === 'string') {
          form.append(key.startsWith('files_') ? 'files' : key, value);
        } else if (value && typeof value === 'object' && 'buffer' in value) {
          const file = value as { name: string; mimeType: string; buffer: Buffer };
          form.append(
            key.startsWith('files_') ? 'files' : key,
            new Blob([new Uint8Array(file.buffer)], { type: file.mimeType }),
            file.name,
          );
        }
      }
      return ctx.request.post(url, { headers, multipart: form, maxRedirects });
    }

    if (options?.formEncoded) {
      // application/x-www-form-urlencoded — for Django views that parse
      // request.POST via `FormCls(request.POST)`. Playwright's `form:` option
      // serializes correctly. Without this, bodies go out as JSON and Django
      // form views silently fall through to their invalid branch.
      return ctx.request.post(url, {
        headers,
        form: body as Record<string, string>,
        maxRedirects,
      });
    }

    // Default: JSON body (for endpoints that parse request.body as JSON,
    // e.g. /pipelines/data/<pk>/ which calls FlowPipelineData.model_validate_json).
    return ctx.request.post(url, { headers, data: body, maxRedirects });
  }

  const request: RequestFn = (method, url, body, options) =>
    serialize(async () => {
      let res = await doRequest(method, url, body, options);
      // CSRF retry: Django returns 403 Forbidden with a CSRF message. Refetch
      // the token and retry the mutation once before giving up.
      if (!res.ok() && res.status() === 403 && method !== 'GET') {
        await refreshCsrf();
        res = await doRequest(method, url, body, options);
      }
      return {
        ok: res.ok(),
        status: res.status(),
        headers: res.headers(),
        text: async () => await res.text(),
        json: async () => await res.json(),
      };
    });

  playwright = new PlaywrightBackend({ teamSlug, baseUrl, csrfToken, request });
  return playwright;
}

// CompositeBackend — lazy playwright proxy so REST-only calls don't pay the browser cost
const compositeRaw = new CompositeBackend({
  rest,
  playwright: new Proxy({} as PlaywrightBackend, {
    get(_, prop) {
      return async (...args: unknown[]) => {
        const real = await getPlaywrightBackend();
        // @ts-expect-error dynamic dispatch
        return real[prop as string](...args);
      };
    },
  }),
});

// Wrap in logging proxy so every atom call emits a structured log entry
const composite = createLoggingProxy(compositeRaw, defaultFileLogger());

// ── MCP Server Setup ────────────────────────────────────────────────

const server = new McpServer({ name: 'ocs', version: '1.0.0' });

function result(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

// ── Authoring atoms (10) ────────────────────────────────────────────

server.tool(
  'ocs_clone_chatbot',
  'Clone an OCS chatbot from a template. Returns the new experiment_id, public_id, and pipeline_id.',
  { template_id: z.number(), new_name: z.string() },
  async (args) => result(await composite.cloneChatbot(args)),
);

server.tool(
  'ocs_set_chatbot_system_prompt',
  "Update the LLMResponseWithPrompt node's prompt field for this chatbot. NOTE: when also changing collection_index_ids in the same operator-visible step, prefer ocs_set_chatbot_pipeline — it does both updates in a single transactional save and avoids the cross-field validation chicken-and-egg (e.g. setting a prompt with `{collection_index_summaries}` when no collections are attached, or vice versa).",
  { experiment_id: z.number(), prompt: z.string() },
  async (args) => { await composite.setChatbotSystemPrompt(args); return result({ ok: true }); },
);

server.tool(
  'ocs_set_chatbot_pipeline',
  "Transactional update of the LLMResponseWithPrompt node's params: prompt + collections + tools + source material in one save. Any field omitted is preserved from the existing pipeline. Pre-flight: if the FINAL prompt (after merge) contains `{collection_index_summaries}`, the FINAL collection_index_ids must be non-empty — otherwise OCS rejects the save and the bot becomes unconfigurable. Use this when changing both prompt and collections together; use the focused atoms (ocs_set_chatbot_system_prompt, ocs_attach_knowledge, ocs_set_chatbot_tools, ocs_set_source_material) when only changing one.",
  {
    experiment_id: z.number(),
    prompt: z.string().optional(),
    collection_index_ids: z.array(z.number()).optional(),
    max_results: z.number().optional(),
    generate_citations: z.boolean().optional(),
    source_material_id: z.number().nullable().optional(),
    tools: z.array(z.string()).optional(),
    custom_actions: z.array(z.string()).optional(),
    built_in_tools: z.array(z.string()).optional(),
    mcp_tools: z.array(z.string()).optional(),
  },
  async (args) => { await composite.setChatbotPipeline(args); return result({ ok: true }); },
);

server.tool(
  'ocs_create_collection',
  'Create a new Collection (RAG knowledge base) in OCS. For indexed collections (is_index=true), llm_provider and embedding_model are required — defaults from OCS_LLM_PROVIDER_ID and OCS_EMBEDDING_MODEL_ID env vars.',
  {
    name: z.string(),
    summary: z.string(),
    is_index: z.boolean(),
    is_remote_index: z.boolean(),
    llm_provider: z.number().optional().describe('LLM provider ID. Defaults to OCS_LLM_PROVIDER_ID env var.'),
    embedding_model: z.number().optional().describe('Embedding model ID. Defaults to OCS_EMBEDDING_MODEL_ID env var.'),
  },
  async (args) => {
    const llm_provider = args.llm_provider ?? (process.env.OCS_LLM_PROVIDER_ID ? Number(process.env.OCS_LLM_PROVIDER_ID) : undefined);
    const embedding_model = args.embedding_model ?? (process.env.OCS_EMBEDDING_MODEL_ID ? Number(process.env.OCS_EMBEDDING_MODEL_ID) : undefined);
    return result(await composite.createCollection({ ...args, llm_provider, embedding_model }));
  },
);

server.tool(
  'ocs_upload_collection_files',
  'Upload files to an existing Collection. Files will be chunked and embedded asynchronously. chunk_size and chunk_overlap are optional (default 800/400, matching the upstream NM Bot collection); if omitted the upload still works but uses the defaults.',
  {
    collection_id: z.number(),
    files: z.array(z.object({
      name: z.string(),
      content: z.string().describe('Base64-encoded file content'),
      mime_type: z.string(),
    })),
    chunk_size: z.number().optional().describe('Chunk size in tokens. Default 800.'),
    chunk_overlap: z.number().optional().describe('Chunk overlap in tokens. Must be < chunk_size. Default 400.'),
  },
  async (args) => {
    const decoded = args.files.map((f) => ({
      name: f.name,
      content: Buffer.from(f.content, 'base64'),
      mime_type: f.mime_type,
    }));
    return result(
      await composite.uploadCollectionFiles({
        collection_id: args.collection_id,
        files: decoded,
        chunk_size: args.chunk_size,
        chunk_overlap: args.chunk_overlap,
      }),
    );
  },
);

server.tool(
  'ocs_wait_for_collection_indexing',
  'Poll until the specified files in a Collection have been indexed (chunked + embedded). Pass the file_ids returned by ocs_upload_collection_files.',
  {
    collection_id: z.number(),
    file_ids: z.array(z.number()),
    timeout_sec: z.number().optional(),
  },
  async (args) => result(await composite.waitForCollectionIndexing(args)),
);

server.tool(
  'ocs_attach_knowledge',
  "Attach one or more Collections to a chatbot's retriever node. Pre-flight: when attaching at least one collection (collection_index_ids non-empty), the bot's current system prompt MUST contain the `{collection_index_summaries}` template variable — without it, the OCS pipeline-save endpoint silently rejects the patch and every downstream publish_chatbot_version is blocked. The MCP fails fast with a typed error in this case; fix by calling ocs_set_chatbot_system_prompt with a prompt containing the token, then retry. Pass collection_index_ids=[] to detach all collections (skips the token check).",
  {
    experiment_id: z.number(),
    collection_index_ids: z.array(z.number()),
    max_results: z.number().optional(),
    generate_citations: z.boolean().optional(),
  },
  async (args) => { await composite.attachKnowledge(args); return result({ ok: true }); },
);

server.tool(
  'ocs_set_chatbot_tools',
  "Configure the chatbot's tools, custom actions, built-in tools, and MCP tools.",
  {
    experiment_id: z.number(),
    tools: z.array(z.string()).optional(),
    custom_actions: z.array(z.string()).optional(),
    built_in_tools: z.array(z.string()).optional(),
    mcp_tools: z.array(z.string()).optional(),
  },
  async (args) => { await composite.setChatbotTools(args); return result({ ok: true }); },
);

server.tool(
  'ocs_set_source_material',
  "Point a chatbot's legacy SourceMaterial FK at a specific row. Use null to clear.",
  { experiment_id: z.number(), source_material_id: z.number().nullable() },
  async (args) => { await composite.setSourceMaterial(args); return result({ ok: true }); },
);

server.tool(
  'ocs_publish_chatbot_version',
  'Publish a new default version of a chatbot.',
  { experiment_id: z.number(), description: z.string() },
  async (args) => result(await composite.publishChatbotVersion(args)),
);

server.tool(
  'ocs_get_chatbot_embed_info',
  'Fetch the public_id and embed_key needed to render the OCS widget.',
  { experiment_id: z.number() },
  async (args) => result(await composite.getChatbotEmbedInfo(args)),
);

// ── Observation atoms (12) ──────────────────────────────────────────

server.tool(
  'ocs_list_chatbots',
  'List chatbots on the OCS team. Each entry includes both `id` (UUID public_id, used by ocs_get_chatbot/ocs_send_test_message) AND `experiment_id` (integer, used by every authoring atom: ocs_set_chatbot_system_prompt, ocs_attach_knowledge, ocs_publish_chatbot_version, etc.). Use this to find an existing bot by name and reconfigure it idempotently — no need to clone if it already exists.',
  { cursor: z.string().optional(), page_size: z.number().optional() },
  async (args) => result(await composite.listChatbots(args)),
);

server.tool(
  'ocs_get_chatbot',
  'Retrieve a single chatbot by its public UUID (from ocs_list_chatbots). Returns both `id` (UUID) and `experiment_id` (integer) — the latter is required by every authoring atom.',
  { public_id: z.string() },
  async (args) => result(await composite.getChatbot(args)),
);

server.tool(
  'ocs_list_sessions',
  'List sessions, optionally filtered by experiment, tags, or since-date.',
  {
    experiment_id: z.string().optional(),
    since: z.string().optional(),
    tags: z.string().optional(),
    versions: z.string().optional(),
    cursor: z.string().optional(),
    page_size: z.number().optional(),
  },
  async (args) => result(await composite.listSessions(args)),
);

server.tool(
  'ocs_get_session',
  'Retrieve a session with its full message history.',
  { session_id: z.string() },
  async (args) => result(await composite.getSession(args)),
);

server.tool(
  'ocs_end_session',
  'Mark a session as ended.',
  { session_id: z.string() },
  async (args) => { await composite.endSession(args); return result({ ok: true }); },
);

server.tool(
  'ocs_add_session_tags',
  'Add tags to a session.',
  { session_id: z.string(), tags: z.array(z.string()) },
  async (args) => result(await composite.addSessionTags(args)),
);

server.tool(
  'ocs_remove_session_tags',
  'Remove tags from a session.',
  { session_id: z.string(), tags: z.array(z.string()) },
  async (args) => result(await composite.removeSessionTags(args)),
);

server.tool(
  'ocs_update_session_state',
  'Patch the arbitrary state blob on a session.',
  { session_id: z.string(), state: z.record(z.string(), z.unknown()) },
  async (args) => result(await composite.updateSessionState(args)),
);

server.tool(
  'ocs_send_test_message',
  'Send a test message to a chatbot via the anonymous widget chat API. Requires the public_id and embed_key from ocs_get_chatbot_embed_info.',
  {
    public_id: z.string().describe('UUID public_id of the chatbot'),
    embed_key: z.string().describe('Embed key (widget_token) from ocs_get_chatbot_embed_info'),
    message: z.string().describe('The message to send'),
  },
  async (args) => result(await composite.sendTestMessage(args)),
);

server.tool(
  'ocs_trigger_bot_message',
  'Trigger the bot to send a message to a participant on a given channel.',
  {
    experiment_id: z.string(),
    identifier: z.string(),
    platform: z.string(),
    prompt_text: z.string(),
    session_data: z.record(z.string(), z.unknown()).optional(),
    participant_data: z.record(z.string(), z.unknown()).optional(),
  },
  async (args) => { await composite.triggerBotMessage(args); return result({ ok: true }); },
);

server.tool(
  'ocs_update_participant_data',
  'Create or update participant data across one or more experiments.',
  {
    identifier: z.string(),
    platform: z.string(),
    data: z.array(z.object({
      experiment: z.string(),
      data: z.record(z.string(), z.unknown()).optional(),
      schedules: z.array(z.record(z.string(), z.unknown())).optional(),
    })),
  },
  async (args) => { await composite.updateParticipantData(args as never); return result({ ok: true }); },
);

server.tool(
  'ocs_download_file',
  'Download a file from OCS by file ID.',
  { file_id: z.number() },
  async (args) => {
    const f = await composite.downloadFile(args);
    return result({
      filename: f.filename,
      mime_type: f.mime_type,
      content_base64: f.content.toString('base64'),
    });
  },
);

// ── Startup ─────────────────────────────────────────────────────────

async function main() {
  try {
    await rest.verify();
  } catch (e) {
    // Non-fatal: REST backend may be unavailable (no OCS_API_TOKEN, network
    // issues, etc.). Observation tools (REST-backed) will fail at call time,
    // but authoring tools (Playwright-backed) still work. This lets the MCP
    // server start even when only Playwright auth is available.
    console.error('OCS REST verification failed (non-fatal):', e instanceof Error ? e.message : e);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('OCS MCP server fatal error:', err);
  process.exit(1);
});
