// scripts/run-content-generator.ts
//
// CLI wrapper around lib/content-generator-client.ts so the
// app-multimedia-coverage skill (a prompt) can invoke image
// generation via Bash.
//
// Usage:
//   npx tsx scripts/run-content-generator.ts <input.json> <output.png>
//
// Where <input.json> is:
//   {
//     "applicationContext": "...",
//     "formText": "...",
//     "imageDirectives": "...",  // optional
//     "upscale": false            // optional, defaults false
//   }
//
// Reads CONTENT_GENERATOR_URL and CONTENT_GENERATOR_API_KEY from the
// plugin-data .env (loaded here — a Bash tool call inherits none of ACE's
// secrets; see lib/load-plugin-env.ts and ace#1957), or from the shell env
// when explicitly exported.
// Writes the decoded PNG bytes to <output.png>.
// Prints a JSON line to stdout: { image_path, prompt_used, elapsed_ms, bytes }
//
// Exit codes:
//   0 — success
//   1 — bad CLI usage
//   2 — bad input JSON, missing env, or output dir doesn't exist
//   3 — Content Generator request failed (auth, validation, 5xx, etc.)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ContentGeneratorClient } from '../lib/content-generator-client.js';
import { loadPluginEnv } from '../lib/load-plugin-env.js';

// A Bash-invoked script inherits none of ACE's secrets — .env is loaded into
// MCP subprocesses only. Load it here, before the first credential read
// (ace#1957). Same contract as scripts/run-form-walk.ts (ace#993).
const __env = loadPluginEnv(import.meta.url);

async function main(): Promise<number> {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    console.error('Usage: npx tsx scripts/run-content-generator.ts <input.json> <output.png>');
    return 1;
  }

  const url = process.env.CONTENT_GENERATOR_URL;
  const apiKey = process.env.CONTENT_GENERATOR_API_KEY;
  if (!url || !apiKey) {
    // Name the file we read, or the operator is left guessing. The remediation
    // is NOT `source ~/.ace/env.sh` — that exports NOVA_API_KEY and nothing
    // else. These two keys live in the plugin-data .env, refreshed by
    // `/ace:setup --force-env` (ace#1957).
    const missing = [
      !url ? 'CONTENT_GENERATOR_URL' : null,
      !apiKey ? 'CONTENT_GENERATOR_API_KEY' : null,
    ]
      .filter(Boolean)
      .join(' and ');
    console.error(
      `Set ${missing} in the env. Looked in ${__env.path} ` +
        `(${__env.loaded ? 'read' : 'not readable'}). ` +
        'Refresh it with `/ace:setup --force-env`; `source ~/.ace/env.sh` ' +
        'cannot supply these keys — it exports NOVA_API_KEY only.',
    );
    return 2;
  }

  let input: {
    applicationContext?: unknown;
    formText?: unknown;
    imageDirectives?: unknown;
    upscale?: unknown;
  };
  try {
    input = JSON.parse(readFileSync(inputPath, 'utf-8'));
  } catch (e) {
    console.error(`Failed to read/parse ${inputPath}: ${(e as Error).message}`);
    return 2;
  }

  if (typeof input?.applicationContext !== 'string' || typeof input?.formText !== 'string') {
    console.error('input.json must include string applicationContext and formText.');
    return 2;
  }
  if (input.imageDirectives !== undefined && input.imageDirectives !== null && typeof input.imageDirectives !== 'string') {
    console.error('input.json imageDirectives must be a string when present.');
    return 2;
  }
  if (input.upscale !== undefined && typeof input.upscale !== 'boolean') {
    console.error('input.json upscale must be a boolean when present.');
    return 2;
  }

  // Ensure the output directory exists BEFORE we burn a generator call.
  // Class-level preventer for the heredoc-collision footgun: callers that
  // pass an output path with a non-existent parent dir (e.g. when bash ate
  // a `$(dirname ...)` substitution and produced `mkdir -p .` instead) used
  // to silently get an ENOENT post-API, wasting the generator quota and
  // leaving the wrapper's success-shaped JSON output as misleading
  // evidence. mkdirSync({recursive:true}) is idempotent and ~free.
  try {
    mkdirSync(dirname(outputPath), { recursive: true });
  } catch (e) {
    console.error(`Cannot create output directory for ${outputPath}: ${(e as Error).message}`);
    return 2;
  }

  const client = new ContentGeneratorClient({ url, apiKey });
  const t0 = Date.now();
  let result: { image: Buffer; promptUsed: string };
  try {
    result = await client.generateImage({
      applicationContext: input.applicationContext,
      formText: input.formText,
      imageDirectives: input.imageDirectives as string | undefined,
      upscale: (input.upscale as boolean | undefined) ?? false,
    });
  } catch (e) {
    console.error(`Content Generator failed: ${(e as Error).message}`);
    return 3;
  }
  const elapsed = Date.now() - t0;

  writeFileSync(outputPath, result.image);
  console.log(
    JSON.stringify({
      image_path: outputPath,
      prompt_used: result.promptUsed,
      elapsed_ms: elapsed,
      bytes: result.image.length,
    }),
  );
  return 0;
}

main().then((code) => process.exit(code));
