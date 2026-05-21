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
    method: 'GET' | 'POST' | 'DELETE',
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

    if (method === 'DELETE') {
      // OCS soft-archive views (DeleteCollection, DeletePipeline, archive_chatbot
      // siblings) are Django View.delete() methods responding to the HTTP DELETE
      // verb. CSRF header still required; no request body expected by the view.
      return ctx.request.delete(url, { headers, maxRedirects });
    }

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
  'ocs_create_chatbot',
  'Create a brand-new OCS chatbot from scratch (not by cloning). POST /a/<team>/chatbots/new/ via the CSRF-protected ChatbotForm (apps/chatbots/views.py:CreateChatbot, apps/chatbots/forms.py:ChatbotForm — fields: name + optional description). On success, OCS auto-creates a default Pipeline with the team\'s first LLM provider and 302-redirects to /edit/. Returns { experiment_id, pipeline_id }. Does NOT create channels — caller follows up with createEmbeddedWidgetChannel if needed. Used by the ACE Interviews stub bot template build where the bot is the *clone source*, so channels are added on clones, not the source.',
  { name: z.string(), description: z.string().optional() },
  async (args) => result(await composite.createChatbot(args)),
);

server.tool(
  'ocs_add_pipeline_node',
  'Add a node to a chatbot\'s pipeline graph. GET-mutate-POST the pipeline JSON at /a/<team>/pipelines/data/<pipeline_id>/ — same shape as the existing LLM-patch atoms. Supports splice-into-existing-edge: pass `disconnect_edge: {source:A, target:B}` + `connect_from: A` + `connect_to: B` to turn A→B into A→new→B (the typical pattern for inserting Router or Python nodes between Start and the default LLM). `node_id` is auto-generated as `<node_type>-<5hex>` (matching OCS UI convention) if omitted. Returns the chosen `node_id`. Server-side validation errors surface as PipelineValidationError.',
  {
    pipeline_id: z.number(),
    node_type: z.string().describe('OCS data.type value — e.g. "DynamicRouterNode", "PythonNode", "LLMResponseWithPrompt", "StartNode", "EndNode".'),
    node_id: z.string().optional().describe('Explicit node id; auto-generated if omitted.'),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    params: z.record(z.any()).optional().describe('Node-specific config blob, passed through into data.params verbatim.'),
    connect_from: z.string().optional().describe('Existing node id; if set, creates edge connect_from→new_node.'),
    connect_to: z.string().optional().describe('Existing node id; if set, creates edge new_node→connect_to.'),
    disconnect_edge: z.object({ source: z.string(), target: z.string() }).optional().describe('Optional edge to remove before adding new wiring. Use with connect_from + connect_to to splice in.'),
  },
  async (args) => result(await composite.addPipelineNode(args)),
);

server.tool(
  'ocs_set_chatbot_system_prompt',
  "Update the LLMResponseWithPrompt node's prompt field for this chatbot. NOTE: when also changing collection_index_ids in the same operator-visible step, prefer ocs_set_chatbot_pipeline — it does both updates in a single transactional save and avoids the cross-field validation chicken-and-egg (e.g. setting a prompt with `{collection_index_summaries}` when no collections are attached, or vice versa).",
  { experiment_id: z.number(), prompt: z.string() },
  async (args) => { await composite.setChatbotSystemPrompt(args); return result({ ok: true }); },
);

