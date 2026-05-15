#!/usr/bin/env tsx
/**
 * connect-labs-server: stdio MCP proxy to labs.connect.dimagi.com/mcp/.
 *
 * Reads LABS_MCP_TOKEN from ${CLAUDE_PLUGIN_DATA}/.env (legacy fallback:
 * plugin root .env), then forwards every JSON-RPC frame received on stdin
 * over HTTPS to the labs MCP, injecting `Authorization: Bearer <token>`.
 * The HTTP response body is written back to stdout as a single line.
 *
 * Stays a stdio MCP because ACE's plugin.json only wires stdio mcpServers.
 * When Claude Code's plugin.json gains first-class HTTP MCP support, this
 * proxy can be deleted in favor of a direct `type: "http"` entry.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export interface JsonRpcFrame {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ForwardOpts {
  token: string;
  url: string;
}

export async function forward(frame: JsonRpcFrame, opts: ForwardOpts): Promise<JsonRpcFrame> {
  if (!opts.token) {
    throw new Error('LABS_MCP_TOKEN is required to forward to labs MCP');
  }
  const res = await fetch(opts.url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${opts.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(frame),
  });
  if (!res.ok) {
    return {
      jsonrpc: '2.0',
      id: frame.id ?? null,
      error: {
        code: -32000,
        message: `labs MCP returned ${res.status}: ${await res.text()}`,
      },
    };
  }
  return (await res.json()) as JsonRpcFrame;
}

/**
 * Local tools that the proxy handles itself rather than forwarding upstream.
 * These get merged into the `tools/list` response and intercepted on
 * `tools/call`. Each entry is exposed to the MCP host as
 * `mcp__connect-labs__<name>` (the host adds the prefix).
 *
 * Added in 0.13.x: `labs_delete_record` — the upstream `LabsRecordDataView`
 * supports DELETE but isn't exposed as an MCP tool, so the proxy makes a
 * direct REST call to `/export/labs_record/` with the same Bearer token.
 * Covers solicitations, funds, reviews, and responses (all backed by the
 * same `LabsRecord` table; no type discriminator needed for delete —
 * lookup is by primary key alone).
 */
export const LOCAL_TOOLS = [
  {
    name: 'labs_delete_record',
    description:
      'Hard-delete a LabsRecord by primary key. Covers solicitations, funds, reviews, and responses (all backed by the same LabsRecord table; type discriminator not required for delete). Used by /ace:sweep labs to clean up orphan records. Calls the upstream HTTP DELETE /export/labs_record/ endpoint directly (not via the labs MCP); auth uses the same LABS_MCP_TOKEN.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Integer primary key of the LabsRecord to delete.' },
      },
      required: ['id'],
      // additionalProperties:false is required by Claude Code's MCP tool injection
      // layer (verified empirically 2026-05-15: tools missing this field are
      // silently dropped from the catalog even though they appear in the proxy's
      // wire-level tools/list response). Every upstream labs MCP tool has this
      // set; mirroring it here for consistency.
      additionalProperties: false,
    },
  },
] as const;

/**
 * Derive the labs REST base URL from `LABS_MCP_URL`. The MCP endpoint
 * lives at `<base>/mcp/`; the REST endpoints live alongside (`<base>/export/...`).
 */
export function labsBaseUrl(mcpUrl: string): string {
  return mcpUrl.replace(/\/mcp\/?$/, '');
}

export interface LocalCallOpts {
  token: string;
  baseUrl: string;
}

/**
 * Handle a `tools/call` for a local tool. Returns an MCP-shaped result
 * frame; never forwards. Throws if the local tool isn't recognized
 * (callers should check `isLocalTool` first).
 */
export async function callLocal(frame: JsonRpcFrame, opts: LocalCallOpts): Promise<JsonRpcFrame> {
  const params = (frame.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
  if (params.name !== 'labs_delete_record') {
    throw new Error(`callLocal: unknown local tool ${JSON.stringify(params.name)}`);
  }
  const id = (params.arguments ?? {}).id;
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    return {
      jsonrpc: '2.0',
      id: frame.id ?? null,
      error: { code: -32602, message: 'labs_delete_record: `id` must be an integer' },
    };
  }
  const url = `${opts.baseUrl}/export/labs_record/`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${opts.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([{ id }]),
  });
  if (!res.ok) {
    return {
      jsonrpc: '2.0',
      id: frame.id ?? null,
      error: {
        code: -32000,
        message: `labs_delete_record: ${res.status} ${await res.text()}`,
      },
    };
  }
  // MCP `tools/call` result shape: `{ content: [{ type: 'text', text: '...' }] }`.
  return {
    jsonrpc: '2.0',
    id: frame.id ?? null,
    result: { content: [{ type: 'text', text: `Deleted LabsRecord id=${id}` }] },
  };
}

