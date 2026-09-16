//
// Nova MCP over plain HTTP JSON-RPC — the call path that does not go through
// Claude Code tool binding.
//
// ## Why this exists
//
// Nova's MCP is a plain HTTP JSON-RPC endpoint. Normally ACE reaches it the
// ordinary way, as bound MCP tools. Two situations make that impossible, and
// both have cost a live run:
//
//   1. **A tool schema the Messages API refuses to bind.** On
//      `poverty-graduation/20260915-1518` every agent whose tool array
//      contained one of Nova's deeper schemas died before its first tool call
//      with `400 tools.N.custom.input_schema: JSON schema is invalid. It must
//      match JSON Schema draft 2020-12`. That killed
//      `nova:nova-architect-autonomous` outright — and with it every documented
//      Phase 3 build path — while `get_hq_connection`, `get_app`, `get_module`
//      and `create_form` stayed callable from the caller's own session. The
//      fault is in binding, not in Nova: the same tools answer fine over
//      JSON-RPC. See dimagi-internal/ace#2408.
//
//   2. **An argument too expensive to pass through a model.**
//      `upload_media_asset` takes inline base64, which tokenizes at ~1 token
//      per character, so a 60 KB image costs ~80k tokens as a tool argument.
//      `scripts/run-nova-media-upload.ts` has made this same call server-side
//      since 2026-08-27 for that reason; this module is that script's transport
//      generalised so the next caller does not re-derive it.
//
// Reaching for this is a deliberate downgrade, not a default. Bound MCP tools
// give the model schema validation and argument completion; this gives it a
// string. Use it when tool binding is unavailable or ruinously expensive, and
// say which in the caller.
//
// Requires `NOVA_API_KEY`. A Bash-invoked script inherits none of ACE's
// secrets (ace#1957), so callers should `loadPluginEnv` before the first read.

/** The endpoint Nova's MCP serves. Overridable for tests and staging. */
export const NOVA_MCP_URL = 'https://mcp.commcare.app/mcp';

export interface NovaRpcOptions {
  /** Bearer token. Defaults to `process.env.NOVA_API_KEY` at call time. */
  apiKey?: string;
  /** Endpoint override. Defaults to `NOVA_MCP_URL`, then `process.env.NOVA_MCP_URL`. */
  url?: string;
  /** Injected for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Nova answers over SSE (`event: message\ndata: {...}`) as well as plain JSON.
 * Pull the last `data:` payload out of either shape.
 *
 * Pure and exported so the transport quirk is covered by a unit test rather
 * than discovered against the live server.
 */
export function parseNovaRpcBody(body: string): Record<string, unknown> {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const dataLines = trimmed
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .filter((l) => l.length > 0);
  if (dataLines.length === 0) {
    throw new Error(`unrecognised response from Nova: ${trimmed.slice(0, 300)}`);
  }
  return JSON.parse(dataLines[dataLines.length - 1]);
}

/**
 * Extract the text payload from an MCP `tools/call` result, parsed as JSON
 * when it is JSON. Nova returns `{content: [{type:'text', text:'...'}], isError?}`.
 *
 * Throws on `isError` so a tool-level rejection cannot be mistaken for data —
 * Nova applies nothing on rejection and names the problem in the text, so the
 * message is the useful part.
 */
export function unwrapToolResult(result: unknown, toolName: string): unknown {
  const r = (result ?? {}) as { content?: Array<{ text?: string }>; isError?: boolean };
  const text = (r.content ?? []).map((c) => c.text ?? '').join('');
  if (r.isError) throw new Error(`Nova ${toolName} rejected the call: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

let nextId = 0;

/** Make one JSON-RPC call against Nova's MCP endpoint. */
export async function novaRpc(
  method: string,
  params?: unknown,
  opts: NovaRpcOptions = {},
): Promise<unknown> {
  const apiKey = opts.apiKey ?? process.env.NOVA_API_KEY;
  if (!apiKey) {
    throw new Error(
      'NOVA_API_KEY is not set. Load it with `loadPluginEnv` first, or refresh ' +
        'it with `/ace:setup --force-env` (CLAUDE.md § Auth model).',
    );
  }
  const url = opts.url ?? process.env.NOVA_MCP_URL ?? NOVA_MCP_URL;
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
  });
  if (!res.ok) throw new Error(`Nova ${method} → HTTP ${res.status} ${res.statusText}`);

  const payload = parseNovaRpcBody(await res.text());
  if (payload.error) throw new Error(`Nova ${method} error: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

/**
 * Call a Nova tool by name. This is the entry point callers want: it reaches
 * every tool Nova serves, including the deep schemas the Messages API will not
 * bind (ace#2408).
 */
export async function novaCall(
  name: string,
  args: Record<string, unknown> = {},
  opts: NovaRpcOptions = {},
): Promise<unknown> {
  const result = await novaRpc('tools/call', { name, arguments: args }, opts);
  return unwrapToolResult(result, name);
}

/** List the tools Nova currently serves. Useful for contract probes. */
export async function novaToolNames(opts: NovaRpcOptions = {}): Promise<string[]> {
  const result = (await novaRpc('tools/list', undefined, opts)) as { tools?: Array<{ name: string }> };
  return (result.tools ?? []).map((t) => t.name);
}
