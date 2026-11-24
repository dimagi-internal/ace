#!/usr/bin/env npx tsx
/**
 * Call any connect-labs MCP tool server-side, over plain HTTP JSON-RPC.
 *
 * ## Why this exists
 *
 * The connect-labs MCP is a native `type: "http"` entry, and a Claude Code
 * session does not always BIND its tools: on 2026-11-18 (ace#3437, a recurrence
 * of ace#738) `claude mcp list` reported connect-labs, ace-gdrive, ace-connect,
 * ace-ocs and nova all `✔ Connected` while not one of their tools was callable
 * or visible to `ToolSearch`. `bin/ace-doctor` passed every MCP in the same
 * session, because it probes the SERVERS over HTTP rather than asking whether
 * this session bound their tools.
 *
 * A run fails loudly when that happens — a phase skill calls an atom and stops.
 * A TURN does not: it still has Bash and email, so it reads the thread, cannot
 * reach labs, and reports the partner's problem as unreachable. That turn had
 * to re-implement a labs client in a scratch file to answer a partner before a
 * client demo. This is that client, in the repo, so the fallback is a supported
 * path instead of something each session reinvents.
 *
 * It is the READ-side sibling of `scripts/run-labs-synthetic-generate.ts`,
 * which already makes the same call server-side for the write side (and whose
 * `parseRpcBody` shape this mirrors: labs answers as JSON or as an SSE stream).
 *
 * ## Auth
 *
 * `LABS_MCP_TOKEN` comes from the plugin-data `.env` via `loadPluginEnv`, the
 * shared loader every Bash-reachable script uses (ace#1964) — a Bash tool call
 * inherits none of ACE's secrets. Never `source` the file: it holds shell
 * metacharacters and fragments of stored passwords (ace#3421).
 *
 * ## Usage
 *
 *   npx tsx scripts/labs-call.ts --list
 *   npx tsx scripts/labs-call.ts <tool-name> '<json-args>'
 *   npx tsx scripts/labs-call.ts data_describe '{"opportunity_ids":[10174],"load_missing":true}'
 *
 * Inside the installed plugin, call tsx directly — the cache's
 * `node_modules/.bin/tsx` is a dereferenced copy, so `npx tsx` throws
 * ERR_MODULE_NOT_FOUND there (ace#2252):
 *
 *   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/labs-call.ts" --list
 *
 * Output (stdout): the tool's own JSON-RPC result, pretty-printed; `--list`
 * prints one tool name per line.
 * Exit codes: 0 ok, 1 usage / auth / transport error, 2 labs returned an error.
 */
import { loadPluginEnv } from '../lib/load-plugin-env.js';

// Before the first process.env read below — a Bash-invoked script inherits
// none of ACE's secrets (ace#1957, ace#1964).
const __env = loadPluginEnv(import.meta.url);

const LABS_MCP_URL = process.env.LABS_MCP_URL ?? 'https://labs.connect.dimagi.com/mcp/';

function die(msg: string, code = 1): never {
  process.stderr.write(`labs-call: ${msg}\n`);
  process.exit(code);
}

/** Labs answers `tools/call` as JSON or as an SSE `data:` stream. */
export function parseRpcBody(body: string): Record<string, unknown> {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const dataLines = trimmed
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim());
  if (dataLines.length === 0) die(`unrecognised response from labs: ${trimmed.slice(0, 300)}`);
  return JSON.parse(dataLines[dataLines.length - 1]);
}

export function buildRequest(tool: string | null, args: Record<string, unknown>): string {
  return JSON.stringify(
    tool === null
      ? { jsonrpc: '2.0', id: 1, method: 'tools/list' }
      : { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } },
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const list = argv.includes('--list');
  const dryRun = argv.includes('--dry-run');
  const positional = argv.filter((a) => !a.startsWith('--'));

  if (!list && positional.length === 0) {
    die('usage: labs-call.ts --list | labs-call.ts <tool-name> \'<json-args>\' [--dry-run]');
  }

  let args: Record<string, unknown> = {};
  if (!list && positional[1]) {
    try {
      args = JSON.parse(positional[1]);
    } catch (e) {
      die(`second argument must be JSON: ${(e as Error).message}`);
    }
  }

  const request = buildRequest(list ? null : positional[0], args);
  if (dryRun) {
    process.stdout.write(`${request}\n`);
    return;
  }

  // `loadPluginEnv` injects into `process.env` and returns only metadata about
  // the file it read — so the token comes from `process.env`, and `__env` is
  // used to say WHICH `.env` was consulted when it is missing.
  const token = process.env.LABS_MCP_TOKEN;
  if (!token) {
    die(`no LABS_MCP_TOKEN in the environment or ${__env.path ?? 'the plugin-data .env'} — mint one with /ace:labs-token-mint`);
  }

  const res = await fetch(LABS_MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: request,
  });

  const text = await res.text();
  if (!res.ok) die(`labs HTTP ${res.status}: ${text.slice(0, 600)}`);

  const parsed = parseRpcBody(text);
  if (list) {
    const tools = ((parsed as Record<string, any>)?.result?.tools ?? []) as Array<{ name: string }>;
    process.stdout.write(`${tools.map((t) => t.name).join('\n')}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
  // Labs reports tool-level failures inside a 200 — surface them in the exit code.
  if ((parsed as Record<string, any>)?.result?.isError) process.exit(2);
}

// Importable for tests; only the direct invocation makes a network call.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => die((e as Error).message));
}
