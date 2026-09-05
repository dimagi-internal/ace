#!/usr/bin/env npx tsx
/**
 * Upload a local media file to Nova's asset library and print its asset id.
 *
 * ## Why this exists rather than calling the MCP tool directly
 *
 * Nova's `upload_media_asset` takes the file as inline base64. Calling it as
 * an MCP tool means the model has to hold that base64 as a tool-call argument
 * — and base64 tokenizes at roughly one token per character, so a 60 KB image
 * costs ~80k tokens to send. Measured 2026-08-27: reading a 46 KB base64 file
 * alone consumed 45k tokens and hit the read cap. An app carrying a dozen
 * images would spend most of a phase's budget moving pixels, and would fail
 * long before that on argument size.
 *
 * Nova's MCP is a plain HTTP JSON-RPC endpoint, so ACE can make the same call
 * server-side: this script reads the bytes off disk, encodes them here, and
 * POSTs `tools/call` itself. The model sees one short command and one line of
 * JSON. Cost per image drops from ~80k tokens to ~20.
 *
 * This is the `_path` companion pattern the repo already applies to
 * `commcare_upload_multimedia` and `commcare_patch_xform` (boundary-probe
 * registry, 2026-05-12), reached by proxy because Nova's schema is upstream
 * and not ours to extend.
 *
 * Requires `NOVA_API_KEY`. It is read from the plugin-data `.env` (loaded
 * here — a Bash tool call inherits none of ACE's secrets; see
 * `lib/load-plugin-env.ts` and ace#1957), or from the shell env when
 * explicitly exported. `source ~/.ace/env.sh` also works for THIS key, but
 * only because that file exports exactly this one variable — it is not a
 * general remediation. See CLAUDE.md § Auth model.
 *
 * Usage:
 *   npx tsx scripts/run-nova-media-upload.ts <file> [--filename <name>]
 *                                            [--project-id <id>] [--mime <type>]
 *
 * Output (stdout): {"asset_id": "...", "kind": "image", "deduplicated": false}
 * Exit codes: 0 uploaded, 1 usage/IO/auth error, 2 Nova rejected the asset.
 */

import { readFileSync, existsSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { loadPluginEnv } from '../lib/load-plugin-env.js';

// Before the first process.env read below — a Bash-invoked script inherits
// none of ACE's secrets (ace#1957).
const __env = loadPluginEnv(import.meta.url);

const NOVA_MCP_URL = process.env.NOVA_MCP_URL ?? 'https://mcp.commcare.app/mcp';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};

function die(msg: string, code = 1): never {
  process.stderr.write(`run-nova-media-upload: ${msg}\n`);
  process.exit(code);
}

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) die(`${name} needs a value`);
  return v;
}

/**
 * Nova answers over SSE (`event: message\ndata: {...}`) as well as plain JSON.
 * Pull the last `data:` payload out of either shape.
 */
function parseRpcBody(body: string): Record<string, unknown> {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const dataLines = trimmed
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim());
  if (dataLines.length === 0) die(`unrecognised response from Nova: ${trimmed.slice(0, 300)}`);
  return JSON.parse(dataLines[dataLines.length - 1]);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stderr.write(
      'usage: run-nova-media-upload.ts <file> [--filename <name>] ' +
        '[--project-id <id>] [--mime <type>]\n',
    );
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const file = argv[0];
  if (!existsSync(file)) die(`no such file: ${file}`);

  const apiKey = process.env.NOVA_API_KEY;
  if (!apiKey) {
    die(
      `NOVA_API_KEY is not set. Looked in ${__env.path} ` +
        `(${__env.loaded ? 'read' : 'not readable'}). Refresh it with ` +
        '`/ace:setup --force-env` (CLAUDE.md § Auth model).',
    );
  }

  const ext = extname(file).toLowerCase();
  const mime = flag(argv, '--mime') ?? MIME_BY_EXT[ext];
  if (!mime) {
    die(`cannot infer a mime type from "${ext || '(no extension)'}" — pass --mime`);
  }

  const filename = flag(argv, '--filename') ?? basename(file);
  const projectId = flag(argv, '--project-id');

  const args: Record<string, unknown> = {
    filename,
    mime_type: mime,
    data_base64: readFileSync(file).toString('base64'),
  };
  if (projectId) args.project_id = projectId;

  let res: Response;
  try {
    res = await fetch(NOVA_MCP_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'upload_media_asset', arguments: args },
      }),
    });
  } catch (e) {
    die(`could not reach Nova at ${NOVA_MCP_URL}: ${(e as Error).message}`);
  }

  const body = await res.text();
  if (res.status === 401 || res.status === 403) {
    die(`Nova rejected the API key (${res.status}). Re-check NOVA_API_KEY.`);
  }
  if (!res.ok) die(`Nova returned ${res.status}: ${body.slice(0, 300)}`, 2);

  const rpc = parseRpcBody(body);
  if (rpc.error) {
    die(`Nova error: ${JSON.stringify(rpc.error).slice(0, 400)}`, 2);
  }

  // The tool result arrives as a text block holding the real JSON payload.
  const content = (rpc.result as { content?: Array<{ text?: string }> } | undefined)?.content;
  const text = content?.[0]?.text;
  if (!text) die(`Nova returned no asset payload: ${body.slice(0, 300)}`, 2);

  let parsed: { asset_id?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    // An MCP tool reports failure as a plain-text content block.
    die(`Nova refused the upload: ${text.slice(0, 400)}`, 2);
  }
  if (!parsed.asset_id) die(`Nova refused the upload: ${text.slice(0, 400)}`, 2);

  process.stdout.write(`${JSON.stringify(parsed)}\n`);
}

main().catch((e) => die(`unexpected failure: ${(e as Error).message}`));
