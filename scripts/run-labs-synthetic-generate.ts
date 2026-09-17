#!/usr/bin/env npx tsx
/**
 * Generate a synthetic dataset from a manifest FILE, so the bytes that go over
 * the wire are the bytes on disk.
 *
 * ## Why this exists rather than calling the MCP tool directly
 *
 * `synthetic_generate_from_manifest(opportunity_id, manifest_yaml)` takes the
 * manifest as an inline `string` and exposes no file-handle parameter — unlike
 * `drive_create_file`, `drive_update_file` and `update_yaml_file`, which all
 * take `localFilePath` precisely so a payload never passes through the model
 * twice.
 *
 * That gap makes ace#1737's remedy unsatisfiable. `demo-data-setup` § step 5b
 * says to author the manifest once to a local file, "send that file's contents"
 * to the atom, and archive the same file — but with no file parameter the model
 * must re-emit the YAML into the tool call, so the WIRE payload is one emission
 * and the ARCHIVE is another. They are identical only if the model reproduces
 * the file byte-for-byte, which is the exact assumption ace#1737 disproved:
 * `hh-poverty-targeting/20260824-1404` archived a manifest that did not parse
 * as YAML at all (flow mappings column-aligned, so the longest key got zero
 * spaces before its `{`) while generation itself had succeeded. Nothing failed,
 * the run was green, and the break surfaced only when the next run tried to
 * fork it. See ace#2433.
 *
 * Labs' MCP is a plain HTTP JSON-RPC endpoint, so ACE can make the same call
 * server-side: this script reads the manifest off disk and POSTs `tools/call`
 * itself. The model never holds the YAML, so there is only ONE emission and
 * the archived file IS the wire payload — by construction, not by diligence.
 *
 * Same `_path` companion pattern the repo already applies to
 * `commcare_upload_multimedia`, `commcare_patch_xform` and — for the identical
 * "the schema is upstream and not ours to extend" reason —
 * `scripts/run-nova-media-upload.ts`.
 *
 * Requires `LABS_MCP_TOKEN`. Read from the plugin-data `.env` (loaded here — a
 * Bash tool call inherits none of ACE's secrets; see `lib/load-plugin-env.ts`
 * and ace#1957), or from the shell env when explicitly exported.
 *
 * Usage:
 *   npx tsx scripts/run-labs-synthetic-generate.ts <manifest.yaml> --opportunity-id <id>
 *   npx tsx scripts/run-labs-synthetic-generate.ts <manifest.yaml> --opportunity-id <id> --dry-run
 *
 * `--dry-run` builds and prints the exact JSON-RPC request without sending it,
 * and without needing a token. Generation is a real mutation against a labs
 * opportunity, so the request is inspectable before it is made.
 *
 * Output (stdout): the tool's own JSON result, one line.
 * Exit codes: 0 generated (or dry-run printed), 1 usage/IO/auth error,
 *             2 labs rejected the manifest.
 */

import { readFileSync, existsSync } from 'node:fs';
import { loadPluginEnv } from '../lib/load-plugin-env.js';

// Before the first process.env read below — a Bash-invoked script inherits
// none of ACE's secrets (ace#1957).
const __env = loadPluginEnv(import.meta.url);

const LABS_MCP_URL = process.env.LABS_MCP_URL ?? 'https://labs.connect.dimagi.com/mcp/';

function die(msg: string, code = 1): never {
  process.stderr.write(`run-labs-synthetic-generate: ${msg}\n`);
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

/**
 * The request body, built from the manifest's bytes.
 *
 * Exported so a test can assert the payload without a network call — and,
 * more to the point, assert that `manifest_yaml` is the file's content
 * verbatim. That identity is the whole reason this script exists, so it is
 * the thing worth pinning.
 */
export function buildRequest(opportunityId: number, manifestYaml: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'synthetic_generate_from_manifest',
      arguments: { opportunity_id: opportunityId, manifest_yaml: manifestYaml },
    },
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--'));
  const oppIdx = argv.indexOf('--opportunity-id');
  const dryRun = argv.includes('--dry-run');

  if (!file) die('usage: run-labs-synthetic-generate.ts <manifest.yaml> --opportunity-id <id> [--dry-run]');
  if (!existsSync(file)) die(`no such file: ${file}`);
  if (oppIdx === -1 || !argv[oppIdx + 1]) die('--opportunity-id <id> is required');

  const opportunityId = Number(argv[oppIdx + 1]);
  if (!Number.isInteger(opportunityId)) die(`--opportunity-id must be an integer, got ${argv[oppIdx + 1]}`);

  // The ONE read. Nothing re-serialises this between here and the wire.
  const manifestYaml = readFileSync(file, 'utf8');
  const request = buildRequest(opportunityId, manifestYaml);

  if (dryRun) {
    process.stdout.write(`${request}\n`);
    return;
  }

  // `loadPluginEnv` injects into `process.env` and returns only metadata about
  // the file it read — so the token is read from `process.env`, and `__env` is
  // used to say WHICH `.env` was consulted when it is missing.
  const token = process.env.LABS_MCP_TOKEN;
  if (!token) {
    die(
      `LABS_MCP_TOKEN is not set. Looked in ${__env.path} ` +
        `(${__env.loaded ? 'read' : 'not readable'}). Mint one with ` +
        `/ace:labs-token-mint, then refresh with /ace:setup --force-env.`,
    );
  }

  let res: Response;
  try {
    res = await fetch(LABS_MCP_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: request,
    });
  } catch (e) {
    die(`could not reach labs at ${LABS_MCP_URL}: ${(e as Error).message}`);
  }

  const body = await res.text();
  if (res.status === 401 || res.status === 403) {
    die(`labs rejected the token (${res.status}). Re-mint with /ace:labs-token-mint.`);
  }
  if (!res.ok) die(`labs returned ${res.status}: ${body.slice(0, 300)}`, 2);

  const rpc = parseRpcBody(body);
  if (rpc.error) die(`labs error: ${JSON.stringify(rpc.error).slice(0, 400)}`, 2);

  const content = (rpc.result as { content?: Array<{ text?: string }> } | undefined)?.content;
  const text = content?.[0]?.text;
  if (!text) die(`labs returned no payload: ${body.slice(0, 300)}`, 2);

  process.stdout.write(`${text}\n`);
}

main().catch((e) => die(`unexpected failure: ${(e as Error).message}`));