server.tool(
  'ocs_set_chatbot_pipeline',
  "Transactional update of the LLMResponseWithPrompt node's params: prompt + collections + tools + source material in one save. Any field omitted is preserved from the existing pipeline. OCS cross-field rule (verified 2026-04-28): the FINAL prompt must contain `{collection_index_summaries}` iff FINAL collection_index_ids.length >= 2. Pre-flight raises a typed error in either violation direction. Use this when changing both prompt and collections together; use the focused atoms when only changing one.",
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
  'Upload files to an existing Collection. Each file MUST supply EXACTLY ONE source: `file_path` (local filesystem path — MCP reads + base64-encodes server-side, preferred for any payload >1KB) OR `content` (caller-supplied base64 — legacy inline mode, only sensible for tiny strings). Mixing both, or supplying neither, fails fast. The file_path mode exists because emitting megabytes of base64 in the tool_use input wedges model generation (stream-idle timeout) — class-level preventer for the 2026-05-19 Phase 5 wedge (`docs/learnings/2026-05-19-ocs-upload-b64-context-wedge.md`). For files that live on Drive, `drive_download_binary` to a tmp path first, then pass that as `file_path` — keeps the b64 entirely out of agent context. Files will be chunked and embedded asynchronously. chunk_size and chunk_overlap are optional (default 800/400, matching the upstream NM Bot collection).',
  {
    collection_id: z.number(),
    files: z.array(z.object({
      name: z.string(),
      content: z.string().optional().describe(
        'Base64-encoded file content. Legacy inline mode — use file_path for anything > ~1KB to avoid stalling model generation on large b64 tool_use inputs.',
      ),
      file_path: z.string().optional().describe(
        'Local filesystem path. MCP reads the bytes + base64-encodes server-side, so the agent never holds the b64 in context. Pass an absolute path; relative paths resolve against the MCP subprocess CWD which is rarely predictable. Preferred for any payload > 1KB.',
      ),
      mime_type: z.string(),
    })),
    chunk_size: z.number().optional().describe('Chunk size in tokens. Default 800.'),
    chunk_overlap: z.number().optional().describe('Chunk overlap in tokens. Must be < chunk_size. Default 400.'),
  },
  async (args) => {
    const decoded = await Promise.all(
      args.files.map((f) => decodeUploadCollectionFileSource(f)),
    );
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

/**
 * Resolve a single `ocs_upload_collection_files` file-input entry to its
 * decoded `Buffer` regardless of source (file_path read or inline b64 decode),
 * enforcing exactly-one-source-per-file. Exported for unit-testability.
 *
 * Class-level preventer for the 2026-05-19 Phase 5 wedge: the inline `content`
 * (base64) path forces the agent to emit megabytes of b64 in its tool_use
 * input, which stalls model generation on any payload past ~10KB. The
 * file_path path keeps the bytes on disk, with the MCP doing the b64 work
 * server-side, so the agent never holds the encoded form in context.
 */
export async function decodeUploadCollectionFileSource(f: {
  name: string;
  content?: string;
  file_path?: string;
  mime_type: string;
}): Promise<{ name: string; content: Buffer; mime_type: string }> {
  const { readFile } = await import('node:fs/promises');
  const hasContent = f.content !== undefined;
  const hasPath = f.file_path !== undefined;
  if (!hasContent && !hasPath) {
    throw new Error(
      `ocs_upload_collection_files: file "${f.name}" missing source — supply exactly one of content / file_path.`,
    );
  }
  if (hasContent && hasPath) {
    throw new Error(
      `ocs_upload_collection_files: file "${f.name}" supplies both content and file_path — pick one.`,
    );
  }
  const bytes = hasPath
    ? await readFile(f.file_path!)
    : Buffer.from(f.content!, 'base64');
  return { name: f.name, content: bytes, mime_type: f.mime_type };
}

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
  "Attach one or more Collections to a chatbot's retriever node. OCS cross-field rule (verified 2026-04-28 via live probe): the prompt MUST contain `{collection_index_summaries}` if and only if `collection_index_ids.length >= 2`. Single or zero collections must NOT include the variable; multiple collections MUST include it. The MCP pre-flights both directions and fails fast with a typed PipelineValidationError if the bot's current prompt + your new collections list would violate it. Fix by either adjusting the prompt (via ocs_set_chatbot_system_prompt) or attaching a different number of collections. For atomic prompt+collections changes, prefer ocs_set_chatbot_pipeline.",
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

server.tool(
  'ocs_delete_chatbot',
  'Delete a chatbot (user-visible effect: the chatbot disappears from listings; mechanism is OCS setting is_archived=True server-side). SAFE PER-OPP: each ACE clone has its own Experiment row, so deleting one clone does not affect the golden template or other opps. CRITICAL — callers MUST exclude OCS_GOLDEN_TEMPLATE_ID from the set of ids passed to this atom; the atom itself has no concept of "template" and will delete any experiment_id given. The /ace:sweep ocs flow enforces this exclusion. Routes through Playwright to /a/<team>/chatbots/<pk>/delete/ (POST, returns 302 HTMX HX-Redirect). No REST equivalent.',
  { experiment_id: z.number().int() },
  async (args) => result(await composite.deleteChatbot(args)),
);

server.tool(
  'ocs_get_chatbot_pipeline_id',
  'Resolve an experiment_id (integer chatbot id) to its working-version pipeline_id (integer). The OCS REST `/api/experiments/<id>/` response omits pipeline_id by design; this atom scrapes it from the pipeline-builder HTML (`SiteJS.pipeline.renderPipeline("#pipelineBuilder", "<team>", <pipeline_id>)`) via Playwright and caches the result per experiment_id. Used by /ace:sweep ocs to pair each orphan chatbot with its per-opp Pipeline row before deletion — without this, deleting an orphan chatbot leaves its Pipeline as a zombie row on the team (is_archived=False, no parent chatbot in the live listing). Returns `{ pipeline_id: number }`.',
  { experiment_id: z.number().int() },
  async (args) => result(await composite.getChatbotPipelineId(args)),
);

server.tool(
  'ocs_delete_pipeline',
  'Delete a pipeline (sets is_archived=True server-side). SAFE PER-OPP: when ACE clones a chatbot, Pipeline.create_new_version(is_copy=True) deep-clones the Pipeline row + its nodes — each clone has its own pipeline. Deleting the pipeline does NOT cascade-delete its referenced Collections — those need separate ocs_delete_collection calls. Routes through Playwright to /a/<team>/pipelines/<pk>/delete/ (HTTP DELETE method on Django View.delete(); returns 200 empty body).',
  { pipeline_id: z.number().int() },
  async (args) => result(await composite.deletePipeline(args)),
);

server.tool(
  'ocs_delete_collection',
  'Delete a collection (calls Collection.archive() server-side — sets is_archived=True AND triggers delete_document_source_task to async-purge underlying File rows + object-storage blobs + FileChunkEmbedding vectors; the user-visible effect is full deletion). SAFE PER-OPP for collections created fresh by Phase 5 (those are not shared). CRITICAL — callers MUST exclude OCS_GOLDEN_TEMPLATE_COLLECTION_ID (the collection referenced by every cloned pipeline; typically id 350) from the set of ids passed to this atom. Deleting the template collection would break every clone\'s RAG retrieval. The /ace:sweep ocs flow enforces this exclusion. Routes through Playwright to /a/<team>/documents/collection/<pk>/delete/ (HTTP DELETE method on Django View.delete(); returns 200 empty body; async cleanup task fires after).',
  { collection_id: z.number().int() },
  async (args) => result(await composite.deleteCollection(args)),
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
