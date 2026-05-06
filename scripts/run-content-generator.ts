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
// Reads CONTENT_GENERATOR_URL and CONTENT_GENERATOR_API_KEY from env.
// Writes the decoded PNG bytes to <output.png>.
// Prints a JSON line to stdout: { image_path, prompt_used, elapsed_ms, bytes }
//
// Exit codes:
//   0 — success
//   1 — bad CLI usage
//   2 — bad input JSON or missing env
//   3 — Content Generator request failed (auth, validation, 5xx, etc.)

import { readFileSync, writeFileSync } from 'node:fs';
import { ContentGeneratorClient } from '../lib/content-generator-client.js';

async function main(): Promise<number> {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    console.error('Usage: npx tsx scripts/run-content-generator.ts <input.json> <output.png>');
    return 1;
  }

  const url = process.env.CONTENT_GENERATOR_URL;
  const apiKey = process.env.CONTENT_GENERATOR_API_KEY;
  if (!url || !apiKey) {
    console.error('Set CONTENT_GENERATOR_URL and CONTENT_GENERATOR_API_KEY in the env.');
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
