/**
 * OCS MCP Server for ACE
 *
 * Exposes 22 atomic OCS capabilities as MCP tools. Delegates to a CompositeBackend
 * that routes each atom to either REST (public OCS API) or Playwright (authenticated
 * Django session + CSRF) based on capability-map.ts.
 *
 * See docs/superpowers/specs/2026-04-08-ace-ocs-chatbot-buildout-design.md
 */

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

// Simple promise-queue serializer so concurrent authoring calls can't race
// on CSRF token rotation or cookie mutation. Spec section: Playwright backend → Concurrency.
let requestChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = requestChain.then(fn, fn);
  requestChain = next.catch(() => undefined);
  return next;
}

async function getPlaywrightBackend(): Promise<PlaywrightBackend> {
  if (playwright) return playwright;
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
    options?: { followRedirects?: boolean; multipart?: Record<string, unknown> },
  ) {
    if (method === 'GET') {
      return ctx.request.get(url, {
        maxRedirects: options?.followRedirects === false ? 0 : undefined,
      });
    }
    // POST: route to either multipart or JSON body depending on options.
    const maxRedirects = options?.followRedirects === false ? 0 : undefined;
    const headers = { 'X-CSRFToken': csrfToken, Referer: baseUrl };
    if (options?.multipart) {
      // Re-map our `files_N` synthetic field names back to the repeated `files`
      // field name that Django's `request.FILES.getlist("files")` expects.
      // Playwright's `multipart` dict doesn't support duplicate keys directly,
      // so we work around it by using unique keys then letting Playwright
      // stream each one. The server-side `getlist` call on `files` won't find
      // anything under `files_0`, so for each entry we prefix with `files`.
      //
      // NOTE: Playwright accepts Node's FormData via `form` — we use that path
      // when we need multiple values for one field. Otherwise, the dict works.
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
      return ctx.request.post(url, {
        headers,
        multipart: form,
        maxRedirects,
      });
    }
    return ctx.request.post(url, {
      headers,
      data: body,
      maxRedirects,
    });
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
  "Update the LLMResponseWithPrompt node's prompt field for this chatbot.",
  { experiment_id: z.number(), prompt: z.string() },
  async (args) => { await composite.setChatbotSystemPrompt(args); return result({ ok: true }); },
);

server.tool(
  'ocs_create_collection',
  'Create a new Collection (RAG knowledge base) in OCS.',
  {
    name: z.string(),
    summary: z.string(),
    is_index: z.boolean(),
    is_remote_index: z.boolean(),
    llm_provider: z.number().optional(),
    embedding_model: z.number().optional(),
  },
  async (args) => result(await composite.createCollection(args)),
);

server.tool(
  'ocs_upload_collection_files',
  'Upload files to an existing Collection. Files will be chunked and embedded asynchronously.',
  {
    collection_id: z.number(),
    files: z.array(z.object({
      name: z.string(),
      content: z.string().describe('Base64-encoded file content'),
      mime_type: z.string(),
    })),
  },
  async (args) => {
    const decoded = args.files.map((f) => ({
      name: f.name,
      content: Buffer.from(f.content, 'base64'),
      mime_type: f.mime_type,
    }));
    return result(await composite.uploadCollectionFiles({ collection_id: args.collection_id, files: decoded }));
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
  "Attach one or more Collections to a chatbot's retriever node.",
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
  'List chatbots on the OCS team.',
  { cursor: z.string().optional(), page_size: z.number().optional() },
  async (args) => result(await composite.listChatbots(args)),
);

server.tool(
  'ocs_get_chatbot',
  'Retrieve a single chatbot by its public UUID (from ocs_list_chatbots).',
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
  'Send a test message to a chatbot via the OpenAI-compatible endpoint.',
  {
    experiment_id: z.number(),
    messages: z.array(z.object({ role: z.string(), content: z.string() })),
  },
  async (args) => result(await composite.sendTestMessage({
    experiment_id: args.experiment_id,
    messages: args.messages as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  })),
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
    console.error('OCS REST verification failed:', e);
    process.exit(1);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('OCS MCP server fatal error:', err);
  process.exit(1);
});