/** Returns true if the frame is a `tools/call` for a local tool. */
export function isLocalToolCall(frame: JsonRpcFrame): boolean {
  if (frame.method !== 'tools/call') return false;
  const name = (frame.params as { name?: string } | undefined)?.name;
  return LOCAL_TOOLS.some((t) => t.name === name);
}

/**
 * Merge local tool definitions into a `tools/list` reply from upstream.
 * If the upstream reply is an error, return it unchanged; otherwise
 * append every entry in LOCAL_TOOLS to `result.tools`.
 */
export function mergeToolsList(reply: JsonRpcFrame): JsonRpcFrame {
  if (reply.error) return reply;
  const result = (reply.result ?? {}) as { tools?: unknown[] };
  const upstream = Array.isArray(result.tools) ? result.tools : [];
  return {
    ...reply,
    result: { ...result, tools: [...upstream, ...LOCAL_TOOLS] },
  };
}

function parseEnvFile(path: string): Record<string, string> {
  try {
    const txt = readFileSync(path, 'utf8');
    const out: Record<string, string> = {};
    for (const line of txt.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}

function loadToken(): string {
  if (process.env.LABS_MCP_TOKEN) return process.env.LABS_MCP_TOKEN;
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  if (dataDir) {
    const fromData = parseEnvFile(join(dataDir, '.env')).LABS_MCP_TOKEN;
    if (fromData) return fromData;
  }
  const rootEcho = process.env.CLAUDE_PLUGIN_ROOT_ECHO;
  if (rootEcho) {
    const fromRoot = parseEnvFile(join(rootEcho, '.env')).LABS_MCP_TOKEN;
    if (fromRoot) return fromRoot;
  }
  return '';
}

/**
 * JSON-RPC notifications have no `id` and MUST NOT receive a reply.
 * The MCP host sends `notifications/initialized` after the
 * `initialize` request — if the proxy writes anything back to stdout
 * for it, the host treats the unsolicited message as a protocol
 * violation and stops trusting the connection (manifests as
 * "ToolSearch can't see this MCP's tools" since the host disables
 * tool discovery on a misbehaving stdio peer). Tracking:
 * jjackson/ace#106 finding 8.
 */
export function isNotification(frame: JsonRpcFrame): boolean {
  return frame.id === undefined || frame.id === null;
}

async function main() {
  const token = loadToken();
  const url = process.env.LABS_MCP_URL || 'https://labs.connect.dimagi.com/mcp/';
  const baseUrl = labsBaseUrl(url);

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let frame: JsonRpcFrame;
    try {
      frame = JSON.parse(trimmed) as JsonRpcFrame;
    } catch (e) {
      // Parse errors on a request must surface as an error reply with
      // id=null per JSON-RPC. We can't distinguish a malformed
      // notification from a malformed request, so we follow the
      // request convention; the host will discard a stray error if it
      // wasn't expecting one.
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: `Parse error: ${(e as Error).message}` },
      }) + '\n');
      continue;
    }
    const isNotif = isNotification(frame);
    try {
      let reply: JsonRpcFrame;
      if (isLocalToolCall(frame)) {
        // Intercept tools/call for local tools — never forwards upstream.
        reply = await callLocal(frame, { token, baseUrl });
      } else {
        reply = await forward(frame, { token, url });
        // Merge local tool defs into tools/list responses so the MCP
        // host advertises them alongside the upstream tools.
        if (frame.method === 'tools/list') {
          reply = mergeToolsList(reply);
        }
      }
      // Notifications must not produce a stdout reply, even if the
      // upstream server volunteered one (e.g. labs replying with
      // "Method not found" to `notifications/initialized` — that's
      // labs being strict, but the MCP wire protocol says no reply
      // for notifications regardless).
      if (!isNotif) {
        process.stdout.write(JSON.stringify(reply) + '\n');
      }
    } catch (e) {
      // Same rule applies on transport failures: don't write an error
      // reply for a notification; the host has nothing to correlate
      // it against.
      if (!isNotif) {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: frame.id ?? null,
          error: { code: -32000, message: (e as Error).message },
        }) + '\n');
      }
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`connect-labs-server fatal: ${(e as Error).stack || e}\n`);
    process.exit(1);
  });
}
