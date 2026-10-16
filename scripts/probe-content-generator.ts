// scripts/probe-content-generator.ts
//
// LIVE CONTRACT (probed 2026-05-05 via /openapi.json + live POST):
//   Service: Dimagi Content Gen v0.1.0
//   Endpoint: POST <CONTENT_GENERATOR_URL>/v1/form-image
//   Auth: x-api-key: <google-cloud-api-key> header
//         (the gateway also documents ?key= as a fallback; header is the
//          confirmed-working scheme — see probe run 2026-05-05)
//   Request body (application/json):
//     { application_context, form_text, image_directives?, upscale?=false }
//   Response 200 (application/json):
//     { image: <base64-PNG>, prompt_used: <string> }
//   Wall-clock: ~68s observed for an upscale=false request on 2026-05-05;
//   spec hints ~10s low-res and ~30s upscaled but live latency is higher.
//
// Run:
//   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" scripts/probe-content-generator.ts
//
// Credentials come from the plugin-data .env via loadPluginEnv — no manual
// `export` needed (an exported shell value still wins). The old header told
// you to export both keys by hand, so on a machine where they were provisioned
// the probe refused and read as "generation unavailable" (ace#2141).
//
// Exit codes — each names a different remedy, so they are never conflated:
//   0 — success (200 + a PNG came back)
//   2 — CREDENTIALS MISSING: a key is absent from the env AND the .env it read
//   3 — SERVICE UNREACHABLE: the request never got a response (DNS, TLS, timeout)
//   4 — SERVICE ERROR: the gateway answered non-200 (auth, validation, 5xx)

import { writeFileSync } from 'node:fs';
import { loadPluginEnv } from '../lib/load-plugin-env.js';

// Before the first credential read (ace#1957, ace#2141).
const ENV = loadPluginEnv(import.meta.url);

const URL = process.env.CONTENT_GENERATOR_URL ?? '';
const KEY = process.env.CONTENT_GENERATOR_API_KEY ?? '';
const missing = [
  !URL && 'CONTENT_GENERATOR_URL',
  !KEY && 'CONTENT_GENERATOR_API_KEY',
].filter(Boolean);
if (missing.length) {
  console.error(
    `CREDENTIALS MISSING: ${missing.join(', ')} not set in the env or in ${ENV.path}` +
      ` (${ENV.loaded ? `${ENV.keys} keys read` : 'file not loaded'}).` +
      ' This says nothing about whether the service is up. Refresh the .env with /ace:setup --force-env.',
  );
  process.exit(2);
}

const endpoint = URL.replace(/\/$/, '') + '/v1/form-image';
const body = {
  application_context:
    'Frontline workers in Africa teaching mothers to care for Small Vulnerable Newborns with Kangaroo Mother Care. Modestly dressed, representative of context.',
  form_text: "Show the mother how to support the baby's head and neck while skin-to-skin.",
  image_directives:
    'Frontline worker assisting a mother holding a small newborn skin-to-skin against her chest, head supported, warm lighting.',
  upscale: false,
};

const t0 = Date.now();
let res: Response;
try {
  res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify(body),
  });
} catch (e) {
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  console.error(
    `SERVICE UNREACHABLE: no response from ${new globalThis.URL(endpoint).host}` +
      ` after ${Date.now() - t0}ms — ${cause?.code ?? cause?.message ?? (e as Error).message}.` +
      ' Credentials were present; this is the network or the gateway.',
  );
  process.exit(3);
}
const elapsed = Date.now() - t0;

console.log({
  status: res.status,
  contentType: res.headers.get('content-type'),
  elapsedMs: elapsed,
  authScheme: 'x-api-key header',
});

const buf = Buffer.from(await res.arrayBuffer());
writeFileSync('/tmp/content-gen-probe-response.bin', buf);

if (res.status !== 200) {
  console.error(`SERVICE ERROR: HTTP ${res.status}. Body slice:`, buf.slice(0, 1000).toString('utf-8'));
  process.exit(4);
}

const json = JSON.parse(buf.toString('utf-8'));
console.log('Response keys:', Object.keys(json));
console.log('prompt_used (first 200 chars):', String(json.prompt_used ?? '').slice(0, 200));
const imageBytes = Buffer.from(json.image, 'base64');
writeFileSync('/tmp/content-gen-probe-image.png', imageBytes);
console.log(`PNG saved (${imageBytes.length} bytes) to /tmp/content-gen-probe-image.png`);
console.log(`First 4 bytes (PNG magic = 89504e47):`, imageBytes.slice(0, 4).toString('hex'));
