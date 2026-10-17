/**
 * One labs MCP `tools/call` over HTTP JSON-RPC, for scripts.
 *
 * Labs' MCP is a plain JSON-RPC endpoint, so a script can make the same call an
 * MCP atom makes without the model re-emitting the arguments
 * (`scripts/run-labs-synthetic-generate.ts`, ace#2433). `scripts/clone-run.ts`
 * carries its own copy of this; this is the shared form for new scripts.
 *
 * Requires `LABS_MCP_TOKEN` (`/ace:labs-token-mint`). A Bash-invoked script
 * inherits none of ACE's secrets, so call `loadPluginEnv(import.meta.url)`
 * before `makeLabsCall()` (ace#1957).
 */

/** One labs MCP tool call: resolves to the tool's JSON result, throws on a tool error. */
export type LabsCall = (tool: string, args: Record<string, unknown>) => Promise<any>;

export const DEFAULT_LABS_MCP_URL = 'https://labs.connect.dimagi.com/mcp/';

/** Labs answers `tools/call` as JSON or as an SSE `data:` stream. */
export function parseLabsRpc(body: string): any {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const data = trimmed.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  if (!data.length) throw new Error(`unrecognised labs response: ${trimmed.slice(0, 200)}`);
  return JSON.parse(data[data.length - 1]);
}

export interface LabsCallOptions {
  url?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export function makeLabsCall(opts: LabsCallOptions = {}): LabsCall {
  const url = opts.url ?? process.env.LABS_MCP_URL ?? DEFAULT_LABS_MCP_URL;
  const doFetch = opts.fetchImpl ?? fetch;
  return async (tool, args) => {
    const token = opts.token ?? process.env.LABS_MCP_TOKEN;
    if (!token) throw new Error('LABS_MCP_TOKEN is not set (/ace:labs-token-mint)');
    const res = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`${tool}: labs HTTP ${res.status}: ${body.slice(0, 200)}`);
    const rpc = parseLabsRpc(body);
    if (rpc.error) throw new Error(`${tool}: ${JSON.stringify(rpc.error).slice(0, 300)}`);
    const text = rpc.result?.content?.[0]?.text ?? '';
    if (rpc.result?.isError) throw new Error(`${tool}: ${String(text).slice(0, 400)}`);
    try {
      return unwrapToolResult(text ? JSON.parse(text) : {});
    } catch {
      throw new Error(`${tool}: non-JSON result: ${String(text).slice(0, 200)}`);
    }
  };
}

/**
 * Some labs tools return their result as a NESTED content list — the text part
 * is itself `[{"type":"text","text":"<json>"}]` (seen on
 * `workflow_template_export`, 2026-10-16). Unwrap that one level so callers
 * always get the tool's own object.
 */
export function unwrapToolResult(v: any): any {
  if (Array.isArray(v) && v.length === 1 && v[0] && v[0].type === 'text' && typeof v[0].text === 'string') {
    return JSON.parse(v[0].text);
  }
  return v;
}
